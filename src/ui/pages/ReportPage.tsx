import { useMemo, useState } from 'react';
import type { Batch, Product, SaleLine, SalesOrder } from '../../db/types';
import type { FifoResult } from '../../db/calc';
import { dayReport, expiryWarnings, productMargins, rangeReport } from '../../db/calc';
import { fenToStr, localDate, qtyToStr } from '../../db/util';
import { Card, Empty, Stat } from '../kit';

const ALL_FROM = '0000-01-01';
const ALL_TO = '9999-12-31';

export default function ReportPage({
  products,
  batches,
  orders,
  lines,
  fifo,
  warnDays
}: {
  products: Product[];
  batches: Batch[];
  orders: SalesOrder[];
  lines: SaleLine[];
  fifo: FifoResult;
  warnDays: number;
}) {
  const [date, setDate] = useState(localDate());
  const [mode, setMode] = useState<'day' | 'all'>('day');

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? '(已删)';
  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const from = mode === 'day' ? date : ALL_FROM;
  const to = mode === 'day' ? date : ALL_TO;

  const rep = useMemo(
    () =>
      mode === 'day'
        ? dayReport(date, orders, lines, fifo)
        : rangeReport(ALL_FROM, ALL_TO, orders, lines, fifo),
    [mode, date, orders, lines, fifo]
  );

  const margins = useMemo(
    () => productMargins(from, to, orders, lines, fifo, productName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from, to, orders, lines, fifo, products]
  );

  const warnings = useMemo(
    () => expiryWarnings(batches, fifo, productName, warnDays),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batches, fifo, warnDays, products]
  );

  return (
    <div className="page">
      <Card>
        <div className="col">
          <div className="row between">
            <div className="seg">
              <button className={mode === 'day' ? 'on' : ''} onClick={() => setMode('day')}>
                当日
              </button>
              <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>
                全部
              </button>
            </div>
            {mode === 'day' ? (
              <input
                className="input"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={{ width: 150 }}
              />
            ) : null}
          </div>

          <div className="stat-grid">
            <Stat k="营业单数" v={rep.orderCount} />
            <Stat k="卖出件数" v={rep.lineCount} />
            <Stat k="销售额" v={`¥${fenToStr(rep.revenueFen)}`} tone="brand" />
            <Stat
              k="毛利"
              v={`¥${fenToStr(rep.grossFen)}`}
              tone={rep.grossFen >= 0 ? 'ok' : 'bad'}
            />
            <Stat k="现金" v={`¥${fenToStr(rep.cashFen)}`} />
            <Stat k="微信" v={`¥${fenToStr(rep.wechatFen)}`} />
            <Stat k="支付宝" v={`¥${fenToStr(rep.alipayFen)}`} />
            <Stat k="砍价让利" v={`¥${fenToStr(rep.discountFen)}`} tone="bad" />
          </div>

          <div className="tiny">
            成本按批次先进先出算（FIFO）。毛利 = 销售额 − 成本。让利 = 标价与成交价的差额。
          </div>
        </div>
      </Card>

      {fifo.uncoveredQty > 0 ? (
        <div className="notice bad">
          有 {fifo.uncoveredQty} 件销量没有对应的进货批次（漏录进货或超卖），这部分成本用均价估算，毛利会偏高。
          建议去「进货」补录。
        </div>
      ) : null}

      <Card flush>
        <div className="list-item">
          <div className="main">
            <div className="t1">单品毛利</div>
            <div className="t2">{mode === 'day' ? date : '全部时间'}，按毛利从高到低</div>
          </div>
        </div>
        {margins.length === 0 ? (
          <Empty icon="📊" text="这段时间还没卖东西" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mini">
              <thead>
                <tr>
                  <th>商品</th>
                  <th style={{ textAlign: 'right' }}>数量</th>
                  <th style={{ textAlign: 'right' }}>销售额</th>
                  <th style={{ textAlign: 'right' }}>成本</th>
                  <th style={{ textAlign: 'right' }}>毛利</th>
                </tr>
              </thead>
              <tbody>
                {margins.map((m) => {
                  const p = productById.get(m.productId);
                  return (
                    <tr key={m.productId}>
                      <td>{m.name}</td>
                      <td className="num">{qtyToStr(m.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')}</td>
                      <td className="num">¥{fenToStr(m.revenueFen)}</td>
                      <td className="num">¥{fenToStr(m.costFen)}</td>
                      <td className="num" style={{ color: m.grossFen >= 0 ? 'var(--ok)' : 'var(--bad)', fontWeight: 700 }}>
                        ¥{fenToStr(m.grossFen)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card flush>
        <div className="list-item">
          <div className="main">
            <div className="t1">临期 / 过期预警</div>
            <div className="t2">只算还有剩余的批次，{warnDays} 天内到期或已过期</div>
          </div>
        </div>
        {warnings.length === 0 ? (
          <Empty icon="✅" text="没有临期批次" />
        ) : (
          <div className="list">
            {warnings.map((w) => (
              <div key={w.batch.id} className="list-item">
                <div className="main">
                  <div className="t1">
                    {w.productName}
                    {w.daysLeft < 0 ? (
                      <span className="badge bad">已过期</span>
                    ) : (
                      <span className="badge warn">剩 {w.daysLeft} 天</span>
                    )}
                  </div>
                  <div className="t2">
                    批号 {w.batch.batchNo ?? '无'} · 有效期至 {w.batch.expiryDate} · 剩{' '}
                    {qtyToStr(w.remaining, 0, '件')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}