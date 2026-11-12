import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react';
import {
  Boxes,
  ChartColumn,
  ChevronLeft,
  MoreHorizontal,
  PackagePlus,
  PenLine,
  Sparkles,
  TriangleAlert
} from 'lucide-react';
import { setSetting } from '../db/repo';
import {
  SETTING_KEYS,
  type AppData,
  type SalesOrder,
  type Session,
  type SessionSummary
} from '../db/types';
import type { FifoResult } from '../db/calc';
import { Btn, Card, Empty, Toast, type Done, type ToastTone } from './kit';
import { ErrorBoundary, PageErrorFallback } from './ErrorBoundary';
import UpdateBar from './UpdateBar';
import MorePage from './MorePage';
import RecordPage from './pages/RecordPage';
import type { RecordDraft } from './recordDraft';
import type { SyncApi } from './useSync';

export type Tab = 'record' | 'purchase' | 'stock' | 'report' | 'more';
export type SubPage = 'products' | 'history' | 'settings' | null;
export type Theme = 'dark' | 'light';

export interface EditorState {
  mode: 'new' | 'edit' | 'patch';
  orderId?: string;
  sessionId?: string;
}

const TABS: { key: Tab; label: string; icon: typeof Sparkles }[] = [
  { key: 'record', label: '记账', icon: PenLine },
  { key: 'purchase', label: '进货', icon: PackagePlus },
  { key: 'stock', label: '库存', icon: Boxes },
  { key: 'report', label: '报表', icon: ChartColumn },
  { key: 'more', label: '更多', icon: MoreHorizontal }
];

const TAB_TITLE: Record<Tab, string> = {
  record: '记账',
  purchase: '进货',
  stock: '库存',
  report: '报表',
  more: '更多'
};

const SUB_TITLE: Record<Exclude<SubPage, null>, string> = {
  products: '商品管理',
  history: '销售记录',
  settings: '设置与同步'
};

/** 示例商品 Toast 的「本次会话已提醒过」标记（L-10，sessionStorage） */
const SAMPLE_TOAST_KEY = 'yh-sample-toast-shown';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('yh-theme');
    return saved === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** 主题：dataset + theme-color + localStorage，与原 App 内逻辑一致 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    /*
     * L-06：Safari 隐私模式下 localStorage.setItem 会抛错，不 catch 的话
     * 整个 effect 从这里中断，下面的 theme-color 永远停在旧值
     * —— 状态栏与实际主题对不上，而且不会自愈。写法与 recordDraft 的存草稿一致。
     */
    try {
      localStorage.setItem('yh-theme', theme);
    } catch {
      /* 存不下就只作用于本次会话 */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#070a10' : '#eef2f6');
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return { theme, toggleTheme };
}

/**
 * 顶栏右槽的同步状态点（诉求 6 腾出的位置）。
 * 颜色只用于一眼扫；形状 / 数字 / 符号保证色弱用户也能区分：
 *   空心灰环 = 离线（或未开云同步）、实心橙 + 数字 = 待推送 N 条、
 *   实心绿 + ✓ = 已同步、实心红 + ! = 同步出错。
 * 点击只弹 Toast 说明，不新增全局状态。
 */
function SyncDot({ sync, showToast }: { sync: SyncApi; showToast: Done }) {
  const state: 'ok' | 'pending' | 'offline' | 'error' | 'off' = sync.error
    ? 'error'
    : !sync.configured
      ? 'off'
      : !sync.online
        ? 'offline'
        : sync.pending > 0
          ? 'pending'
          : 'ok';

  const clock = (ts: number | null): string => {
    if (!ts) return '';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return d.toDateString() === new Date().toDateString()
      ? `${hh}:${mm}`
      : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  };
  const last = clock(sync.lastSyncAt);

  // 统一以「同步状态：」开头：避免与底部「记账」页签的可访问名撞车
  // （Playwright get_by_role(name=...) 默认是子串匹配，strict 模式会因两个按钮都含「记账」而报错）。
  const label =
    state === 'error'
      ? '同步状态：同步出错，数据还在本机'
      : state === 'off'
        ? '同步状态：未开启云同步'
        : state === 'offline'
          ? '同步状态：离线，联网自动补发'
          : state === 'pending'
            ? `同步状态：待推送 ${sync.pending} 条`
            : last
              ? `同步状态：已同步，上次 ${last}`
              : '同步状态：已同步';
  const color =
    state === 'error'
      ? 'var(--yh-ink-bad)'
      : state === 'pending'
        ? 'var(--yh-ink-warn)'
        : state === 'ok'
          ? 'var(--yh-ink-ok)'
          : 'var(--yh-ink-4)';
  const filled = state === 'ok' || state === 'pending' || state === 'error';
  // 角标只放得下 2 位；真实条数在 aria-label 与 Toast 里给全
  /*
   * M-06：「未开启云同步」(off) 与「离线」(offline) 后果完全不同
   * —— off 永远不会往云端备份，offline 只是暂缓、联网自动补发。
   * 老实现两者都是同一个空心灰环、都没有 mark，强光/色弱下只能靠点开读 Toast 分辨。
   * 现在：off = 虚线环 + 「—」，offline = 实线空心环（无 mark），再配合下面的 aria-label/title。
   */
  const mark =
    state === 'error'
      ? '!'
      : state === 'pending'
        ? sync.pending > 99
          ? '99+'
          : String(sync.pending)
        : state === 'ok'
          ? '✓'
          : state === 'off'
            ? '—'
            : '';

  const showDetail = () => {
    if (state === 'error') {
      showToast(`同步出错：${sync.error}。数据还在本机，联网后会自动重试`, 'error');
    } else if (state === 'off') {
      showToast('没开启云同步，账本只在这台手机上。到「设置与同步」可以开启', 'warning');
    } else if (state === 'offline') {
      showToast(
        `离线，联网后自动补发${sync.pending > 0 ? `（待推送 ${sync.pending} 条）` : ''}`,
        'warning'
      );
    } else if (state === 'pending') {
      showToast(`待推送 ${sync.pending} 条，联网 / 回到前台时自动同步`, 'warning');
    } else {
      showToast(last ? `已同步 · 上次同步 ${last}` : '已同步', 'success');
    }
  };

  return (
    <button
      type="button"
      className="glass-pill"
      onClick={showDetail}
      aria-label={label}
      title={label}
      style={{
        minWidth: 44,
        height: 44,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: '0 8px'
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          boxSizing: 'border-box',
          background: filled ? color : 'transparent',
          /* 形状也要能区分（M-06）：off=虚线环，offline=实线空心环，不能只靠颜色 */
          border: filled ? 'none' : `2px ${state === 'off' ? 'dashed' : 'solid'} ${color}`
        }}
      />
      {mark ? (
        <span
          aria-hidden="true"
          style={{ fontSize: 11, fontWeight: 700, lineHeight: 1, color }}
        >
          {mark}
        </span>
      ) : null}
    </button>
  );
}

/**
 * 路由指纹：错误边界 resetKey 与「滚动位置记忆」共用一套口径。
 * 两处各拼一遍迟早会漂（例如只在一边加了 editor.orderId）。
 */
function routeKeyOf(tab: Tab, sub: SubPage, editor: EditorState | null): string {
  return `${tab}|${sub ?? ''}|${
    editor ? `${editor.mode}:${editor.orderId ?? editor.sessionId ?? ''}` : ''
  }`;
}

/** 顶栏与底部导航独立成组件：数据未就绪时也能先渲染外壳，缩短首屏等待 */
function AppHeader({
  title,
  sub,
  sync,
  showToast,
  onBack
}: {
  title: string;
  sub: SubPage;
  sync: SyncApi;
  showToast: Done;
  onBack: () => void;
}) {
  return (
    <header className="glass-nav app-nav">
      {sub ? (
        <button className="glass-pill back-btn" onClick={onBack} aria-label="返回" type="button">
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
      ) : (
        <img className="app-brand" src="./brand-128.png" alt="" aria-hidden="true" />
      )}
      <h1 className="glass-title">{title}</h1>
      <SyncDot sync={sync} showToast={showToast} />
    </header>
  );
}

function TabBar({ tab, onSelect }: { tab: Tab; onSelect: (t: Tab) => void }) {
  return (
    <div className="glass-tab-bar-dock">
      <nav
        className="glass-tab-bar glass-tab-bar--floating glass-tab-bar--droplet"
        aria-label="主导航"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              className={`glass-tab-bar__item ${on ? 'is-active' : ''}`}
              aria-current={on ? 'page' : undefined}
              onClick={() => onSelect(t.key)}
            >
              <span className="glass-tab-bar__icon">
                <Icon size={24} aria-hidden="true" />
              </span>
              <span className="glass-tab-bar__label">{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * 加载占位改骨架屏（三.9）：原来只有一行灰字，垂直位置还靠 marginTop 视口百分比硬编码，
 * 弱网 / 冷启动时这张卡会闪一下且位置偏。
 * 用 GlassKit 的 .glass-skeleton（glasskit.css 第 26 节），它自带
 * prefers-reduced-motion 分支（reduce 下 animation:none，只留静止渐变），不用另写。
 */
function PageLoading() {
  return (
    <div className="page-stack" aria-busy="true">
      <Card>
        <div className="glass-skeleton" aria-hidden="true">
          <div
            className="glass-skeleton__line glass-skeleton__line--title"
            style={{ width: '40%' }}
          />
          <div className="glass-skeleton__line" style={{ width: '88%' }} />
          <div className="glass-skeleton__line" style={{ width: '64%' }} />
        </div>
        <p className="muted-text" style={{ margin: 'var(--yh-space-3) 0 0' }}>
          正在打开…
        </p>
      </Card>
      {/* 第二张代表「下面还有内容」：切 tab 时骨架与内容区同宽，观感连续 */}
      <Card>
        <div className="glass-skeleton" aria-hidden="true">
          <div
            className="glass-skeleton__line glass-skeleton__line--title"
            style={{ width: '52%' }}
          />
          <div className="glass-skeleton__line" style={{ width: '76%' }} />
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Toast */

export interface ToastItem {
  msg: string;
  tone: ToastTone;
  action?: { label: string; onClick: () => void };
}

export interface ToastApi {
  toast: ToastItem | null;
  showToast: Done;
  pauseToast: () => void;
  resumeToast: () => void;
  clearToast: () => void;
}

export function useToast(): ToastApi {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const toastEnd = useRef(0);
  const toastRemaining = useRef(0);
  /**
   * 当前 toast 的镜像（M-16）。showToast 是 useCallback（依赖 armToast），
   * 读 state 会拿到闭包里的旧值，所以用 ref 记住「此刻挂着的是哪一条」。
   */
  const toastRef = useRef<ToastItem | null>(null);

  const clear = useCallback(() => {
    toastRef.current = null;
    setToast(null);
  }, []);

  const armToast = useCallback((ms: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    toastRemaining.current = ms;
    toastEnd.current = Date.now() + ms;
    timer.current = window.setTimeout(() => {
      toastRef.current = null;
      setToast(null);
    }, ms);
  }, []);

  const pauseToast = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    toastRemaining.current = Math.max(0, toastEnd.current - Date.now());
  };

  const resumeToast = () => {
    if (toastRemaining.current <= 0) {
      clear();
      return;
    }
    armToast(toastRemaining.current);
  };

  const showToast = useCallback<Done>(
    (msg, tone = 'success', action) => {
      /*
       * M-16：带「撤销」的提示有 6 秒生命期，绝不能被后面一条普通提示顶掉。
       * 场景：连开两单 —— 第二单的「已记 1 单」会把第一单的「撤销」挤走，
       * 用户想反悔时入口已经没了（这时只能去销售记录里翻）。
       * 规则：当前挂着未过期的可撤销提示时，普通提示直接丢弃（不排队，避免积压刷屏）；
       * 新提示也带 action 才替换 —— 两个撤销入口不可能同时有用。
       */
      const now = Date.now();
      const current = toastRef.current;
      /*
       * 只保护「撤销」类提示：示例商品的「知道了」同样带 action，但它只是确认按钮，
       * 不该把随后弹出的「已记 1 单」这类普通提示吞掉——吞掉会让摊主以为没记上，
       * e2e-smoke.py 也正是按「已记 1 单」断言保存成功。
       */
      const currentIsUndo = Boolean(current?.action && current.action.label.includes('撤销'));
      const currentUndoAlive = currentIsUndo && toastEnd.current > now;
      /*
       * 错误提示是例外：宁可让撤销入口少活几秒，也不能把「没记上 / 没存上」吞掉
       * （吞掉就等于让用户以为已经记成功了）。同步类错误另有顶栏状态灯兜底。
       */
      if (currentUndoAlive && !action && tone !== 'error') return;

      const next: ToastItem = { msg, tone, action };
      toastRef.current = next;
      setToast(next);
      const duration = action ? 6000 : tone === 'error' ? 5200 : tone === 'warning' ? 4000 : 2600;
      armToast(duration);
    },
    [armToast]
  );

  return {
    toast,
    showToast,
    pauseToast,
    resumeToast,
    clearToast: clear
  };
}

export function ToastHost({ api, hidden }: { api: ToastApi; hidden: boolean }) {
  if (!api.toast || hidden) return null;
  return (
    <Toast
      message={api.toast.msg}
      tone={api.toast.tone}
      action={api.toast.action?.label}
      onAction={
        api.toast.action
          ? () => {
              api.toast?.action?.onClick();
              api.clearToast();
            }
          : undefined
      }
      onClose={api.toast.tone === 'error' ? api.clearToast : undefined}
      onPause={api.pauseToast}
      onResume={api.resumeToast}
    />
  );
}

/* ------------------------------------------------------------------ 页面内容 */

const PurchasePage = lazy(() => import('./pages/PurchasePage'));
const StockPage = lazy(() => import('./pages/StockPage'));
const ReportPage = lazy(() => import('./pages/ReportPage'));
const ProductsPage = lazy(() => import('./pages/ProductsPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const RecordEditor = lazy(() => import('./RecordEditor'));

const preloadSecondaryPages = () => {
  void import('./pages/PurchasePage');
  void import('./pages/StockPage');
  void import('./pages/ReportPage');
  void import('./pages/ProductsPage');
  void import('./pages/HistoryPage');
  void import('./pages/SettingsPage');
  void import('./RecordEditor');
};

/** 只读派生数据：放在 Context 里，页面按需消费，不再逐层传 props */
export interface AppDataValue {
  data: AppData;
  inv: Map<string, number>;
  fifo: FifoResult;
  avgCost: Map<string, number>;
  operators: string[];
  deviceId: string;
  settings: Record<string, string>;
  sync: SyncApi;
  openSession?: Session;
  openSummary: SessionSummary;
  sessionOrders: SalesOrder[];
  warnDays: number;
  editorInitial?: RecordDraft;
  /**
   * P5：今天最近一次已结账的场次（含结账时写入的快照）。
   * 没有进行中场次时，记账页用它显示「上一场 … 结账」+ 撤销入口。
   * 由 App 算好（只认当天结的），这里只透传，不在页面里重新挑场次。
   */
  lastClosed: { session: Session; summary: SessionSummary } | null;
  showToast: Done;
}

/** 写操作：单独存放，只读数据变化不会牵连这些消费者重渲染 */
export interface AppActionsValue {
  setEditor: Dispatch<SetStateAction<EditorState | null>>;
  setSub: Dispatch<SetStateAction<SubPage>>;
  setTab: Dispatch<SetStateAction<Tab>>;
  onSaved: (order: SalesOrder, andNext: boolean, undo?: () => Promise<void>) => void;
  onOpenCloseSession: () => void;
  /** 报表页的带参回调（需要 sessionId） */
  onPatchSession: (session: Session) => void;
  /** 报表页的「去记一笔」 */
  onGoRecord: () => void;
  /**
   * P5：撤销最近一场结账（记账页「上一场 … 结账」条上的按钮）。
   * 失败原因（例如「下一场已经开始，不能撤销结账」）由实现方 Toast 出来。
   */
  onReopenLastClosed: () => Promise<void>;
  /**
   * P9：开单页「去建商品」—— 置上「建完回开单页并把商品加进本单」的意图。
   */
  onCreateProductForEditor: () => void;
  /**
   * P9：商品管理里「新建」保存成功（参数是新建商品 id）。
   * App 只在上面那条意图成立时回开单页；否则（更多 → 商品管理 → 新建）什么都不做，
   * 用户仍然留在列表页。意图是一次性的，消费/离开时立刻清掉。
   */
  onProductCreated: (productId: string) => void;
  /** P9：RecordEditor 已把 pendingProductId 加进草稿，App 可以清空它了 */
  onPendingProductConsumed: () => void;
}

const AppDataContext = createContext<AppDataValue | null>(null);
const AppActionsContext = createContext<AppActionsValue | null>(null);

export function useAppData(): AppDataValue {
  const v = useContext(AppDataContext);
  if (!v) throw new Error('useAppData 必须在 AppDataProvider 内使用');
  return v;
}

export function useAppActions(): AppActionsValue {
  const v = useContext(AppActionsContext);
  if (!v) throw new Error('useAppActions 必须在 AppActionsProvider 内使用');
  return v;
}

/** value / actions 由调用方 useMemo，避免每次渲染都换新对象 */
export function AppDataProvider({
  value,
  actions,
  children
}: {
  value: AppDataValue;
  actions: AppActionsValue;
  children: ReactNode;
}) {
  return (
    <AppActionsContext.Provider value={actions}>
      <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
    </AppActionsContext.Provider>
  );
}

export interface AppMainProps {
  tab: Tab;
  sub: SubPage;
  editor: EditorState | null;
  /**
   * P9：刚建好、尚未加进草稿的商品 id（由 App 持有，见 App.onProductCreated）。
   * 只有「从开单页去建商品」那一次会非空，RecordEditor 消费后回调清空。
   */
  pendingProductId: string | null;
  theme: Theme;
  onToggleTheme: () => void;
}

/** 主内容区：按 tab / sub / editor 原样路由到各页面 */
export function AppMain({ tab, sub, editor, pendingProductId, theme, onToggleTheme }: AppMainProps) {
  const {
    data,
    inv,
    avgCost,
    operators,
    deviceId,
    openSummary,
    editorInitial,
    sync,
    showToast
  } = useAppData();
  const { setEditor, setSub, setTab, onSaved, onCreateProductForEditor, onPendingProductConsumed } =
    useAppActions();
  // 首屏渲染完成后再空闲预取其余页面，切 tab / 开单时不等待下载。
  useEffect(() => {
    const canIdle = typeof window.requestIdleCallback === 'function';
    const handle = canIdle
      ? window.requestIdleCallback(preloadSecondaryPages, { timeout: 2500 })
      : window.setTimeout(preloadSecondaryPages, 1200);
    return () => {
      if (canIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);

  const TabPage = TAB_PAGES[tab];
  // settings 要传主题开关，走下面的单独分支；其余子页查表
  const SubPageView = sub === 'products' || sub === 'history' ? SUB_PAGES[sub] : null;

  // 页面级错误边界：单个 chunk 加载失败只坏这一页，开单页不被连坐
  // resetKey 跟着路由变，切页时自动清掉错误态，别让坏掉的一页拖住整壳
  /*
   * 错误边界 + 滚动记忆共用同一个指纹。切页时自动清错误态，
   * 也让下面按指纹存取 scrollTop（别让坏掉的一页拖住整壳）。
   */
  const routeKey = routeKeyOf(tab, sub, editor);
  return (
    <ErrorBoundary
      resetKey={routeKey}
      fallback={(error, reset) => <PageErrorFallback error={error} onRetry={reset} />}
    >
      <Suspense fallback={<PageLoading />}>
        {editor ? (
          <RecordEditor
            key={
              editor.mode === 'edit'
                ? `edit-${editor.orderId}`
                : editor.mode === 'patch'
                  ? `patch-${editor.sessionId}`
                  : 'new'
            }
            mode={editor.mode}
            products={data.products}
            inv={inv}
            avgCost={avgCost}
            operators={operators}
            deviceId={deviceId}
            sessionId={editor.sessionId}
            orderId={editor.orderId}
            initial={editorInitial}
            sessionOrderCount={
              editor.mode === 'patch'
                ? data.orders.filter((o) => o.sessionId === editor.sessionId && !o.voided).length
                : openSummary.orderCount
            }
            /* P4：开单页没有顶栏（整页编辑），离线状态要靠这一页自己显示 */
            online={sync.online}
            /* P9：从「去建商品」回来的那一次，把刚建好的商品 id 带进来（只在新单里用） */
            pendingProductId={editor.mode === 'new' ? pendingProductId : null}
            onPendingProductConsumed={onPendingProductConsumed}
            onSaved={onSaved}
            onCancel={() => setEditor(null)}
            /* P9：去建商品时置「建完回开单页」的意图，回来时自动加进本单 */
            onCreateProduct={onCreateProductForEditor}
            onOpenHistory={() => {
              setEditor(null);
              setTab('report');
              setSub(null);
            }}
            onDone={showToast}
          />
        ) : sub === 'settings' ? (
          <SettingsSubPage theme={theme} onToggleTheme={onToggleTheme} />
        ) : SubPageView ? (
          <SubPageView />
        ) : (
          <TabPage />
        )}
      </Suspense>
    </ErrorBoundary>
  );
}

/* ------------------------------------------------------------------ 路由表 */

/** 各 tab 的适配层：只负责把 Context 里的派生值交给页面，页面 props 保持不变 */
function RecordTabPage() {
  const { data, openSession, openSummary, sessionOrders, sync, lastClosed } = useAppData();
  const { setEditor, setTab, setSub, onOpenCloseSession, onReopenLastClosed } = useAppActions();
  return (
    <RecordPage
      session={openSession}
      summary={openSummary}
      orders={sessionOrders}
      lines={data.lines}
      products={data.products}
      online={sync.online}
      lastClosed={lastClosed}
      onNewRecord={() => setEditor({ mode: 'new' })}
      onOpenOrder={(id) => setEditor({ mode: 'edit', orderId: id })}
      onCloseSession={onOpenCloseSession}
      onReopenLastClosed={onReopenLastClosed}
      /* 「看本场」= 报表默认就停在本场 / 最近已结账那一场，切过去即可 */
      onOpenLastReport={() => setTab('report')}
      onOpenHistory={() => {
        setTab('more');
        setSub('history');
      }}
      onGoStock={() => setTab('stock')}
    />
  );
}

function PurchaseTabPage() {
  const { data, deviceId, showToast } = useAppData();
  return (
    <PurchasePage
      products={data.products}
      batches={data.batches}
      deviceId={deviceId}
      onDone={showToast}
    />
  );
}

function StockTabPage() {
  const { data, inv, fifo, deviceId, warnDays, showToast } = useAppData();
  return (
    <StockPage
      products={data.products}
      batches={data.batches}
      inv={inv}
      fifo={fifo}
      deviceId={deviceId}
      warnDays={warnDays}
      onDone={showToast}
    />
  );
}

function ReportTabPage() {
  const { data, deviceId, fifo, warnDays, showToast } = useAppData();
  const { onPatchSession, onGoRecord } = useAppActions();
  return (
    <ReportPage
      products={data.products}
      batches={data.batches}
      orders={data.orders}
      lines={data.lines}
      sessions={data.sessions}
      deviceId={deviceId}
      fifo={fifo}
      warnDays={warnDays}
      onDone={showToast}
      onPatchSession={onPatchSession}
      onGoRecord={onGoRecord}
    />
  );
}

function MoreTabPage() {
  const { data, openSession, openSummary, settings, sync } = useAppData();
  const { setSub, onOpenCloseSession } = useAppActions();
  return (
    <MorePage
      products={data.products.length}
      orders={data.orders.length}
      session={openSession}
      summary={openSummary}
      deviceName={settings[SETTING_KEYS.deviceName] ?? ''}
      sync={sync}
      onOpen={setSub}
      onCloseSession={onOpenCloseSession}
    />
  );
}

function ProductsSubPage() {
  const { data, inv, showToast } = useAppData();
  const { onProductCreated } = useAppActions();
  return (
    <ProductsPage
      products={data.products}
      inv={inv}
      onDone={showToast}
      /* P9：新建成功后交给 App 判断要不要回开单页（意图只在「从开单页跳来」时置位） */
      onCreated={onProductCreated}
    />
  );
}

function HistorySubPage() {
  const { data, showToast } = useAppData();
  return (
    <HistoryPage
      products={data.products}
      orders={data.orders}
      lines={data.lines}
      onDone={showToast}
    />
  );
}

/** 设置页需要主题开关（诉求 6），所以单独接 props；其余子页依旧无 props */
function SettingsSubPage({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { settings, deviceId, sync, showToast } = useAppData();
  return (
    <SettingsPage
      settings={settings}
      deviceId={deviceId}
      sync={sync}
      theme={theme}
      onToggleTheme={onToggleTheme}
      onDone={showToast}
    />
  );
}

/** tab / sub 各一张映射表，AppMain 只做一次查表（settings 有 props，单独渲染） */
const TAB_PAGES: Record<Tab, ComponentType> = {
  record: RecordTabPage,
  purchase: PurchaseTabPage,
  stock: StockTabPage,
  report: ReportTabPage,
  more: MoreTabPage
};

const SUB_PAGES: Record<'products' | 'history', ComponentType> = {
  products: ProductsSubPage,
  history: HistorySubPage
};

/* ------------------------------------------------------------------ 壳层 */

export interface AppShellProps {
  booting: boolean;
  bootError: string | null;
  editor: EditorState | null;
  sub: SubPage;
  tab: Tab;
  sync: SyncApi;
  onBack: () => void;
  onSelectTab: (t: Tab) => void;
  migrateError: string | null;
  onRetryMigrate: () => void;
  onExportBackup: () => void;
  hasSample: boolean;
  sampleNoticeDismissed: boolean;
  showToast: Done;
  toastApi: ToastApi;
  toastHidden: boolean;
  children: ReactNode;
}

/** 主题开关不进壳层：App 直接经 AppMain 传给设置页，壳层只负责同步状态点 */
export function AppShell({
  booting,
  bootError,
  editor,
  sub,
  tab,
  sync,
  onBack,
  onSelectTab,
  migrateError,
  onRetryMigrate,
  onExportBackup,
  hasSample,
  sampleNoticeDismissed,
  showToast,
  toastApi,
  toastHidden,
  children
}: AppShellProps) {
  /*
   * 列表 → 详情 → 返回记住滚动位置（三.6）。
   * 改造后滚动容器只有一个（.app-main），所以按路由存 scrollTop 就够，
   * 不需要 display:none 保活页面（2000 单时那会把 DOM 全留在内存里）。
   */
  const mainRef = useRef<HTMLElement | null>(null);
  // Map 放 ref：滚动是高频事件，进 state 会把整壳重渲染一遍
  const scrollMemo = useRef(new Map<string, number>());
  // 恢复时是我们自己写 scrollTop，这几次滚动不能当成「用户滚到了这里」
  const restoringRef = useRef(false);
  const routeKey = routeKeyOf(tab, sub, editor);

  /*
   * 记忆：监听捕获阶段而不是 <main onScroll>，因为库存页把滚动下移到了
   * [data-scroll-root] 那层，事件不会冒泡到 <main>。
   * 开单页是文档滚动（.app-main--editor 为 overflow:visible），没有内层 scrollTop 可记。
   */
  useEffect(() => {
    if (editor) return;
    const onScroll = (e: Event) => {
      const target = e.target;
      const main = mainRef.current;
      if (!main || !(target instanceof HTMLElement)) return;
      if (target !== main && !target.hasAttribute('data-scroll-root')) return;
      if (!main.contains(target) || restoringRef.current) return;
      scrollMemo.current.set(routeKey, target.scrollTop);
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [routeKey, editor]);

  /*
   * 恢复：用 useLayoutEffect，DOM 已经换上来、还没绘制，滚一下不会被用户看见。
   * 双 rAF 是必需的：懒加载 chunk / 列表数据刚渲染时高度还没撑开，
   * 这时设置 scrollTop 会被浏览器夹到 0，得等两帧再补一次。
   */
  useLayoutEffect(() => {
    const main = mainRef.current;
    // 开单页跳过：它走文档滚动，scrollTop 恒为 0，还原没意义还会跟键盘弹起打架
    if (!main || editor) return;
    const el = main.querySelector<HTMLElement>('[data-scroll-root]') ?? main;
    const target = scrollMemo.current.get(routeKey) ?? 0;
    restoringRef.current = true;
    el.scrollTop = target;
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      el.scrollTop = target;
      raf2 = window.requestAnimationFrame(() => {
        el.scrollTop = target;
        restoringRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      restoringRef.current = false;
    };
  }, [routeKey, editor]);

  /*
   * L-10：示例商品提示改成一次性 Toast（原先是记账页首屏的常驻横幅）。
   * - 「已知晓」的唯一真相仍是 sampleNoticeDismissed 设置：只有点了 Toast 上的
   *   「知道了」才落库，之后永不再提；
   * - 没点的话本次会话内不再重复弹（sessionStorage 去重，避免切 tab 反复骚扰），
   *   下次打开应用会再提醒一次，不至于彻底漏掉；
   * - 只在记账页、且不在开单页时提醒，别打断录单。
   */
  const sampleToastShown = useRef(false);
  useEffect(() => {
    if (!hasSample || sampleNoticeDismissed || editor || tab !== 'record') return;
    if (sampleToastShown.current) return;
    try {
      if (sessionStorage.getItem(SAMPLE_TOAST_KEY) === '1') return;
      sessionStorage.setItem(SAMPLE_TOAST_KEY, '1');
    } catch {
      /* 隐私模式下 sessionStorage 不可用：只靠 ref 去重 */
    }
    sampleToastShown.current = true;
    showToast('这些是示例商品，去「更多 → 商品管理」改成自己的货', 'warning', {
      label: '知道了',
      onClick: () => {
        void setSetting(SETTING_KEYS.sampleNoticeDismissed, '1');
      }
    });
  }, [hasSample, sampleNoticeDismissed, editor, tab, showToast]);

  if (booting) {
    return (
      <div className="glass-bg glass-bg--has-tab-bar-floating">
        <div className="app-shell">
          <AppHeader
            title="记账"
            sub={null}
            sync={sync}
            showToast={showToast}
            onBack={() => undefined}
          />
          <main className="app-main">
            {/* 去掉垂直位置的硬编码：开账本失败才出错误卡，否则出骨架屏 */}
            {bootError ? (
              <Empty icon={<Sparkles size={24} />} text={`账本打不开：${bootError}`} />
            ) : (
              <PageLoading />
            )}
          </main>
        </div>
        <TabBar tab={tab} onSelect={onSelectTab} />
      </div>
    );
  }

  const title = editor
    ? editor.mode === 'patch'
      ? '补记一笔'
      : editor.mode === 'edit'
        ? '改这一单'
        : '记一笔'
    : sub
      ? SUB_TITLE[sub]
      : TAB_TITLE[tab];

  /*
   * 滚动形态用 class 显式声明，不让 CSS 去猜路由（也避开 :has() 的兼容风险）：
   * - app-shell--editor / app-main--editor：开单页回到「文档滚动」。
   *   iOS 弹软键盘会改 100dvh，锁高一屏会让整张单据跳一下，这是硬约束。
   * - app-main--split：库存页「固定区 + 列表区自己滚」，.app-main 本身不滚，
   *   保证只有一个滚动条。
   * - app-main--dock：记账页底部有 fixed 的结算浮条，底部留白要留到 172px。
   */
  const shellClass = editor ? 'app-shell app-shell--editor' : 'app-shell';
  const mainClass = [
    'app-main',
    editor ? 'app-main--editor' : '',
    !editor && tab === 'record' && !sub ? 'app-main--dock' : '',
    !editor && tab === 'stock' && !sub ? 'app-main--split' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`glass-bg ${editor ? '' : 'glass-bg--has-tab-bar-floating'}`}>
      <div className={shellClass}>
        {!editor ? (
          <AppHeader
            title={title}
            sub={sub}
            sync={sync}
            showToast={showToast}
            onBack={onBack}
          />
        ) : null}

        <UpdateBar />

        <main className={mainClass} ref={mainRef}>
          {migrateError && !editor ? (
            <div className="glass-status" style={{ marginBottom: 'var(--yh-page-gap)' }}>
              <TriangleAlert size={20} aria-hidden="true" />
              <p>历史数据还没归到场次：{migrateError}。账本可以继续记，迁移成功后再看报表。</p>
              <Btn block={false} size="sm" variant="secondary" onClick={onRetryMigrate}>
                重试迁移
              </Btn>
              <Btn block={false} size="sm" variant="secondary" onClick={onExportBackup}>
                导出最近备份
              </Btn>
            </div>
          ) : null}

          {/*
           * L-10：示例商品提示已改成一次性 Toast（见下面的 useEffect）。
           * 这里原本是一条常驻横幅，永久占掉记账页首屏一条 —— 但它只是首次引导，
           * 而记账页首屏是摊位上最贵的空间（浮条 + 本场金额 + 本场流水都在抢）。
           */}

          {children}
        </main>
      </div>

      {!sub && !editor ? <TabBar tab={tab} onSelect={onSelectTab} /> : null}

      <ToastHost api={toastApi} hidden={toastHidden} />
    </div>
  );
}