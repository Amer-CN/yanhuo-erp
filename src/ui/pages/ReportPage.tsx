import { useMemo, useState } from 'react';
import {
  TriangleAlert,
  TrendingUp,
  Copy,
  ChevronUp,
  PenLine,
  CalendarRange,
  Ban,
  Sun
} from 'lucide-react';
import type { Batch, Product, SaleLine, SalesOrder, Session } from '../../db/types';
import { PAY_LABEL } from '../../db/types';
import type { FifoResult } from '../../db/calc';
import {
  dayReport,
  emptySessionSummary,
  expiryWarnings,
  productMarginsBySession,
  sessionReport,
  type DayReport,
  type ExpiryWarning,
  type ProductMargin,
  type SessionReport
} from '../../db/calc';
import { restoreOrder } from '../../db/repo';
import {
  DELETED_PRODUCT,
  fenToStr,
  isoToLocalDate,
  isoToTime,
  localDate,
  qtyToStr
} from '../../db/util';
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

/** 单据按时间倒序（删除单弹层用：最近删的排最前） */
function newestFirst(list: SalesOrder[]): SalesOrder[] {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * 场次选择：顶部只留「统计范围」只读标签，**可点入口下移成底部浮胶囊**（L1）。
 *
 * 2026-11-12（L1）：原来「进行中 / 历史场次」分段 + 场次胶囊都在页面顶端（实测 y≈87），
 * 收摊时单手拿手机根本够不到（390×844 的拇指舒适区在 y > 562）。
 * 现在按 A 方案：顶部不再放任何可点控件，只写清「现在看的是哪一场」；
 * 唯一的入口是吸在浮动底栏上方的这颗 44px 胶囊（`position: fixed`，
 * 底边 = .app-main 给底栏预留的 96px + 安全区），点开仍是原来的场次 Sheet。
 * 为什么不用 B（整体挪到「今天」卡下方）：那还停在上半屏，仍然够不到。
 */
function SessionScopeLabel({ mode, selected }: { mode: 'current' | 'history'; selected?: Session }) {
  const scopeText =
    mode === 'current' ? '进行中这一场' : selected ? sessionLabel(selected) : '历史场次';
  return (
    /* 只读：让用户知道下面这些数字属于哪一场，但这里不再承担切换动作 */
    <div className="tiny-text" style={{ marginBottom: 6 }}>
      统计范围：{scopeText}
    </div>
  );
}

/**
 * 底部浮胶囊（B2 的唯一切换入口）。
 *
 * **必须挂在页面根节点上**，不能放进 `<Card>`：GlassKit 的玻璃卡带
 * `backdrop-filter`，它会成为 fixed 后代的包含块，胶囊就跟着卡片定位
 * （实测落到 y=869，比视口还低 25px），吸附底栏的效果直接失效。
 */
function SessionSwitchFab({
  mode,
  onOpenPicker
}: {
  mode: 'current' | 'history';
  onOpenPicker: () => void;
}) {
  return (
    <button
      type="button"
      className="glass-pill season-pick report-session-fab"
      aria-label="切换场次"
      aria-haspopup="dialog"
      onClick={onOpenPicker}
    >
      <CalendarRange size={16} aria-hidden="true" />
      <span>{mode === 'current' ? '历史场次' : '换一场'}</span>
      <ChevronUp size={14} aria-hidden="true" />
    </button>
  );
}

/** 「已排除 N 笔删除（¥X）· 点开看」：作废单不再等于没发生（M1） */
function ExcludedLine({
  count,
  fen,
  onOpen
}: {
  count: number;
  fen: number;
  onOpen: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="report-excluded">
      <span>
        已排除 {count} 笔删除（¥{fenToStr(fen)}）
      </span>
      <button type="button" className="link-btn" onClick={onOpen}>
        点开看
      </button>
    </div>
  );
}

/** 进行中那行说明：必须写明「不计入今天」，否则又会被当成今天的收入（H1） */
function OpenSessionNote({ count, fen }: { count: number; fen: number }) {
  if (count === 0) return null;
  return (
    <p className="report-note">
      还有 {count} 场进行中 · ¥{fenToStr(fen)}（不计入今天）
    </p>
  );
}

/**
 * 「今天」汇总卡：固定在最上面、不参与场次切换（H1）。
 *
 * 数据是 `dayReport()` 按 closedAt 落在今天的**已结账**场次累加的，
 * 所以收摊后打开报表第一眼就是今天的账，不会跳到 22:00 新开的那一场。
 */
function TodayCard({ day, onOpenVoided }: { day: DayReport; onOpenVoided: () => void }) {
  const hasClosed = day.sessionCount > 0;
  return (
    <Card>
      <div className="report-day-head">
        <div className="report-day-head__title">
          {hasClosed ? (
            <>
              今天 · 已结账 {day.sessionCount} 场
              <span className="brand"> · ¥{fenToStr(day.revenueFen)}</span>
            </>
          ) : (
            '今天'
          )}
        </div>
        <span className="tiny-text">{day.date}</span>
      </div>

      {hasClosed ? (
        <>
          <div className="hero-stats hero-stats--single">
            <div className="stat stat--hero">
              <div className="k">毛利{day.grossKnown ? '' : '（成本待补）'}</div>
              <div className={`v ${day.grossKnown ? (day.grossFen >= 0 ? 'ok' : 'bad') : ''}`}>
                {day.grossKnown ? `¥${fenToStr(day.grossFen)}` : '—'}
              </div>
            </div>
          </div>

          <div className="pay-rows">
            <div className="pay-row">
              <span>现金</span>
              <span>¥{fenToStr(day.cashFen)}</span>
            </div>
            <div className="pay-row">
              <span>微信</span>
              <span>¥{fenToStr(day.wechatFen)}</span>
            </div>
            <div className="pay-row">
              <span>支付宝</span>
              <span>¥{fenToStr(day.alipayFen)}</span>
            </div>
          </div>

          <div className="stat-grid stat-grid--compact">
            <Stat k="单数" v={day.orderCount} />
            <Stat k="让利" v={`¥${fenToStr(day.discountFen)}`} tone="bad" />
            <Stat k="赠品成本" v={`¥${fenToStr(day.giftCostFen)}`} />
          </div>

          <ExcludedLine count={day.voidedCount} fen={day.voidedFen} onOpen={onOpenVoided} />

          {!day.grossKnown ? (
            <p className="report-note">
              今天有 {day.costIncompleteSessions} 场成本待补（缺批次），补录进货后毛利会自动恢复。
            </p>
          ) : null}
        </>
      ) : (
        <Empty icon={<Sun size={24} />} text="今天还没有已结账的场次" />
      )}

      <OpenSessionNote count={day.openSessionCount} fen={day.openRevenueFen} />
    </Card>
  );
}

/** 被删除的单据明细：时间 / 金额 / 行内「撤销」（M1） */
function VoidedSheet({
  title,
  orders,
  restoringId,
  onUndo,
  onClose
}: {
  title: string;
  orders: SalesOrder[];
  restoringId: string | null;
  onUndo: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={title} subtitle={`共 ${orders.length} 笔 · 不计入销售额`} onClose={onClose}>
      {orders.length === 0 ? (
        <Empty icon={<Ban size={24} />} text="没有被删除的单据" />
      ) : (
        <ul className="glass-list">
          {orders.map((o) => (
            <li key={o.id} className="glass-list__item">
              <span className="glass-list__leading">
                <Ban size={20} aria-hidden="true" />
              </span>
              <div className="glass-list__content">
                <div className="glass-list__title-row">
                  <div className="glass-list__title">
                    {isoToTime(o.createdAt)} · {o.operator}
                  </div>
                  <span className="glass-badge">{PAY_LABEL[o.payMethod]}</span>
                </div>
                <div className="glass-list__subtitle">已删除 · 不计入合计</div>
              </div>
              <div
                className="glass-list__trailing"
                style={{ display: 'flex', alignItems: 'center', gap: 10 }}
              >
                <span className="voided-amount">¥{fenToStr(o.totalFen)}</span>
                <button
                  type="button"
                  className="link-btn"
                  aria-label={`撤销删除 ${isoToTime(o.createdAt)} 这一单`}
                  disabled={restoringId === o.id}
                  onClick={() => onUndo(o.id)}
                >
                  撤销
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
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
  onGoRecord,
  onOpenVoided
}: {
  selected?: Session;
  summary: SessionReport;
  payTotal: number;
  payMismatch: boolean;
  costMissing: boolean;
  onPatchSession: () => void;
  onGoRecord: () => void;
  onOpenVoided: () => void;
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

      {/* M1：删除单以前被 filter 掉了，报表里像没发生过；这里如实写「已排除几笔、多少钱」 */}
      <ExcludedLine
        count={summary.voidedCount ?? 0}
        fen={summary.voidedFen ?? 0}
        onOpen={onOpenVoided}
      />

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
  voidedCount,
  onCopy,
  onPatchSession,
  onGoRecord
}: {
  margins: ProductMargin[];
  productByName: Map<string, Product>;
  selected?: Session;
  orderCount: number;
  /** 本场被删除的单数：只有删除单的场次不能说成「还没卖东西」（M1） */
  voidedCount: number;
  onCopy: () => void;
  onPatchSession: () => void;
  onGoRecord: () => void;
}) {
  const [sort, setSort] = useState<SortKey>('gross');

  const sortedMargins = useMemo(() => {
    const arr = [...margins];
    arr.sort((a, b) => {
      // H3：缺成本的行排最前。它们的毛利是**估**出来的，藏在一堆正常行里
      // 会被当成「真赚了」，排在最前 + 徽标才是安全的默认。
      if (Boolean(a.costIncomplete) !== Boolean(b.costIncomplete)) return a.costIncomplete ? -1 : 1;
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
          text={
            selected
              ? voidedCount > 0
                ? `这一场没有有效销售（${voidedCount} 笔已删除，可在上方「点开看」撤销）`
                : '这一场还没卖东西'
              : '还没有场次'
          }
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
                {/*
                  窄屏（≤520）只留「商品 / 数量 / 销售额 / 成本 / 毛利」五列：
                  赠品信息已在商品名下写「赠 1」，让利总额在汇总卡里，
                  而**成本**和**毛利**必须同屏可见——否则毛利会被右边缘切掉。
                */}
                <th className="glass-table__num hide-narrow">让利</th>
                <th className="glass-table__num hide-narrow">赠品</th>
                <th className="glass-table__num">成本</th>
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
                      {m.giftQty || m.costIncomplete ? (
                        <div className="margin-flags">
                          {m.giftQty ? (
                            <span className="tiny-text">赠 {m.giftQty}</span>
                          ) : null}
                          {m.costIncomplete ? (
                            <span
                              className="glass-badge glass-badge--warning"
                              title={`本行 ${m.uncoveredQty ?? 0} 个（基本单位）没有进货批次，成本是估算值`}
                            >
                              成本待补
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="glass-table__num">
                      {qtyToStr(m.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')}
                    </td>
                    <td className="glass-table__num">¥{fenToStr(m.revenueFen)}</td>
                    <td className="glass-table__num hide-narrow">¥{fenToStr(m.discountFen)}</td>
                    <td className="glass-table__num hide-narrow">
                      {m.giftQty ? `${m.giftQty} · ¥${fenToStr(m.giftCostFen ?? 0)}` : '—'}
                    </td>
                    <td className="glass-table__num">¥{fenToStr(m.costFen)}</td>
                    <td
                      className="glass-table__num"
                      style={{
                        // 缺成本的行不许用「盈利绿」：数字后面加 ~，颜色降为次要文字
                        color: m.costIncomplete
                          ? 'var(--gl-color-text-muted)'
                          : m.grossFen >= 0
                            ? 'var(--yh-ok-ink)'
                            : 'var(--yh-bad-ink)',
                        fontWeight: 'var(--yh-weight-semibold)'
                      }}
                    >
                      ¥{fenToStr(m.grossFen)}
                      {m.costIncomplete ? '~' : ''}
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
 * 报表：顶部固定「今天」合计，下面才是单场明细。
 *
 * 默认视图是「今天」卡（H1）：收摊后打开报表，第一眼必须是今天已结账场次的合计，
 * 而不是 22:00 新开、还没结账的下一场。场次切换只影响下面的明细卡，
 * 「进行中」= 当前这一场，「历史场次」= 已结账场次（按结账时间倒序）。
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
  /** 删除单明细弹层：'today' = 今天已结账场次的删除单；'session' = 当前这一场 */
  const [voidedSheet, setVoidedSheet] = useState<'today' | 'session' | null>(null);
  /** 撤销删除的防连点（与流水页同一份守卫思路） */
  const [restoring, setRestoring] = useState<string | null>(null);
  const today = localDate();

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

  /**
   * 今天合计（H1）：只算 closedAt 落在本地今天的**已结账**场次；
   * 进行中的场次单独给场次与金额，界面写「不计入今天」。
   */
  const day = useMemo(
    () => dayReport(sessions, orders, lines, fifo, today),
    [sessions, orders, lines, fifo, today]
  );

  /** 今天已结账场次的 id：删除单弹层要用它过滤（口径必须与 dayReport 一致） */
  const todayClosedIds = useMemo(() => {
    const s = new Set<string>();
    for (const x of sessions) {
      if (x.status === 'closed' && x.closedAt && isoToLocalDate(x.closedAt) === today) s.add(x.id);
    }
    return s;
  }, [sessions, today]);

  const todayVoided = useMemo(
    () => newestFirst(orders.filter((o) => o.voided && o.sessionId && todayClosedIds.has(o.sessionId))),
    [orders, todayClosedIds]
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

  /** 当前这一场被删除的单（M1：报表里要能点开看，而不是只 filter 掉） */
  const sessionVoided = useMemo(
    () => (selected ? newestFirst(orders.filter((o) => o.voided && o.sessionId === selected.id)) : []),
    [orders, selected]
  );

  /**
   * H2：毛利「—」按**场次**判断，不再看全局 fifo.uncoveredQty。
   *
   * 为什么要按场次：全局口径下，只要昨天/下一场/任何一个商品缺一批货，
   * 今天这一场的毛利也一起变成「—」，摊主会以为账坏了；而同一个页面的
   * 「复制本场汇总」却照样打印金额 —— 两处口径打架，用户谁都不信。
   * 现在只有**本场**有缺批次才隐藏毛利，提示条也只说本场缺多少。
   */
  const costMissing = summary.uncoveredQty > 0;
  const payTotal = summary.cashFen + summary.wechatFen + summary.alipayFen;
  const payMismatch = summary.orderCount > 0 && payTotal !== summary.revenueFen;

  /**
   * 撤销删除（M1）：报表的「已排除 N 笔删除」点开就能救回来。
   * 守卫与流水页一致：先确认单据还在本机，再写库，失败如实报错。
   */
  const undoDelete = async (id: string) => {
    if (restoring) return;
    if (!orders.some((o) => o.id === id)) {
      onDone('这一单已经不在了（可能被另一台手机清空过）', 'warning');
      return;
    }
    setRestoring(id);
    try {
      await restoreOrder(id);
      onDone('已撤销删除');
    } catch {
      onDone('撤销失败，请重试', 'error');
    } finally {
      setRestoring(null);
    }
  };

  const copySummary = async () => {
    if (!selected) return;
    // 与 hero 用同一个 grossKnown（= costMissing）判断：禁止一处「—」一处金额
    const grossText = costMissing
      ? `毛利 —（成本待补：本场 ${summary.uncoveredQty} 个缺批次）`
      : `毛利 ¥${fenToStr(summary.grossFen)}`;
    const text = [
      `本场 ${sessionRange(selected)}`,
      `销售额 ¥${fenToStr(summary.revenueFen)} · ${summary.orderCount} 单`,
      `现金 ¥${fenToStr(summary.cashFen)} · 微信 ¥${fenToStr(summary.wechatFen)} · 支付宝 ¥${fenToStr(summary.alipayFen)}`,
      `${grossText} · 让利 ¥${fenToStr(summary.discountFen)} · 赠品成本 ¥${fenToStr(summary.giftCostFen)}`,
      summary.voidedCount > 0
        ? `已排除 ${summary.voidedCount} 笔删除（¥${fenToStr(summary.voidedFen)}）`
        : '',
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
      {/* 今天合计：固定最上面、不参与场次切换（H1） */}
      <TodayCard day={day} onOpenVoided={() => setVoidedSheet('today')} />

      <Card>
        <SessionScopeLabel mode={mode} selected={selected} />

        <SessionSummaryCard
          selected={selected}
          summary={summary}
          payTotal={payTotal}
          payMismatch={payMismatch}
          costMissing={costMissing}
          onPatchSession={patchSelected}
          onGoRecord={onGoRecord}
          onOpenVoided={() => setVoidedSheet('session')}
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
            本场有 {summary.uncoveredQty} 个（基本单位）销量没有对应的进货批次（漏录进货或超卖），
            这部分成本用均价估算，<strong>本场</strong>毛利先显示为「—」。
            去「进货」补录后会自动恢复。
          </p>
        </div>
      ) : null}

      <MarginTable
        margins={margins}
        productByName={productByName}
        selected={selected}
        orderCount={summary.orderCount}
        voidedCount={summary.voidedCount}
        onCopy={copySummary}
        onPatchSession={patchSelected}
        onGoRecord={onGoRecord}
      />

      <ExpiryWarnings warnings={warnings} warnDays={warnDays} productById={productByName} />

      {/* 场次切换的唯一点击入口：固定在底栏上方，页面滚到哪儿都够得到 */}
      <SessionSwitchFab mode={mode} onOpenPicker={() => setPickerOpen(true)} />
      {/* 占位：滚到底时最后一张卡能停在胶囊上方，不被浮胶囊压住右下角 */}
      <div className="report-session-fab-gap" aria-hidden="true" />

      {voidedSheet ? (
        <VoidedSheet
          title={voidedSheet === 'today' ? '今天被删除的单' : '这一场被删除的单'}
          orders={voidedSheet === 'today' ? todayVoided : sessionVoided}
          restoringId={restoring}
          onUndo={(id) => void undoDelete(id)}
          onClose={() => setVoidedSheet(null)}
        />
      ) : null}

      {pickerOpen ? (
        <Sheet
          title="选场次"
          subtitle="按结账时间倒序"
          onClose={() => setPickerOpen(false)}
        >
          <ul className="glass-list">
            {/*
              第一行固定是「进行中这一场」：底部胶囊是唯一的切换入口，
              用户点进历史场次之后必须有一条明确的路回到进行中，
              否则只能离开页面再进来（旧的分段控件消失后就没有退路了）。
            */}
            <li
              className="glass-list__item glass-list__item--interactive list-item"
              role="button"
              tabIndex={0}
              aria-pressed={mode === 'current'}
              onClick={() => {
                setMode('current');
                setPickerOpen(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setMode('current');
                  setPickerOpen(false);
                }
              }}
            >
              <div className="glass-list__content">
                <div className="glass-list__title">进行中这一场</div>
                <div className="glass-list__subtitle">
                  {openSession
                    ? `${isoToTime(openSession.startedAt)} 开始 · 还没结账`
                    : '本机没有进行中的场次'}
                </div>
              </div>
            </li>
            {closed.map((s) => {
              const rep = sessionReport(s.id, orders, lines, fifo);
              return (
                <li
                  key={s.id}
                  className="glass-list__item glass-list__item--interactive list-item"
                  role="button"
                  tabIndex={0}
                  aria-pressed={mode === 'history' && s.id === selected?.id}
                  onClick={() => {
                    setPickedId(s.id);
                    // 选中某个历史场次 = 显式进入历史视图（旧的「历史场次」分段按钮已移除）
                    setMode('history');
                    setPickerOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setPickedId(s.id);
                      setMode('history');
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
          {closed.length === 0 ? (
            <Empty icon={<CalendarRange size={24} />} text="还没有历史场次" />
          ) : null}
        </Sheet>
      ) : null}
    </div>
  );
}