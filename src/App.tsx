import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ensureDeviceId, getSetting, loadAll, setSetting } from './db/repo';
import { SETTING_KEYS } from './db/types';
import { seedIfEmpty } from './db/seed';
import { fifoAllocate, inventoryMap, dayReport } from './db/calc';
import { fenToStr, localDate } from './db/util';
import { Card, Empty } from './ui/kit';
import SellPage from './ui/pages/SellPage';
import PurchasePage from './ui/pages/PurchasePage';
import StockPage from './ui/pages/StockPage';
import ReportPage from './ui/pages/ReportPage';
import ProductsPage from './ui/pages/ProductsPage';
import HistoryPage from './ui/pages/HistoryPage';
import SettingsPage from './ui/pages/SettingsPage';

type Tab = 'sell' | 'purchase' | 'stock' | 'report' | 'more';
type SubPage = 'products' | 'history' | 'settings' | null;

const TABS: { key: Tab; ico: string; label: string }[] = [
  { key: 'sell', ico: '🧨', label: '开单' },
  { key: 'purchase', ico: '📦', label: '进货' },
  { key: 'stock', ico: '🏷️', label: '库存' },
  { key: 'report', ico: '📊', label: '报表' },
  { key: 'more', ico: '⋯', label: '更多' }
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
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

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
  const showToast = (msg: string) => {
    setToast(msg);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2600);
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
      <div className="app">
        <div className="page">
          <div className="empty" style={{ marginTop: '40vh' }}>
            <div className="big">🧨</div>
            <div>正在打开账本…</div>
          </div>
        </div>
      </div>
    );
  }

  const title = sub ? SUB_TITLE[sub] : TAB_TITLE[tab];

  return (
    <div className="app">
      <div className="topbar">
        {sub ? (
          <button className="back-btn" onClick={() => setSub(null)} aria-label="返回">
            ‹
          </button>
        ) : null}
        <h1>{title}</h1>
        <span className="sub">{deviceName}</span>
      </div>

      {tab === 'sell' && !sub ? (
        <SellPage
          products={data.products}
          inv={inv}
          deviceId={deviceId}
          operators={operators}
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
          todayRevenue={dayReport(
            localDate(),
            data.orders,
            data.lines,
            fifo
          ).revenueFen}
          todayCount={dayReport(localDate(), data.orders, data.lines, fifo).orderCount}
          deviceName={deviceName}
          onOpen={setSub}
        />
      ) : null}

      {sub === 'products' ? (
        <ProductsPage products={data.products} inv={inv} onDone={showToast} />
      ) : null}

      {sub === 'history' ? (
        <HistoryPage products={data.products} orders={data.orders} lines={data.lines} onDone={showToast} />
      ) : null}

      {sub === 'settings' ? (
        <SettingsPage settings={settings} deviceId={deviceId} onDone={showToast} />
      ) : null}

      {!sub ? (
        <nav className="tabbar">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? 'on' : ''}
              onClick={() => {
                setTab(t.key);
                setSub(null);
              }}
            >
              <span className="ico">{t.ico}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
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
    <div className="page">
      <Card>
        <div className="row between">
          <div>
            <div className="tiny">今天（{localDate()}）</div>
            <div className="amount big">¥{fenToStr(todayRevenue)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="tiny">单数</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{todayCount}</div>
          </div>
        </div>
        <div className="tiny" style={{ marginTop: 6 }}>
          设备：{deviceName}
        </div>
      </Card>

      <Card flush>
        <div className="list">
          <div className="list-item" onClick={() => onOpen('products')}>
            <div className="main">
              <div className="t1">🏷️ 商品管理</div>
              <div className="t2">共 {products} 个商品</div>
            </div>
            <span className="tiny">›</span>
          </div>
          <div className="list-item" onClick={() => onOpen('history')}>
            <div className="main">
              <div className="t1">🧾 销售记录</div>
              <div className="t2">共 {orders} 单，可看明细 / 作废</div>
            </div>
            <span className="tiny">›</span>
          </div>
          <div className="list-item" onClick={() => onOpen('settings')}>
            <div className="main">
              <div className="t1">⚙️ 设置与同步</div>
              <div className="t2">操作人、导出备份、导入合并</div>
            </div>
            <span className="tiny">›</span>
          </div>
        </div>
      </Card>

      <Card>
        <div className="tiny">
          摆摊流程：进货 → 开单 → 收摊看「报表」对现金 → 两台设备互相「导出/导入」合并。
          每天收摊导出一次备份，发微信存着。
        </div>
      </Card>

      {products === 0 ? <Empty icon="🧨" text="还没有商品，先去商品管理建几个" /> : null}
    </div>
  );
}