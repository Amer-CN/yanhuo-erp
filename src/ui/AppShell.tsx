import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
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
  Moon,
  PackagePlus,
  PenLine,
  Sparkles,
  Sun,
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
    localStorage.setItem('yh-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#070a10' : '#eef2f6');
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return { theme, toggleTheme };
}

/** 顶栏与底部导航独立成组件：数据未就绪时也能先渲染外壳，缩短首屏等待 */
function AppHeader({
  title,
  sub,
  theme,
  onBack,
  onToggleTheme
}: {
  title: string;
  sub: SubPage;
  theme: Theme;
  onBack: () => void;
  onToggleTheme: () => void;
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
      <button
        className="glass-pill"
        onClick={onToggleTheme}
        aria-label={theme === 'dark' ? '切到浅色' : '切到深色'}
        type="button"
      >
        {theme === 'dark' ? <Sun size={21} aria-hidden="true" /> : <Moon size={21} aria-hidden="true" />}
      </button>
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

function PageLoading() {
  return (
    <div className="page-stack" aria-busy="true">
      <Card>
        <p className="muted-text" style={{ margin: 0 }}>
          正在打开…
        </p>
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

  const armToast = useCallback((ms: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    toastRemaining.current = ms;
    toastEnd.current = Date.now() + ms;
    timer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  const pauseToast = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    toastRemaining.current = Math.max(0, toastEnd.current - Date.now());
  };

  const resumeToast = () => {
    if (toastRemaining.current <= 0) {
      setToast(null);
      return;
    }
    armToast(toastRemaining.current);
  };

  const showToast = useCallback<Done>(
    (msg, tone = 'success', action) => {
      setToast({ msg, tone, action });
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
    clearToast: () => setToast(null)
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
}

/** 主内容区：按 tab / sub / editor 原样路由到各页面 */
export function AppMain({ tab, sub, editor }: AppMainProps) {
  const {
    data,
    inv,
    avgCost,
    operators,
    deviceId,
    openSummary,
    editorInitial,
    showToast
  } = useAppData();
  const { setEditor, setSub, setTab, onSaved } = useAppActions();
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
  const SubPageView = sub ? SUB_PAGES[sub] : null;

  return (
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
          onSaved={onSaved}
          onCancel={() => setEditor(null)}
          onCreateProduct={() => {
            setEditor(null);
            setSub('products');
          }}
          onOpenHistory={() => {
            setEditor(null);
            setTab('report');
            setSub(null);
          }}
          onDone={showToast}
        />
      ) : (
        <>
          {SubPageView ? <SubPageView /> : <TabPage />}

          
        </>
      )}
    </Suspense>
  );
}

/* ------------------------------------------------------------------ 路由表 */

/** 各 tab 的适配层：只负责把 Context 里的派生值交给页面，页面 props 保持不变 */
function RecordTabPage() {
  const { data, openSession, openSummary, sessionOrders, sync } = useAppData();
  const { setEditor, setTab, setSub, onOpenCloseSession } = useAppActions();
  return (
    <RecordPage
      session={openSession}
      summary={openSummary}
      orders={sessionOrders}
      lines={data.lines}
      products={data.products}
      online={sync.online}
      onNewRecord={() => setEditor({ mode: 'new' })}
      onOpenOrder={(id) => setEditor({ mode: 'edit', orderId: id })}
      onCloseSession={onOpenCloseSession}
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
  const { data, inv, fifo, deviceId, showToast } = useAppData();
  return (
    <StockPage
      products={data.products}
      batches={data.batches}
      inv={inv}
      fifo={fifo}
      deviceId={deviceId}
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
  return <ProductsPage products={data.products} inv={inv} onDone={showToast} />;
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

function SettingsSubPage() {
  const { settings, deviceId, sync, showToast } = useAppData();
  return <SettingsPage settings={settings} deviceId={deviceId} sync={sync} onDone={showToast} />;
}

/** tab / sub 各一张映射表，AppMain 只做一次查表 */
const TAB_PAGES: Record<Tab, ComponentType> = {
  record: RecordTabPage,
  purchase: PurchaseTabPage,
  stock: StockTabPage,
  report: ReportTabPage,
  more: MoreTabPage
};

const SUB_PAGES: Record<Exclude<SubPage, null>, ComponentType> = {
  products: ProductsSubPage,
  history: HistorySubPage,
  settings: SettingsSubPage
};

/* ------------------------------------------------------------------ 壳层 */

export interface AppShellProps {
  booting: boolean;
  bootError: string | null;
  editor: EditorState | null;
  sub: SubPage;
  tab: Tab;
  theme: Theme;
  onToggleTheme: () => void;
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

export function AppShell({
  booting,
  bootError,
  editor,
  sub,
  tab,
  theme,
  onToggleTheme,
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
  if (booting) {
    return (
      <div className="glass-bg glass-bg--has-tab-bar-floating">
        <div className="app-shell">
          <AppHeader
            title="记账"
            sub={null}
            theme={theme}
            onBack={() => undefined}
            onToggleTheme={onToggleTheme}
          />
          <main className="app-main">
            <div style={{ marginTop: '34vh' }}>
              <Empty
                icon={<Sparkles size={24} />}
                text={bootError ? `账本打不开：${bootError}` : '正在打开账本…'}
              />
            </div>
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

  return (
    <div className={`glass-bg ${editor ? '' : 'glass-bg--has-tab-bar-floating'}`}>
      <div className="app-shell">
        {!editor ? (
          <AppHeader
            title={title}
            sub={sub}
            theme={theme}
            onBack={onBack}
            onToggleTheme={onToggleTheme}
          />
        ) : null}

        <UpdateBar />

        <main className={editor ? 'app-main app-main--editor' : 'app-main'}>
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

          {hasSample && !sampleNoticeDismissed && !editor && tab === 'record' ? (
            <div className="sample-note" style={{ marginBottom: 'var(--yh-page-gap)' }}>
              <span>这些是示例商品，记得改成自己的货</span>
              <Btn
                block={false}
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await setSetting(SETTING_KEYS.sampleNoticeDismissed, '1');
                  showToast('去「更多 → 商品管理」改成自己的货');
                }}
              >
                知道了
              </Btn>
            </div>
          ) : null}

          {children}
        </main>
      </div>

      {!sub && !editor ? <TabBar tab={tab} onSelect={onSelectTab} /> : null}

      <ToastHost api={toastApi} hidden={toastHidden} />
    </div>
  );
}