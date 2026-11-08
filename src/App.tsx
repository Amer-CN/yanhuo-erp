import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Sparkles,
  PackagePlus,
  Boxes,
  ChartColumn,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon,
  Package,
  Receipt,
  Settings,
  PenLine,
  TriangleAlert
} from 'lucide-react';
import {
  closeSession,
  ensureDeviceId,
  getSetting,
  loadAll,
  migrateSessions,
  reopenSession,
  setSetting
} from './db/repo';
import { SETTING_KEYS, type Session } from './db/types';
import { seedIfEmpty } from './db/seed';
import {
  emptySessionSummary,
  fifoAllocate,
  inventoryMap,
  productAvgCostFen,
  sessionReport
} from './db/calc';
import { fenToStr, isoToTime } from './db/util';
import { Btn, Card, ConfirmSheet, Empty, Toast, type Done, type ToastTone } from './ui/kit';
import { useSync } from './ui/useSync';
import RecordPage from './ui/pages/RecordPage';
import PurchasePage from './ui/pages/PurchasePage';
import StockPage from './ui/pages/StockPage';
import ReportPage from './ui/pages/ReportPage';
import ProductsPage from './ui/pages/ProductsPage';
import HistoryPage from './ui/pages/HistoryPage';
import SettingsPage from './ui/pages/SettingsPage';
import RecordEditor, { draftFromOrder } from './ui/RecordEditor';
import CloseSessionSheet, { CloseSessionResult } from './ui/CloseSessionSheet';
import type { RecordDraft } from './ui/recordDraft';

type Tab = 'record' | 'purchase' | 'stock' | 'report' | 'more';
type SubPage = 'products' | 'history' | 'settings' | null;

interface EditorState {
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

type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  const saved = localStorage.getItem('yh-theme');
  return saved === 'light' ? 'light' : 'dark';
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return '平板';
  if (/iPhone/.test(ua)) return '手机';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? '手机' : '平板';
  return '本机';
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [migrateError, setMigrateError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('record');
  const [sub, setSub] = useState<SubPage>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [closeOpen, setCloseOpen] = useState<Session | null>(null);
  const [closeDone, setCloseDone] = useState<Session | null>(null);
  const [closing, setClosing] = useState(false);
  const [reopenAsk, setReopenAsk] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    tone: ToastTone;
    action?: { label: string; onClick: () => void };
  } | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const timer = useRef<number | undefined>(undefined);
  const toastEnd = useRef(0);
  const toastRemaining = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('yh-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#070a10' : '#eef2f6');
  }, [theme]);

  // 液滴选中动画（GlassKit 官方模块，失败也不影响使用）
  useEffect(() => {
    let alive = true;
    import('@jungherz-de/glasskit/glasskit-droplet.js')
      .then((m) => {
        if (alive && typeof m.attachDroplets === 'function') m.attachDroplets(document);
      })
      .catch(() => {
        /* 没有模块就退回普通高亮 */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensureDeviceId();
        if (!(await getSetting(SETTING_KEYS.deviceName))) {
          await setSetting(SETTING_KEYS.deviceName, defaultDeviceName());
        }
        if (!(await getSetting(SETTING_KEYS.operatorA))) await setSetting(SETTING_KEYS.operatorA, '我');
        if (!(await getSetting(SETTING_KEYS.operatorB))) await setSetting(SETTING_KEYS.operatorB, '老婆');
        if (!(await getSetting(SETTING_KEYS.expiryWarnDays))) {
          await setSetting(SETTING_KEYS.expiryWarnDays, '30');
        }
        await seedIfEmpty();
        try {
          await migrateSessions();
        } catch (e) {
          if (alive) setMigrateError(msgOf(e));
        }
      } catch (e) {
        if (alive) setBootError(msgOf(e));
      }
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const data = useLiveQuery(() => loadAll(), []);
  const sync = useSync();

  const armToast = (ms: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    toastRemaining.current = ms;
    toastEnd.current = Date.now() + ms;
    timer.current = window.setTimeout(() => setToast(null), ms);
  };

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

  const showToast: Done = (msg, tone = 'success', action) => {
    setToast({ msg, tone, action });
    const duration = action ? 6000 : tone === 'error' ? 5200 : tone === 'warning' ? 4000 : 2600;
    armToast(duration);
  };

  const settings = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of data?.settings ?? []) m[s.key] = s.value;
    return m;
  }, [data]);

  const deviceId = settings[SETTING_KEYS.deviceId] ?? '';
  const deviceName = settings[SETTING_KEYS.deviceName] ?? '';
  const operators = [
    settings[SETTING_KEYS.operatorA] ?? '我',
    settings[SETTING_KEYS.operatorB] ?? '老婆'
  ];
  const warnDays = Number(settings[SETTING_KEYS.expiryWarnDays] ?? '30') || 30;
  const hasSample = (data?.products ?? []).some((p) => p.sample);
  const sampleNoticeDismissed = settings[SETTING_KEYS.sampleNoticeDismissed] === '1';

  const fifo = useMemo(
    () => fifoAllocate(data?.batches ?? [], data?.orders ?? [], data?.lines ?? []),
    [data]
  );
  const inv = useMemo(
    () =>
      inventoryMap(
        data?.batches ?? [],
        data?.orders ?? [],
        data?.lines ?? [],
        data?.adjustments ?? []
      ),
    [data]
  );
  const avgCost = useMemo(() => productAvgCostFen(data?.batches ?? []), [data]);

  const openSession = useMemo(() => {
    const rows = (data?.sessions ?? []).filter((s) => s.status === 'open' && s.deviceId === deviceId);
    return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  }, [data, deviceId]);

  const openSummary = useMemo(
    () =>
      openSession && data
        ? sessionReport(openSession.id, data.orders, data.lines, fifo)
        : emptySessionSummary(),
    [openSession, data, fifo]
  );

  const sessionOrders = useMemo(
    () => (openSession && data ? data.orders.filter((o) => o.sessionId === openSession.id) : []),
    [openSession, data]
  );

  const negativeCount = useMemo(
    () => (data?.products ?? []).filter((p) => !p.archived && (inv.get(p.id) ?? 0) < 0).length,
    [data, inv]
  );

  const closeSummary = useMemo(
    () =>
      closeOpen && data
        ? sessionReport(closeOpen.id, data.orders, data.lines, fifo)
        : emptySessionSummary(),
    [closeOpen, data, fifo]
  );

  const editingOrder = useMemo(
    () => (editor?.orderId ? (data?.orders ?? []).find((o) => o.id === editor.orderId) : undefined),
    [editor, data]
  );

  const editorInitial = useMemo<RecordDraft | undefined>(() => {
    if (!editingOrder || !data) return undefined;
    return draftFromOrder(
      editingOrder,
      data.lines.filter((l) => l.orderId === editingOrder.id)
    );
  }, [editingOrder, data]);

  if (!ready || !data) {
    return (
      <div className="glass-bg">
        <div className="app-shell">
          <div style={{ marginTop: '42vh' }}>
            <Empty
              icon={<Sparkles size={24} />}
              text={bootError ? `账本打不开：${bootError}` : '正在打开账本…'}
            />
          </div>
        </div>
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

  const handleRecordSaved = (
    order: { totalFen: number },
    andNext: boolean,
    undo?: () => Promise<void>
  ) => {
    const msg =
      order.totalFen === 0 ? '已记 1 单（赠品）' : `已记 1 单 ¥${fenToStr(order.totalFen)}`;
    showToast(
      msg,
      'success',
      undo
        ? {
            label: '撤销',
            onClick: () => {
              void (async () => {
                try {
                  await undo();
                  showToast('已撤销这一单', 'warning');
                } catch (e) {
                  showToast(`撤销失败：${msgOf(e)}`, 'error');
                }
              })();
            }
          }
        : undefined
    );
    if (!andNext) setEditor(null);
  };

  const handleCloseSession = async () => {
    if (!closeOpen || closing) return;
    setClosing(true);
    try {
      const s = await closeSession(closeOpen.id, operators[0] || '我');
      setCloseOpen(null);
      setCloseDone(s);
      showToast(
        `已结账 · ${s.summary?.orderCount ?? 0} 单 ¥${fenToStr(s.summary?.revenueFen ?? 0)}`
      );
    } catch (e) {
      showToast(`没结上：${msgOf(e)}`, 'error');
    } finally {
      setClosing(false);
    }
  };

  const handleReopen = async () => {
    if (!closeDone) return;
    try {
      await reopenSession(closeDone.id);
      setReopenAsk(false);
      setCloseDone(null);
      showToast('已恢复本场，可以继续记');
    } catch (e) {
      showToast(`撤销失败：${msgOf(e)}`, 'error');
    }
  };

  const retryMigrate = async () => {
    try {
      await migrateSessions();
      setMigrateError(null);
      showToast('历史数据已归到场次');
    } catch (e) {
      setMigrateError(msgOf(e));
    }
  };

  return (
    <div className={`glass-bg ${editor ? '' : 'glass-bg--has-tab-bar-floating'}`}>
      <div className="app-shell">
        {!editor ? (
          <header className="glass-nav app-nav">
            {sub ? (
              <button
                className="glass-pill back-btn"
                onClick={() => setSub(null)}
                aria-label="返回"
                type="button"
              >
                <ChevronLeft size={22} aria-hidden="true" />
              </button>
            ) : (
              <img className="app-brand" src="./icon-192.png" alt="" aria-hidden="true" />
            )}
            <h1 className="glass-title">{title}</h1>
            <button
              className="glass-pill"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? '切到浅色' : '切到深色'}
              type="button"
            >
              {theme === 'dark' ? <Sun size={21} aria-hidden="true" /> : <Moon size={21} aria-hidden="true" />}
            </button>
          </header>
        ) : null}

        <main className={editor ? 'app-main app-main--editor' : 'app-main'}>
          {migrateError && !editor ? (
            <div className="glass-status" style={{ marginBottom: 'var(--yh-page-gap)' }}>
              <TriangleAlert size={20} aria-hidden="true" />
              <p>历史数据还没归到场次：{migrateError}。账本可以继续记，迁移成功后再看报表。</p>
              <Btn block={false} size="sm" variant="secondary" onClick={retryMigrate}>
                重试迁移
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
                  ? data.orders.filter(
                      (o) => o.sessionId === editor.sessionId && !o.voided
                    ).length
                  : openSummary.orderCount
              }
              onSaved={handleRecordSaved}
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
              {tab === 'record' && !sub ? (
                <RecordPage
                  session={openSession}
                  summary={openSummary}
                  orders={sessionOrders}
                  lines={data.lines}
                  products={data.products}
                  online={sync.online}
                  onNewRecord={() => setEditor({ mode: 'new' })}
                  onOpenOrder={(id) => setEditor({ mode: 'edit', orderId: id })}
                  onCloseSession={() => {
                    if (openSession) setCloseOpen(openSession);
                  }}
                  onOpenHistory={() => {
                    setTab('more');
                    setSub('history');
                  }}
                  onGoStock={() => setTab('stock')}
                />
              ) : null}

              {tab === 'purchase' && !sub ? (
                <PurchasePage
                  products={data.products}
                  batches={data.batches}
                  deviceId={deviceId}
                  onDone={showToast}
                />
              ) : null}

              {tab === 'stock' && !sub ? (
                <StockPage
                  products={data.products}
                  batches={data.batches}
                  inv={inv}
                  fifo={fifo}
                  deviceId={deviceId}
                  onDone={showToast}
                />
              ) : null}

              {tab === 'report' && !sub ? (
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
                  onPatchSession={(s) => setEditor({ mode: 'patch', sessionId: s.id })}
                  onGoRecord={() => {
                    setTab('record');
                    setEditor({ mode: 'new' });
                  }}
                />
              ) : null}

              {tab === 'more' && !sub ? (
                <MorePage
                  products={data.products.length}
                  orders={data.orders.length}
                  session={openSession}
                  summary={openSummary}
                  deviceName={deviceName}
                  sync={sync}
                  onOpen={setSub}
                  onCloseSession={() => {
                    if (openSession) setCloseOpen(openSession);
                  }}
                />
              ) : null}

              {sub === 'products' ? (
                <ProductsPage products={data.products} inv={inv} onDone={showToast} />
              ) : null}

              {sub === 'history' ? (
                <HistoryPage
                  products={data.products}
                  orders={data.orders}
                  lines={data.lines}
                  onDone={showToast}
                />
              ) : null}

              {sub === 'settings' ? (
                <SettingsPage
                  settings={settings}
                  deviceId={deviceId}
                  sync={sync}
                  onDone={showToast}
                />
              ) : null}
            </>
          )}
        </main>
      </div>

      {!sub && !editor ? (
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
                  onClick={() => {
                    setTab(t.key);
                    setSub(null);
                  }}
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
      ) : null}

      {closeOpen ? (
        <CloseSessionSheet
          session={closeOpen}
          summary={closeSummary}
          pendingSync={sync.pending}
          uncoveredQty={fifo.uncoveredQty}
          negativeCount={negativeCount}
          busy={closing}
          onConfirm={handleCloseSession}
          onCancel={() => setCloseOpen(null)}
          onSyncNow={() => {
            void sync.syncNow().catch((e) => showToast(`同步失败：${msgOf(e)}`, 'error'));
          }}
          onRecordMore={() => {
            setCloseOpen(null);
            setEditor({ mode: 'new' });
          }}
          onGoPurchase={() => {
            setCloseOpen(null);
            setTab('purchase');
          }}
          onGoStock={() => {
            setCloseOpen(null);
            setTab('stock');
          }}
        />
      ) : null}

      {closeDone ? (
        <CloseSessionResult
          session={closeDone}
          summary={closeDone.summary ?? emptySessionSummary()}
          costMissing={fifo.uncoveredQty > 0}
          onViewReport={() => {
            setCloseDone(null);
            setTab('report');
          }}
          onReopen={() => setReopenAsk(true)}
          onClose={() => setCloseDone(null)}
        />
      ) : null}

      {reopenAsk && closeDone ? (
        <ConfirmSheet
          title="撤销结账？"
          description="撤销后本场恢复进行中，可以继续记；下一场开始后就不能再撤销了。"
          confirmText="撤销结账"
          danger
          onConfirm={handleReopen}
          onCancel={() => setReopenAsk(false)}
        />
      ) : null}

      {toast && !closeOpen && !closeDone ? (
        <Toast
          message={toast.msg}
          tone={toast.tone}
          action={toast.action?.label}
          onAction={
            toast.action
              ? () => {
                  toast.action?.onClick();
                  setToast(null);
                }
              : undefined
          }
          onClose={toast.tone === 'error' ? () => setToast(null) : undefined}
          onPause={pauseToast}
          onResume={resumeToast}
        />
      ) : null}

      </div>
    );
  }

function MorePage({
  products,
  orders,
  session,
  summary,
  deviceName,
  sync,
  onOpen,
  onCloseSession
}: {
  products: number;
  orders: number;
  session?: Session;
  summary: { revenueFen: number; orderCount: number };
  deviceName: string;
  sync: {
    configured: boolean;
    online: boolean;
    syncing: boolean;
    pending: number;
    error: string | null;
  };
  onOpen: (p: Exclude<SubPage, null>) => void;
  onCloseSession: () => void;
}) {
  const syncText = !sync.configured
    ? '未开启（点设置与同步）'
    : !sync.online
      ? '离线，联网后自动同步'
      : sync.syncing
        ? '同步中…'
        : sync.error
          ? '同步出错'
          : `已连接 · 待推送 ${sync.pending} 条`;
  return (
    <div className="page-stack">
      <Card>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="tiny-text">
              {session ? `本场 · ${isoToTime(session.startedAt)} 开始` : '本场还没开张'}
            </div>
            <div
              style={{
                fontSize: 'var(--yh-text-3xl)',
                fontWeight: 'var(--yh-weight-semibold)',
                color: 'var(--yh-price-ink)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 'var(--yh-leading-tight)'
              }}
            >
              ¥{fenToStr(summary.revenueFen)}
            </div>
            <div className="tiny-text">已记 {summary.orderCount} 单</div>
          </div>
          <Btn
            block={false}
            size="sm"
            variant="secondary"
            disabled={!session || summary.orderCount === 0}
            onClick={onCloseSession}
          >
            收摊结账
          </Btn>
        </div>
        <div className="tiny-text" style={{ marginTop: 8 }}>
          设备：{deviceName} · 云同步：{syncText}
        </div>
      </Card>

      <ul className="glass-list">
        <li
          className="glass-list__item glass-list__item--interactive list-item"
          {...{
            role: 'button',
            tabIndex: 0,
            onClick: () => onOpen('products'),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen('products');
              }
            }
          }}
        >
          <span className="glass-list__leading">
            <Package size={22} aria-hidden="true" />
          </span>
          <div className="glass-list__content">
            <div className="glass-list__title">商品管理</div>
            <div className="glass-list__subtitle">共 {products} 个商品</div>
          </div>
          <div className="glass-list__trailing">
            <ChevronRight size={18} aria-hidden="true" />
          </div>
        </li>

        <li
          className="glass-list__item glass-list__item--interactive list-item"
          {...{
            role: 'button',
            tabIndex: 0,
            onClick: () => onOpen('history'),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen('history');
              }
            }
          }}
        >
          <span className="glass-list__leading">
            <Receipt size={22} aria-hidden="true" />
          </span>
          <div className="glass-list__content">
            <div className="glass-list__title">销售记录</div>
            <div className="glass-list__subtitle">共 {orders} 单，按场次看明细</div>
          </div>
          <div className="glass-list__trailing">
            <ChevronRight size={18} aria-hidden="true" />
          </div>
        </li>

        <li
          className="glass-list__item glass-list__item--interactive list-item"
          {...{
            role: 'button',
            tabIndex: 0,
            onClick: () => onOpen('settings'),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen('settings');
              }
            }
          }}
        >
          <span className="glass-list__leading">
            <Settings size={22} aria-hidden="true" />
          </span>
          <div className="glass-list__content">
            <div className="glass-list__title">设置与同步</div>
            <div className="glass-list__subtitle">操作人、导出备份、导入合并</div>
          </div>
          <div className="glass-list__trailing">
            <ChevronRight size={18} aria-hidden="true" />
          </div>
        </li>
      </ul>

      <Card>
        <p className="muted-text" style={{ margin: 0 }}>
          摆摊流程：进货 → 记一笔 → 收摊结账 → 看报表对现金。两台设备会自动同步；每天收摊再导出一次备份，发微信存着。
        </p>
      </Card>

      {products === 0 ? <Empty icon={<Package size={24} />} text="还没有商品，先去商品管理建几个" /> : null}
    </div>
  );
}