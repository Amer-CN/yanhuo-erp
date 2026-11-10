import { useMemo, useState } from 'react';
import { Receipt, RotateCcw, Ban } from 'lucide-react';
import type { Product, SaleLine, SalesOrder } from '../../db/types';
import { PAY_LABEL } from '../../db/types';
import { restoreOrder, voidOrder } from '../../db/repo';
import { DELETED_PRODUCT, fenToStr, isoToLocalDate, isoToTime, qtyToStr } from '../../db/util';
import { Btn, ConfirmSheet, Empty, Sheet, rowProps, type Done } from '../kit';

export default function HistoryPage({
  products,
  orders,
  lines,
  onDone
}: {
  products: Product[];
  orders: SalesOrder[];
  lines: SaleLine[];
  onDone: Done;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [voidConfirm, setVoidConfirm] = useState(false);

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const sorted = useMemo(
    () => [...orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [orders]
  );

  const grouped = useMemo(() => {
    const m = new Map<string, SalesOrder[]>();
    for (const o of sorted) {
      const d = isoToLocalDate(o.createdAt);
      const arr = m.get(d) ?? [];
      arr.push(o);
      m.set(d, arr);
    }
    return [...m.entries()];
  }, [sorted]);

  const open = openId ? orders.find((o) => o.id === openId) : undefined;
  const openLines = open ? lines.filter((l) => l.orderId === open.id) : [];

  return (
    <div className="page-stack">
      {grouped.length === 0 ? (
        <Empty icon={<Receipt size={24} />} text="还没有销售记录" />
      ) : (
        grouped.map(([day, list]) => {
          const total = list.filter((o) => !o.voided).reduce((s, o) => s + o.totalFen, 0);
          return (
            <div key={day}>
              <div className="day-header">
                <span>{day}</span>
                <span className="sub">
                  {list.length} 单 · 合计 ¥{fenToStr(total)}
                </span>
              </div>
              <ul className="glass-list">
                {list.map((o) => {
                  const n = lines.filter((l) => l.orderId === o.id).length;
                  return (
                    <li
                      key={o.id}
                      className="glass-list__item glass-list__item--interactive list-item"
                      {...rowProps(() => setOpenId(o.id))}
                    >
                      <span className="glass-list__leading">
                        <Receipt size={22} aria-hidden="true" />
                      </span>
                      <div className="glass-list__content">
                        <div className="glass-list__title-row">
                          <div className="glass-list__title">
                            {isoToTime(o.createdAt)} · {o.operator}
                          </div>
                          <span
                            className={`glass-badge ${
                              o.payMethod === 'cash' ? '' : 'glass-badge--primary'
                            }`}
                          >
                            {PAY_LABEL[o.payMethod]}
                          </span>
                          {o.voided ? (
                            <span className="glass-badge glass-badge--error">已作废</span>
                          ) : null}
                        </div>
                        <div className="glass-list__subtitle">{n} 个商品</div>
                      </div>
                      <div className="glass-list__trailing">
                        <span
                          style={{
                            fontWeight: 'var(--yh-weight-semibold)',
                            fontVariantNumeric: 'tabular-nums',
                            textDecoration: o.voided ? 'line-through' : undefined
                          }}
                        >
                          ¥{fenToStr(o.totalFen)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}

      {open ? (
        <Sheet
          title={`${isoToLocalDate(open.createdAt)} ${isoToTime(open.createdAt)}`}
          subtitle={`${open.operator} · ${PAY_LABEL[open.payMethod]}${open.voided ? ' · 已作废' : ''}`}
          onClose={() => setOpenId(null)}
          footer={
            open.voided ? (
              <Btn
                block
                variant="secondary"
                onClick={async () => {
                  await restoreOrder(open.id);
                  onDone('已恢复');
                  setOpenId(null);
                }}
              >
                <span className="icon-text">
                  <RotateCcw size={18} aria-hidden="true" /> 撤销作废
                </span>
              </Btn>
            ) : (
              <Btn
                block
                variant="danger"
                onClick={() => setVoidConfirm(true)}
              >
                <span className="icon-text">
                  <Ban size={18} aria-hidden="true" /> 整单作废
                </span>
              </Btn>
            )
          }
        >
          <div className="page-stack">
            {openLines.map((l) => {
              const p = productById.get(l.productId);
              return (
                <div key={l.id} className="mini-card">
                  <div className="row-between">
                    <div className="grow">
                      <div className="cart-line__name">{p?.name ?? DELETED_PRODUCT}</div>
                      <div className="cart-line__meta">
                        {qtyToStr(l.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')} × ¥
                        {fenToStr(l.unitPriceFen)}
                        {l.discountFen > 0 ? ` · 让利 ¥${fenToStr(l.discountFen)}` : ''}
                      </div>
                    </div>
                    <div style={{ fontWeight: 'var(--yh-weight-semibold)', fontVariantNumeric: 'tabular-nums' }}>
                      ¥{fenToStr(l.amountFen)}
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="row-between" style={{ padding: '4px 2px' }}>
              <span style={{ fontWeight: 'var(--yh-weight-semibold)' }}>合计</span>
              <span
                style={{
                  fontWeight: 'var(--yh-weight-semibold)',
                  fontSize: 'var(--yh-text-2xl)',
                  color: 'var(--gl-color-primary)',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                ¥{fenToStr(open.totalFen)}
              </span>
            </div>
          </div>
        </Sheet>
      ) : null}

      {voidConfirm ? (
        <ConfirmSheet
          title="整单作废？"
          description="作废后不计入报表（库存会加回来）。"
          confirmText="整单作废"
          danger
          onConfirm={async () => {
            setVoidConfirm(false);
            if (!open) return;
            await voidOrder(open.id);
            onDone('已作废');
            setOpenId(null);
          }}
          onCancel={() => setVoidConfirm(false)}
        />
      ) : null}
    </div>
  );
}