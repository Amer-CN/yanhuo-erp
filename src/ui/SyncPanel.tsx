import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { readSyncControl } from '../db/syncControl';
import {
  confirmReconnect,
  prepareReconnect,
  ReconnectError,
  type ReconnectChoice,
  type ReconnectPreview
} from '../db/syncReconnect';
import { Cloud, CloudOff, RefreshCw, Settings2, Trash2, Copy } from 'lucide-react';
import {
  clearSyncConfig,
  getSyncConfig,
  getStoredSyncConfig,
  isDefaultSyncConfig,
  makeLedgerKey,
  saveSyncConfig,
  testSyncConfig,
  type SyncConfig
} from '../db/sync';
import type { SyncApi } from './useSync';
import { Btn, Card, ConfirmSheet, Field, Sheet, type Done } from './kit';
import { localDate } from '../db/util';
import schemaSql from '../../supabase/schema.sql?raw';

function fmtTime(ts: number | null): string {
  if (!ts) return '还没同步过';
  const d = new Date(ts);
  return `${localDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function SyncPanel({ sync, onDone, blocked = false }: { sync: SyncApi; onDone: Done; blocked?: boolean }) {
  const [editing, setEditing] = useState(() => !getSyncConfig());
  const [url, setUrl] = useState(() => getStoredSyncConfig()?.url ?? '');
  const [key, setKey] = useState(() => getStoredSyncConfig()?.anonKey ?? '');
  const [ledger, setLedger] = useState(() => getStoredSyncConfig()?.ledgerKey ?? '');
  const [help, setHelp] = useState(false);
  const [disableConfirm, setDisableConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const control = useLiveQuery(() => readSyncControl(), []);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<ReconnectPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ReconnectChoice>>({});
  const [previewStale, setPreviewStale] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const locked = busy || blocked;
  const paused = Boolean(control?.paused);
  const needsReconnect = Boolean(control?.paused && control.reason !== 'user');
  const different = preview?.groups.filter((group) => group.status === 'different') ?? [];
  const choicesComplete = different.every((group) => choices[group.recordKey] === 'local' || choices[group.recordKey] === 'remote');

  const statusText = paused
    ? control?.maintenance ? '账本维护中' : '已暂停，待确认'
    : !sync.configured
      ? '未开启'
      : !sync.online
        ? '离线（联网后自动同步）'
        : sync.syncing
          ? '同步中…'
          : sync.error
            ? '同步出错'
            : '已连接';

  const run = async (task: () => Promise<void>) => {
    if (gate.current || blockedRef.current) return;
    gate.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };
  const config = (): SyncConfig | null => {
    if (!url.trim() || !key.trim() || !ledger.trim()) {
      onDone('三个都填：Project URL、anon key、同步码', 'error');
      return null;
    }
    return { url: url.trim(), anonKey: key.trim(), ledgerKey: ledger.trim() };
  };

  const save = async () => {
    const cfg = config();
    if (!cfg) return;
    await run(async () => {
      try {
        // 状态必须在提交时重读，不能用打开设置时缓存的 paused 值。
        const current = await readSyncControl();
        if (current.paused && current.reason !== 'user') {
          setEditing(true);
          onDone('同步已暂停，请先准备重连并核对数据差异', 'warning');
          return;
        }
        await saveSyncConfig(cfg);
        window.dispatchEvent(new Event('yh-sync-config'));
        setEditing(false);
        onDone('云同步已开启，正在等待同步结果');
      } catch (e) {
        onDone('启用失败：' + (e instanceof Error ? e.message : String(e)), 'error');
      }
    });
  };

  const test = async () => {
    const cfg = config();
    if (!cfg) return;
    await run(async () => {
      try {
        await testSyncConfig(cfg);
        onDone('连接成功，云端表可访问');
      } catch (e) {
        onDone('连接失败：' + (e instanceof Error ? e.message : String(e)), 'error');
      }
    });
  };

  const disable = async () => {
    await run(async () => {
      try {
        await clearSyncConfig();
        window.dispatchEvent(new Event('yh-sync-config'));
        setDisableConfirm(false);
        setEditing(true);
        onDone('已关闭云同步，本机数据与连接配置保留', 'warning');
      } catch (e) {
        onDone('关闭失败：' + (e instanceof Error ? e.message : String(e)), 'error');
      }
    });
  };

  const prepare = async () => {
    const cfg = config();
    if (!cfg) return;
    await run(async () => {
      setPreviewOpen(true);
      setPreview(null);
      setChoices({});
      setPreviewStale(false);
      setPreviewError(null);
      try {
        setPreview(await prepareReconnect(cfg));
      } catch (e) {
        setPreviewError(`差异预览失败，请重新预览：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };

  const reconnect = async () => {
    if (!preview || previewStale || !choicesComplete) return;
    const selected = preview;
    await run(async () => {
      setPreviewError(null);
      try {
        await confirmReconnect(selected, choices);
        window.dispatchEvent(new Event('yh-sync-config'));
        setPreviewOpen(false);
        setPreview(null);
        setEditing(false);
        onDone('差异已确认，已重新接入；同步结果请看上次同步时间');
      } catch (e) {
        const stale = e instanceof ReconnectError && e.code === 'RECONNECT_STALE';
        setPreviewStale(true);
        setPreviewError(stale
          ? '账本或清空状态已变化，请重新预览并确认差异。'
          : `重新接入失败，请重新预览：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };
  const closePreview = () => {
    if (gate.current || blockedRef.current) return;
    setPreviewOpen(false);
    setPreview(null);
    setChoices({});
  };
  const edit = () => {
    if (gate.current || blockedRef.current) return;
    const stored = getStoredSyncConfig();
    if (stored) { setUrl(stored.url); setKey(stored.anonKey); setLedger(stored.ledgerKey); }
    setEditing(true);
  };

  return (
    <Card>
      <div className="form-head">
        <h2>云同步</h2>
        <span
          className={`glass-badge ${!paused && sync.error ? 'glass-badge--error' : !paused && sync.configured ? 'glass-badge--success' : ''}`}
        >
          {statusText}
        </span>
      </div>

      {paused ? (
        <p className="glass-hint" role="status" style={{ marginTop: 10 }}>
          {control?.maintenance
            ? '账本操作进行中，请等待结果。'
            : needsReconnect
              ? '本机已恢复或清空，云端未回滚。同步保持暂停；先准备重连，核对差异后才能继续。'
              : '云同步已关闭；本机数据与连接配置保留。'}
        </p>
      ) : null}

      {editing ? (
        <div className="page-stack" style={{ marginTop: 10 }}>
          <p className="muted-text" style={{ margin: 0 }}>
            两台手机填同一个同步码。数据存在你自己的 Supabase 项目里，离线照常开单，联网自动推拉。
          </p>
          <Field label="Project URL">
            <input
              className="glass-input"
              value={url}
              disabled={locked || Boolean(control?.maintenance)}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://xxxx.supabase.co"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field label="anon public key">
            <input
              className="glass-input"
              type="password"
              value={key}
              disabled={locked || Boolean(control?.maintenance)}
              onChange={(e) => setKey(e.target.value)}
              placeholder="eyJhbGciOi..."
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field label="同步码（两台手机必须一样）">
            <input
              className="glass-input"
              value={ledger}
              disabled={locked || Boolean(control?.maintenance)}
              onChange={(e) => setLedger(e.target.value)}
              placeholder="点下面生成一个"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <Btn block={false} variant="tertiary" disabled={locked} onClick={() => setLedger(makeLedgerKey())}>
              生成
            </Btn>
            <Btn
              block={false}
              variant="tertiary"
              disabled={locked}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(ledger);
                  onDone('同步码已复制，去第二台手机粘贴');
                } catch {
                  onDone('复制失败，长按输入框手动复制', 'warning');
                }
              }}
            >
              <span className="icon-text">
                <Copy size={16} aria-hidden="true" /> 复制
              </span>
            </Btn>
            <span className="tiny-text">生成后复制给另一台手机</span>
          </div>
          <div className="stack-sm">
            <Btn block disabled={locked || !control || Boolean(control.maintenance)} onClick={needsReconnect ? prepare : save}>
              {needsReconnect ? '准备重连' : '保存并启用'}
            </Btn>
            <Btn block variant="secondary" disabled={locked || !control || Boolean(control.maintenance)} onClick={test}>
              测试连接
            </Btn>
            <Btn block variant="tertiary" disabled={locked} onClick={() => setHelp(true)}>
              怎么配置？看步骤
            </Btn>
          </div>
        </div>
      ) : (
        <div className="page-stack" style={{ marginTop: 10 }}>
          <p className="tiny-text" style={{ margin: 0 }}>
            {isDefaultSyncConfig() ? '内置配置，打开即用；内置账本为共享密钥，仅用于自用。' : '自定义同步配置；两台设备填相同配置。'}
          </p>
          <div className="sync-lines">
            <div className="sync-line">
              <span>状态</span>
              <span className="icon-text">
                {sync.configured ? <Cloud size={16} aria-hidden="true" /> : <CloudOff size={16} aria-hidden="true" />}
                {statusText}
              </span>
            </div>
            <div className="sync-line">
              <span>配置</span>
              <span>{isDefaultSyncConfig() ? '内置，打开即用' : '自定义'}</span>
            </div>
            <div className="sync-line">
              <span>上次同步</span>
              <span>{fmtTime(sync.lastSyncAt)}</span>
            </div>
            <div className="sync-line">
              <span>待推送</span>
              <span>{sync.pending} 条</span>
            </div>
          </div>
          {/* 错误文本统一走 glass-hint--error；.glass-status 只留给中性说明 */}
          {sync.error ? <div className="glass-hint glass-hint--error">{sync.error}</div> : null}
          <div className="stack-sm">
            <Btn block disabled={locked || sync.syncing || !control || Boolean(control.maintenance)} onClick={needsReconnect ? prepare : () => sync.syncNow()}>
              <span className="icon-text">
                <RefreshCw size={18} aria-hidden="true" /> {needsReconnect ? '准备重连' : '立即同步'}
              </span>
            </Btn>
            <Btn block variant="secondary" disabled={locked || Boolean(control?.maintenance)} onClick={edit}>
              <span className="icon-text">
                <Settings2 size={18} aria-hidden="true" /> 修改配置
              </span>
            </Btn>
            <Btn block variant="danger" disabled={locked || Boolean(control?.maintenance)} onClick={() => setDisableConfirm(true)}>
              <span className="icon-text">
                <Trash2 size={18} aria-hidden="true" /> 关闭云同步
              </span>
            </Btn>
          </div>
        </div>
      )}

      {previewOpen ? (
        <Sheet
          title="重新接入前核对差异"
          onClose={closePreview}
          dismissible={!locked}
          footer={
            <div className="stack-sm">
              <Btn block disabled={locked || !preview || previewStale || !choicesComplete} onClick={() => void reconnect()}>
                {busy ? '处理中…' : '确认差异并重新接入'}
              </Btn>
              {previewStale || (!preview && previewError) ? (
                <Btn block variant="secondary" disabled={locked} onClick={() => void prepare()}>重新预览</Btn>
              ) : null}
              <Btn block variant="secondary" disabled={locked} onClick={closePreview}>暂不接入</Btn>
            </div>
          }
        >
          <div className="page-stack">
            <p className="muted-text" style={{ margin: 0 }}>
              预览期间同步保持暂停。仅本机的记录会保留并待上传，仅云端的记录会带到本机；内容不同的每组记录，请明确选一个版本。
            </p>
            {previewError ? <p className="glass-hint glass-hint--error" role="alert">{previewError}</p> : null}
            {!preview && !previewError ? <p role="status">正在读取本机与云端差异…</p> : null}
            {preview ? (
              <>
                <div className="merge-counts" aria-label="差异汇总">
                  <span>仅本机 {preview.counts.localOnly} 组</span>
                  <span>仅云端 {preview.counts.remoteOnly} 组</span>
                  <span>内容不同 {preview.counts.different} 组</span>
                  <span>相同 {preview.counts.same} 组</span>
                </div>
                {preview.groups.map((group) => (
                  <div key={group.recordKey} className="stack-sm" style={{ borderTop: '1px solid var(--gl-border-subtle)', paddingTop: 10 }}>
                    <div className="cart-line__name">{group.label}</div>
                    <p className="tiny-text" style={{ margin: 0 }}>
                      本机：{group.localText}
                    </p>
                    <p className="tiny-text" style={{ margin: 0 }}>
                      云端：{group.remoteText}
                    </p>
                    {group.status === 'different' ? (
                      <fieldset disabled={locked || previewStale} style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend className="tiny-text">选择保留的版本</legend>
                        <div className="stack-sm" style={{ marginTop: 6 }}>
                          <label className="check-row">
                            <input type="radio" name={`reconnect-${group.recordKey}`} value="local"
                              checked={choices[group.recordKey] === 'local'}
                              onChange={() => setChoices((current) => ({ ...current, [group.recordKey]: 'local' }))} />
                            采用本机版本
                          </label>
                          <label className="check-row">
                            <input type="radio" name={`reconnect-${group.recordKey}`} value="remote"
                              checked={choices[group.recordKey] === 'remote'}
                              onChange={() => setChoices((current) => ({ ...current, [group.recordKey]: 'remote' }))} />
                            采用云端版本
                          </label>
                        </div>
                      </fieldset>
                    ) : (
                      <p className="tiny-text" style={{ margin: 0 }}>
                        {group.status === 'localOnly' ? '保留本机，接入后待上传' : group.status === 'remoteOnly' ? '接入时采用云端' : '两端相同，无需选择'}
                      </p>
                    )}
                  </div>
                ))}
                {different.length > 0 && !choicesComplete ? <p className="tiny-text" role="status">请为每组内容不同的记录选择版本，尚未选择的记录不会默认采用本机。</p> : null}
              </>
            ) : null}
          </div>
        </Sheet>
      ) : null}

      {help ? (
        <Sheet title="配置云同步（约 3 分钟）" onClose={() => setHelp(false)}>
          <div className="page-stack">
            <div>
              <div className="cart-line__name">1. 建一个 Supabase 项目</div>
              <p className="muted-text">
                打开 supabase.com 登录 → New project → 随便起名（区域选 Singapore）→ 等 1 分钟。
              </p>
            </div>
            <div>
              <div className="cart-line__name">2. 新项目在 SQL Editor 里执行下面的 SQL</div>
              <p className="muted-text">
                已有账本升级时，先按仓库《云同步设置》的迁移步骤补列并备份，不要清表重建。
              </p>
              <pre className="sql-block">{schemaSql}</pre>
              <Btn
                block
                variant="secondary"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(schemaSql);
                    onDone('SQL 已复制');
                  } catch {
                    onDone('复制失败，长按选中复制', 'warning');
                  }
                }}
              >
                <span className="icon-text">
                  <Copy size={16} aria-hidden="true" /> 复制 SQL
                </span>
              </Btn>
            </div>
            <div>
              <div className="cart-line__name">3. 拿 URL 和 anon key</div>
              <p className="muted-text">
                Project Settings → API：复制 Project URL 和 anon public key，填到上面。
              </p>
            </div>
            <div>
              <div className="cart-line__name">4. 两台手机填同一个同步码</div>
              <p className="muted-text">
                第一台点「生成」得到一个码，复制给第二台填进去。之后开单会自动同步。
              </p>
            </div>
            <div className="glass-status">
              <p>
                不要放开 RLS。连接失败时先核对项目 URL、key、项目是否暂停和迁移步骤；仍失败先导出备份，再联系维护者。
              </p>
            </div>
            <Btn block onClick={() => setHelp(false)}>
              知道了
            </Btn>
          </div>
        </Sheet>
      ) : null}

      {disableConfirm ? (
        <ConfirmSheet
          title="关闭云同步？"
          description="本机数据保留，但两台手机不再自动同步。"
          confirmText="关闭云同步"
          danger
          busy={locked}
          onConfirm={() => void disable()}
          onCancel={() => { if (!gate.current && !blockedRef.current) setDisableConfirm(false); }}
        />
      ) : null}
    </Card>
  );
}