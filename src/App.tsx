import { useCallback, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  emptySessionSummary,
  fifoAllocate,
  inventoryMap,
  productAvgCostFen,
  sessionReport
} from './db/calc';
import { loadAll, reopenSession } from './db/repo';
import { pickOpenSession } from './db/sessionLogic';
import { SETTING_KEYS } from './db/types';
import type { Session, SessionSummary } from './db/types';
import { fenToStr, isoToLocalDate, localDate } from './db/util';
import { useSync } from './ui/useSync';
import { draftFromOrder, type RecordDraft } from './ui/recordDraft';
import {
  AppDataProvider,
  AppMain,
  AppShell,
  useTheme,
  useToast,
  type AppActionsValue,
  type AppDataValue,
  type EditorState,
  type SubPage,
  type Tab
} from './ui/AppShell';
import { msgOf, useBoot } from './ui/useBoot';
import { CloseSessionFlow, useCloseSessionFlow } from './ui/CloseSessionFlow';

export default function App() {
  const [tab, setTab] = useState<Tab>('record');
  const [sub, setSub] = useState<SubPage>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const toastCtl = useToast();
  const { theme, toggleTheme } = useTheme();
  /**
   * P9 的「意图」：只有「从开单页点去建商品」这一条路会把它置 true。
   * 生命周期（写成 ref 是因为它只影响一次跳转，不该触发重渲染）：
   *   置位 → onCreateProductForEditor（开单页去建商品）
   *   清除 → ① onProductCreated（建好了：立刻消费掉，回开单页加行）
   *          ② 从商品管理退出去（onBack）或切 tab —— 用户放弃了这条流程
   * 不清就会变成永久跳转 bug：以后从「更多 → 商品管理」新建也会被弹回开单页。
   */
  const createProductIntentRef = useRef(false);
  /**
   * 建好、但还没被开单页消费掉的那个商品 id。
   * 必须是 state 而不是 ref：RecordEditor 要等到 `data.products` 里出现它才加行
   * （liveQuery 是异步刷新的，建完立刻回开单页时 products 可能还差这一条）。
   */
  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
  /** 任何「离开商品管理」的路径都要清意图，避免泄漏到下一次新建 */
  const clearCreateIntent = () => {
    createProductIntentRef.current = false;
    // 一并清掉待加入的商品：用户已经放弃这条流程，下次进开单页不该再冒出一行
    setPendingProductId(null);
  };
  const boot = useBoot(toastCtl.showToast);
  const data = useLiveQuery(() => loadAll(), []);
  // H3：同步结束时若「对方动了你的数据」，由 useSync 合成一条可撤销 Toast
  const sync = useSync(toastCtl.showToast);

  const settings = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of data?.settings ?? []) m[s.key] = s.value;
    return m;
  }, [data]);

  const deviceId = settings[SETTING_KEYS.deviceId] ?? '';
  // 一台手机 = 一个人：operators 恒为一个元素，长度 1，所有 operators[0] 的消费点零改动
  const operators = useMemo(() => {
    const self = (settings[SETTING_KEYS.operatorSelf] ?? '').trim();
    return [self || settings[SETTING_KEYS.deviceName] || '本机'];
  }, [settings]);
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

  const openSession = useMemo(
    () => pickOpenSession(data?.sessions ?? [], deviceId),
    [data, deviceId]
  );

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

  const editingOrder = useMemo(
    () => (editor?.orderId ? (data?.orders ?? []).find((o) => o.id === editor.orderId) : undefined),
    [editor, data]
  );

  /**
   * P5：上一场（今天最近一次结账）—— 没有进行中场次时，记账页靠它给一个「反悔」入口。
   *
   * 为什么只认「今天结的」：撤销结账是收摊后几分钟内的动作（发现漏记一单），
   * 过了今天再撤，报表与流水的日期口径都会乱；而 db 层只保证「下一场开始前」可撤，
   * 那是必要条件不是充分条件 —— 界面这一层再收紧到当天。
   * summary 直接用 session 上已持久化的快照（repo 结账时写入、补记后重算），
   * 不在这里重新算：账已经封存，重算反而会和报表对不上。
   */
  const lastClosed = useMemo<{ session: Session; summary: SessionSummary } | null>(() => {
    if (openSession || !data) return null;
    const today = localDate();
    const closed = data.sessions
      .filter((s) => s.status === 'closed' && s.closedAt && isoToLocalDate(s.closedAt) === today)
      .sort((a, b) => ((a.closedAt ?? '') < (b.closedAt ?? '') ? 1 : -1));
    const s = closed[0];
    return s ? { session: s, summary: s.summary ?? emptySessionSummary() } : null;
  }, [data, openSession]);

  const editorInitial = useMemo<RecordDraft | undefined>(() => {
    if (!editingOrder || !data) return undefined;
    return draftFromOrder(
      editingOrder,
      data.lines.filter((l) => l.orderId === editingOrder.id)
    );
  }, [editingOrder, data]);

  const handleRecordSaved = useCallback((
    order: { totalFen: number },
    andNext: boolean,
    undo?: () => Promise<void>
  ) => {
    /*
     * P3：连续开单（andNext）的回执**不再做成浮层 Toast**。
     * Toast 置顶 72–150，而保存后自动弹开的「选商品」层顶边在 84，
     * 标题与「本单已加 N 种」会被整条盖住，用户以为「没开新单 / 页面没反应」。
     * 现在由 RecordEditor 在底栏内联一行「已记 1 单 ¥xx · 撤销」（.record-receipt），
     * 撤销用的是同一个 undo 闭包。
     * 不是连续开单时（「只保存」→ 直接回首页，没有弹层）仍走 Toast。
     */
    if (!andNext) {
      const base =
        order.totalFen === 0 ? '已记 1 单（赠品）' : `已记 1 单 ¥${fenToStr(order.totalFen)}`;
      // P4：主串「已记 1 单」不动（e2e / 文档按它断言），断网时只追加一句「待联网上传」
      const msg = sync.online ? base : `${base} · 待联网上传`;
      toastCtl.showToast(
        msg,
        'success',
        undo
          ? {
              label: '撤销',
              onClick: () => {
                void (async () => {
                  try {
                    await undo();
                    toastCtl.showToast('已撤销这一单', 'warning');
                  } catch (e) {
                    toastCtl.showToast(`撤销失败：${msgOf(e)}`, 'error');
                  }
                })();
              }
            }
          : undefined
      );
      setEditor(null);
    }
  }, [toastCtl.showToast, sync.online]);

  const closeFlow = useCloseSessionFlow({
    data,
    fifo,
    inv,
    operators,
    openSession,
    showToast: toastCtl.showToast
  });

  /**
   * 只读派生值：依赖链必须保持稳定，否则整个 Context 每渲染都会换新对象：
   *   toastCtl.showToast → useToast 里 useCallback（依赖 armToast，armToast 又是 useCallback([])）
   *   sync               → useSync 末尾 useMemo（configured/online/syncing/pending/last/error/syncNow 全在依赖里）
   *   operators          → 本文件 useMemo([settings])
   *   handleRecordSaved  → useCallback([toastCtl.showToast])
   * 往 value 里加字段时，务必同步加进下面的依赖数组。
   */
  const appData = useMemo<AppDataValue | null>(
    () =>
      data
        ? {
            data,
            inv,
            fifo,
            avgCost,
            operators,
            deviceId,
            settings,
            sync,
            openSession,
            openSummary,
            sessionOrders,
            warnDays,
            editorInitial,
            lastClosed,
            showToast: toastCtl.showToast
          }
        : null,
    [
      data,
      inv,
      fifo,
      avgCost,
      operators,
      deviceId,
      settings,
      sync,
      openSession,
      openSummary,
      sessionOrders,
      warnDays,
      editorInitial,
      lastClosed,
      toastCtl.showToast
    ]
  );

  /** 写操作单独一个 value：数据变化不会让它们的消费者重渲染 */
  const appActions = useMemo<AppActionsValue>(
    () => ({
      setEditor,
      setSub,
      setTab,
      onSaved: handleRecordSaved,
      onOpenCloseSession: () => {
        if (openSession) closeFlow.setCloseOpen(openSession);
      },
      onPatchSession: (s) => setEditor({ mode: 'patch', sessionId: s.id }),
      onGoRecord: () => {
        setTab('record');
        setEditor({ mode: 'new' });
      },
      /*
       * P5：撤销最近一场结账。db 层的 reopenSession 只认「下一场开始前可撤」
       * （repo.ts:683 会抛 NEXT_SESSION_STARTED），跨设备/补记等边界都在它那里兜着，
       * 这里**不重复判断、也不吞错**：失败就把原始原因原样弹出来，用户才知道
       * 到底是「下一场已经开始了」还是数据已经不在本机。
       */
      onReopenLastClosed: async () => {
        const target = lastClosed?.session;
        if (!target) return;
        try {
          await reopenSession(target.id);
          toastCtl.showToast('已撤销结账，这一场回到进行中');
        } catch (e) {
          toastCtl.showToast(`撤销失败：${msgOf(e)}`, 'error');
        }
      },
      /* P9：开单页「去建商品」—— 置意图后切到商品管理 */
      onCreateProductForEditor: () => {
        createProductIntentRef.current = true;
        setEditor(null);
        setSub('products');
      },
      /*
       * P9：商品管理「新建」保存成功。
       * 命中意图 → 一次性消费掉，直接回开单页，并把新商品 id 交给 RecordEditor
       * （挂载后加一行：数量 1、按标价，复用 useRecordDraft.addProduct 的口径）。
       * 没命中（更多 → 商品管理）→ 什么都不做，用户留在列表页。
       *
       * ⚠️ 意图必须在这里立刻清掉：漏清就会变成「以后每次新建商品都被弹回开单页」的
       * 永久跳转 bug —— 这是这类「建完回原页」功能最常见的翻车点。
       */
      onProductCreated: (productId) => {
        if (!createProductIntentRef.current) return;
        createProductIntentRef.current = false;
        setSub(null);
        setPendingProductId(productId);
        setEditor({ mode: 'new' });
      },
      /*
       * P9：RecordEditor 把 pendingProductId 加进草稿后回调这里清空。
       * 清空后这一轮流程彻底结束：刷新 / 重渲染 / 再开新单都不会重复加行。
       */
      onPendingProductConsumed: () => {
        setPendingProductId(null);
      }
    }),
    [handleRecordSaved, openSession, closeFlow.setCloseOpen, setEditor, setSub, setTab, lastClosed, toastCtl.showToast]
  );

  return (
    <>
      <AppShell
        booting={!boot.ready || !data}
        bootError={boot.bootError}
        editor={editor}
        sub={sub}
        tab={tab}
        sync={sync}
        onBack={() => {
          // P9：离开商品管理＝放弃「建完回开单页」这条流程，意图必须立刻清掉
          clearCreateIntent();
          setSub(null);
        }}
        onSelectTab={(t) => {
          clearCreateIntent();
          setTab(t);
          setSub(null);
        }}
        migrateError={boot.migrateError}
        onRetryMigrate={boot.retryMigrate}
        onExportBackup={boot.exportLatestBackup}
        hasSample={hasSample}
        sampleNoticeDismissed={sampleNoticeDismissed}
        showToast={toastCtl.showToast}
        toastApi={toastCtl}
        toastHidden={Boolean(closeFlow.closeOpen || closeFlow.closeDone)}
      >
        {data && appData ? (
          <AppDataProvider value={appData} actions={appActions}>
            <AppMain
              tab={tab}
              sub={sub}
              editor={editor}
              pendingProductId={pendingProductId}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          </AppDataProvider>
        ) : null}
      </AppShell>

      <CloseSessionFlow
        flow={closeFlow}
        sync={sync}
        fifo={fifo}
        showToast={toastCtl.showToast}
        setEditor={setEditor}
        setTab={setTab}
      />
    </>
  );
}