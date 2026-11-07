import { useMemo, useState } from 'react';
import { Search, ShoppingCart, Plus, Minus, X, Banknote, QrCode, Wallet, Sparkles } from 'lucide-react';
import type { Category, PayMethod, Product } from '../../db/types';
import { CATEGORIES, PAY_LABEL } from '../../db/types';
import { checkout } from '../../db/repo';
import { fenToStr, qtyToStr, strToFen } from '../../db/util';
import { Btn, Empty, Field, Sheet } from '../kit';

interface CartLine {
  productId: string;
  unit: 'box' | 'base';
  qtyBase: number;
  listUnitPriceFen: number;
  unitPriceFen: number;
}

export default function SellPage({
  products,
  inv,
  deviceId,
  operators,
  onDone
}: {
  products: Product[];
  inv: Map<string, number>;
  deviceId: string;
  operators: string[];
  onDone: (msg: string) => void;
}) {
  const [cat, setCat] = useState<'全部' | Category>('全部');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [operator, setOperator] = useState(operators[0] ?? '我');
  const [priceLine, setPriceLine] = useState<number | null>(null);
  const [priceInput, setPriceInput] = useState('');
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return products
      .filter((p) => !p.archived)
      .filter((p) => (cat === '全部' ? true : p.category === cat))
      .filter((p) => (kw ? p.name.toLowerCase().includes(kw) : true))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh'));
  }, [products, cat, q]);

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const factorOf = (p: Product, unit: 'box' | 'base') =>
    unit === 'box' && p.boxQty > 1 ? p.boxQty : 1;

  const addProduct = (p: Product) => {
    setCart((prev) => {
      const found = prev.find((c) => c.productId === p.id);
      if (found) {
        return prev.map((c) =>
          c.productId === p.id ? { ...c, qtyBase: c.qtyBase + factorOf(p, c.unit) } : c
        );
      }
      return [
        ...prev,
        {
          productId: p.id,
          unit: 'base',
          qtyBase: 1,
          listUnitPriceFen: p.priceList,
          unitPriceFen: p.priceList
        }
      ];
    });
  };

  const totalFen = cart.reduce((s, c) => s + c.qtyBase * c.unitPriceFen, 0);
  const totalQty = cart.reduce((s, c) => s + c.qtyBase, 0);

  const changeQty = (idx: number, delta: number) => {
    setCart((prev) =>
      prev.map((c, i) => {
        if (i !== idx) return c;
        const p = productById.get(c.productId);
        const f = p ? factorOf(p, c.unit) : 1;
        const next = c.qtyBase + delta * f;
        return { ...c, qtyBase: next < f ? f : next };
      })
    );
  };

  const switchUnit = (idx: number) => {
    setCart((prev) =>
      prev.map((c, i) => {
        if (i !== idx) return c;
        const p = productById.get(c.productId);
        if (!p || p.boxQty <= 1) return c;
        if (c.unit === 'base') {
          return { ...c, unit: 'box' as const, qtyBase: p.boxQty };
        }
        return { ...c, unit: 'base' as const };
      })
    );
  };

  const openPrice = (idx: number) => {
    const c = cart[idx];
    const p = productById.get(c.productId);
    if (!p) return;
    if (!p.negotiable) {
      onDone(`${p.name} 不允许改价`);
      return;
    }
    const f = factorOf(p, c.unit);
    setPriceLine(idx);
    setPriceInput(fenToStr(c.unitPriceFen * f));
  };

  const applyPrice = () => {
    if (priceLine === null) return;
    const fen = strToFen(priceInput);
    if (fen === null || fen < 0) {
      onDone('价格填个数字');
      return;
    }
    setCart((prev) =>
      prev.map((c, i) => {
        if (i !== priceLine) return c;
        const p = productById.get(c.productId);
        const f = p ? factorOf(p, c.unit) : 1;
        return { ...c, unitPriceFen: Math.round(fen / f) };
      })
    );
    setPriceLine(null);
  };

  const submit = async (pay: PayMethod) => {
    if (cart.length === 0 || busy) return;
    setBusy(true);
    try {
      await checkout({
        deviceId,
        operator,
        payMethod: pay,
        lines: cart.map((c) => {
          const p = productById.get(c.productId);
          const f = p ? factorOf(p, c.unit) : 1;
          return {
            productId: c.productId,
            qtyBase: c.qtyBase,
            unit: c.unit,
            qty: Math.round(c.qtyBase / f),
            listUnitPriceFen: c.listUnitPriceFen,
            unitPriceFen: c.unitPriceFen
          };
        })
      });
      onDone(`已收 ${fenToStr(totalFen)}（${PAY_LABEL[pay]}）`);
      setCart([]);
      setPayOpen(false);
      setCartOpen(false);
    } catch (e) {
      onDone('保存失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const priceLineProduct = priceLine !== null ? productById.get(cart[priceLine]?.productId ?? '') : undefined;

  return (
    <div className="page-stack">
      <div className="glass-search">
        <Search className="glass-search__icon" size={18} aria-hidden="true" />
        <input
          className="glass-input"
          type="search"
          placeholder="搜商品名"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="chip-row">
        {(['全部', ...CATEGORIES] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={`glass-badge glass-badge--md glass-badge--interactive ${
              cat === c ? 'glass-badge--selected' : ''
            }`}
            aria-pressed={cat === c}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="glass-segmented glass-segmented--full" role="group" aria-label="谁在卖">
        {operators.map((o) => (
          <button
            key={o}
            type="button"
            className="glass-segmented__item"
            aria-pressed={operator === o}
            onClick={() => setOperator(o)}
          >
            {o}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <Empty icon={<Sparkles size={24} />} text="没有匹配的商品，先去「更多 → 商品」里添加" />
      ) : (
        <div className="product-grid">
          {list.map((p) => {
            const stock = inv.get(p.id) ?? 0;
            return (
              <button key={p.id} type="button" className="prod-btn" onClick={() => addProduct(p)}>
                <span className="prod-btn__name">{p.name}</span>
                <span className="prod-btn__price">¥{fenToStr(p.priceList)}</span>
                <span className="prod-btn__meta">
                  /{p.unitBase}
                  {p.boxQty > 1 ? ` · 1箱${p.boxQty}${p.unitBase}` : ''}
                </span>
                <span className={`prod-btn__stock ${stock < 0 ? 'low' : ''}`}>
                  库存 {qtyToStr(stock, p.boxQty, p.unitBase)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {cart.length > 0 ? (
        <div className="checkout-dock checkout-bar">
          <button
            className="checkout-dock__count"
            type="button"
            onClick={() => setCartOpen(true)}
            aria-label="打开购物车"
          >
            <ShoppingCart size={18} aria-hidden="true" />
            {totalQty} 件
            <span className="cart-count">{cart.length}</span>
          </button>
          <div className="checkout-dock__total">
            <div className="k">合计</div>
            <div className="v">¥{fenToStr(totalFen)}</div>
          </div>
          <Btn block={false} onClick={() => setPayOpen(true)}>
            结算
          </Btn>
        </div>
      ) : null}

      {cartOpen ? (
        <Sheet
          title="购物车"
          subtitle={`${totalQty} 件 · ¥${fenToStr(totalFen)}`}
          onClose={() => setCartOpen(false)}
          footer={
            <Btn
              block
              onClick={() => {
                setCartOpen(false);
                setPayOpen(true);
              }}
            >
              去结算 ¥{fenToStr(totalFen)}
            </Btn>
          }
        >
          <div className="stack-sm">
            {cart.map((c, i) => {
              const p = productById.get(c.productId);
              if (!p) return null;
              const f = factorOf(p, c.unit);
              const amount = c.qtyBase * c.unitPriceFen;
              const unitLabel = c.unit === 'box' ? '箱' : p.unitBase;
              return (
                <div key={c.productId} className="cart-line">
                  <div className="row-between">
                    <div className="grow">
                      <div className="cart-line__name">{p.name}</div>
                      <div className="cart-line__meta">
                        ¥{fenToStr(c.unitPriceFen * f)}/{unitLabel}
                        {c.unitPriceFen < c.listUnitPriceFen ? ' · 已改价' : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                        ¥{fenToStr(amount)}
                      </span>
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label="删除"
                        onClick={() => setCart((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        <X size={18} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div className="row-between">
                    {p.boxQty > 1 ? (
                      <div className="glass-segmented" role="group" aria-label="销售单位">
                        <button
                          type="button"
                          className="glass-segmented__item"
                          aria-pressed={c.unit === 'base'}
                          onClick={() => switchUnit(i)}
                        >
                          {p.unitBase}
                        </button>
                        <button
                          type="button"
                          className="glass-segmented__item"
                          aria-pressed={c.unit === 'box'}
                          onClick={() => switchUnit(i)}
                        >
                          箱
                        </button>
                      </div>
                    ) : (
                      <span className="tiny-text">{p.unitBase}</span>
                    )}

                    <div className="stepper">
                      <button type="button" aria-label="减少" onClick={() => changeQty(i, -1)}>
                        <Minus size={18} aria-hidden="true" />
                      </button>
                      <span className="val">{Math.round(c.qtyBase / f)}</span>
                      <button type="button" aria-label="增加" onClick={() => changeQty(i, 1)}>
                        <Plus size={18} aria-hidden="true" />
                      </button>
                    </div>

                    <Btn block={false} variant="tertiary" size="sm" onClick={() => openPrice(i)}>
                      改价
                    </Btn>
                  </div>
                </div>
              );
            })}
          </div>
        </Sheet>
      ) : null}

      {payOpen ? (
        <Sheet
          title={`收款 ¥${fenToStr(totalFen)}`}
          subtitle={`操作人：${operator}`}
          onClose={() => setPayOpen(false)}
        >
          <div className="stack-sm">
            <Btn block variant="secondary" onClick={() => submit('cash')} disabled={busy}>
              <span className="icon-text">
                <Banknote size={20} aria-hidden="true" /> 现金
              </span>
            </Btn>
            <Btn block variant="secondary" onClick={() => submit('wechat')} disabled={busy}>
              <span className="icon-text">
                <QrCode size={20} aria-hidden="true" /> 微信
              </span>
            </Btn>
            <Btn block variant="secondary" onClick={() => submit('alipay')} disabled={busy}>
              <span className="icon-text">
                <Wallet size={20} aria-hidden="true" /> 支付宝
              </span>
            </Btn>
          </div>
        </Sheet>
      ) : null}

      {priceLine !== null ? (
        <Sheet
          title={`改价：${priceLineProduct?.name ?? ''}`}
          onClose={() => setPriceLine(null)}
          footer={
            <Btn block onClick={applyPrice}>
              确定
            </Btn>
          }
        >
          <div className="page-stack">
            <Field
              label={`成交价（元 / ${
                cart[priceLine]?.unit === 'box' ? '箱' : priceLineProduct?.unitBase ?? '个'
              }）`}
            >
              <input
                className="glass-input"
                inputMode="decimal"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                autoFocus
              />
            </Field>
            <p className="tiny-text">
              原价 ¥
              {fenToStr(
                (priceLineProduct?.priceList ?? 0) *
                  (priceLineProduct
                    ? factorOf(priceLineProduct, cart[priceLine]?.unit ?? 'base')
                    : 1)
              )}
              ，改价会记进报表的「让利」。
            </p>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}