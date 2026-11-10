import { useCallback, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  emptySessionSummary,
  fifoAllocate,
  inventoryMap,
  productAvgCostFen,
  sessionReport
} from './db/calc';
import { loadAll } from './db/repo';
import { SETTING_KEYS } from './db/types';
import { fenToStr } from './db/util';
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
  const boot = useBoot(toastCtl.showToast);
  const data = useLiveQuery(() => loadAll(), []);
  const sync = useSync();

  const settings = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of data?.settings ?? []) m[s.key] = s.value;
    return m;
  }, [data]);

  const deviceId = settings[SETTING_KEYS.deviceId] ?? '';
  const operators = useMemo(
    () => [settings[SETTING_KEYS.operatorA] ?? '我', settings[SETTING_KEYS.operatorB] ?? '老婆'],
    [settings]
  );
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
    const rows = (data?.sessions ?? []).filter(
      (s) => s.status === 'open' && s.deviceId === deviceId
    );
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

  const handleRecordSaved = useCallback((
    order: { totalFen: number },
    andNext: boolean,
    undo?: () => Promise<void>
  ) => {
    const msg =
      order.totalFen === 0 ? '已记 1 单（赠品）' : `已记 1 单 ¥${fenToStr(order.totalFen)}`;
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
    if (!andNext) setEditor(null);
  }, [toastCtl.showToast]);

  const closeFlow = useCloseSessionFlow({
    data,
    fifo,
    inv,
    operators,
    openSession,
    showToast: toastCtl.showToast
  });

  /** 只读派生值：依赖都是上面的稳定结果，避免每次渲染换新对象 */
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
      }
    }),
    [handleRecordSaved, openSession, closeFlow.setCloseOpen, setEditor, setSub, setTab]
  );

  return (
    <>
      <AppShell
        booting={!boot.ready || !data}
        bootError={boot.bootError}
        editor={editor}
        sub={sub}
        tab={tab}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => setSub(null)}
        onSelectTab={(t) => {
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
            <AppMain tab={tab} sub={sub} editor={editor} />
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