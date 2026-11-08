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
  Settings
} from 'lucide-react';
import { ensureDeviceId, getSetting, loadAll, setSetting } from './db/repo';
import { SETTING_KEYS } from './db/types';
import { seedIfEmpty } from './db/seed';
import { fifoAllocate, inventoryMap, dayReport } from './db/calc';
import { fenToStr, localDate } from './db/util';
import { Card, Empty, Toast, type Done, type ToastTone } from './ui/kit';
import { loadSell, saveSell, type SellState } from './ui/sellSession';
import SellPage from './ui/pages/SellPage';
import PurchasePage from './ui/pages/PurchasePage';
import StockPage from './ui/pages/StockPage';
import ReportPage from './ui/pages/ReportPage';
import ProductsPage from './ui/pages/ProductsPage';
import HistoryPage from './ui/pages/HistoryPage';
import SettingsPage from './ui/pages/SettingsPage';

type Tab = 'sell' | 'purchase' | 'stock' | 'report' | 'more';
type SubPage = 'products' | 'history' | 'settings' | null;

const TABS: { key: Tab; label: string; icon: typeof Sparkles }[] = [
  { key: 'sell', label: '开单', icon: Sparkles },
  { key: 'purchase', label: '进货', icon: PackagePlus },
  { key: 'stock', label: '库存', icon: Boxes },
  { key: 'report', label: '报表', icon: ChartColumn },
  { key: 'more', label: '更多', icon: MoreHorizontal }
];

const TAB_TITLE: Record<Tab, string> = {
  sell: '开单',
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

export default function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('sell');
  const [sub, setSub] = useState<SubPage>(null);
  const [toast, setToast] = useState<{
    msg: string;
    tone: ToastTone;
    action?: { label: string; onClick: () => void };
  } | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [sell, setSell] = useState<SellState>(() => loadSell());
  const timer = useRef<number | undefined>(undefined);

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
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const data = useLiveQuery(() => loadAll(), []);

  const showToast: Done = (msg, tone = 'success', action) => {
    setToast({ msg, tone, action });
    if (timer.current) window.clearTimeout(timer.current);
    const duration = action ? 6000 : tone === 'error' ? 5200 : tone === 'warning' ? 4000 : 2600;
    timer.current = window.setTimeout(() => setToast(null), duration);
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

  // 操作人默认第一个；可在开单页右上角切换
  useEffect(() => {
    if (operators.length === 0) return;
    if (!sell.operator || !operators.includes(sell.operator)) {
      setSell((prev) => ({ ...prev, operator: operators[0] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operators.join('|')]);

  // 切 Tab / 刷新不再丢购物车
  useEffect(() => {
    saveSell(sell);
  }, [sell]);

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

  if (!ready || !data) {
    return (
      <div className="glass-bg">
        <div className="app-shell">
          <div style={{ marginTop: '42vh' }}>
            <Empty icon={<Sparkles size={24} />} text="正在打开账本…" />
          </div>
        </div>
      </div>
    );
  }

  const title = sub ? SUB_TITLE[sub] : TAB_TITLE[tab];
  const today = dayReport(localDate(), data.orders, data.lines, fifo);

  return (
    <div className="glass-bg glass-bg--has-tab-bar-floating">
      <div className="app-shell">
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

        <main className="app-main">
          {tab === 'sell' && !sub ? (
            <SellPage
              products={data.products}
              inv={inv}
              deviceId={deviceId}
              operators={operators}
              state={sell}
              onChange={(patch) => setSell((prev) => ({ ...prev, ...patch }))}
              showSampleNotice={hasSample && !sampleNoticeDismissed}
              onDismissSample={async () => {
                await setSetting(SETTING_KEYS.sampleNoticeDismissed, '1');
                showToast('去「更多 → 商品管理」改成自己的货');
              }}
              onDone={showToast}
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
              fifo={fifo}
              warnDays={warnDays}
            />
          ) : null}

          {tab === 'more' && !sub ? (
            <MorePage
              products={data.products.length}
              orders={data.orders.length}
              todayRevenue={today.revenueFen}
              todayCount={today.orderCount}
              deviceName={deviceName}
              onOpen={setSub}
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
            <SettingsPage settings={settings} deviceId={deviceId} onDone={showToast} />
          ) : null}
        </main>
      </div>

      {!sub ? (
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

      {toast ? (
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
        />
      ) : null}
    </div>
  );
}

function MorePage({
  products,
  orders,
  todayRevenue,
  todayCount,
  deviceName,
  onOpen
}: {
  products: number;
  orders: number;
  todayRevenue: number;
  todayCount: number;
  deviceName: string;
  onOpen: (p: Exclude<SubPage, null>) => void;
}) {
  return (
    <div className="page-stack">
      <Card flush>
        <div className="row-between">
          <div>
            <div className="tiny-text">今天 · {localDate()}</div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 700,
                color: 'var(--yh-price-ink)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1.15
              }}
            >
              ¥{fenToStr(todayRevenue)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="tiny-text">单数</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{todayCount}</div>
          </div>
        </div>
        <div className="tiny-text" style={{ marginTop: 8 }}>
          设备：{deviceName}
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
            <div className="glass-list__subtitle">共 {orders} 单，可看明细 / 作废</div>
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
          摆摊流程：进货 → 开单 → 收摊看「报表」对现金 → 两台设备互相「导出/导入」合并。
          每天收摊导出一次备份，发微信存着。
        </p>
      </Card>

      {products === 0 ? <Empty icon={<Package size={24} />} text="还没有商品，先去商品管理建几个" /> : null}
    </div>
  );
}