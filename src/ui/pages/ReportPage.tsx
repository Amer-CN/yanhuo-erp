import { useMemo, useState } from 'react';
import { TriangleAlert, TrendingUp } from 'lucide-react';
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
    <div className="page-stack">
      <Card>
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div className="glass-segmented" role="group" aria-label="统计范围">
            <button
              type="button"
              className="glass-segmented__item"
              aria-pressed={mode === 'day'}
              onClick={() => setMode('day')}
            >
              当日
            </button>
            <button
              type="button"
              className="glass-segmented__item"
              aria-pressed={mode === 'all'}
              onClick={() => setMode('all')}
            >
              全部
            </button>
          </div>
          {mode === 'day' ? (
            <input
              className="glass-input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ width: 150, height: 40 }}
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

        <p className="tiny-text" style={{ marginBottom: 0, marginTop: 12 }}>
          成本按批次先进先出算（FIFO）。毛利 = 销售额 − 成本。让利 = 标价与成交价的差额。
        </p>
      </Card>

      {fifo.uncoveredQty > 0 ? (
        <div className="glass-status">
          <TriangleAlert size={20} aria-hidden="true" />
          <p>
            有 {fifo.uncoveredQty} 件销量没有对应的进货批次（漏录进货或超卖），这部分成本用均价估算，毛利会偏高。
            建议去「进货」补录。
          </p>
        </div>
      ) : null}

      <Card flush>
        <div className="form-head" style={{ margin: '4px 4px 8px' }}>
          <h2>单品毛利</h2>
          <span className="tiny-text">{mode === 'day' ? date : '全部时间'}</span>
        </div>
        {margins.length === 0 ? (
          <Empty icon={<TrendingUp size={24} />} text="这段时间还没卖东西" />
        ) : (
          <div className="glass-table-wrap">
            <table className="glass-table">
              <thead>
                <tr>
                  <th>商品</th>
                  <th className="glass-table__num">数量</th>
                  <th className="glass-table__num">销售额</th>
                  <th className="glass-table__num">成本</th>
                  <th className="glass-table__num">毛利</th>
                </tr>
              </thead>
              <tbody>
                {margins.map((m) => {
                  const p = productById.get(m.productId);
                  return (
                    <tr key={m.productId}>
                      <td>{m.name}</td>
                      <td className="glass-table__num">
                        {qtyToStr(m.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')}
                      </td>
                      <td className="glass-table__num">¥{fenToStr(m.revenueFen)}</td>
                      <td className="glass-table__num">¥{fenToStr(m.costFen)}</td>
                      <td
                        className="glass-table__num"
                        style={{
                          color: m.grossFen >= 0 ? 'var(--gl-color-success)' : 'var(--gl-color-error)',
                          fontWeight: 600
                        }}
                      >
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
        <div className="form-head" style={{ margin: '4px 4px 8px' }}>
          <h2>临期 / 过期预警</h2>
          <span className="tiny-text">{warnDays} 天内</span>
        </div>
        {warnings.length === 0 ? (
          <Empty icon={<TriangleAlert size={24} />} text="没有临期批次" />
        ) : (
          <ul className="glass-list" style={{ borderRadius: 18 }}>
            {warnings.map((w) => (
              <li key={w.batch.id} className="glass-list__item">
                <span className="glass-list__leading">
                  <TriangleAlert
                    size={22}
                    aria-hidden="true"
                    style={{ color: w.daysLeft < 0 ? 'var(--gl-color-error)' : 'var(--gl-color-warning)' }}
                  />
                </span>
                <div className="glass-list__content">
                  <div className="glass-list__title-row">
                    <div className="glass-list__title">{w.productName}</div>
                    <span
                      className={`glass-badge ${
                        w.daysLeft < 0 ? 'glass-badge--error' : 'glass-badge--warning'
                      }`}
                    >
                      {w.daysLeft < 0 ? '已过期' : `剩 ${w.daysLeft} 天`}
                    </span>
                  </div>
                  <div className="glass-list__subtitle">
                    批号 {w.batch.batchNo ?? '无'} · 有效期至 {w.batch.expiryDate} · 剩 {w.remaining} 件
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}