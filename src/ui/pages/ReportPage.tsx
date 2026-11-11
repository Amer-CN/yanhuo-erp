import { useMemo, useState } from 'react';
import {
  TriangleAlert,
  TrendingUp,
  Copy,
  ChevronDown,
  PenLine,
  CalendarRange
} from 'lucide-react';
import type { Batch, Product, SaleLine, SalesOrder, Session, SessionSummary } from '../../db/types';
import type { FifoResult } from '../../db/calc';
import {
  emptySessionSummary,
  expiryWarnings,
  productMarginsBySession,
  sessionReport,
  type ExpiryWarning,
  type ProductMargin
} from '../../db/calc';
import { DELETED_PRODUCT, fenToStr, isoToLocalDate, isoToTime, qtyToStr } from '../../db/util';
import { pickOpenSession } from '../../db/sessionLogic';
import { Btn, Card, Empty, Sheet, Stat, type Done } from '../kit';

type SortKey = 'gross' | 'revenue' | 'qty';

function sessionRange(s: Session): string {
  const d = new Date(s.startedAt);
  if (Number.isNaN(d.getTime())) return s.startedAt;
  const day = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start = isoToTime(s.startedAt);
  const end = s.closedAt ? isoToTime(s.closedAt) : '进行中';
  return `${day} ${start} → ${end}`;
}

function sessionLabel(s: Session): string {
  const d = new Date(s.startedAt);
  if (Number.isNaN(d.getTime())) return s.id.slice(0, 8);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 场`;
}

/** 场次选择：本场 / 历史切换 + 历史场次下拉入口（弹层仍在容器末尾渲染） */
function SessionPicker({
  mode,
  onMode,
  historyDisabled,
  selected,
  onOpenPicker
}: {
  mode: 'current' | 'history';
  onMode: (mode: 'current' | 'history') => void;
  historyDisabled: boolean;
  selected?: Session;
  onOpenPicker: () => void;
}) {
  return (
    <div className="row-between" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
      <div className="glass-segmented" role="group" aria-label="统计范围">
        <button
          type="button"
          className="glass-segmented__item"
          aria-pressed={mode === 'current'}
          onClick={() => onMode('current')}
        >
          本场
        </button>
        <button
          type="button"
          className="glass-segmented__item"
          aria-pressed={mode === 'history'}
          onClick={() => onMode('history')}
          disabled={historyDisabled}
        >
          历史场次
        </button>
      </div>

      {mode === 'history' ? (
        <button type="button" className="glass-pill season-pick" onClick={onOpenPicker}>
          <CalendarRange size={16} aria-hidden="true" />
          <span>{selected ? sessionLabel(selected) : '还没有历史场次'}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** 本场汇总卡内容（销售额 / 收款分项 / 毛利 / 让利 / 赠品） */
function SessionSummaryCard({
  selected,
  summary,
  payTotal,
  payMismatch,
  costMissing,
  onPatchSession,
  onGoRecord
}: {
  selected?: Session;
  summary: SessionSummary;
  payTotal: number;
  payMismatch: boolean;
  costMissing: boolean;
  onPatchSession: () => void;
  onGoRecord: () => void;
}) {
  if (!selected) {
    return (
      <Empty
        icon={<PenLine size={24} />}
        text="还没有场次，记一笔就开始这一场"
        action={
          <Btn block={false} size="sm" onClick={onGoRecord}>
            记一笔
          </Btn>
        }
      />
    );
  }
  return (
    <>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <div className="tiny-text">{sessionRange(selected)}</div>
        <div className="row" style={{ gap: 8 }}>
          {selected.patchedCount > 0 ? (
            <span className="glass-badge glass-badge--primary">
              补过 {selected.patchedCount} 单
            </span>
          ) : null}
          {selected.status === 'closed' ? (
            <button type="button" className="link-btn" onClick={onPatchSession}>
              补记
            </button>
          ) : null}
        </div>
      </div>

      <div className="hero-stats">
        <div className="stat stat--hero">
          <div className="k">销售额</div>
          <div className="v brand">¥{fenToStr(summary.revenueFen)}</div>
        </div>
        <div className="stat stat--hero">
          <div className="k">毛利{costMissing ? '（成本待补）' : ''}</div>
          <div className={`v ${costMissing ? '' : summary.grossFen >= 0 ? 'ok' : 'bad'}`}>
            {costMissing ? '—' : `¥${fenToStr(summary.grossFen)}`}
          </div>
        </div>
      </div>

      <div className="pay-rows">
        <div className="pay-row">
          <span>现金</span>
          <span>¥{fenToStr(summary.cashFen)}</span>
        </div>
        <div className="pay-row">
          <span>微信</span>
          <span>¥{fenToStr(summary.wechatFen)}</span>
        </div>
        <div className="pay-row">
          <span>支付宝</span>
          <span>¥{fenToStr(summary.alipayFen)}</span>
        </div>
        <div className="pay-row pay-row--check">
          <span>合计校验</span>
          <span className={payMismatch ? 'bad' : 'ok'}>
            ¥{fenToStr(payTotal)} {payMismatch ? '≠' : '✓'}
          </span>
        </div>
      </div>

      <div className="stat-grid stat-grid--compact">
        <Stat k="单数" v={summary.orderCount} />
        <Stat k="让利" v={`¥${fenToStr(summary.discountFen)}`} tone="bad" />
        <Stat k="赠品成本" v={`¥${fenToStr(summary.giftCostFen)}`} />
      </div>

      <p className="tiny-text" style={{ marginBottom: 0, marginTop: 12 }}>
        成本按批次先进先出算（FIFO）。毛利 = 销售额 − 成本。赠品金额 0、成本照算，单独列示。
      </p>
    </>
  );
}

/** 单品毛利表：排序 state 与表头都在这里 */
function MarginTable({
  margins,
  productByName,
  selected,
  orderCount,
  onCopy,
  onPatchSession,
  onGoRecord
}: {
  margins: ProductMargin[];
  productByName: Map<string, Product>;
  selected?: Session;
  orderCount: number;
  onCopy: () => void;
  onPatchSession: () => void;
  onGoRecord: () => void;
}) {
  const [sort, setSort] = useState<SortKey>('gross');

  const sortedMargins = useMemo(() => {
    const arr = [...margins];
    arr.sort((a, b) => {
      if (Boolean(a.costIncomplete) !== Boolean(b.costIncomplete)) return a.costIncomplete ? 1 : -1;
      if (sort === 'revenue') return b.revenueFen - a.revenueFen;
      if (sort === 'qty') return b.qtyBase - a.qtyBase;
      return b.grossFen - a.grossFen;
    });
    return arr;
  }, [margins, sort]);

  const sortHeader = (key: SortKey, label: string, extra = '') => (
    <th
      className={`glass-table__num ${extra}`.trim()}
      aria-sort={sort === key ? 'descending' : 'none'}
    >
      <button
        type="button"
        className="th-btn"
        onClick={() => setSort(key)}
        title={`按${label}排序`}
      >
        {label}
        {sort === key ? ' ↓' : ''}
      </button>
    </th>
  );

  return (
    <Card flush>
      <div className="form-head form-head--inset">
        <h2>单品（按{sort === 'gross' ? '毛利' : sort === 'revenue' ? '销售额' : '数量'}降序）</h2>
        {selected ? <span className="tiny-text">{sessionLabel(selected)}</span> : null}
      </div>
      {sortedMargins.length === 0 ? (
        <Empty
          icon={<TrendingUp size={24} />}
          text={selected ? '这一场还没卖东西' : '还没有场次'}
          action={
            selected && selected.status === 'closed' ? (
              <Btn block={false} size="sm" onClick={onPatchSession}>
                补记到这一场
              </Btn>
            ) : (
              <Btn block={false} size="sm" onClick={onGoRecord}>
                记一笔
              </Btn>
            )
          }
        />
      ) : (
        <div className="glass-table-wrap">
          <table className="glass-table">
            <thead>
              <tr>
                <th>商品</th>
                <th className="glass-table__num">
                  <button type="button" className="th-btn" onClick={() => setSort('qty')}>
                    数量{sort === 'qty' ? ' ↓' : ''}
                  </button>
                </th>
                {sortHeader('revenue', '销售额')}
                <th className="glass-table__num hide-sm">让利</th>
                <th className="glass-table__num hide-narrow">赠品</th>
                <th className="glass-table__num hide-narrow">成本</th>
                {sortHeader('gross', '毛利')}
              </tr>
            </thead>
            <tbody>
              {sortedMargins.map((m: ProductMargin) => {
                const p = productByName.get(m.productId);
                return (
                  <tr key={m.productId}>
                    <td>
                      <div>{m.name}</div>
                      {m.giftQty ? (
                        <div className="tiny-text">赠 {m.giftQty}</div>
                      ) : null}
                    </td>
                    <td className="glass-table__num">
                      {qtyToStr(m.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')}
                    </td>
                    <td className="glass-table__num">¥{fenToStr(m.revenueFen)}</td>
                    <td className="glass-table__num hide-sm">¥{fenToStr(m.discountFen)}</td>
                    <td className="glass-table__num hide-narrow">
                      {m.giftQty ? `${m.giftQty} · ¥${fenToStr(m.giftCostFen ?? 0)}` : '—'}
                    </td>
                    <td className="glass-table__num hide-narrow">¥{fenToStr(m.costFen)}</td>
                    <td
                      className="glass-table__num"
                      style={{
                        color: m.grossFen >= 0 ? 'var(--yh-ok-ink)' : 'var(--yh-bad-ink)',
                        fontWeight: 'var(--yh-weight-semibold)'
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

      {selected ? (
        <div className="report-actions">
          <Btn
            block={false}
            variant="secondary"
            size="sm"
            onClick={onCopy}
            disabled={orderCount === 0}
          >
            <span className="icon-text">
              <Copy size={16} aria-hidden="true" /> 复制本场汇总
            </span>
          </Btn>
          {selected.status === 'closed' ? (
            <Btn block={false} size="sm" onClick={onPatchSession}>
              <span className="icon-text">
                <PenLine size={16} aria-hidden="true" /> 补记到这一场
              </span>
            </Btn>
          ) : (
            <Btn block={false} size="sm" onClick={onGoRecord}>
              <span className="icon-text">
                <PenLine size={16} aria-hidden="true" /> 去记一笔
              </span>
            </Btn>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/** 临期 / 过期预警 */
function ExpiryWarnings({
  warnings,
  warnDays,
  productById
}: {
  warnings: ExpiryWarning[];
  warnDays: number;
  /** 用来取商品的 unitBase / boxQty：同屏其它行都写「N 个」，这里不能单独写「件」（M-09） */
  productById: Map<string, Product>;
}) {
  return (
    <Card flush>
      <div className="form-head form-head--inset">
        <h2>临期 / 过期预警</h2>
        <span className="tiny-text">{warnDays} 天内</span>
      </div>
      {warnings.length === 0 ? (
        <Empty icon={<TriangleAlert size={24} />} text="没有临期批次" />
      ) : (
        <ul className="glass-list" style={{ borderRadius: 'var(--yh-radius-lg)' }}>
          {warnings.map((w) => {
            const p = productById.get(w.batch.productId);
            return (
              <li key={w.batch.id} className="glass-list__item">
                <span className="glass-list__leading">
                  <TriangleAlert
                    size={22}
                    aria-hidden="true"
                    style={{
                      color: w.daysLeft < 0 ? 'var(--yh-bad-ink)' : 'var(--gl-color-warning)'
                    }}
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
                    批号 {w.batch.batchNo ?? '无'} · 有效期至 {w.batch.expiryDate} · 剩{' '}
                    {qtyToStr(w.remaining, p?.boxQty ?? 0, p?.unitBase ?? '个')}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * 报表：按场次，不再按自然日。
 * 默认本场（进行中或最近一场）；历史场次按结账时间倒序。
 */
export default function ReportPage({
  products,
  batches,
  orders,
  lines,
  sessions,
  deviceId,
  fifo,
  warnDays,
  onDone,
  onPatchSession,
  onGoRecord
}: {
  products: Product[];
  batches: Batch[];
  orders: SalesOrder[];
  lines: SaleLine[];
  sessions: Session[];
  deviceId: string;
  fifo: FifoResult;
  warnDays: number;
  onDone: Done;
  onPatchSession: (session: Session) => void;
  onGoRecord: () => void;
}) {
  const [mode, setMode] = useState<'current' | 'history'>('current');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const productByName = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const deviceSessions = useMemo(
    () => sessions.filter((s) => s.deviceId === deviceId),
    [sessions, deviceId]
  );

  // 本机进行中的场次：与首页共用 db/sessionLogic.pickOpenSession 的口径，
  // 依赖项仍是 sessions/deviceId（deviceSessions 由二者派生，等价）。
  const openSession = useMemo(
    () => pickOpenSession(sessions, deviceId),
    [sessions, deviceId]
  );

  const closed = useMemo(
    () =>
      deviceSessions
        .filter((s) => s.status === 'closed')
        .sort((a, b) => ((a.closedAt ?? a.startedAt) < (b.closedAt ?? b.startedAt) ? 1 : -1)),
    [deviceSessions]
  );

  const selected =
    mode === 'current'
      ? (openSession ?? closed[0])
      : (closed.find((s) => s.id === pickedId) ?? closed[0]);

  const summary = useMemo(
    () => (selected ? sessionReport(selected.id, orders, lines, fifo) : emptySessionSummary()),
    [selected, orders, lines, fifo]
  );

  const margins = useMemo(
    () =>
      selected
        ? productMarginsBySession(selected.id, orders, lines, fifo, (id) => productByName.get(id)?.name ?? DELETED_PRODUCT)
        : [],
    [selected, orders, lines, fifo, productByName]
  );

  const warnings = useMemo(
    () => expiryWarnings(batches, fifo, (id) => productByName.get(id)?.name ?? DELETED_PRODUCT, warnDays),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batches, fifo, warnDays, products]
  );

  const costMissing = fifo.uncoveredQty > 0;
  const payTotal = summary.cashFen + summary.wechatFen + summary.alipayFen;
  const payMismatch = summary.orderCount > 0 && payTotal !== summary.revenueFen;

  const copySummary = async () => {
    if (!selected) return;
    const text = [
      `本场 ${sessionRange(selected)}`,
      `销售额 ¥${fenToStr(summary.revenueFen)} · ${summary.orderCount} 单`,
      `现金 ¥${fenToStr(summary.cashFen)} · 微信 ¥${fenToStr(summary.wechatFen)} · 支付宝 ¥${fenToStr(summary.alipayFen)}`,
      `毛利 ¥${fenToStr(summary.grossFen)} · 让利 ¥${fenToStr(summary.discountFen)} · 赠品成本 ¥${fenToStr(summary.giftCostFen)}`,
      selected.patchedCount > 0 ? `补过 ${selected.patchedCount} 单` : ''
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onDone('已复制本场汇总，可以发微信对账');
    } catch {
      onDone('复制失败，手动记一下：' + text.replace(/\n/g, '；'), 'error');
    }
  };

  const patchSelected = () => {
    if (selected) onPatchSession(selected);
  };

  return (
    <div className="page-stack">
      <Card>
        <SessionPicker
          mode={mode}
          onMode={setMode}
          historyDisabled={closed.length === 0}
          selected={selected}
          onOpenPicker={() => setPickerOpen(true)}
        />

        <SessionSummaryCard
          selected={selected}
          summary={summary}
          payTotal={payTotal}
          payMismatch={payMismatch}
          costMissing={costMissing}
          onPatchSession={patchSelected}
          onGoRecord={onGoRecord}
        />
      </Card>

      {payMismatch ? (
        <div className="glass-status">
          <TriangleAlert size={20} aria-hidden="true" />
          <p>
            收款合计 ¥{fenToStr(payTotal)} 与销售额 ¥{fenToStr(summary.revenueFen)} 对不上，
            可能是导入了旧数据或补记后未重算。请检查这一场的删除单与补记。
          </p>
        </div>
      ) : null}

      {costMissing ? (
        <div className="glass-status">
          <TriangleAlert size={20} aria-hidden="true" />
          <p>
            有 {fifo.uncoveredQty} 个（基本单位）销量没有对应的进货批次（漏录进货或超卖），这部分成本用均价估算，毛利先显示为「—」。
            去「进货」补录后会自动恢复。
          </p>
        </div>
      ) : null}

      <MarginTable
        margins={margins}
        productByName={productByName}
        selected={selected}
        orderCount={summary.orderCount}
        onCopy={copySummary}
        onPatchSession={patchSelected}
        onGoRecord={onGoRecord}
      />

      <ExpiryWarnings warnings={warnings} warnDays={warnDays} productById={productByName} />

      {pickerOpen ? (
        <Sheet
          title="选场次"
          subtitle="按结账时间倒序"
          onClose={() => setPickerOpen(false)}
        >
          {closed.length === 0 ? (
            <Empty icon={<CalendarRange size={24} />} text="还没有历史场次" />
          ) : (
            <ul className="glass-list">
              {closed.map((s) => {
                const rep = sessionReport(s.id, orders, lines, fifo);
                return (
                  <li
                    key={s.id}
                    className="glass-list__item glass-list__item--interactive list-item"
                    role="button"
                    tabIndex={0}
                    aria-pressed={s.id === selected?.id}
                    onClick={() => {
                      setPickedId(s.id);
                      setPickerOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setPickedId(s.id);
                        setPickerOpen(false);
                      }
                    }}
                  >
                    <div className="glass-list__content">
                      <div className="glass-list__title">
                        {isoToLocalDate(s.startedAt)} · {isoToTime(s.startedAt)}
                        {s.patchedCount > 0 ? ` · 补过 ${s.patchedCount} 单` : ''}
                      </div>
                      <div className="glass-list__subtitle">
                        {rep.orderCount} 单 · 销售额 ¥{fenToStr(rep.revenueFen)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}