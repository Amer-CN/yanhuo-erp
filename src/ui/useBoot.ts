import { useEffect, useState } from 'react';
import { ensureBootstrapSettings, ensureDeviceId, migrateSessions } from '../db/repo';
import { seedIfEmpty } from '../db/seed';
import { latestSnapshot, snapshotBeforeOpen } from '../db/backup';
import { SETTING_KEYS } from '../db/types';
import type { Done } from './kit';

export function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return '平板';
  if (/iPhone/.test(ua)) return '手机';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? '手机' : '平板';
  return '本机';
}

/**
 * 启动编排：快照 → 设备 ID → 默认设置 → 示例数据 → 历史场次迁移。
 * T07 要求 snapshotBeforeOpen 必须在 Dexie 首次打开主库之前，因此始终排第一。
 */
export function useBoot(showToast: Done) {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // 必须在 Dexie 打开主库之前：升级/迁移前先留一份可导出的快照
        try {
          await snapshotBeforeOpen();
        } catch {
          // 快照失败不阻断启动；不写 console，避免打扰摊主
        }
        await ensureDeviceId();
        await ensureBootstrapSettings({
          [SETTING_KEYS.deviceName]: defaultDeviceName(),
          [SETTING_KEYS.operatorA]: '我',
          [SETTING_KEYS.operatorB]: '老婆',
          [SETTING_KEYS.expiryWarnDays]: '30'
        });
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
    };
  }, []);

  const retryMigrate = async () => {
    try {
      await migrateSessions();
      setMigrateError(null);
      showToast('历史数据已归到场次');
    } catch (e) {
      setMigrateError(msgOf(e));
    }
  };

  const exportLatestBackup = async () => {
    try {
      const snap = await latestSnapshot();
      if (!snap) {
        showToast('还没有可导出的备份', 'warning');
        return;
      }
      const blob = new Blob([JSON.stringify(snap.file)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `烟花账-迁移前备份-${snap.at.slice(0, 10)}.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 3000);
      showToast('已导出最近一份备份');
    } catch (e) {
      showToast(`导出备份失败：${msgOf(e)}`, 'error');
    }
  };

  return { ready, bootError, migrateError, retryMigrate, exportLatestBackup };
}