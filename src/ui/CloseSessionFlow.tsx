import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { createSnapshot } from '../db/backup';
import { emptySessionSummary, sessionReport, type FifoResult } from '../db/calc';
import { closeSession, reopenSession } from '../db/repo';
import type { AppData, Session } from '../db/types';
import { fenToStr } from '../db/util';
import CloseSessionSheet, { CloseSessionResult } from './CloseSessionSheet';
import { ConfirmSheet, type Done } from './kit';
import { msgOf } from './useBoot';
import type { SyncApi } from './useSync';
import type { EditorState, Tab } from './AppShell';

/**
 * 收摊 / 撤销结账流程：状态、结账调用与三个弹层集中在这里。
 * 首页和「更多」通过 setCloseOpen 打开同一套流程。
 */
export function useCloseSessionFlow({
  data,
  fifo,
  inv,
  operators,
  openSession,
  showToast
}: {
  data?: AppData;
  fifo: FifoResult;
  inv: Map<string, number>;
  operators: string[];
  openSession?: Session;
  showToast: Done;
}) {
  const [closeOpen, setCloseOpen] = useState<Session | null>(null);
  const [closeDone, setCloseDone] = useState<Session | null>(null);
  const [closing, setClosing] = useState(false);
  const [reopenAsk, setReopenAsk] = useState(false);
  const [reopening, setReopening] = useState(false);

  const closeSummary = useMemo(
    () =>
      closeOpen && data
        ? sessionReport(closeOpen.id, data.orders, data.lines, fifo)
        : emptySessionSummary(),
    [closeOpen, data, fifo]
  );

  const negativeCount = useMemo(
    () => (data?.products ?? []).filter((p) => !p.archived && (inv.get(p.id) ?? 0) < 0).length,
    [data, inv]
  );

  const handleCloseSession = async () => {
    if (!closeOpen || closing) return;
    setClosing(true);
    try {
      const s = await closeSession(closeOpen.id, operators[0] || '我');
      setCloseOpen(null);
      setCloseDone(s);
      // 收摊成功即落一份本地快照；备份失败只提示，不阻断结账流程
      void createSnapshot('close').catch(() => {
        showToast('已结账，但本地备份没写成', 'warning');
      });
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
    if (!closeDone || reopening) return;
    setReopening(true);
    try {
      await reopenSession(closeDone.id);
      setReopenAsk(false);
      setCloseDone(null);
      showToast('已恢复本场，可以继续记');
    } catch (e) {
      // 失败不关确认框：让用户看到原因，可以再点一次
      showToast(`撤销失败：${msgOf(e)}`, 'error');
    } finally {
      setReopening(false);
    }
  };

  return {
    closeOpen,
    closeDone,
    closing,
    reopening,
    reopenAsk,
    setCloseOpen,
    setCloseDone,
    setReopenAsk,
    closeSummary,
    negativeCount,
    handleCloseSession,
    handleReopen,
    openSession
  };
}

export function CloseSessionFlow({
  flow,
  sync,
  fifo,
  showToast,
  setEditor,
  setTab
}: {
  flow: ReturnType<typeof useCloseSessionFlow>;
  sync: SyncApi;
  fifo: FifoResult;
  showToast: Done;
  setEditor: Dispatch<SetStateAction<EditorState | null>>;
  setTab: Dispatch<SetStateAction<Tab>>;
}) {
  return (
    <>
      {flow.closeOpen ? (
        <CloseSessionSheet
          session={flow.closeOpen}
          summary={flow.closeSummary}
          pendingSync={sync.pending}
          uncoveredQty={fifo.uncoveredQty}
          negativeCount={flow.negativeCount}
          busy={flow.closing}
          onConfirm={flow.handleCloseSession}
          onCancel={() => flow.setCloseOpen(null)}
          onSyncNow={() => {
            void sync.syncNow().catch((e) => showToast(`同步失败：${msgOf(e)}`, 'error'));
          }}
          onRecordMore={() => {
            flow.setCloseOpen(null);
            setEditor({ mode: 'new' });
          }}
          onGoPurchase={() => {
            flow.setCloseOpen(null);
            setTab('purchase');
          }}
          onGoStock={() => {
            flow.setCloseOpen(null);
            setTab('stock');
          }}
        />
      ) : null}

      {flow.closeDone ? (
        <CloseSessionResult
          session={flow.closeDone}
          summary={flow.closeDone.summary ?? emptySessionSummary()}
          costMissing={fifo.uncoveredQty > 0}
          onViewReport={() => {
            flow.setCloseDone(null);
            setTab('report');
          }}
          onReopen={() => flow.setReopenAsk(true)}
          onClose={() => flow.setCloseDone(null)}
        />
      ) : null}

      {flow.reopenAsk && flow.closeDone ? (
        <ConfirmSheet
          title="撤销结账？"
          description="撤销后本场恢复进行中，可以继续记；下一场开始后就不能再撤销了。"
          confirmText="撤销结账"
          danger
          busy={flow.reopening}
          onConfirm={() => void flow.handleReopen()}
          onCancel={() => flow.setReopenAsk(false)}
        />
      ) : null}
    </>
  );
}