import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, Upload, Smartphone, Trash2, TriangleAlert, RotateCcw, Save } from 'lucide-react';
import { db } from '../../db/db';
import { clearAllData, loadAll, setSetting } from '../../db/repo';
import {
  exportBackup,
  importMerge,
  parseBackup,
  replaceAll,
  type BackupFile,
  type MergeResult
} from '../../db/merge';
import {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  type SnapshotReason,
  type SnapshotRow
} from '../../db/backup';
import { SETTING_KEYS } from '../../db/types';
import { afterMerge, clearCloud, getSyncConfig } from '../../db/sync';
import SyncPanel from '../SyncPanel';
import type { SyncApi } from '../useSync';
import { fenToStr } from '../../db/util';
import { Btn, Card, ConfirmSheet, Field, Sheet, type Done } from '../kit';

interface PendingMerge {
  backup: BackupFile;
  counts: {
    products: number;
    batches: number;
    orders: number;
    lines: number;
    adjustments: number;
    settings: number;
  };
  productDiffs: string[];
  settingsDiffs: string[];
}

const SNAPSHOT_REASON: Record<SnapshotReason, string> = {
  close: '收摊自动',
  manual: '手动',
  'pre-migrate': '迁移前'
};

function snapshotStats(row: SnapshotRow): { orderCount: number; revenueFen: number } {
  const orders = row.file.data.orders.filter((o) => !o.voided);
  return {
    orderCount: orders.length,
    revenueFen: orders.reduce((sum, o) => sum + o.totalFen, 0)
  };
}

export default function SettingsPage({
  settings,
  deviceId,
  sync,
  onDone
}: {
  settings: Record<string, string>;
  deviceId: string;
  sync: SyncApi;
  onDone: Done;
}) {
  const [deviceName, setDeviceName] = useState(settings[SETTING_KEYS.deviceName] ?? '');
  const [opA, setOpA] = useState(settings[SETTING_KEYS.operatorA] ?? '我');
  const [opB, setOpB] = useState(settings[SETTING_KEYS.operatorB] ?? '老婆');
  const [warn, setWarn] = useState(settings[SETTING_KEYS.expiryWarnDays] ?? '30');
  const fileRef = useRef<HTMLInputElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pending, setPending] = useState<PendingMerge | null>(null);
  const [backupFirst, setBackupFirst] = useState(true);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [preMerge, setPreMerge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<SnapshotRow | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const conflictCount = useLiveQuery(() => db.conflicts.count(), [], 0) ?? 0;

  useEffect(() => {
    void listSnapshots()
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  }, []);

  const refreshSnapshots = async () => {
    try {
      setSnapshots(await listSnapshots());
    } catch {
      setSnapshots([]);
    }
  };

  const doSnapshot = async () => {
    setSnapshotBusy(true);
    try {
      await createSnapshot('manual');
      await refreshSnapshots();
      onDone('已备份到本机');
    } catch (e) {
      onDone('备份失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setSnapshotBusy(false);
    }
  };

  const doRestore = async () => {
    if (!restoreTarget?.id) return;
    setSnapshotBusy(true);
    try {
      await restoreSnapshot(restoreTarget.id);
      setRestoreTarget(null);
      await refreshSnapshots();
      onDone('已恢复到这份备份，云同步已暂停；确认无误后到「云同步」重新开启', 'warning');
    } catch (e) {
      onDone('恢复失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setSnapshotBusy(false);
    }
  };

  const saveText = async (key: string, value: string) => {
    await setSetting(key, value);
  };

  const lastExport = settings[SETTING_KEYS.lastExportAt] ?? '';
  const lastImport = settings[SETTING_KEYS.lastImportAt] ?? '';

  const download = (backup: BackupFile) => {
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate()
    ).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(
      2,
      '0'
    )}`;
    a.href = url;
    a.download = `烟花账-备份-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  const doExport = async (silent = false): Promise<BackupFile | null> => {
    try {
      const backup = await exportBackup(deviceId);
      const name = `烟花账-备份-${new Date().toISOString().slice(0, 10)}.json`;
      const file = new File([JSON.stringify(backup)], name, { type: 'application/json' });
      const nav = navigator as Navigator & {
        canShare?: (data?: { files?: File[] }) => boolean;
        share?: (data: { files?: File[]; title?: string }) => Promise<void>;
      };
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        try {
          await nav.share({ files: [file], title: '烟花账备份' });
        } catch {
          download(backup);
        }
      } else {
        download(backup);
      }
      await setSetting(SETTING_KEYS.lastExportAt, new Date().toISOString());
      if (!silent) onDone('备份已导出，记得发微信存一份');
      return backup;
    } catch (e) {
      onDone('导出失败：' + (e instanceof Error ? e.message : String(e)), 'error');
      return null;
    }
  };

  const pickFile = async (file: File) => {
    try {
      const text = await file.text();
      const backup = parseBackup(text);
      const current = await loadAll();

      const productDiffs: string[] = [];
      const curById = new Map(current.products.map((p) => [p.id, p]));
      for (const inc of backup.data.products) {
        const cur = curById.get(inc.id);
        if (!cur) {
          productDiffs.push(`新增：${inc.name}（¥${fenToStr(inc.priceList)}）`);
          continue;
        }
        if (cur.priceList !== inc.priceList) {
          productDiffs.push(`${inc.name}：¥${fenToStr(cur.priceList)} → ¥${fenToStr(inc.priceList)}`);
        } else if (cur.name !== inc.name) {
          productDiffs.push(`改名：${cur.name} → ${inc.name}`);
        }
      }

      const settingsDiffs: string[] = [];
      const keyName: Record<string, string> = {
        [SETTING_KEYS.operatorA]: '操作人 A',
        [SETTING_KEYS.operatorB]: '操作人 B',
        [SETTING_KEYS.expiryWarnDays]: '临期预警天数'
      };
      for (const s of backup.data.settings) {
        const label = keyName[s.key];
        if (!label) continue;
        const cur = current.settings.find((x) => x.key === s.key)?.value ?? '';
        if (cur && cur !== s.value) settingsDiffs.push(`${label}：${cur} → ${s.value}`);
      }

      setPending({
        backup,
        counts: {
          products: backup.data.products.length,
          batches: backup.data.batches.length,
          orders: backup.data.orders.length,
          lines: backup.data.lines.length,
          adjustments: backup.data.adjustments.length,
          settings: backup.data.settings.length
        },
        productDiffs: productDiffs.slice(0, 8),
        settingsDiffs
      });
      setBackupFirst(true);
    } catch (e) {
      onDone('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    }
  };

  const confirmMerge = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      let snapshot: string | null = null;
      if (backupFirst) {
        const pre = await exportBackup(deviceId);
        snapshot = JSON.stringify(pre);
        const preName = `烟花账-合并前备份-${new Date().toISOString().slice(0, 10)}.json`;
        const file = new File([snapshot], preName, { type: 'application/json' });
        const nav = navigator as Navigator & {
          canShare?: (data?: { files?: File[] }) => boolean;
          share?: (data: { files?: File[]; title?: string }) => Promise<void>;
        };
        if (nav.canShare?.({ files: [file] }) && nav.share) {
          try {
            await nav.share({ files: [file], title: '合并前本机备份' });
          } catch {
            download(JSON.parse(snapshot) as BackupFile);
          }
        } else {
          download(JSON.parse(snapshot) as BackupFile);
        }
      }
      const r = await importMerge(pending.backup);
      await afterMerge();
      await setSetting(SETTING_KEYS.lastImportAt, new Date().toISOString());
      setPreMerge(snapshot);
      setPending(null);
      setResult(r);
      onDone('合并完成，请核对下面的数字');
    } catch (e) {
      onDone('合并失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const undoMerge = async () => {
    if (!preMerge) return;
    if (!confirm('撤销这次合并？会把账本恢复到合并前的状态。')) return;
    try {
      await replaceAll(JSON.parse(preMerge) as BackupFile);
      const cfg = getSyncConfig();
      if (cfg) {
        // 云端也可能已经有合并后的记录，先清再推送，避免又被拉回来
        await clearCloud(cfg);
      }
      await afterMerge();
      setPreMerge(null);
      setResult(null);
      onDone('已撤销合并，账本回到合并前', 'warning');
    } catch (e) {
      onDone('撤销失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    }
  };

  const restoreStats = restoreTarget ? snapshotStats(restoreTarget) : null;

  return (
    <div className="page-stack">
      <Card>
        <h2 className="section-title">本机与操作人</h2>
        <div className="page-stack" style={{ marginTop: 10 }}>
          <Field label="这台设备叫什么（两台设备别重名）">
            <input
              className="glass-input"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              onBlur={() => saveText(SETTING_KEYS.deviceName, deviceName.trim() || '本机')}
              placeholder="手机 / 平板"
            />
          </Field>
          <div className="form-row">
            <Field label="操作人 A">
              <input
                className="glass-input"
                value={opA}
                onChange={(e) => setOpA(e.target.value)}
                onBlur={() => saveText(SETTING_KEYS.operatorA, opA.trim() || '我')}
              />
            </Field>
            <Field label="操作人 B">
              <input
                className="glass-input"
                value={opB}
                onChange={(e) => setOpB(e.target.value)}
                onBlur={() => saveText(SETTING_KEYS.operatorB, opB.trim() || '老婆')}
              />
            </Field>
          </div>
          <Field label="临期预警提前几天">
            <input
              className="glass-input"
              inputMode="numeric"
              value={warn}
              onChange={(e) => setWarn(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={() => saveText(SETTING_KEYS.expiryWarnDays, warn || '30')}
            />
          </Field>
          <p className="tiny-text" style={{ margin: 0 }}>
            本机编号：{deviceId.slice(0, 8)}（合并数据时用来区分来源）
          </p>
        </div>
      </Card>

      <Card>
        <h2 className="section-title">备份与合并</h2>
        <p className="muted-text" style={{ marginTop: 8 }}>
          两台设备各自开单，收摊后：一台点「导出」发微信，另一台点「导入合并」。同一条记录不会重复计入。
        </p>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          <Btn block onClick={() => void doExport()}>
            <span className="icon-text">
              <Download size={18} aria-hidden="true" /> 导出备份（发微信）
            </span>
          </Btn>
          <Btn block variant="secondary" onClick={() => fileRef.current?.click()}>
            <span className="icon-text">
              <Upload size={18} aria-hidden="true" /> 导入并合并
            </span>
          </Btn>
        </div>
        <div className="backup-times">
          <span>上次导出：{lastExport ? lastExport.slice(0, 16).replace('T', ' ') : '还没导出过'}</span>
          <span>上次导入：{lastImport ? lastImport.slice(0, 16).replace('T', ' ') : '还没导入过'}</span>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
            e.target.value = '';
          }}
        />
      </Card>

      <Card>
        <h2 className="section-title">本地备份</h2>
        <p className="muted-text" style={{ marginTop: 8 }}>
          收摊结账后自动存一份在本机，保留最近 3 个日期。清缓存或换机前，先从这里导出一份发微信。
        </p>
        <Btn
          block
          variant="secondary"
          disabled={snapshotBusy}
          onClick={() => void doSnapshot()}
          style={{ marginTop: 10 }}
        >
          <span className="icon-text">
            <Save size={18} aria-hidden="true" /> 立即备份
          </span>
        </Btn>
        {snapshots.length === 0 ? (
          <p className="tiny-text" style={{ marginBottom: 0 }}>
            还没有本地备份。
          </p>
        ) : (
          <div className="stack-sm" style={{ marginTop: 12 }}>
            {snapshots.slice(0, 3).map((row) => {
              const stats = snapshotStats(row);
              return (
                <div key={row.id ?? row.at} className="stack-sm">
                  <p className="tiny-text" style={{ margin: 0 }}>
                    {row.at.slice(0, 16).replace('T', ' ')} · {SNAPSHOT_REASON[row.reason]} ·{' '}
                    {stats.orderCount} 单 · ¥{fenToStr(stats.revenueFen)}
                  </p>
                  <div className="row" style={{ gap: 8 }}>
                    <Btn
                      block={false}
                      variant="secondary"
                      style={{ flex: 1 }}
                      disabled={snapshotBusy}
                      onClick={() => setRestoreTarget(row)}
                    >
                      恢复
                    </Btn>
                    <Btn
                      block={false}
                      variant="tertiary"
                      style={{ flex: 1 }}
                      onClick={() => {
                        download(row.file);
                        onDone('已导出这份备份');
                      }}
                    >
                      导出
                    </Btn>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <SyncPanel sync={sync} onDone={onDone} />

      {conflictCount > 0 ? (
        <Card>
          <h2 className="section-title">同步冲突</h2>
          <p className="muted-text" style={{ marginTop: 8 }}>
            待核对 {conflictCount} 条。两台设备改过同一条记录时会出现；本地记录已保留，没有自动覆盖。
          </p>
        </Card>
      ) : null}

      <Card>
        <h2 className="section-title">装到手机桌面</h2>
        <p className="muted-text" style={{ marginTop: 8 }}>
          安卓 Chrome / 苹果 Safari 打开本页 → 菜单「添加到主屏幕」。装好后像 App 一样全屏，断网也能开单。
          <br />
          苹果的 Safari 长期不打开可能清缓存，所以每天收摊点一次「导出备份」。
        </p>
        <Btn block variant="tertiary" onClick={() => setHelpOpen(true)}>
          <span className="icon-text">
            <Smartphone size={18} aria-hidden="true" /> 看详细步骤
          </span>
        </Btn>
      </Card>

      <Card>
        <h2 className="section-title">危险操作</h2>
        <div style={{ marginTop: 10 }}>
          <Btn
            block
            variant="danger"
            onClick={async () => {
              if (!confirm('清空所有商品、进货、销售数据？导出备份后再操作。')) return;
              if (!confirm('再确认一次：清空后无法恢复（除了导入之前导出的备份）。')) return;
              const cfg = getSyncConfig();
              if (cfg && confirm('同时清空云端账本？两台手机都会被清空。')) {
                await clearCloud(cfg);
              }
              await clearAllData();
              onDone('已清空', 'warning');
            }}
          >
            <span className="icon-text">
              <Trash2 size={18} aria-hidden="true" /> 清空全部数据
            </span>
          </Btn>
        </div>
        <p className="tiny-text" style={{ marginBottom: 0 }}>
          烟花账 v0.4 · 本地优先 · 云同步已内置
        </p>
      </Card>

      {pending ? (
        <Sheet
          title="确认合并"
          subtitle={`来源设备 ${pending.backup.deviceId ? pending.backup.deviceId.slice(0, 8) : '未知'} · 导出于 ${pending.backup.exportedAt.slice(0, 16).replace('T', ' ')}`}
          onClose={() => setPending(null)}
          footer={
            <div className="row" style={{ gap: 8 }}>
              <Btn block={false} variant="secondary" style={{ flex: 1 }} onClick={() => setPending(null)}>
                取消
              </Btn>
              <Btn block={false} style={{ flex: 1 }} disabled={busy} onClick={confirmMerge}>
                合并这些数据
              </Btn>
            </div>
          }
        >
          <div className="page-stack">
            <div className="merge-counts">
              <span>商品 {pending.counts.products}</span>
              <span>进货 {pending.counts.batches}</span>
              <span>销售 {pending.counts.orders}</span>
              <span>明细 {pending.counts.lines}</span>
              <span>调整 {pending.counts.adjustments}</span>
            </div>
            {pending.productDiffs.length > 0 ? (
              <div>
                <div className="tiny-text" style={{ fontWeight: 'var(--yh-weight-semibold)' }}>
                  商品变化
                </div>
                <ul className="merge-diff">
                  {pending.productDiffs.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {pending.settingsDiffs.length > 0 ? (
              <div>
                <div className="tiny-text" style={{ fontWeight: 'var(--yh-weight-semibold)' }}>
                  设置变化（操作人按设备保留，不会覆盖）
                </div>
                <ul className="merge-diff">
                  {pending.settingsDiffs.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <label className="check-row">
              <input
                type="checkbox"
                className="glass-checkbox"
                checked={backupFirst}
                onChange={(e) => setBackupFirst(e.target.checked)}
              />
              合并前先导出本机备份（推荐）
            </label>
            <div className="glass-status">
              <TriangleAlert size={20} aria-hidden="true" />
              <p>合并只增不减，同一条记录不会重复。设置里的操作人按设备保留。</p>
            </div>
          </div>
        </Sheet>
      ) : null}

      {result ? (
        <Sheet
          title="合并完成"
          onClose={() => setResult(null)}
          footer={
            <div className="row" style={{ gap: 8 }}>
              <Btn block={false} variant="secondary" style={{ flex: 1 }} onClick={() => setResult(null)}>
                完成
              </Btn>
              {preMerge ? (
                <Btn block={false} variant="tertiary" style={{ flex: 1 }} onClick={undoMerge}>
                  <span className="icon-text">
                    <RotateCcw size={16} aria-hidden="true" /> 撤销合并
                  </span>
                </Btn>
              ) : null}
            </div>
          }
        >
          <div className="page-stack">
            <div className="merge-counts">
              <span>商品 +{result.productsAdded} / 改 {result.productsUpdated}</span>
              <span>进货 +{result.batchesAdded}</span>
              <span>销售 +{result.ordersAdded} 单</span>
              <span>明细 +{result.linesAdded}</span>
              <span>调整 +{result.adjustmentsAdded}</span>
            </div>
            <p className="tiny-text" style={{ margin: 0 }}>
              同一条记录只算一次。建议现在去「报表」对一下当日销售额。
            </p>
          </div>
        </Sheet>
      ) : null}

      {helpOpen ? (
        <Sheet title="添加到主屏幕" onClose={() => setHelpOpen(false)}>
          <div className="page-stack">
            <div>
              <div className="cart-line__name">安卓（Chrome / Edge）</div>
              <p className="muted-text">
                右上角 ⋮ →「添加到主屏幕」→ 确认。以后从桌面图标打开。
              </p>
            </div>
            <div>
              <div className="cart-line__name">iPhone / iPad（Safari）</div>
              <p className="muted-text">
                底部「分享」按钮 → 往下找「添加到主屏幕」→ 添加。注意要用 Safari，微信里打开的不行。
              </p>
            </div>
            <div className="glass-status">
              <Smartphone size={20} aria-hidden="true" />
              <p>装好后先在飞行模式下试开一单，确认断网也能用，再拿去摊位。</p>
            </div>
            <Btn block onClick={() => setHelpOpen(false)}>
              知道了
            </Btn>
          </div>
        </Sheet>
      ) : null}
    {restoreTarget && restoreStats ? (
        <ConfirmSheet
          title="恢复这份本地备份？"
          description={
            <div className="stack-sm">
              <p style={{ margin: 0 }}>
                当前本机数据会被这份备份整体替换；恢复后云同步默认暂停，避免旧数据覆盖另一台手机。
              </p>
              <p className="tiny-text" style={{ margin: 0 }}>
                {restoreTarget.at.slice(0, 16).replace('T', ' ')} · {SNAPSHOT_REASON[restoreTarget.reason]} ·{' '}
                {restoreStats.orderCount} 单 · ¥{fenToStr(restoreStats.revenueFen)}
              </p>
            </div>
          }
          confirmText="恢复并暂停云同步"
          danger
          busy={snapshotBusy}
          onConfirm={() => void doRestore()}
          onCancel={() => setRestoreTarget(null)}
        />
      ) : null}
    </div>
  );
}