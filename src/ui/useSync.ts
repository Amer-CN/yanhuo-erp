import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  dropLocalRecord,
  getSyncConfig,
  lastSyncAt,
  lastSyncError,
  remoteChangeList,
  restoreLocalSnapshot,
  syncNow as runSync,
  syncPending,
  type Kind,
  type RemoteChange,
  type RemoteImpact,
  type SyncStatus
} from '../db/sync';
import { nextBackoff } from '../db/syncResolve';
import { restoreOrder, updateProduct, voidOrder } from '../db/repo';
import { fenToStr } from '../db/util';
import type { Category, Product } from '../db/types';
import type { Done } from './kit';

/**
 * B3：新设备首次接入时的下载状态。
 * - `idle`：本机从未同步过（水位为 0），还没开始拉
 * - `running`：首轮 pull 正在进行 —— 此时账本看起来是空的，必须告诉用户「在下载」
 * - `done`：首轮结束（无论拉到多少条），之后回落成普通的增量同步状态
 */
export type InitialSyncState = 'idle' | 'running' | 'done';

export interface SyncApi extends SyncStatus {
  syncNow: (silent?: boolean) => Promise<void>;
  /**
   * H3：最近收到的「对方改动」条目（顶栏角标用）。
   * 不在同步完成时自动清空 —— 用户没点开过，就不该悄悄消失。
   */
  remoteChanges: RemoteChange[];
  /** 顶栏角标点击后清空（详情已用 Toast 展示） */
  clearRemoteChanges: () => void;
  /** B3：首次接入的下载状态（顶栏 / 更多页据此显示「正在下载历史」） */
  initialSync: InitialSyncState;
  /** B3：首轮已拉到的**行数**（「正在下载历史…（已拉 N 条）」；不是单数） */
  pulledCount: number;
}

const PULL_INTERVAL = 10_000;

/** 角标/列表最多保留多少条：只是「最近发生了什么」，不是审计日志 */
const KEEP_CHANGES = 20;

/**
 * 一条改动说成人话。文案刻意带上「你填的是 / 你这边是」：
 * H3 的痛点不是数据变了，而是没人告诉用户「谁赢了、我原来的值是什么」。
 */
function changeMessage(change: RemoteChange): string {
  if (change.type === 'removed') {
    return `另一台手机删掉了${change.label}`;
  }
  if (change.type === 'restored') {
    return `另一台手机撤销了删除，把数据带回来了：${change.label}`;
  }
  const local = change.local;
  const remote = change.remote;
  if (change.kind === 'product') {
    const before = numberField(local, 'priceList');
    const after = numberField(remote, 'priceList');
    if (before !== null && after !== null && before !== after) {
      return `另一台手机把${change.label}标价改成了 ¥${fenToStr(after)}（你填的是 ¥${fenToStr(before)}）`;
    }
    return `另一台手机改了${change.label}的资料`;
  }
  if (change.kind === 'order') {
    const before = numberField(local, 'totalFen');
    const after = numberField(remote, 'totalFen');
    if (before !== null && after !== null && before !== after) {
      return `另一台手机把${change.label}的金额改成了 ¥${fenToStr(after)}（你这边是 ¥${fenToStr(before)}）`;
    }
    if (Boolean(local?.voided) !== Boolean(remote?.voided)) {
      return `另一台手机${remote?.voided === true ? '作废' : '恢复了'}${change.label}`;
    }
    return `另一台手机改了${change.label}`;
  }
  if (change.kind === 'session') return `另一台手机改了${change.label}的记录`;
  return `另一台手机改了${change.label}`;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | null {
  const v = value?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 多条改动时的详情文案（「查看」/ 顶栏角标共用）。
 * 不逐条给「撤销」：一次弹 3 个撤销入口等于没有入口；要看细节可以逐次在
 * 下一次同步的 Toast 里处理，这里先让人知道「哪几条被动过」。
 */
export function describeRemoteChanges(changes: RemoteChange[]): string {
  const labels = changes
    .slice(0, 3)
    .map((c) => c.label)
    .join('、');
  const more = changes.length > 3 ? ` 等 ${changes.length} 条` : '';
  return `另一台手机改了 ${changes.length} 条记录：${labels}${more}`;
}

/** 撤销成功后的回执：三种改动的结果不同，别用同一句话糊过去 */
function undoSuccessMessage(change: RemoteChange): string {
  if (change.type === 'removed') return `已撤销：${change.label}已恢复`;
  if (change.type === 'restored') {
    return change.kind === 'order'
      ? `已撤销：${change.label}已重新作废（不计入账）`
      : `已撤销：${change.label}已从本机删除`;
  }
  return `已撤销：${change.label}已改回你这边`;
}

/** 撤销：覆盖 → 恢复本地旧值；删除 → 把旧快照重建回来；复活 → 重新作废/删除 */
async function applyUndo(change: RemoteChange): Promise<void> {
  if (change.type === 'overwritten') {
    if (change.kind === 'product') {
      const p = change.local as Partial<Product> | undefined;
      if (!p) throw new Error('这条改动没有留下本地旧值');
      // 商品走现有 updateProduct：它会顺手清掉 sample 标记、更新 updatedAt 并入队回推
      await updateProduct(change.recordId, {
        ...(typeof p.name === 'string' ? { name: p.name } : {}),
        ...(typeof p.category === 'string' ? { category: p.category as Category } : {}),
        ...(typeof p.unitBase === 'string' ? { unitBase: p.unitBase } : {}),
        ...(typeof p.boxQty === 'number' ? { boxQty: p.boxQty } : {}),
        ...(typeof p.priceList === 'number' ? { priceList: p.priceList } : {}),
        ...(typeof p.negotiable === 'boolean' ? { negotiable: p.negotiable } : {}),
        ...(typeof p.archived === 'boolean' ? { archived: p.archived } : {})
      });
      return;
    }
    if (change.kind === 'order') {
      // 对方把单作废了、我这边原本没作废：撤销 = 现有 restoreOrder（会重算场次快照）
      const wasVoided = change.local?.voided === true;
      const nowVoided = change.remote?.voided === true;
      if (!wasVoided && nowVoided) {
        await restoreOrder(change.recordId);
        return;
      }
    }
    // 订单/场次等：覆盖可能发生在已结账的数据上，updateRecord 的 open 限制会挡住；
    // 直接按旧快照写回 + 入队回推（撤销是用户主动行为，本地优先不破）。
    await restoreLocalSnapshot(change);
    return;
  }
  if (change.type === 'removed') {
    // 本地行已被墓碑硬删，restoreOrder 找不到行；用快照连明细一起重建
    await restoreLocalSnapshot(change);
    return;
  }
  // restored：撤销复活 = 让它重新不计入账。订单沿用现有 voidOrder（可再「撤销作废」）。
  if (change.kind === 'order') {
    await voidOrder(change.recordId);
    return;
  }
  await dropLocalRecord(change.kind as Kind, change.recordId);
}

export function useSync(showToast?: Done): SyncApi {
  const [configured, setConfigured] = useState<boolean>(() => !!getSyncConfig());
  const [online, setOnline] = useState<boolean>(() => navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  const [last, setLast] = useState<number | null>(() => lastSyncAt());
  const [error, setError] = useState<string | null>(() => lastSyncError());
  const [remoteChanges, setRemoteChanges] = useState<RemoteChange[]>([]);
  /*
   * B3：本机有没有同步过只看水位（localStorage 的 lastSyncAt）。
   * 为空 = 这台设备从没同步成功过，接下来那一轮 pull 就是「下载历史」，
   * 首屏看起来像空账本，必须显式告诉用户，而不是先亮绿 ✓「已同步」。
   */
  const [initialSync, setInitialSync] = useState<InitialSyncState>(() =>
    lastSyncAt() ? 'done' : 'idle'
  );
  const [pulledCount, setPulledCount] = useState(0);
  /** 首轮是否还没成功结束：成功后置 false，后续增量轮不再进入「下载历史」分支、也不再弹 Toast */
  const initialPending = useRef(!lastSyncAt());
  const changesRef = useRef<RemoteChange[]>([]);
  const toastRef = useRef<Done | undefined>(showToast);
  toastRef.current = showToast;
  const busy = useRef(false);
  const backoff = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);
  const syncRef = useRef<(silent?: boolean) => Promise<void>>(async () => undefined);

  const refresh = useCallback(async () => {
    setConfigured(!!getSyncConfig());
    setPending(await syncPending());
    setLast(lastSyncAt());
    setError(lastSyncError());
  }, []);

  const clearRemoteChanges = useCallback(() => {
    changesRef.current = [];
    setRemoteChanges([]);
  }, []);

  const undoChange = useCallback(async (change: RemoteChange) => {
    try {
      await applyUndo(change);
      const left = changesRef.current.filter(
        (c) =>
          !(c.type === change.type && c.kind === change.kind && c.recordId === change.recordId)
      );
      changesRef.current = left;
      setRemoteChanges(left);
      toastRef.current?.(undoSuccessMessage(change));
    } catch (e) {
      // 失败必须如实说，否则用户以为已经撤销了（下次同步还会看到旧值）
      toastRef.current?.(`撤销失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, []);

  /**
   * 把一轮同步的「对方改动」合成**最多一条** Toast，并累计到顶栏角标。
   *
   * 为什么只弹一条：一轮同步可能同时覆盖 5 个商品、删 1 单；逐条弹会互相顶掉
   * （M-16 下带「撤销」的提示会各自抢 6 秒），用户反而什么都看不清。
   */
  const reportImpact = useCallback(
    (impact: RemoteImpact) => {
      const list = remoteChangeList(impact);
      if (list.length === 0) return;
      const merged = [...changesRef.current, ...list].slice(-KEEP_CHANGES);
      changesRef.current = merged;
      setRemoteChanges(merged);

      const toast = toastRef.current;
      if (!toast) return;
      if (list.length === 1) {
        const change = list[0];
        toast(changeMessage(change), 'warning', {
          label: '撤销',
          onClick: () => void undoChange(change)
        });
        return;
      }
      toast(`另一台手机改了 ${list.length} 条记录`, 'warning', {
        label: '查看',
        // 「知道了」带 action 只是为了让这条详情不被下一条普通提示顶掉（M-16 只保护撤销类）
        onClick: () =>
          toastRef.current?.(describeRemoteChanges(list), 'warning', {
            label: '知道了',
            onClick: () => undefined
          })
      });
    },
    [undoChange]
  );

  const syncNow = useCallback(
    async (silent = false) => {
      const cfg = getSyncConfig();
      setConfigured(!!cfg);
      if (!cfg) return;
      if (!navigator.onLine) {
        setOnline(false);
        return;
      }
      if (busy.current) return;
      busy.current = true;
      setSyncing(true);
      /*
       * B3：这一轮是不是「新设备首次下载历史」。
       * 判据只有本机水位（`initialPending`），首轮失败会退回 idle 并保留标记，
       * 下次重试仍然是「下载历史」，不会因为一次失败就永远不提示。
       */
      const isInitial = initialPending.current;
      if (isInitial) {
        setInitialSync('running');
        setPulledCount(0);
      }
      try {
        const result = await runSync(cfg, isInitial ? (n) => setPulledCount(n) : undefined);
        setError(null);
        backoff.current = 0;
        if (retryTimer.current) {
          window.clearTimeout(retryTimer.current);
          retryTimer.current = undefined;
        }
        // H3：同步成功后立即告诉用户「这一轮对方动了你的什么」（空集合 = 不提示）
        reportImpact(result.impact);
        if (isInitial) {
          // 首轮成功收尾：先落标记，再弹一次「已下载 N 单」，之后的增量轮不会再走这里
          initialPending.current = false;
          setInitialSync('done');
          setPulledCount(result.pulled);
          if (result.pulledOrders > 0) {
            /*
             * 只弹一次（`initialPending` 已置 false，后续增量轮不会再进这个分支）。
             *
             * 为什么延迟 900ms：全新设备第一次打开时，AppShell 还会弹一条
             * 「这些是示例商品…」提示。Toast 是单槽（后弹的顶掉前一条），
             * 实测不延迟时这条「已下载」20ms 后就被示例商品提示顶掉 —— 用户等于没看到。
             * 稍等一拍再弹，既不抢首屏提示，也保证下载回执真的被看见。
             */
            const downloaded = result.pulledOrders;
            window.setTimeout(() => {
              toastRef.current?.(`已下载 ${downloaded} 单历史记录`, 'success', {
                label: '知道了',
                onClick: () => undefined
              });
            }, 900);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // 首轮失败：退回 idle（顶栏不再停在「正在下载历史」），下次重试会重新进入 running
        if (isInitial) setInitialSync('idle');
        // 失败后按 1s→2s→4s…→60s 退避重试；网络恢复由 online 事件另触发
        if (navigator.onLine) {
          backoff.current = nextBackoff(backoff.current);
          if (retryTimer.current) window.clearTimeout(retryTimer.current);
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = undefined;
            void syncRef.current(true);
          }, backoff.current);
        }
        if (!silent) throw e;
      } finally {
        busy.current = false;
        setSyncing(false);
        await refresh();
      }
    },
    [refresh, reportImpact]
  );
  syncRef.current = syncNow;

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void syncNow(true);
    };
    const onOffline = () => setOnline(false);
    let debounce: number | undefined;
    const onWanted = () => {
      if (debounce) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void syncNow(true), 700);
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') void syncNow(true);
    };
    const onConfig = () => void refresh();

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('yh-sync-wanted', onWanted);
    window.addEventListener('yh-sync-config', onConfig);
    document.addEventListener('visibilitychange', onVis);

    void refresh();
    if (getSyncConfig()) void syncNow(true);

    const timer = window.setInterval(() => {
      if (retryTimer.current) return;
      if (document.visibilityState === 'visible' && navigator.onLine) void syncNow(true);
    }, PULL_INTERVAL);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('yh-sync-wanted', onWanted);
      window.removeEventListener('yh-sync-config', onConfig);
      document.removeEventListener('visibilitychange', onVis);
      window.clearInterval(timer);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      if (debounce) window.clearTimeout(debounce);
    };
  }, [refresh, syncNow]);

  return useMemo(
    () => ({
      configured,
      online,
      syncing,
      pending,
      lastSyncAt: last,
      error,
      syncNow,
      remoteChanges,
      clearRemoteChanges,
      initialSync,
      pulledCount
    }),
    [
      configured,
      online,
      syncing,
      pending,
      last,
      error,
      syncNow,
      remoteChanges,
      clearRemoteChanges,
      initialSync,
      pulledCount
    ]
  );
}