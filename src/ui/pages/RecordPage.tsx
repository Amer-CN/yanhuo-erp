import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Clock, Receipt, Sparkles, WifiOff } from 'lucide-react';
import type { Product, SaleLine, SalesOrder, Session, SessionSummary } from '../../db/types';
import { PAY_LABEL } from '../../db/types';
import { fenToStr, isoToLocalDate, isoToTime, localDate } from '../../db/util';
import { Btn, Card, Empty, Sheet, Toast, rowProps } from '../kit';

function startLabel(session: Session): string {
  const d = new Date(session.startedAt);
  if (Number.isNaN(d.getTime())) return session.startedAt;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${isoToTime(
    session.startedAt
  )}`;
}

function orderSummary(order: SalesOrder, lines: SaleLine[], products: Map<string, Product>): string {
  const ls = lines.filter((l) => l.orderId === order.id);
  if (ls.length === 0) return '没有明细';
  const shown = ls.slice(0, 2).map((l) => {
    const p = products.get(l.productId);
    return `${p?.name ?? '已删商品'} ×${l.qty}${l.gift ? '（赠）' : ''}`;
  });
  return ls.length > 2 ? `${shown.join(' · ')} 等 ${ls.length} 种` : shown.join(' · ');
}

/**
 * 记账首页：本场概览 + 最近流水 + 记一笔。
 * 金额是本场累计，不是自然日。
 */
export default function RecordPage({
  session,
  summary,
  orders,
  lines,
  products,
  online,
  lastClosed,
  onNewRecord,
  onOpenOrder,
  onCloseSession,
  onReopenLastClosed,
  onOpenLastReport,
  onOpenHistory,
  onGoStock
}: {
  session?: Session;
  summary: SessionSummary;
  orders: SalesOrder[];
  lines: SaleLine[];
  products: Product[];
  online: boolean;
  /**
   * P5：今天最近一次已结账的场次（App 算好传进来，会计口径在那边定死）。
   * 只有「没有进行中场次」时才用得上 —— 有场次时它一定是 null。
   */
  lastClosed: { session: Session; summary: SessionSummary } | null;
  onNewRecord: () => void;
  onOpenOrder: (id: string) => void;
  onCloseSession: () => void;
  /** 撤销上一场结账；失败原因由 App 侧 Toast 出来（不在这里吞错） */
  onReopenLastClosed: () => Promise<void>;
  /** 「看本场」→ 报表（默认停在本场 / 最近已结账那一场） */
  onOpenLastReport: () => void;
  onOpenHistory: () => void;
  onGoStock: () => void;
}) {
  /*
   * 跨天未结的三件套，全是这一页的局部状态（不往上提全局）：
   * - crossDayOpen：处理面板开着没；
   * - crossDayDismissed：「这次跨天已经处理过 / 明确选了继续记」——只负责**不再自动提醒**，
   *   不负责隐藏徽标。徽标必须一直在，用户随时能改主意；
   * - crossDayHint：进页面时那一次性的 Toast 文案（按本地日期去重，见下面的 effect）。
   */
  const [crossDayDismissed, setCrossDayDismissed] = useState(false);
  const [crossDayOpen, setCrossDayOpen] = useState(false);
  const [crossDayHint, setCrossDayHint] = useState<string | null>(null);
  /*
   * 「这一场还没记单 / 账面没货可能是漏记进货」的引导。
   * 原来是一条常驻 .link-btn（高约 44px，天天占一屏），但它只是低频排查线索：
   * (a) 进页面首次弹一次 Toast，按**场次 id** 用 sessionStorage 去重（同一场只提醒一次，
   *     换了场次再提醒——文案说的是「这一场」，按日期去重会串场）；
   * (b) 本场卡片的 0 单区域里留一个 12px 文字链当常驻入口，不占独立一行、不压结算浮条。
   */
  const [stockHint, setStockHint] = useState<string | null>(null);
  /**
   * P5：撤销结账的进行中标记（局部状态，不上提）。
   * 收摊是低频但不可逆的动作，点一下没反应比点两下更糟 —— 按钮要有「撤销中…」。
   */
  const [reopening, setReopening] = useState(false);

  const handleReopen = async () => {
    if (reopening) return;
    setReopening(true);
    try {
      await onReopenLastClosed();
    } finally {
      setReopening(false);
    }
  };

  const productMap = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const recent = useMemo(
    () =>
      [...orders]
        .filter((o) => !o.voided)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 8),
    [orders]
  );

  const crossDay = Boolean(session && isoToLocalDate(session.startedAt) < localDate());
  const hasSession = Boolean(session);
  const empty = summary.orderCount === 0;
  const sessionId = session?.id ?? null;

  /*
   * 跨天提醒从「常驻 72px 大卡片」改成「一次性 Toast + 标题旁小徽标」。
   * 去重口径：按**本地日期**记在 sessionStorage —— 同一天反复切 tab 不再骚扰，
   * 但跨天这事儿一天至少露一次脸。sessionStorage 拿不到（隐私模式）就只靠本页 state，
   * 最坏结果是多提示一次，不会丢信息。
   */
  useEffect(() => {
    if (!crossDay || crossDayDismissed) return;
    const key = `yh-crossday-hint-${localDate()}`;
    try {
      if (sessionStorage.getItem(key) === '1') return;
      sessionStorage.setItem(key, '1');
    } catch {
      /* 隐私模式：只靠下面的 state 与 crossDayDismissed 去重 */
    }
    setCrossDayHint('昨天那场还没结账，点标题旁的标记处理');
  }, [crossDay, crossDayDismissed]);

  // Toast 自己退场：6 秒够读完一行，又不至于长时间压在流水和弹层上方
  useEffect(() => {
    if (!crossDayHint) return;
    const timer = window.setTimeout(() => setCrossDayHint(null), 6000);
    return () => window.clearTimeout(timer);
  }, [crossDayHint]);

  /*
   * 有场次但 0 单：进页面首次提醒「可能漏记进货」。
   * 去重键带场次 id —— 提醒针对的是「这一场」，同一场反复切 tab 不再啰嗦，
   * 但换一场（哪怕同一天）应该再露一次脸；sessionStorage 不可用时最坏多提示一次。
   */
  useEffect(() => {
    if (!sessionId || !empty) return;
    const key = `yh-empty-session-hint-${sessionId}`;
    try {
      if (sessionStorage.getItem(key) === '1') return;
      sessionStorage.setItem(key, '1');
    } catch {
      /* 隐私模式：只靠本页 state 去重 */
    }
    setStockHint('这一场还没记单。如果账面没货，可能是漏记进货了');
  }, [sessionId, empty]);

  useEffect(() => {
    if (!stockHint) return;
    const timer = window.setTimeout(() => setStockHint(null), 6000);
    return () => window.clearTimeout(timer);
  }, [stockHint]);

  /* 关掉面板 = 「这次我知道了」：auto 提醒不再弹，但徽标照旧常驻 */
  const dismissCrossDay = () => {
    setCrossDayDismissed(true);
    setCrossDayOpen(false);
  };

  /*
   * 打开面板时立刻收掉提醒：Toast 和 Sheet 都停在底部同一块区域，
   * 同时出现会盖住弹层标题（实测截图里「这场还没结账」被压住一半）。
   * 点了徽标就说明用户已经看见了，提醒没有存在意义。
   */
  const openCrossDayPanel = () => {
    setCrossDayHint(null);
    // 两条提示都停在顶部同一个位置，跨天这条更重要：打开面板时把另一条也收掉
    setStockHint(null);
    setCrossDayOpen(true);
  };

  return (
    <div className="page-stack">
      {!online ? (
        <div className="offline-note" role="status">
          <WifiOff size={16} aria-hidden="true" />
          <span>离线，照常记账；联网自动补发</span>
        </div>
      ) : null}

      {/*
        2026-11-11：这里原来是一张 .first-run-card--warn（约 72px，两个按钮）。
        它跨天就常驻，等于每天开场先吃掉一屏，而「继续记 / 去结账」其实是低频决策。
        现在改成：本场标题行上的小徽标（下面 session-head__line 里）+ 首次进入的一次性 Toast，
        面板里再讲清后果。徽标和卡片下方的「收摊结账」按钮是两个入口，文案不重复。
      */}

      <Card>
        {hasSession && session ? (
          <>
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              {/*
               * .session-summary 只做一件事：给左侧这列 min-width:0。
               * 不加的话金额（¥1234.50）是不收缩的，右边按钮被挤窄后
               * 「收摊结账」四个字会折成「收摊结 / 账」。
               */}
              <div className="session-summary">
                <div className="session-head__line">
                  <span className="tiny-text">本场 · {startLabel(session)} 开始</span>
                  {/*
                   * 跨天未结的徽标：只在开场日期 < 今天时出现（口径没变，别改成按自然日算金额）。
                   * 为什么必须留着它：一场（session）是**连续经营单元**，跨天没结 = 昨天没结。
                   * 这时候「继续记」会把今天的单并进昨天那一场，报表按场次统计时两天的金额分不开，
                   * 结账时间与 closedBy 也会落错。徽标就是让这件事随时可见、随时可改的入口。
                   */}
                  {crossDay ? (
                    <button
                      type="button"
                      className="crossday-pill"
                      aria-label="跨天未结账，打开处理面板"
                      onClick={openCrossDayPanel}
                    >
                      <span className="crossday-pill__text">跨天未结</span>
                    </button>
                  ) : null}
                </div>
                <div className="session-summary__revenue" aria-live="polite">
                  ¥{fenToStr(summary.revenueFen)}
                </div>
                <div className="session-summary__meta">已记 {summary.orderCount} 单</div>
              </div>
              <Btn
                block={false}
                size="sm"
                variant="secondary"
                className="session-close-btn"
                disabled={empty}
                onClick={onCloseSession}
                title={empty ? '还没记单' : undefined}
              >
                收摊结账
              </Btn>
            </div>

            {empty ? (
              /*
               * 本场 0 单区域。原来是三行支付方式、全是 ¥0，等于白占半张卡。
               * 这里换成一句状态 + 12px 文字链：常驻入口还在，但不占独立一行，
               * 也不像原来那样悬在结算浮条上方 44px。
               */
              <div className="session-empty">
                <Clock size={22} aria-hidden="true" />
                <div>
                  <div className="tiny-text">这一场还没记单</div>
                  <button type="button" className="link-btn link-btn--xs" onClick={onGoStock}>
                    去库存看看
                  </button>
                </div>
              </div>
            ) : (
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
              </div>
            )}
          </>
        ) : (
          <div className="session-empty">
            <Clock size={22} aria-hidden="true" />
            <div>
              <div className="first-run-card__title">还没开张</div>
              <div className="tiny-text">记一笔就开始这一场；第一单会自动开场</div>
            </div>
          </div>
        )}
      </Card>

      {/*
        P5：上一场汇总条（只在「没有进行中场次」且今天刚结过账时出现）。
        为什么需要它：撤销结账原来只活在结账流程的结果弹层里，点「完成」之后
        全应用再没有入口；而收摊是每天一次的不可逆动作，「结完发现漏了一单」
        必然发生。这里是那条逃生通道：一行文字 + 两个操作，≤56px，不做成大卡片
        （它只在该出现的几分钟内有用，常驻大卡会把「记一笔」挤出首屏）。
      */}
      {!hasSession && lastClosed ? (
        <div className="last-session-bar">
          <span className="last-session-bar__text">
            上一场 {isoToTime(lastClosed.session.closedAt ?? lastClosed.session.startedAt)} 结账 ·{' '}
            {lastClosed.summary.orderCount} 单 ¥{fenToStr(lastClosed.summary.revenueFen)}
          </span>
          <button type="button" className="link-btn link-btn--xs last-session-bar__more" onClick={onOpenLastReport}>
            看本场
          </button>
          <Btn
            block={false}
            size="sm"
            variant="secondary"
            disabled={reopening}
            aria-label="撤销结账，让这一场回到进行中"
            onClick={() => void handleReopen()}
          >
            {reopening ? '撤销中…' : '撤销结账'}
          </Btn>
        </div>
      ) : null}

      <Card flush>
        <div className="form-head form-head--inset">
          <h2>本场流水</h2>
          <button type="button" className="link-btn" onClick={onOpenHistory}>
            看全部
          </button>
        </div>

        {recent.length === 0 ? (
          <Empty
            icon={<Receipt size={24} />}
            text="这一场还没记单"
            action={
              <Btn block={false} size="sm" onClick={onNewRecord}>
                记一笔
              </Btn>
            }
          />
        ) : (
          <ul className="glass-list" style={{ borderRadius: 'var(--yh-radius-lg)' }}>
            {recent.map((o) => (
              <li
                key={o.id}
                className="glass-list__item glass-list__item--interactive list-item"
                {...rowProps(() => onOpenOrder(o.id))}
              >
                <div className="glass-list__content">
                  <div className="glass-list__title-row">
                    <div className="glass-list__title">
                      {isoToTime(o.createdAt)} · {o.operator} · {PAY_LABEL[o.payMethod]}
                    </div>
                    <span className="amount">¥{fenToStr(o.totalFen)}</span>
                  </div>
                  <div className="glass-list__subtitle">{orderSummary(o, lines, productMap)}</div>
                </div>
                <div className="glass-list__trailing">
                  <ChevronRight size={18} aria-hidden="true" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 常驻的「账面没货？去库存看看」已收进本场卡片的 0 单区域（见上），
          不再单独占一行 44px 的 link-btn */}

      <div className="checkout-dock record-dock">
        <div className="checkout-dock__total" style={{ textAlign: 'left', marginLeft: 0 }}>
          <div className="k">本场已记 {summary.orderCount} 单</div>
          <div className="v">¥{fenToStr(summary.revenueFen)}</div>
        </div>
        <Btn block={false} onClick={onNewRecord}>
          <span className="icon-text">
            <Sparkles size={18} aria-hidden="true" /> 记一笔
          </span>
        </Btn>
      </div>

      {/*
        跨天未结的处理面板。复用 kit 里的 Sheet，不另造组件。
        这里必须把「继续记」的后果讲白 —— 它不是「关掉一个提示」，而是账务口径的选择：
        一场 = 连续经营单元，跨天不结就是把今天并进昨天那场。
      */}
      {crossDay && session && crossDayOpen ? (
        <Sheet
          title="这场还没结账"
          onClose={dismissCrossDay}
          footer={
            <div className="stack-sm">
              <Btn block variant="secondary" onClick={dismissCrossDay}>
                继续记
              </Btn>
              <Btn
                block
                onClick={() => {
                  dismissCrossDay();
                  onCloseSession();
                }}
              >
                去结账
              </Btn>
            </div>
          }
        >
          <div className="page-stack">
            <p className="muted-text" style={{ margin: 0 }}>
              从 {startLabel(session)} 开到 现在 · 已记 {summary.orderCount} 单 ¥
              {fenToStr(summary.revenueFen)}
            </p>
            <p className="tiny-text" style={{ margin: 0 }}>
              <strong>继续记</strong>：今天的单会并进这一场，两天的金额分不开；
              <strong>去结账</strong>：先把这场结掉，今天开新的一场。
            </p>
          </div>
        </Sheet>
      ) : null}

      {/*
        一次性提醒（不是常驻卡片）：进来时告诉用户「标记在标题旁」，
        说完自己走，不占版面。同一天只提醒一次（见上面的 sessionStorage 去重）。
      */}
      {crossDayHint && !crossDayOpen ? (
        <Toast message={crossDayHint} tone="warning" onClose={() => setCrossDayHint(null)} />
      ) : null}

      {/*
        0 单提醒：Toast 现在统一停在顶部（见 record.css 的 .glass-toast.toast），
        和跨天提醒是同一个位置，所以两条不同时出——跨天这条会改账务口径，优先级更高。
        action 文案刻意不带「撤销」二字：M-16 的保护规则会把带「撤销」的按钮判成
        「必须等用户表态」，提示条就不再自动消失。
      */}
      {stockHint && !crossDayHint && !crossDayOpen ? (
        <Toast
          message={stockHint}
          tone="warning"
          action="去库存"
          onAction={() => {
            setStockHint(null);
            onGoStock();
          }}
          onClose={() => setStockHint(null)}
        />
      ) : null}
    </div>
  );
}