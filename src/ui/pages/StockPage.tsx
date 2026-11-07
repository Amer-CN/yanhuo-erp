import { useMemo, useState } from 'react';
import { Search, Boxes, TriangleAlert, ChevronRight } from 'lucide-react';
import type { Batch, Product } from '../../db/types';
import type { FifoResult } from '../../db/calc';
import { batchStock } from '../../db/calc';
import { createAdjustment } from '../../db/repo';
import { fenToStr, localDate, qtyToStr } from '../../db/util';
import { Btn, Empty, Field, Sheet, Stat } from '../kit';

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
    <div className="page-stack">
      <div className="stat-grid">
        <Stat k="库存总件数" v={totalQty} />
        <Stat k="库存成本" v={<span>¥{fenToStr(totalValue)}</span>} tone="brand" />
      </div>

      <div className="glass-search">
        <Search className="glass-search__icon" size={18} aria-hidden="true" />
        <input
          className="glass-input"
          type="search"
          placeholder="搜商品"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {list.length === 0 ? (
        <Empty icon={<Boxes size={24} />} text="还没有商品" />
      ) : (
        <ul className="glass-list">
          {list.map((p) => {
            const stock = inv.get(p.id) ?? 0;
            return (
              <li
                key={p.id}
                className="glass-list__item glass-list__item--interactive list-item"
                role="button"
                tabIndex={0}
                onClick={() => setOpenId(p.id)}
              >
                <span className="glass-list__leading">
                  {stock < 0 ? (
                    <TriangleAlert size={22} aria-hidden="true" style={{ color: 'var(--gl-color-error)' }} />
                  ) : (
                    <Boxes size={22} aria-hidden="true" />
                  )}
                </span>
                <div className="glass-list__content">
                  <div className="glass-list__title-row">
                    <div className="glass-list__title">{p.name}</div>
                    {p.boxQty > 1 ? (
                      <span className="glass-badge">
                        1箱={p.boxQty}
                        {p.unitBase}
                      </span>
                    ) : null}
                  </div>
                  <div className="glass-list__subtitle">
                    库存 {qtyToStr(stock, p.boxQty, p.unitBase)}
                  </div>
                </div>
                <div className="glass-list__trailing">
                  {stock < 0 ? <span className="glass-badge glass-badge--error">负库存</span> : null}
                  <ChevronRight size={18} aria-hidden="true" />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {open ? (
        <Sheet title={open.name} onClose={() => setOpenId(null)}>
          <div className="page-stack">
            <div className="row-between">
              <span className="muted-text">当前库存</span>
              <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {qtyToStr(inv.get(open.id) ?? 0, open.boxQty, open.unitBase)}
              </span>
            </div>

            <div>
              <h2 className="section-title" style={{ marginBottom: 8 }}>
                批次明细
              </h2>
              {batchStock(batches, open.id, fifo).length === 0 ? (
                <Empty icon={<Boxes size={24} />} text="还没录进货" />
              ) : (
                <div className="stack-sm">
                  {batchStock(batches, open.id, fifo).map(({ batch, remaining }) => {
                    const days = batch.expiryDate
                      ? Math.round(
                          (new Date(`${batch.expiryDate}T00:00:00`).getTime() -
                            new Date(`${localDate()}T00:00:00`).getTime()) /
                            86400000
                        )
                      : null;
                    return (
                      <div key={batch.id} className="mini-card">
                        <div className="row-between">
                          <div>
                            <div className="cart-line__name">
                              {batch.batchNo ? `批号 ${batch.batchNo}` : '（无批号）'}
                            </div>
                            <div className="cart-line__meta">
                              到货 {batch.receivedAt} · 进价 ¥{fenToStr(batch.unitCostFen)}/{open.unitBase}
                            </div>
                            {batch.expiryDate ? (
                              <div className="cart-line__meta">
                                有效期至 {batch.expiryDate}
                                {days !== null
                                  ? `（${days < 0 ? '已过期' : `剩 ${days} 天`}）`
                                  : ''}
                                {days !== null && days <= 30 ? (
                                  <span className="glass-badge glass-badge--error" style={{ marginLeft: 6 }}>
                                    临期
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          <div style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                            剩 {qtyToStr(remaining, open.boxQty, open.unitBase)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <h2 className="section-title" style={{ marginBottom: 8 }}>
                修正库存（盘亏/盘盈）
              </h2>
              <p className="tiny-text" style={{ marginTop: 0 }}>
                盘点发现对不上时用：负数=少了，正数=多了，单位是{open.unitBase}。
              </p>
              <div className="page-stack">
                <Field label={`调整数量（${open.unitBase}）`}>
                  <input
                    className="glass-input"
                    inputMode="numeric"
                    value={adjust}
                    onChange={(e) => setAdjust(e.target.value)}
                    placeholder="-2"
                  />
                </Field>
                <Field label="原因（可空）">
                  <input
                    className="glass-input"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="摔坏 / 数错"
                  />
                </Field>
                <Btn block variant="secondary" onClick={submitAdjust}>
                  记一笔调整
                </Btn>
              </div>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
