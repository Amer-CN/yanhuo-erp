import { useMemo, useState } from 'react';
import type { Product, SaleLine, SalesOrder } from '../../db/types';
import { PAY_LABEL } from '../../db/types';
import { restoreOrder, voidOrder } from '../../db/repo';
import { fenToStr, isoToLocalDate, isoToTime, qtyToStr } from '../../db/util';
import { Btn, Card, Empty, Sheet } from '../kit';

export default function HistoryPage({
  products,
  orders,
  lines,
  onDone
}: {
  products: Product[];
  orders: SalesOrder[];
  lines: SaleLine[];
  onDone: (msg: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

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
    <div className="page">
      {grouped.length === 0 ? (
        <Empty icon="🧾" text="还没有销售记录" />
      ) : (
        grouped.map(([day, list]) => {
          const total = list.filter((o) => !o.voided).reduce((s, o) => s + o.totalFen, 0);
          return (
            <Card key={day} flush>
              <div className="list-item" style={{ background: '#fffaf4', cursor: 'default' }}>
                <div className="main">
                  <div className="t1">{day}</div>
                  <div className="t2">
                    {list.length} 单 · 合计 ¥{fenToStr(total)}
                  </div>
                </div>
              </div>
              <div className="list">
                {list.map((o) => {
                  const n = lines.filter((l) => l.orderId === o.id).length;
                  return (
                    <div key={o.id} className="list-item" onClick={() => setOpenId(o.id)}>
                      <div className="main">
                        <div className="t1">
                          {isoToTime(o.createdAt)} · {o.operator}
                          <span className={`badge ${o.payMethod === 'cash' ? '' : 'ok'}`}>
                            {PAY_LABEL[o.payMethod]}
                          </span>
                          {o.voided ? <span className="badge bad">已作废</span> : null}
                        </div>
                        <div className="t2">{n} 个商品</div>
                      </div>
                      <div
                        className="amount"
                        style={{ textDecoration: o.voided ? 'line-through' : undefined }}
                      >
                        ¥{fenToStr(o.totalFen)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })
      )}

      {open ? (
        <Sheet
          title={`${isoToLocalDate(open.createdAt)} ${isoToTime(open.createdAt)} · ${open.operator}`}
          onClose={() => setOpenId(null)}
          footer={
            open.voided ? (
              <Btn
                block
                variant="ghost"
                onClick={async () => {
                  await restoreOrder(open.id);
                  onDone('已恢复');
                  setOpenId(null);
                }}
              >
                撤销作废
              </Btn>
            ) : (
              <Btn
                block
                variant="danger"
                onClick={async () => {
                  if (!confirm('整单作废？作废后不计入报表（库存会加回来）。')) return;
                  await voidOrder(open.id);
                  onDone('已作废');
                  setOpenId(null);
                }}
              >
                整单作废
              </Btn>
            )
          }
        >
          <div className="col">
            <div className="row between muted">
              <span>收款方式</span>
              <span>{PAY_LABEL[open.payMethod]}</span>
            </div>
            <div className="divider" />
            {openLines.map((l) => {
              const p = productById.get(l.productId);
              return (
                <div key={l.id} className="row between">
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{p?.name ?? '(已删)'}</div>
                    <div className="tiny">
                      {qtyToStr(l.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')} × ¥
                      {fenToStr(l.unitPriceFen)}
                      {l.discountFen > 0 ? ` · 让利 ¥${fenToStr(l.discountFen)}` : ''}
                    </div>
                  </div>
                  <div className="amount">¥{fenToStr(l.amountFen)}</div>
                </div>
              );
            })}
            <div className="divider" />
            <div className="row between">
              <span style={{ fontWeight: 700 }}>合计</span>
              <span className="amount big">¥{fenToStr(open.totalFen)}</span>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}