import { useMemo, useState } from 'react';
import {
  Search,
  ShoppingCart,
  Plus,
  Minus,
  X,
  Banknote,
  QrCode,
  Wallet,
  Sparkles,
  User,
  RotateCcw
} from 'lucide-react';
import type { PayMethod, Product } from '../../db/types';
import { CATEGORIES, PAY_LABEL } from '../../db/types';
import { checkout, voidOrder } from '../../db/repo';
import { fenToStr, qtyToStr, strToFen } from '../../db/util';
import { Btn, Empty, Field, Sheet, type Done } from '../kit';
import type { CartLine, SellState } from '../sellSession';

export default function SellPage({
  products,
  inv,
  deviceId,
  operators,
  state,
  onChange,
  showSampleNotice,
  onDismissSample,
  onDone
}: {
  products: Product[];
  inv: Map<string, number>;
  deviceId: string;
  operators: string[];
  state: SellState;
  onChange: (patch: Partial<SellState>) => void;
  showSampleNotice: boolean;
  onDismissSample: () => void;
  onDone: Done;
}) {
  const { cart, operator, cat, q } = state;
  const [cartOpen, setCartOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [cashOpen, setCashOpen] = useState(false);
  const [opOpen, setOpOpen] = useState(false);
  const [priceLine, setPriceLine] = useState<number | null>(null);
  const [priceInput, setPriceInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState('');
  const [result, setResult] = useState<{
    orderId: string;
    total: number;
    change: number;
    method: PayMethod;
  } | null>(null);

  const setCart = (next: CartLine[]) => onChange({ cart: next });

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
    const found = cart.find((c) => c.productId === p.id);
    if (found) {
      setCart(
        cart.map((c) =>
          c.productId === p.id ? { ...c, qtyBase: c.qtyBase + factorOf(p, c.unit) } : c
        )
      );
      return;
    }
    setCart([
      ...cart,
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
    setCart(
      cart.map((c, i) => {
        if (i !== idx) return c;
        const p = productById.get(c.productId);
        const f = p ? factorOf(p, c.unit) : 1;
        const next = c.qtyBase + delta * f;
        return { ...c, qtyBase: next < f ? f : next };
      })
    );
  };

  const switchUnit = (idx: number) => {
    setCart(
      cart.map((c, i) => {
        if (i !== idx) return c;
        const p = productById.get(c.productId);
        if (!p || p.boxQty <= 1) return c;
        if (c.unit === 'base') {
          // 记下切换前的数量，切回来能恢复；转箱按整箱取整
          const boxes = Math.max(1, Math.floor(c.qtyBase / p.boxQty));
          return { ...c, unit: 'box' as const, baseBefore: c.qtyBase, qtyBase: boxes * p.boxQty };
        }
        return {
          ...c,
          unit: 'base' as const,
          qtyBase: c.baseBefore ?? c.qtyBase
        };
      })
    );
  };

  const openPrice = (idx: number) => {
    const c = cart[idx];
    const p = productById.get(c.productId);
    if (!p) return;
    if (!p.negotiable) {
      onDone(`${p.name} 不允许改价`, 'warning');
      return;
    }
    const f = factorOf(p, c.unit);
    setPriceLine(idx);
    setPriceInput(fenToStr(c.unitPriceFen * f));
  };

  const priceFenNow = (() => {
    if (priceLine === null) return null;
    return strToFen(priceInput);
  })();

  const applyPrice = () => {
    if (priceLine === null) return;
    const fen = strToFen(priceInput);
    if (fen === null || fen < 0) {
      onDone('价格填个数字，比如 20 或 19.5', 'error');
      return;
    }
    setCart(
      cart.map((c, i) => {
        if (i !== priceLine) return c;
        const p = productById.get(c.productId);
        const f = p ? factorOf(p, c.unit) : 1;
        return { ...c, unitPriceFen: Math.round(fen / f) };
      })
    );
    setPriceLine(null);
  };

  const submit = async (pay: PayMethod, cashReceived?: number) => {
    if (cart.length === 0 || busy) return;
    setBusy(true);
    try {
      const order = await checkout({
        deviceId,
        operator: operator || operators[0] || '我',
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
      const change = pay === 'cash' && cashReceived ? cashReceived - order.totalFen : 0;
      onDone(`已收 ${fenToStr(order.totalFen)}（${PAY_LABEL[pay]}）${change > 0 ? `，找零 ${fenToStr(change)}` : ''}`);
      setResult({ orderId: order.id, total: order.totalFen, change, method: pay });
      setCart([]);
      setPayOpen(false);
      setCashOpen(false);
      setCartOpen(false);
      setReceived('');
    } catch (e) {
      onDone('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const priceLineProduct =
    priceLine !== null ? productById.get(cart[priceLine]?.productId ?? '') : undefined;
  const priceLineCart = priceLine !== null ? cart[priceLine] : undefined;
  const priceFactor = priceLineProduct && priceLineCart
    ? factorOf(priceLineProduct, priceLineCart.unit)
    : 1;
  const newLineTotal =
    priceLineCart && priceFenNow !== null
      ? Math.round((priceFenNow / priceFactor) * priceLineCart.qtyBase)
      : 0;
  const listLineTotal = priceLineCart
    ? priceLineCart.qtyBase * priceLineCart.listUnitPriceFen
    : 0;
  const giving = Math.max(0, listLineTotal - newLineTotal);

  const cashReceivedFen = strToFen(received);
  const changeFen =
    cashReceivedFen !== null && cashReceivedFen >= totalFen ? cashReceivedFen - totalFen : null;

  return (
    <div className="page-stack">
      {showSampleNotice ? (
        <div className="first-run-card first-run-card--sample">
          <div>
            <div className="first-run-card__title">这些是示例商品</div>
            <div className="tiny-text">库存 0 也能卖；去「更多 → 商品管理」改成自己的货</div>
          </div>
          <Btn block={false} size="sm" variant="secondary" onClick={onDismissSample}>
            知道了
          </Btn>
        </div>
      ) : null}

      <div className="row-between" style={{ gap: 8 }}>
        <div className="glass-search grow">
          <Search className="glass-search__icon" size={18} aria-hidden="true" />
          <input
            className="glass-input"
            type="search"
            placeholder="搜商品名"
            aria-label="搜商品名"
            value={q}
            onChange={(e) => onChange({ q: e.target.value })}
          />
        </div>
        <button type="button" className="glass-pill op-pill" onClick={() => setOpOpen(true)} aria-label={`操作人：${operator || operators[0]}`}>
          <User size={16} aria-hidden="true" />
          <span>{operator || operators[0]}</span>
        </button>
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
            onClick={() => onChange({ cat: c })}
          >
            {c}
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
            aria-label={`打开购物车，${cart.length} 种商品`}
          >
            <ShoppingCart size={18} aria-hidden="true" />
            {totalQty} 件
            <span className="cart-count">{cart.length}</span>
          </button>
          <div className="checkout-dock__total" aria-live="polite">
            <div className="k">合计</div>
            <div className="v">¥{fenToStr(totalFen)}</div>
          </div>
          <Btn block={false} onClick={() => setPayOpen(true)}>
            结算
          </Btn>
        </div>
      ) : null}

      {opOpen ? (
        <Sheet title="谁在卖" subtitle="按设备记住，之后不用每次选" onClose={() => setOpOpen(false)}>
          <div className="stack-sm">
            {operators.map((op) => (
              <Btn
                key={op}
                block
                variant={op === operator ? 'primary' : 'secondary'}
                onClick={async () => {
                  onChange({ operator: op });
                  setOpOpen(false);
                }}
              >
                {op}
              </Btn>
            ))}
          </div>
        </Sheet>
      ) : null}

      {cartOpen ? (
        <Sheet
          title="购物车"
          subtitle={`${totalQty} 件 · ¥${fenToStr(totalFen)}`}
          onClose={() => setCartOpen(false)}
          footer={
            <div className="row" style={{ gap: 8 }}>
              <Btn
                block={false}
                variant="secondary"
                style={{ flex: 1 }}
                onClick={() => {
                  setCartOpen(false);
                  setPayOpen(true);
                }}
              >
                去结算 ¥{fenToStr(totalFen)}
              </Btn>
            </div>
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
                      <span style={{ fontWeight: 'var(--yh-weight-semibold)', fontVariantNumeric: 'tabular-nums' }}>
                        ¥{fenToStr(amount)}
                      </span>
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={`删除 ${p.name}`}
                        onClick={() => setCart(cart.filter((_, idx) => idx !== i))}
                      >
                        <X size={18} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div className="cart-line__controls">
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
          subtitle={`操作人：${operator || operators[0]}`}
          onClose={() => setPayOpen(false)}
        >
          <div className="stack-sm">
            <div className="pay-recap">
              {cart.map((c) => {
                const p = productById.get(c.productId);
                if (!p) return null;
                const f = factorOf(p, c.unit);
                return (
                  <div key={c.productId} className="pay-recap__line">
                    <span>
                      {p.name} × {Math.round(c.qtyBase / f)}
                      {c.unit === 'box' ? ' 箱' : p.unitBase}
                    </span>
                    <span>¥{fenToStr(c.qtyBase * c.unitPriceFen)}</span>
                  </div>
                );
              })}
              <div className="pay-recap__line pay-recap__line--total">
                <span>合计</span>
                <span>¥{fenToStr(totalFen)}</span>
              </div>
            </div>
            <Btn block variant="secondary" onClick={() => { setPayOpen(false); setCashOpen(true); setReceived(''); }} disabled={busy}>
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

      {cashOpen ? (
        <Sheet
          title="现金收款"
          subtitle={`应收 ¥${fenToStr(totalFen)}`}
          onClose={() => setCashOpen(false)}
          footer={
            <Btn
              block
              disabled={changeFen === null || busy}
              onClick={() => submit('cash', cashReceivedFen ?? undefined)}
            >
              {changeFen === null ? '实收不足' : `确认收款 ¥${fenToStr(cashReceivedFen ?? 0)}`}
            </Btn>
          }
        >
          <div className="page-stack">
            <Field label="实收（元）" hint="顾客给了多少">
              <input
                className="glass-input"
                inputMode="decimal"
                value={received}
                onChange={(e) => setReceived(e.target.value)}
                placeholder={fenToStr(totalFen)}
                autoFocus
              />
            </Field>
            <div className="chip-row">
              <button type="button" className="glass-badge glass-badge--md glass-badge--interactive" onClick={() => setReceived(fenToStr(totalFen))}>
                正好 ¥{fenToStr(totalFen)}
              </button>
              {[5000, 10000, 20000]
                .filter((v) => v >= totalFen)
                .map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="glass-badge glass-badge--md glass-badge--interactive"
                    onClick={() => setReceived(fenToStr(v))}
                  >
                    ¥{fenToStr(v)}
                  </button>
                ))}
            </div>
            <div className={`cash-change ${changeFen === null ? 'is-missing' : ''}`} aria-live="polite">
              <span className="k">找零</span>
              <span className="v">{changeFen === null ? '—' : `¥${fenToStr(changeFen)}`}</span>
            </div>
          </div>
        </Sheet>
      ) : null}

      {result ? (
        <Sheet
          title="收款完成"
          subtitle={`${PAY_LABEL[result.method]} · ¥${fenToStr(result.total)}`}
          onClose={() => setResult(null)}
          footer={
            <div className="row" style={{ gap: 8 }}>
              <Btn block={false} variant="secondary" style={{ flex: 1 }} onClick={() => setResult(null)}>
                完成
              </Btn>
              <Btn
                block={false}
                variant="tertiary"
                style={{ flex: 1 }}
                onClick={async () => {
                  await voidOrder(result.orderId);
                  setResult(null);
                  onDone('已撤销这一单', 'warning');
                }}
              >
                <span className="icon-text">
                  <RotateCcw size={16} aria-hidden="true" /> 撤销
                </span>
              </Btn>
            </div>
          }
        >
          <div className="page-stack">
            <div className="result-big">¥{fenToStr(result.total)}</div>
            {result.change > 0 ? (
              <div className="cash-change">
                <span className="k">找零</span>
                <span className="v">¥{fenToStr(result.change)}</span>
              </div>
            ) : null}
            <p className="tiny-text" style={{ margin: 0 }}>
              已记入今日报表。撤销会把这单作废并把库存加回来。
            </p>
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
              label={`成交价（元 / ${priceLineCart?.unit === 'box' ? '箱' : priceLineProduct?.unitBase ?? '个'}）`}
              error={priceFenNow === null && priceInput.trim() !== '' ? '填个数字，比如 20 或 19.5' : undefined}
            >
              <input
                className="glass-input"
                inputMode="decimal"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                autoFocus
              />
            </Field>
            <div className="price-preview">
              <div className="row-between">
                <span className="tiny-text">原价</span>
                <span>¥{fenToStr(listLineTotal)}</span>
              </div>
              <div className="row-between">
                <span className="tiny-text">改后</span>
                <span style={{ fontWeight: 'var(--yh-weight-semibold)' }}>¥{fenToStr(newLineTotal)}</span>
              </div>
              <div className="row-between">
                <span className="tiny-text">让利</span>
                <span style={{ color: giving > 0 ? 'var(--yh-bad-ink)' : undefined }}>
                  ¥{fenToStr(giving)}
                </span>
              </div>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}