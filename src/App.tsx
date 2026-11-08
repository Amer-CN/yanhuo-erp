import { useMemo, useState } from 'react';
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
  AppMain,
  AppShell,
  useTheme,
  useToast,
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

  const handleRecordSaved = (
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
  };

  const closeFlow = useCloseSessionFlow({
    data,
    fifo,
    inv,
    operators,
    openSession,
    showToast: toastCtl.showToast
  });

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
        {data ? (
          <AppMain
            data={data}
            inv={inv}
            fifo={fifo}
            avgCost={avgCost}
            operators={operators}
            deviceId={deviceId}
            settings={settings}
            sync={sync}
            openSession={openSession}
            openSummary={openSummary}
            sessionOrders={sessionOrders}
            warnDays={warnDays}
            sub={sub}
            tab={tab}
            editor={editor}
            editorInitial={editorInitial}
            setEditor={setEditor}
            setSub={setSub}
            setTab={setTab}
            onSaved={handleRecordSaved}
            showToast={toastCtl.showToast}
            onOpenCloseSession={() => {
              if (openSession) closeFlow.setCloseOpen(openSession);
            }}
          />
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