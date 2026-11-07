import { useMemo, useState } from 'react';
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

  const factorOf = (p: Product, unit: 'box' | 'base') => (unit === 'box' && p.boxQty > 1 ? p.boxQty : 1);

  const addProduct = (p: Product) => {
    if (cart.some((c) => c.productId === p.id)) {
      setCart((prev) =>
        prev.map((c) =>
          c.productId === p.id
            ? { ...c, qtyBase: c.qtyBase + factorOf(p, c.unit) }
            : c
        )
      );
      return;
    }
    setCart((prev) => [
      ...prev,
      {
        productId: p.id,
        unit: 'base',
        qtyBase: 1,
        listUnitPriceFen: p.priceList,
        unitPriceFen: p.priceList
      }
    ]);
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
          // 换成箱：至少 1 箱
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
    <div className="page" style={{ paddingBottom: cart.length ? '150px' : undefined }}>
      <div className="search">
        <input
          className="input"
          placeholder="搜商品名"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="chips">
        {(['全部', ...CATEGORIES] as const).map((c) => (
          <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>

      <div className="row between">
        <span className="tiny">谁在卖：</span>
        <div className="seg">
          {operators.map((o) => (
            <button key={o} className={operator === o ? 'on' : ''} onClick={() => setOperator(o)}>
              {o}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <Card2Empty />
      ) : (
        <div className="grid">
          {list.map((p) => {
            const stock = inv.get(p.id) ?? 0;
            return (
              <button key={p.id} className="prod-btn" onClick={() => addProduct(p)}>
                <span className="name">{p.name}</span>
                <span className="price">¥{fenToStr(p.priceList)}</span>
                <span className="meta">
                  /{p.unitBase}
                  {p.boxQty > 1 ? ` · 1箱${p.boxQty}${p.unitBase}` : ''}
                </span>
                <span className={`stock ${stock < 0 ? 'low' : ''}`}>
                  库存 {qtyToStr(stock, p.boxQty, p.unitBase)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {cart.length > 0 ? (
        <div className="checkout-bar">
          <button
            className="btn ghost"
            style={{ position: 'relative', paddingRight: 16 }}
            onClick={() => setCartOpen(true)}
          >
            🧺 {totalQty} 件
            <span className="cart-count">{cart.length}</span>
          </button>
          <div className="grow" />
          <div style={{ textAlign: 'right', lineHeight: 1.15 }}>
            <div className="tiny">合计</div>
            <div className="amount" style={{ fontSize: 20, color: 'var(--brand-dark)' }}>
              ¥{fenToStr(totalFen)}
            </div>
          </div>
          <Btn size="lg" onClick={() => setPayOpen(true)}>
            结算
          </Btn>
        </div>
      ) : null}

      {cartOpen ? (
        <Sheet
          title="购物车"
          onClose={() => setCartOpen(false)}
          footer={
            <Btn block size="lg" onClick={() => setPayOpen(true)}>
              去结算 ¥{fenToStr(totalFen)}
            </Btn>
          }
        >
          <div className="col">
            {cart.map((c, i) => {
              const p = productById.get(c.productId);
              if (!p) return null;
              const f = factorOf(p, c.unit);
              const amount = c.qtyBase * c.unitPriceFen;
              const unitLabel = c.unit === 'box' ? '箱' : p.unitBase;
              return (
                <div key={c.productId} className="card" style={{ padding: 12 }}>
                  <div className="row between">
                    <div className="grow">
                      <div style={{ fontWeight: 700 }}>{p.name}</div>
                      <div className="tiny">
                        ¥{fenToStr(c.unitPriceFen * f)}/{unitLabel}
                        {c.unitPriceFen < c.listUnitPriceFen ? ' · 已改价' : ''}
                      </div>
                    </div>
                    <button
                      className="btn danger sm"
                      onClick={() => setCart((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      删
                    </button>
                  </div>
                  <div className="row between" style={{ marginTop: 10 }}>
                    {p.boxQty > 1 ? (
                      <div className="seg">
                        <button className={c.unit === 'base' ? 'on' : ''} onClick={() => switchUnit(i)}>
                          {p.unitBase}
                        </button>
                        <button className={c.unit === 'box' ? 'on' : ''} onClick={() => switchUnit(i)}>
                          箱
                        </button>
                      </div>
                    ) : (
                      <span className="tiny">{p.unitBase}</span>
                    )}
                    <div className="stepper">
                      <button onClick={() => changeQty(i, -1)}>−</button>
                      <span className="val">{Math.round(c.qtyBase / f)}</span>
                      <button onClick={() => changeQty(i, 1)}>＋</button>
                    </div>
                    <button className="btn soft sm" onClick={() => openPrice(i)}>
                      改价
                    </button>
                    <div style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                      ¥{fenToStr(amount)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Sheet>
      ) : null}

      {payOpen ? (
        <Sheet title={`收款 ¥${fenToStr(totalFen)}`} onClose={() => setPayOpen(false)}>
          <div className="col">
            <div className="muted">操作人：{operator}</div>
            <Btn block size="lg" onClick={() => submit('cash')} disabled={busy}>
              💵 现金
            </Btn>
            <Btn block size="lg" variant="soft" onClick={() => submit('wechat')} disabled={busy}>
              💚 微信
            </Btn>
            <Btn block size="lg" variant="soft" onClick={() => submit('alipay')} disabled={busy}>
              💙 支付宝
            </Btn>
          </div>
        </Sheet>
      ) : null}

      {priceLine !== null ? (
        <Sheet
          title={`改价：${priceLineProduct?.name ?? ''}`}
          onClose={() => setPriceLine(null)}
          footer={
            <Btn block size="lg" onClick={applyPrice}>
              确定
            </Btn>
          }
        >
          <Field label={`成交价（元 / ${cart[priceLine]?.unit === 'box' ? '箱' : priceLineProduct?.unitBase ?? '个'}）`}>
            <input
              className="input num"
              inputMode="decimal"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="tiny" style={{ marginTop: 8 }}>
            原价 ¥
            {fenToStr(
              (priceLineProduct?.priceList ?? 0) *
                (priceLineProduct ? factorOf(priceLineProduct, cart[priceLine]?.unit ?? 'base') : 1)
            )}
            ，改价会记进报表的「让利」。
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

function Card2Empty() {
  return <Empty icon="🧨" text="没有匹配的商品，先去「更多 → 商品」里添加" />;
}