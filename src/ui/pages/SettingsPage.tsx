import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, Upload, Smartphone, Trash2, TriangleAlert, RotateCcw, Save, Moon, Sun } from 'lucide-react';
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
import { SETTING_KEYS, type Product, type Setting } from '../../db/types';
import {
  adoptRemoteConflict,
  afterMerge,
  clearCloud,
  getSyncConfig,
  loadConflicts,
  type ConflictView
} from '../../db/sync';
import SyncPanel from '../SyncPanel';
import type { SyncApi } from '../useSync';
import type { Theme } from '../AppShell';
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

/** 商品的可见变化（新增 / 调价 / 改名），顺序与备份里的商品顺序一致 */
function diffProducts(current: Product[], incoming: Product[]): string[] {
  const diffs: string[] = [];
  const curById = new Map(current.map((p) => [p.id, p]));
  for (const inc of incoming) {
    const cur = curById.get(inc.id);
    if (!cur) {
      diffs.push(`新增：${inc.name}（¥${fenToStr(inc.priceList)}）`);
      continue;
    }
    if (cur.priceList !== inc.priceList) {
      diffs.push(`${inc.name}：¥${fenToStr(cur.priceList)} → ¥${fenToStr(inc.priceList)}`);
    } else if (cur.name !== inc.name) {
      diffs.push(`改名：${cur.name} → ${inc.name}`);
    }
  }
  return diffs;
}

/**
 * 设置项在「导入合并」预览里的中文名（只列**真正会被合并改写**的键）。
 *
 * L-08：operatorA / operatorB 已进 merge.ts 的 LOCAL_IDENTITY_KEYS（按设备保留、
 * 永不覆盖），把它们列进「设置变化」等于预告一个不会发生的改名 —— 摊主会以为
 * 另一台手机把操作人改掉了。operatorSelf 同理（本机专属，也不进预览）。
 * 目前只有临期天数会被合并改写，所以这里只剩它。
 */
const SETTING_LABELS: Record<string, string> = {
  [SETTING_KEYS.expiryWarnDays]: '临期预警天数'
};

/** 关键设置的变化（只比较操作人与临期天数） */
function diffSettings(current: Setting[], incoming: Setting[]): string[] {
  const diffs: string[] = [];
  for (const s of incoming) {
    const label = SETTING_LABELS[s.key];
    if (!label) continue;
    const cur = current.find((x) => x.key === s.key)?.value ?? '';
    if (cur && cur !== s.value) diffs.push(`${label}：${cur} → ${s.value}`);
  }
  return diffs;
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

/** 下载备份（不依赖组件状态，四个 section 共用） */
function download(backup: BackupFile) {
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
}

/** 优先用系统分享（手机可发微信），否则退回下载；两处导出共用 */
async function shareOrDownload(file: File, backup: BackupFile, title = '烟花账备份') {
  const nav = navigator as Navigator & {
    canShare?: (data?: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title });
    } catch {
      download(backup);
    }
  } else {
    download(backup);
  }
}

/** 本机名 / 本机操作人编号 / 临期天数 / 外观 */
function MachineSection({
  settings,
  deviceId,
  theme,
  onToggleTheme,
  onDone
}: {
  settings: Record<string, string>;
  deviceId: string;
  theme: Theme;
  onToggleTheme: () => void;
  onDone: Done;
}) {
  const [deviceName, setDeviceName] = useState(settings[SETTING_KEYS.deviceName] ?? '');
  // 旧的 operatorA/B 只保留读（历史单里仍是旧字符串），设置页只暴露本机编号
  const [opSelf, setOpSelf] = useState(settings[SETTING_KEYS.operatorSelf] ?? '');
  const [warn, setWarn] = useState(settings[SETTING_KEYS.expiryWarnDays] ?? '30');

  /**
   * 存设置（M-10）：失败必须说一声。
   * 这几个字段都是 onBlur 静默落库的，配额满 / 事务冲突时 setSetting 会抛错，
   * 不提示的话用户以为编号已经存好，之后每张单都记在旧编号上（对账时才发现）。
   */
  const saveText = async (key: string, value: string) => {
    try {
      await setSetting(key, value);
    } catch (e) {
      onDone(`没存上：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  return (
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
        <Field
          label="本机操作人编号"
          hint="这台手机记账时记在谁名下。另一台手机设成 002。留空会退回设备名（两台都留空就都叫「本机」，历史单分不出谁卖的）。只影响本机，不会同步。"
        >
          <input
            className="glass-input"
            inputMode="numeric"
            maxLength={3}
            value={opSelf}
            onChange={(e) => setOpSelf(e.target.value.replace(/[^\d]/g, ''))}
            /*
             * 留空不静默放过（M-11）：回填 001 并落库。
             * 因为 App 里 operators[0] 是 operatorSelf → deviceName → '本机' 三级回落，
             * 两台手机都留空时历史单全部显示「本机」，报表里两个人彻底分不开。
             */
            onBlur={() => {
              const next = opSelf.trim();
              if (!next) {
                setOpSelf('001');
                void saveText(SETTING_KEYS.operatorSelf, '001');
                return;
              }
              void saveText(SETTING_KEYS.operatorSelf, next);
            }}
            placeholder="001"
          />
        </Field>
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

      {/*
       * 外观单独成段（M-13）：原来它夹在「临期预警」输入框正下方，
       * 正是失焦后手指的自然落点，一按整屏变色又没有任何反馈。
       * 现在用分隔线隔开、挪到卡片末尾，并在切换后给一条 Toast 说明切到了哪一档。
       */}
      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: '1px solid var(--gl-border-subtle)'
        }}
      >
        <div className="tiny-text" style={{ marginBottom: 6 }}>
          外观
        </div>
        <Btn
          block
          variant="secondary"
          onClick={() => {
            onToggleTheme();
            // 切换后立刻说明结果：整屏变色如果没有文字确认，用户会怀疑自己点错了
            onDone(`已切到${theme === 'dark' ? '浅色' : '深色'}外观`);
          }}
          aria-label={`切换外观，当前${theme === 'dark' ? '深色' : '浅色'}`}
        >
          <span className="icon-text">
            {theme === 'dark' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
            外观：{theme === 'dark' ? '深色' : '浅色'}
          </span>
        </Btn>
        <p className="tiny-text" style={{ margin: '8px 0 0' }}>
          点一下在深色 / 浅色之间切换。摊位强光下用浅色，晚上收摊用深色。
        </p>
      </div>
    </Card>
  );
}

/** 导出备份 + 选择文件触发导入 */
function BackupSection({
  settings,
  deviceId,
  onDone,
  onPickFile
}: {
  settings: Record<string, string>;
  deviceId: string;
  onDone: Done;
  onPickFile: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const lastExport = settings[SETTING_KEYS.lastExportAt] ?? '';
  const lastImport = settings[SETTING_KEYS.lastImportAt] ?? '';

  const doExport = async (silent = false): Promise<BackupFile | null> => {
    try {
      const backup = await exportBackup(deviceId);
      const name = `烟花账-备份-${new Date().toISOString().slice(0, 10)}.json`;
      const file = new File([JSON.stringify(backup)], name, { type: 'application/json' });
      await shareOrDownload(file, backup);
      await setSetting(SETTING_KEYS.lastExportAt, new Date().toISOString());
      if (!silent) onDone('备份已导出，记得发微信存一份');
      return backup;
    } catch (e) {
      onDone('导出失败：' + (e instanceof Error ? e.message : String(e)), 'error');
      return null;
    }
  };

  return (
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
          if (f) onPickFile(f);
          e.target.value = '';
        }}
      />
    </Card>
  );
}

/** 本地快照 + 云同步状态 + 同步冲突 + 安装引导 */
function SnapshotSection({
  sync,
  onDone,
  conflictCount
}: {
  sync: SyncApi;
  onDone: Done;
  conflictCount: number;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<SnapshotRow | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // 冲突列表：null = 加载中（打开 Sheet 时先置 null，避免把「还没读出来」误显示成「没有冲突」）
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictRows, setConflictRows] = useState<ConflictView[] | null>(null);
  const [conflictBusy, setConflictBusy] = useState<number | null>(null);

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

  const restoreStats = restoreTarget ? snapshotStats(restoreTarget) : null;

  /** 打开冲突列表：先显示加载态，再替换成列表或空态 */
  const openConflicts = async () => {
    setConflictOpen(true);
    setConflictRows(null);
    try {
      setConflictRows(await loadConflicts());
    } catch {
      setConflictRows([]);
    }
  };

  /**
   * 「用云端」：把该条冲突的云端快照写回本地，成功后这一条从列表和 conflicts 表一起消失。
   * 失败必须如实告知（校验不通过 / 事务失败），否则用户以为已经采用了云端值。
   */
  const takeRemoteVersion = async (row: ConflictView) => {
    setConflictBusy(row.id);
    try {
      await adoptRemoteConflict(row.id);
      setConflictRows(await loadConflicts());
      onDone('已用云端版本覆盖本地');
    } catch (e) {
      onDone(`没采用云端版本：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setConflictBusy(null);
    }
  };

  return (
    <>
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
          <Btn block variant="secondary" style={{ marginTop: 10 }} onClick={() => void openConflicts()}>
            查看
          </Btn>
        </Card>
      ) : (
        <Card>
          <h2 className="section-title">同步冲突</h2>
          <p className="muted-text" style={{ marginTop: 8 }}>
            没有冲突。两台手机改过同一条记录时，会在这里列出来。
          </p>
        </Card>
      )}

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

      {conflictOpen ? (
        <Sheet
          title="同步冲突"
          subtitle={conflictRows ? `${conflictRows.length} 条` : undefined}
          onClose={() => setConflictOpen(false)}
        >
          <div className="page-stack">
            {conflictRows === null ? (
              <p className="muted-text">正在读取…</p>
            ) : conflictRows.length === 0 ? (
              <p className="muted-text">没有冲突，已经全部处理完了。</p>
            ) : (
              conflictRows.map((row) => (
                <div key={row.id} className="glass-status" style={{ display: 'block' }}>
                  <div className="cart-line__name">{row.title}</div>
                  <p className="tiny-text" style={{ margin: '4px 0' }}>
                    {row.at.slice(0, 16).replace('T', ' ')} · {row.recordId}
                  </p>
                  <p className="tiny-text" style={{ margin: '2px 0' }}>
                    本地：{row.localText}
                  </p>
                  <p className="tiny-text" style={{ margin: '2px 0' }}>
                    云端：{row.remoteText}
                  </p>
                  <Btn
                    block
                    variant="secondary"
                    style={{ marginTop: 8 }}
                    disabled={conflictBusy !== null}
                    onClick={() => void takeRemoteVersion(row)}
                  >
                    {conflictBusy === row.id ? '处理中…' : '用云端'}
                  </Btn>
                </div>
              ))
            )}
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
    </>
  );
}

/** 危险操作：导入合并确认 / 撤销合并 / 三段式清空 */
function DangerSection({
  deviceId,
  onDone,
  pending,
  setPending,
  busy,
  setBusy
}: {
  deviceId: string;
  onDone: Done;
  pending: PendingMerge | null;
  setPending: (p: PendingMerge | null) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const [backupFirst, setBackupFirst] = useState(true);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [preMerge, setPreMerge] = useState<string | null>(null);
  const [undoConfirm, setUndoConfirm] = useState(false);
  const [clearStep, setClearStep] = useState<0 | 1 | 2 | 3>(0);
  const [pendingCfg, setPendingCfg] = useState<ReturnType<typeof getSyncConfig>>(null);
  // 清空本机进行中：重复点会连跑两遍（第二遍必然报错），按钮一并禁掉
  const [clearing, setClearing] = useState(false);

  // 每次导入新备份时重置「合并前先备份」勾选（与原来 pickFile 里的重置一致）
  useEffect(() => {
    if (pending) setBackupFirst(true);
  }, [pending]);

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
        await shareOrDownload(file, pre, '合并前本机备份');
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

  /** 危险操作三段式：1 确认清本机 → 2 再确认 → 3（有云端配置时）是否清云端 */
  const runClearLocal = async () => {
    if (clearing) return;
    setClearStep(0);
    setClearing(true);
    try {
      await clearAllData();
      onDone('已清空', 'warning');
    } catch (e) {
      // 清空失败必须如实告知，否则用户以为账本已经空了
      onDone(`没清掉：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setClearing(false);
    }
  };

  const confirmClearStep = async () => {
    if (clearing) return;
    if (clearStep === 1) {
      setClearStep(2);
      return;
    }
    if (clearStep === 2) {
      const cfg = getSyncConfig();
      if (cfg) {
        setPendingCfg(cfg);
        setClearStep(3);
        return;
      }
      await runClearLocal();
      return;
    }
    const cfg = pendingCfg;
    setPendingCfg(null);
    let cloudError: string | null = null;
    if (cfg) {
      try {
        await clearCloud(cfg);
      } catch (e) {
        // 云端失败不阻断本地清空；必须明确告知，否则下次同步会把旧数据拉回来
        cloudError = e instanceof Error ? e.message : String(e);
      }
    }
    await runClearLocal();
    if (cloudError) {
      onDone(`本地已清空，但云端没清干净（${cloudError}）。联网后再清一次云端`, 'warning');
    }
  };

  /**
   * 取消 / 关掉对话框 = **永远是安全出口**：只关闭，绝不清任何数据。
   *
   * 历史事故（H-01，已修，**别改回**）：第 3 段「同时清空云端账本？」原来把「取消」
   * 实现成「跳过清云端、但仍清本机」，于是摊主想「先不清云端」点一下取消，
   * 本机账本当场被清空且不可恢复（清空本机没有撤销）。
   * 现在只有 confirmClearStep（确认）能走到 clearAllData / clearCloud，
   * cancel / 遮罩 / Esc / 关闭按钮一律短路到这里。
   */
  const cancelClearStep = () => {
    setPendingCfg(null);
    setClearStep(0);
  };

  return (
    <>
      <Card>
        <h2 className="section-title">危险操作</h2>
        <div style={{ marginTop: 10 }}>
          <Btn
            block
            variant="danger"
            onClick={() => setClearStep(1)}
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
                <Btn block={false} variant="tertiary" style={{ flex: 1 }} onClick={() => setUndoConfirm(true)}>
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

      {undoConfirm ? (
        <ConfirmSheet
          title="撤销这次合并？"
          description="会把账本恢复到合并前的状态。"
          confirmText="撤销合并"
          danger
          onConfirm={() => {
            setUndoConfirm(false);
            void undoMerge();
          }}
          onCancel={() => setUndoConfirm(false)}
        />
      ) : null}

      {clearStep > 0 ? (
        <ConfirmSheet
          title={
            clearStep === 1
              ? '清空所有商品、进货、销售数据？'
              : clearStep === 2
                ? '再确认一次：'
                : '同时清空云端账本？'
          }
          description={
            clearStep === 1
              ? '导出备份后再操作。'
              : clearStep === 2
                ? '清空后无法恢复（除了导入之前导出的备份）。'
                : '两台手机都会被清空。点「不清了（保留数据）」只关掉这一步，什么都不会清。若另一台手机还有未上传的改动，它上线时可能会把部分旧数据带回来；建议先在那边同步一次。'
          }
          confirmText={clearStep === 1 ? '继续' : clearStep === 2 ? '清空本机' : '一并清空云端'}
          /* 第 3 步的取消必须写成安全语义：原来它就叫「取消」，却会清本机 */
          cancelText={clearStep === 3 ? '不清了（保留数据）' : '取消'}
          danger
          busy={clearing}
          onConfirm={() => void confirmClearStep()}
          onCancel={cancelClearStep}
        />
      ) : null}
    </>
  );
}

/**
 * 设置页容器：只持有导入结果（pending）与合并中标志（busy），
 * 其余 state 跟着职责拆进 Machine / Backup / Snapshot / Danger 四个 section。
 */
export default function SettingsPage({
  settings,
  deviceId,
  sync,
  theme,
  onToggleTheme,
  onDone
}: {
  settings: Record<string, string>;
  deviceId: string;
  sync: SyncApi;
  theme: Theme;
  onToggleTheme: () => void;
  onDone: Done;
}) {
  const [pending, setPending] = useState<PendingMerge | null>(null);
  const [busy, setBusy] = useState(false);
  const conflictCount = useLiveQuery(() => db.conflicts.count(), [], 0) ?? 0;

  const pickFile = async (file: File) => {
    try {
      const text = await file.text();
      const backup = parseBackup(text);
      const current = await loadAll();
      const productDiffs = diffProducts(current.products, backup.data.products);
      const settingsDiffs = diffSettings(current.settings, backup.data.settings);

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
    } catch (e) {
      onDone('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    }
  };

  return (
    <div className="page-stack">
      <MachineSection
        settings={settings}
        deviceId={deviceId}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onDone={onDone}
      />

      <BackupSection settings={settings} deviceId={deviceId} onDone={onDone} onPickFile={pickFile} />

      <SnapshotSection sync={sync} onDone={onDone} conflictCount={conflictCount} />

      <DangerSection
        deviceId={deviceId}
        onDone={onDone}
        pending={pending}
        setPending={setPending}
        busy={busy}
        setBusy={setBusy}
      />
    </div>
  );
}