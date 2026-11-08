import { useState } from 'react';
import { Cloud, CloudOff, RefreshCw, Settings2, Trash2, Copy } from 'lucide-react';
import {
  clearSyncConfig,
  getSyncConfig,
  makeLedgerKey,
  saveSyncConfig,
  testSyncConfig,
  type SyncConfig
} from '../db/sync';
import type { SyncApi } from './useSync';
import { Btn, Card, Field, Sheet, type Done } from './kit';
import { localDate } from '../db/util';

const SQL = `create table if not exists public.yh_records (
  id text primary key,
  record_id text not null,
  ledger text not null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null,
  device_id text not null default '',
  deleted boolean not null default false
);
create index if not exists yh_records_ledger_updated
  on public.yh_records (ledger, updated_at);
alter table public.yh_records enable row level security;
grant select, insert, update, delete on public.yh_records to anon;
drop policy if exists "yh ledger access" on public.yh_records;
create policy "yh ledger access" on public.yh_records
  for all to anon
  using (ledger = coalesce(current_setting('request.headers', true)::json->>'x-ledger-key', ''))
  with check (ledger = coalesce(current_setting('request.headers', true)::json->>'x-ledger-key', ''));`;

function fmtTime(ts: number | null): string {
  if (!ts) return '还没同步过';
  const d = new Date(ts);
  return `${localDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function SyncPanel({ sync, onDone }: { sync: SyncApi; onDone: Done }) {
  const [editing, setEditing] = useState(() => !getSyncConfig());
  const [url, setUrl] = useState(() => getSyncConfig()?.url ?? '');
  const [key, setKey] = useState(() => getSyncConfig()?.anonKey ?? '');
  const [ledger, setLedger] = useState(() => getSyncConfig()?.ledgerKey ?? '');
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);

  const statusText = !sync.configured
    ? '未开启'
    : !sync.online
      ? '离线（联网后自动同步）'
      : sync.syncing
        ? '同步中…'
        : sync.error
          ? '同步出错'
          : '已连接';

  const save = async () => {
    if (!url.trim() || !key.trim() || !ledger.trim()) {
      onDone('三个都填：Project URL、anon key、同步码', 'error');
      return;
    }
    saveSyncConfig({ url, anonKey: key, ledgerKey: ledger });
    window.dispatchEvent(new Event('yh-sync-config'));
    setEditing(false);
    setBusy(true);
    try {
      await sync.syncNow();
      onDone('云同步已开启');
    } catch (e) {
      onDone('连接失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const cfg: SyncConfig = { url, anonKey: key, ledgerKey: ledger };
    setBusy(true);
    try {
      await testSyncConfig(cfg);
      onDone('连接成功，云端表可访问');
    } catch (e) {
      onDone('连接失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const disable = () => {
    if (!confirm('关闭云同步？本机数据保留，但两台手机不再自动同步。')) return;
    clearSyncConfig();
    window.dispatchEvent(new Event('yh-sync-config'));
    setEditing(true);
    onDone('已关闭云同步', 'warning');
  };

  return (
    <Card>
      <div className="form-head">
        <h2>云同步</h2>
        <span
          className={`glass-badge ${sync.error ? 'glass-badge--error' : sync.configured ? 'glass-badge--success' : ''}`}
        >
          {statusText}
        </span>
      </div>

      {editing ? (
        <div className="page-stack" style={{ marginTop: 10 }}>
          <p className="muted-text" style={{ margin: 0 }}>
            两台手机填同一个同步码。数据存在你自己的 Supabase 项目里，离线照常开单，联网自动推拉。
          </p>
          <Field label="Project URL">
            <input
              className="glass-input"
              value={url}
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
              onChange={(e) => setLedger(e.target.value)}
              placeholder="点下面生成一个"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <Btn block={false} variant="tertiary" onClick={() => setLedger(makeLedgerKey())}>
              生成
            </Btn>
            <Btn
              block={false}
              variant="tertiary"
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
            <Btn block disabled={busy} onClick={save}>
              保存并启用
            </Btn>
            <Btn block variant="secondary" disabled={busy} onClick={test}>
              测试连接
            </Btn>
            <Btn block variant="tertiary" onClick={() => setHelp(true)}>
              怎么配置？看步骤
            </Btn>
          </div>
        </div>
      ) : (
        <div className="page-stack" style={{ marginTop: 10 }}>
          <div className="sync-lines">
            <div className="sync-line">
              <span>状态</span>
              <span className="icon-text">
                {sync.configured ? <Cloud size={16} aria-hidden="true" /> : <CloudOff size={16} aria-hidden="true" />}
                {statusText}
              </span>
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
          {sync.error ? <div className="glass-status"><p>{sync.error}</p></div> : null}
          <div className="stack-sm">
            <Btn block disabled={sync.syncing} onClick={() => sync.syncNow()}>
              <span className="icon-text">
                <RefreshCw size={18} aria-hidden="true" /> 立即同步
              </span>
            </Btn>
            <Btn block variant="secondary" onClick={() => setEditing(true)}>
              <span className="icon-text">
                <Settings2 size={18} aria-hidden="true" /> 修改配置
              </span>
            </Btn>
            <Btn block variant="danger" onClick={disable}>
              <span className="icon-text">
                <Trash2 size={18} aria-hidden="true" /> 关闭云同步
              </span>
            </Btn>
          </div>
        </div>
      )}

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
              <div className="cart-line__name">2. 在 SQL Editor 里执行下面的 SQL</div>
              <pre className="sql-block">{SQL}</pre>
              <Btn
                block
                variant="secondary"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(SQL);
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
                如果提示连接失败：确认 SQL 已执行、项目没有被暂停；还不行就改用「单人账本」策略（只在
                Supabase 项目里自己可见时用）：把建 policy 那两句换成 using (true) with check (true)。
              </p>
            </div>
            <Btn block onClick={() => setHelp(false)}>
              知道了
            </Btn>
          </div>
        </Sheet>
      ) : null}
    </Card>
  );
}