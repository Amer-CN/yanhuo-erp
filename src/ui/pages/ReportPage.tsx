import { useMemo, useState } from 'react';
import {
  TriangleAlert,
  TrendingUp,
  Copy,
  ChevronDown,
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
 * 本场「状态 + 切换场次」胶囊（P0-1 / P0-2 / P1-6）。
 *
 * 为什么状态必须看 `selected.status` 而不是 `mode`：
 * 没有进行中场次时 `selected = openSession ?? closed[0]`（收摊后最常见），
 * `mode` 仍停在 'current'，旧标签于是把已结账场次写成「进行中这一场」，
 * 下面却显示 09:05 → 21:30 的已结账金额 —— 状态标签会说谎。
 * 现在只认选中场次自己的 status，mode 只负责「用户点的是哪个」。
 *
 * 为什么入口放在本场卡头部、而不是页面顶端：
 * 审计第十节第 6 条否掉的是「把胶囊挪回页面顶端」（顶端 y≈87，收摊时单手够不到）。
 * 这里的位置是本场卡的卡头（390×844 实测 y≈581，首屏内、拇指区），
 * 与顶部横条性质不同；而且它紧贴被它控制的数字，看状态与切换合成一个动作，
 * 不再像旧浮胶囊那样浮在内容上挡住本场现金行/毛利值。
 */
function SessionSwitchButton({
  selected,
  onOpenPicker
}: {
  selected: Session;
  onOpenPicker: () => void;
}) {
  const open = selected.status === 'open';
  return (
    <button
      type="button"
      className="report-session-switch"
      aria-haspopup="dialog"
      aria-label="切换场次"
      onClick={onOpenPicker}
    >
      <CalendarRange size={16} aria-hidden="true" />
      <span className="report-session-switch__scope">本场 ·</span>
      <span className={`glass-badge ${open ? 'glass-badge--primary' : ''}`.trim()}>
        {open ? '进行中' : `已结账${selected.closedAt ? ` ${isoToTime(selected.closedAt)}` : ''}`}
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  );
}

/** 「已排除 N 笔删除（¥X）· 看今天/看这一场的 N 笔」：作废单不再等于没发生（M1） */
function ExcludedLine({
  count,
  fen,
  scope,
  onOpen
}: {
  count: number;
  fen: number;
  /** 两个入口范围不同：今天 = 今天所有已结账场次；session = 当前这一场（P1-9） */
  scope: 'day' | 'session';
  onOpen: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="report-excluded">
      <span>
        已排除 {count} 笔删除（¥{fenToStr(fen)}）
      </span>
      <button type="button" className="link-btn" onClick={onOpen}>
        看{scope === 'day' ? '今天的' : '这一场的'} {count} 笔
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
 *
 * P2-8：今天卡在 390×844 上占到 480px（内容视口 61.6%），把本场卡的数字全挤到
 * 首屏之外。这里只压缩密度、不重排卡片顺序（审计第十节第 1 条），
 * 也不删任何一项：三行收款改成一行三列（标签在上、金额在下）。
 */
function TodayCard({
  day,
  externalCount,
  hasOpenSession,
  onGoCurrent,
  onGoRecord,
  onOpenVoided
}: {
  day: DayReport;
  /** 今天已结账场次里属于另一台手机的数量（跨设备下钻用，P1-7） */
  externalCount: number;
  /** 本机是否有进行中的场次：决定空态按钮是「去看进行中」还是「去记一笔」 */
  hasOpenSession: boolean;
  onGoCurrent: () => void;
  onGoRecord: () => void;
  onOpenVoided: () => void;
}) {
  const hasClosed = day.sessionCount > 0;
  return (
    <Card className="report-day-card">
      <div className="report-day-head">
        <div>
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
          {/* P1-7：今天合计跨设备，这里说明其中有几场来自另一台手机 */}
          {hasClosed && externalCount > 0 ? (
            <div className="tiny-text report-day-external">含另一台手机 {externalCount} 场</div>
          ) : null}
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

          {/* P2-8：一行三列；金额 15px（≥15px 可读），每格 1/3 宽 */}
          <div className="report-pay-grid">
            <div className="report-pay-cell">
              <span className="k">现金</span>
              <span className="v">¥{fenToStr(day.cashFen)}</span>
            </div>
            <div className="report-pay-cell">
              <span className="k">微信</span>
              <span className="v">¥{fenToStr(day.wechatFen)}</span>
            </div>
            <div className="report-pay-cell">
              <span className="k">支付宝</span>
              <span className="v">¥{fenToStr(day.alipayFen)}</span>
            </div>
          </div>

          <div className="stat-grid stat-grid--compact">
            <Stat k="单数" v={day.orderCount} />
            <Stat k="让利" v={`¥${fenToStr(day.discountFen)}`} tone="bad" />
            <Stat k="赠品成本" v={`¥${fenToStr(day.giftCostFen)}`} />
          </div>

          <ExcludedLine count={day.voidedCount} fen={day.voidedFen} scope="day" onOpen={onOpenVoided} />

          {!day.grossKnown ? (
            <p className="report-note">
              今天有 {day.costIncompleteSessions} 场成本待补（缺批次），补录进货后毛利会自动恢复。
            </p>
          ) : null}
        </>
      ) : (
        /* P2-6：空态给下一步，而不是只报「没有」 */
        <Empty
          icon={<Sun size={24} />}
          text="今天还没有已结账的场次"
          action={
            <Btn block={false} size="sm" onClick={hasOpenSession ? onGoCurrent : onGoRecord}>
              {hasOpenSession ? '去看进行中这一场' : '去记一笔'}
            </Btn>
          }
        />
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

/**
 * 「补过 N 单」明细（P2-7）。
 *
 * 数据来源（为什么不用新字段）：`SalesOrder` 没有 patchedAt / patched 标记，
 * `repo.addPatchedRecord` 写的就是一张普通订单，只在 Session 上 patchedCount+1。
 * 但补记只允许发生在结账之后，所以「本场里 createdAt 晚于 closedAt 的未删除单」
 * 就是补记单，createdAt 就是补记时间 —— 不需要改 db 层，也不怕旧数据没有标记。
 * 时间格式统一是 nowIso() 的 UTC ISO（`...Z`），字符串比较即时间比较。
 *
 * 补记单如果后来被删除，这里列出的会比 patchedCount 少；副标题如实给出总数。
 */
function PatchedSheet({
  session,
  orders,
  lines,
  productByName,
  onClose
}: {
  session: Session;
  orders: SalesOrder[];
  lines: SaleLine[];
  productByName: Map<string, Product>;
  onClose: () => void;
}) {
  const summaryByOrder = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lines) {
      const p = productByName.get(l.productId);
      const text = `${p?.name ?? DELETED_PRODUCT} ${qtyToStr(l.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')}`;
      m.set(l.orderId, m.has(l.orderId) ? `${m.get(l.orderId)}、${text}` : text);
    }
    return m;
  }, [lines, productByName]);

  return (
    <Sheet
      title={`这一场补过的 ${session.patchedCount} 单`}
      subtitle={`共 ${orders.length} 笔 · 按补记时间倒序`}
      onClose={onClose}
    >
      {orders.length === 0 ? (
        <Empty
          icon={<PenLine size={24} />}
          text="没有找到补记单明细"
          hint="补记单可能已被删除，或另一台手机的数据还没同步过来"
        />
      ) : (
        <ul className="glass-list">
          {orders.map((o) => (
            <li key={o.id} className="glass-list__item">
              <span className="glass-list__leading">
                <PenLine size={20} aria-hidden="true" />
              </span>
              <div className="glass-list__content">
                <div className="glass-list__title-row">
                  <div className="glass-list__title">
                    {isoToLocalDate(o.createdAt)} {isoToTime(o.createdAt)} · {o.operator}
                  </div>
                  <span className="glass-badge">{PAY_LABEL[o.payMethod]}</span>
                </div>
                <div className="glass-list__subtitle">
                  {summaryByOrder.get(o.id) ?? '商品明细缺失'}
                </div>
              </div>
              <div className="glass-list__trailing">
                <span className="report-patched-amount">¥{fenToStr(o.totalFen)}</span>
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
  isLocal,
  onOpenPicker,
  onOpenPatched,
  onCopy,
  onPatchSession,
  onGoRecord,
  onOpenVoided
}: {
  selected?: Session;
  summary: SessionReport;
  payTotal: number;
  payMismatch: boolean;
  costMissing: boolean;
  /** 是否本机场次：只有本机才能补记；另一台手机的场次要标出来，免得用户找不到「补记」 */
  isLocal: boolean;
  onOpenPicker: () => void;
  onOpenPatched: () => void;
  onCopy: () => void;
  onPatchSession: () => void;
  onGoRecord: () => void;
  onOpenVoided: () => void;
}) {
  if (!selected) {
    return (
      <>
        {/*
          无场次也要给出一致的状态标签（「还没有场次」）：此时没有可切换的对象，
          所以只做展示、不做按钮，避免一个点开也是空列表的死入口。
        */}
        <div className="report-session-head">
          <span className="report-session-switch report-session-switch--static">
            <CalendarRange size={16} aria-hidden="true" />
            <span className="report-session-switch__scope">还没有场次</span>
          </span>
        </div>
        <Empty
          icon={<PenLine size={24} />}
          text="还没有场次，记一笔就开始这一场"
          action={
            <Btn block={false} size="sm" onClick={onGoRecord}>
              记一笔
            </Btn>
          }
        />
      </>
    );
  }
  return (
    <>
      {/*
        卡头 = 「当前是哪一场」+「怎么切换」合一（P0-2 / D / E）。
        旧浮胶囊浮在内容上压住本场现金行与毛利值，文案「历史场次」也与
        Sheet 首行「进行中这一场」矛盾；这里把它落到卡头，44px、拇指区、不遮任何金额。
      */}
      <div className="row-between report-session-head">
        <SessionSwitchButton selected={selected} onOpenPicker={onOpenPicker} />
        <div className="row" style={{ gap: 8 }}>
          {/* 另一台手机的场次：标出来，用户就不会疑惑为什么没有「补记」 */}
          {!isLocal ? <span className="glass-badge report-foreign-badge">另一台手机</span> : null}
          {/*
            P2-7：徽标改成可点按钮（44px 命中区，视觉仍是 27px 徽标），
            点开列出补了哪几单，不用再去「更多 → 销售记录」翻。
          */}
          {selected.patchedCount > 0 ? (
            <button
              type="button"
              className="report-patch-btn"
              aria-haspopup="dialog"
              aria-label={`查看这一场补过的 ${selected.patchedCount} 单`}
              onClick={onOpenPatched}
            >
              <span className="glass-badge glass-badge--primary glass-badge--interactive">
                补过 {selected.patchedCount} 单
              </span>
            </button>
          ) : null}
          {selected.status === 'closed' && isLocal ? (
            <button type="button" className="link-btn" onClick={onPatchSession}>
              补记
            </button>
          ) : null}
        </div>
      </div>

      {/* 时间范围仍是只读的次级信息：状态已由上面的徽标承担，这里只补具体起止时间 */}
      <div className="tiny-text report-session-range">{sessionRange(selected)}</div>

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
        {/*
          P1-8：正常时**不显示**「合计校验 ✓」。
          payTotal 只是 cash+wechat+alipay 再相加，与 revenueFen 同源于
          order.totalFen，恒等成立；打绿勾会让摊主误以为「现金箱已对过账」。
          只有脏数据兜底（payMismatch）才亮红，并提示这不是现金短款。
        */}
        {payMismatch ? (
          <div className="pay-row pay-row--check">
            <span>收款合计</span>
            <span className="bad">¥{fenToStr(payTotal)} ≠</span>
          </div>
        ) : null}
      </div>

      {/* 操作条：只服务上面的本场数字，所以紧贴三行收款，不再挂在单品表底部（A） */}
      <div className="report-actions">
        <Btn
          block={false}
          variant="secondary"
          size="sm"
          onClick={onCopy}
          disabled={summary.orderCount === 0}
        >
          <span className="icon-text">
            <Copy size={16} aria-hidden="true" /> 复制本场汇总
          </span>
        </Btn>
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
        scope="session"
        onOpen={onOpenVoided}
      />

      <p className="tiny-text" style={{ marginBottom: 0, marginTop: 12 }}>
        成本按批次先进先出算（FIFO）。毛利 = 销售额 − 成本。赠品金额 0、成本照算，单独列示。
      </p>
    </>
  );
}

/**
 * 单品毛利表：排序 state 与表头都在这里。
 *
 * 这里**只放表格**：单品卡不再承载任何跨卡操作（A）。「复制本场汇总」在
 * 本场汇总卡里，否则要穿过整张表才够得到（实测 1223px）。
 */
function MarginTable({
  margins,
  productByName,
  selected,
  voidedCount
}: {
  margins: ProductMargin[];
  productByName: Map<string, Product>;
  selected?: Session;
  /** 本场被删除的单数：只有删除单的场次不能说成「还没卖东西」（M1） */
  voidedCount: number;
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
        {/*
          P2-3：缺成本的行永远置顶（H3 的安全默认），所以标题不能只说「按毛利降序」。
          aria-sort 仍只表达点击列的方向，不受这句补充说明影响。
        */}
        <h2>
          {`单品（按${sort === 'gross' ? '毛利' : sort === 'revenue' ? '销售额' : '数量'}降序，成本待补置顶）`}
        </h2>
        {selected ? <span className="tiny-text">{sessionLabel(selected)}</span> : null}
      </div>
      {sortedMargins.length === 0 ? (
        <Empty
          icon={<TrendingUp size={24} />}
          text={
            selected
              ? voidedCount > 0
                ? `这一场没有有效销售（${voidedCount} 笔已删除，可在上方「看这一场的 ${voidedCount} 笔」撤销）`
                : '这一场还没卖东西'
              : '还没有场次'
          }
          /*
            B/C：这里不再放「记一笔」或「补记到这一场」按钮。
            补记的唯一入口在本场卡头，记一笔的唯一入口在空账本的空态里；
            重复按钮会让摊主不知道该点哪个，还容易重复补记。
            只留一句纯文案指向正确位置。
          */
          hint={
            !selected
              ? '先在上方「记一笔」开始这一场'
              : selected.status === 'closed'
                ? '点上方「补记」可补录'
                : '用底栏「记账」开单'
          }
        />
      ) : (
        <div className="glass-table-wrap">
          <table className="glass-table report-table">
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
                      {m.giftQty ? `${m.giftQty} · ¥${fenToStr(m.giftCostFen ?? 0)}` : '无'}
                    </td>
                    <td className="glass-table__num">¥{fenToStr(m.costFen)}</td>
                    <td
                      className="glass-table__num"
                      style={{
                        // 缺成本的行不许用「盈利绿」：毛利本身就是未知，颜色降为次要文字
                        color: m.costIncomplete
                          ? 'var(--gl-color-text-muted)'
                          : m.grossFen >= 0
                            ? 'var(--yh-ok-ink)'
                            : 'var(--yh-bad-ink)',
                        fontWeight: 'var(--yh-weight-semibold)'
                      }}
                    >
                      {/*
                        P0-3：汇总 hero 成本待补时显示「—」，本行必须同样说「—」。
                        以前这里显示「¥5.00~」，同一屏对「这一场赚多少」给出两个答案，
                        摊主会拿表格里那个数去定价。
                      */}
                      {m.costIncomplete ? '—' : `¥${fenToStr(m.grossFen)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/*
        P0-3 脚注：只在真的有「—」时出现，解释它和 0 的区别。
        赠品列的空值已改用「无」，避免和「毛利未知」共用同一个破折号。
      */}
      {sortedMargins.some((m) => m.costIncomplete) ? (
        <p className="tiny-text report-table-footnote">
          — = 成本待补，毛利暂不可算；去「进货」补录后自动恢复。
        </p>
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
        /* P2-6：空态写明窗口口径，和右上角「N 天内」一致；warnDays 来自设置，不写死 */
        <Empty icon={<TriangleAlert size={24} />} text={`${warnDays} 天内没有到期批次`} />
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
  /** 「补过 N 单」明细弹层（P2-7） */
  const [patchedOpen, setPatchedOpen] = useState(false);
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

  // 本机进行中的场次：与首页共用 db/sessionLogic.pickOpenSession 的口径。
  // 进行中只属于开它的那台手机，所以这里**不**跨设备。
  const openSession = useMemo(
    () => pickOpenSession(sessions, deviceId),
    [sessions, deviceId]
  );

  /**
   * P1-7：场次 Sheet 要能下钻今天合计里的**每一场**，而 `dayReport` 用的是全部
   * `sessions`（两台手机同步到本机 IndexedDB 的行都在），所以这里也按全部设备过滤。
   *
   * 旧实现用 `deviceSessions`（本机），于是今天卡「已结账 2 场 · ¥439.50」
   * 而 Sheet 只有本机 1 场 ¥389.50 —— 另一台手机的 ¥50 场次无法下钻。
   * 排序仍按 closedAt 倒序；数据只同步了一半时，就显示已同步的部分，不额外报错。
   */
  const closed = useMemo(
    () =>
      sessions
        .filter((s) => s.status === 'closed')
        .sort((a, b) => ((a.closedAt ?? a.startedAt) < (b.closedAt ?? b.startedAt) ? 1 : -1)),
    [sessions]
  );

  /** 今天已结账场次里，属于其它设备的数量（今天卡提示「含另一台手机 N 场」） */
  const externalClosedTodayCount = useMemo(() => {
    let n = 0;
    for (const s of sessions) {
      if (s.status !== 'closed' || !s.closedAt) continue;
      if (isoToLocalDate(s.closedAt) !== today) continue;
      if (s.deviceId !== deviceId) n += 1;
    }
    return n;
  }, [sessions, deviceId, today]);

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
   * P2-7：补记单 = 本场里 createdAt 晚于 closedAt 的未删除单。
   * 见 PatchedSheet 的注释：不改 db 层，用时间先后作等价标记。
   */
  const sessionPatchedOrders = useMemo(() => {
    const closedAt = selected?.closedAt;
    if (!selected || !closedAt) return [];
    return newestFirst(
      orders.filter((o) => !o.voided && o.sessionId === selected.id && o.createdAt > closedAt)
    );
  }, [orders, selected]);

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
      // P1-8：对账异常必须跟着复制文本走，否则发到微信里对方只看到一串干净数字
      payMismatch
        ? `⚠ 收款合计 ¥${fenToStr(payTotal)} 与销售额 ¥${fenToStr(summary.revenueFen)} 不符，请在 App 里核对`
        : '',
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
      <TodayCard
        day={day}
        externalCount={externalClosedTodayCount}
        hasOpenSession={Boolean(openSession)}
        onGoCurrent={() => {
          // 切回进行中这一场：mode 是内部状态，标签仍由 selected.status 决定
          setMode('current');
          setPickedId(null);
        }}
        onGoRecord={onGoRecord}
        onOpenVoided={() => setVoidedSheet('today')}
      />

      <Card>
        <SessionSummaryCard
          selected={selected}
          summary={summary}
          payTotal={payTotal}
          payMismatch={payMismatch}
          costMissing={costMissing}
          isLocal={selected?.deviceId === deviceId}
          onOpenPicker={() => setPickerOpen(true)}
          onOpenPatched={() => setPatchedOpen(true)}
          onCopy={copySummary}
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
            <strong>这是数据异常，不是现金短款；现金请自己数一遍。</strong>
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
        voidedCount={summary.voidedCount}
      />

      <ExpiryWarnings warnings={warnings} warnDays={warnDays} productById={productByName} />

      {voidedSheet ? (
        <VoidedSheet
          title={voidedSheet === 'today' ? '今天被删除的单' : '这一场被删除的单'}
          orders={voidedSheet === 'today' ? todayVoided : sessionVoided}
          restoringId={restoring}
          onUndo={(id) => void undoDelete(id)}
          onClose={() => setVoidedSheet(null)}
        />
      ) : null}

      {/* P2-7：补记明细只在选中场次存在时打开 */}
      {patchedOpen && selected ? (
        <PatchedSheet
          session={selected}
          orders={sessionPatchedOrders}
          lines={lines}
          productByName={productByName}
          onClose={() => setPatchedOpen(false)}
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
                    <div className="glass-list__title-row">
                      <div className="glass-list__title">
                        {isoToLocalDate(s.startedAt)} · {isoToTime(s.startedAt)}
                        {s.patchedCount > 0 ? ` · 补过 ${s.patchedCount} 单` : ''}
                      </div>
                      {/* P1-7：中性徽标说明这是另一台手机的场次，不是异常 */}
                      {s.deviceId !== deviceId ? (
                        <span className="glass-badge report-foreign-badge">另一台手机</span>
                      ) : null}
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