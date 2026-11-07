import { useMemo, useState } from 'react';
import type { Batch, Product } from '../../db/types';
import type { FifoResult } from '../../db/calc';
import { batchStock } from '../../db/calc';
import { createAdjustment } from '../../db/repo';
import { fenToStr, localDate, qtyToStr } from '../../db/util';
import { Btn, Card, Empty, Field, Sheet, Stat } from '../kit';

export default function StockPage({
  products,
  batches,
  inv,
  fifo,
  deviceId,
  onDone
}: {
  products: Product[];
  batches: Batch[];
  inv: Map<string, number>;
  fifo: FifoResult;
  deviceId: string;
  onDone: (msg: string) => void;
}) {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adjust, setAdjust] = useState('');
  const [reason, setReason] = useState('');

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return products
      .filter((p) => !p.archived)
      .filter((p) => (kw ? p.name.toLowerCase().includes(kw) : true))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh'));
  }, [products, q]);

  const { totalQty, totalValue } = useMemo(() => {
    let qty = 0;
    let value = 0;
    for (const p of products) qty += Math.max(0, inv.get(p.id) ?? 0);
    for (const b of batches) {
      const remain = fifo.batchRemaining.get(b.id) ?? 0;
      if (remain > 0) value += remain * b.unitCostFen;
    }
    return { totalQty: qty, totalValue: value };
  }, [products, batches, inv, fifo]);

  const open = products.find((p) => p.id === openId);

  const submitAdjust = async () => {
    if (!open) return;
    const n = Number(adjust);
    if (!Number.isFinite(n) || n === 0) {
      onDone('填个非 0 的数（负数=少了，正数=多了）');
      return;
    }
    await createAdjustment(
      {
        productId: open.id,
        qtyBase: Math.round(n),
        type: n < 0 ? 'loss' : 'correction',
        reason: reason || undefined
      },
      deviceId
    );
    onDone('已修正库存');
    setAdjust('');
    setReason('');
    setOpenId(null);
  };

  return (
    <div className="page">
      <div className="stat-grid">
        <Stat k="库存总件数" v={totalQty} />
        <Stat k="库存成本" v={<span className="brand">¥{fenToStr(totalValue)}</span>} />
      </div>

      <div className="search">
        <input
          className="input"
          placeholder="搜商品"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {list.length === 0 ? (
        <Empty icon="📦" text="还没有商品" />
      ) : (
        <Card flush>
          <div className="list">
            {list.map((p) => {
              const stock = inv.get(p.id) ?? 0;
              return (
                <div key={p.id} className="list-item" onClick={() => setOpenId(p.id)}>
                  <div className="main">
                    <div className="t1">
                      {p.name}
                      {p.boxQty > 1 ? <span className="badge">1箱={p.boxQty}{p.unitBase}</span> : null}
                    </div>
                    <div className="t2">
                      库存 {qtyToStr(stock, p.boxQty, p.unitBase)}
                    </div>
                  </div>
                  {stock < 0 ? <span className="badge bad">负库存</span> : null}
                  {stock === 0 ? <span className="badge warn">0</span> : null}
                  <span className="tiny">›</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {open ? (
        <Sheet
          title={open.name}
          onClose={() => setOpenId(null)}
          footer={
            <Btn block variant="ghost" onClick={() => setOpenId(null)}>
              关闭
            </Btn>
          }
        >
          <div className="col">
            <div className="row between">
              <span className="muted">当前库存</span>
              <span className="amount">
                {qtyToStr(inv.get(open.id) ?? 0, open.boxQty, open.unitBase)}
              </span>
            </div>

            <div className="divider" />
            <div className="card-head">
              <h2>批次明细</h2>
            </div>
            {batchStock(batches, open.id, fifo).length === 0 ? (
              <Empty icon="🧾" text="还没录进货" />
            ) : (
              <div className="col">
                {batchStock(batches, open.id, fifo).map(({ batch, remaining }) => {
                  const days = batch.expiryDate
                    ? Math.round(
                        (new Date(`${batch.expiryDate}T00:00:00`).getTime() -
                          new Date(`${localDate()}T00:00:00`).getTime()) /
                          86400000
                      )
                    : null;
                  return (
                    <div key={batch.id} className="card" style={{ padding: 10 }}>
                      <div className="row between">
                        <div>
                          <div style={{ fontWeight: 700 }}>
                            {batch.batchNo ? `批号 ${batch.batchNo}` : '（无批号）'}
                          </div>
                          <div className="tiny">
                            到货 {batch.receivedAt} · 进价 ¥{fenToStr(batch.unitCostFen)}/{open.unitBase}
                          </div>
                          {batch.expiryDate ? (
                            <div className={`tiny ${days !== null && days <= 30 ? 'badge bad' : ''}`}>
                              有效期至 {batch.expiryDate}
                              {days !== null ? `（${days < 0 ? '已过期' : `剩 ${days} 天`}）` : ''}
                            </div>
                          ) : null}
                        </div>
                        <div className="amount">剩 {qtyToStr(remaining, open.boxQty, open.unitBase)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="divider" />
            <div className="card-head">
              <h2>修正库存（盘亏/盘盈）</h2>
            </div>
            <div className="tiny">盘点发现对不上时用：负数=少了，正数=多了，单位是{open.unitBase}。</div>
            <Field label={`调整数量（${open.unitBase}）`}>
              <input
                className="input num"
                inputMode="numeric"
                value={adjust}
                onChange={(e) => setAdjust(e.target.value)}
                placeholder="-2"
              />
            </Field>
            <Field label="原因（可空）">
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="摔坏 / 数错"
              />
            </Field>
            <Btn block onClick={submitAdjust} variant="soft">
              记一笔调整
            </Btn>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

