// 云同步：本地优先 + 发件箱推送 + 增量拉取。
// 后端：Supabase（PostgREST）。配置只存 localStorage，不写进会被同步的设置表。

import { db } from './db';
import { loadAll } from './repo';
import { enqueueAllLocal, pendingCount, syncWanted } from './outbox';
import { DEFAULT_SYNC } from './syncDefaults';
import type { Adjustment, Batch, Product, SaleLine, SalesOrder, Setting } from './types';

export interface SyncConfig {
  url: string;
  anonKey: string;
  ledgerKey: string;
}

export interface SyncStatus {
  configured: boolean;
  online: boolean;
  syncing: boolean;
  pending: number;
  lastSyncAt: number | null;
  error: string | null;
}

const LS = {
  url: 'yh-sync-url',
  anonKey: 'yh-sync-anon',
  ledger: 'yh-sync-ledger',
  lastPull: 'yh-sync-last-pull',
  lastSync: 'yh-sync-last-sync',
  error: 'yh-sync-error',
  disabled: 'yh-sync-disabled'
};

/** 设备身份类设置不参与云同步 */
const SKIP_SETTINGS = new Set<string>(['deviceId', 'deviceName']);

export function getSyncConfig(): SyncConfig | null {
  try {
    if (localStorage.getItem(LS.disabled) === '1') return null;

    const url = localStorage.getItem(LS.url)?.trim().replace(/\/+$/, '');
    const anonKey = localStorage.getItem(LS.anonKey)?.trim();
    const ledgerKey = localStorage.getItem(LS.ledger)?.trim();
    if (url && anonKey && ledgerKey) return { url, anonKey, ledgerKey };

    // 没手动配置就用内置配置：打开即同步，零设置
    if (DEFAULT_SYNC.url && DEFAULT_SYNC.anonKey && DEFAULT_SYNC.ledgerKey) {
      return {
        url: DEFAULT_SYNC.url,
        anonKey: DEFAULT_SYNC.anonKey,
        ledgerKey: DEFAULT_SYNC.ledgerKey
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function isDefaultSyncConfig(): boolean {
  const cfg = getSyncConfig();
  return Boolean(
    cfg &&
      cfg.url === DEFAULT_SYNC.url &&
      cfg.anonKey === DEFAULT_SYNC.anonKey &&
      cfg.ledgerKey === DEFAULT_SYNC.ledgerKey
  );
}

export function saveSyncConfig(cfg: SyncConfig): void {
  localStorage.setItem(LS.url, cfg.url.trim().replace(/\/+$/, ''));
  localStorage.setItem(LS.anonKey, cfg.anonKey.trim());
  localStorage.setItem(LS.ledger, cfg.ledgerKey.trim());
  localStorage.removeItem(LS.disabled);
}

export function clearSyncConfig(): void {
  localStorage.removeItem(LS.url);
  localStorage.removeItem(LS.anonKey);
  localStorage.removeItem(LS.ledger);
  localStorage.removeItem(LS.lastPull);
  localStorage.removeItem(LS.lastSync);
  localStorage.removeItem(LS.error);
  localStorage.setItem(LS.disabled, '1');
}

export function makeLedgerKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function lastPullAt(): number {
  return Number(localStorage.getItem(LS.lastPull) ?? 0) || 0;
}

function setLastPull(v: number): void {
  localStorage.setItem(LS.lastPull, String(v));
}

export function lastSyncAt(): number | null {
  const v = Number(localStorage.getItem(LS.lastSync) ?? 0);
  return v || null;
}

export function lastSyncError(): string | null {
  return localStorage.getItem(LS.error);
}

/* ------------------------------------------------------------------ REST */

async function rest<T = unknown>(
  cfg: SyncConfig,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.anonKey,
      // 旧版 anon key 是 JWT（eyJ...），新 publishable key 不是 JWT，
      // 后者只放在 apikey 头里，避免被 PostgREST 当成坏 token。
      ...(cfg.anonKey.startsWith('eyJ') ? { Authorization: `Bearer ${cfg.anonKey}` } : {}),
      'Content-Type': 'application/json',
      'x-ledger-key': cfg.ledgerKey,
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/* ------------------------------------------------------------------ 记录映射 */

type Kind = 'product' | 'batch' | 'order' | 'line' | 'adjustment' | 'setting';

async function getLocal(kind: Kind, recordId: string): Promise<unknown | undefined> {
  switch (kind) {
    case 'product':
      return db.products.get(recordId);
    case 'batch':
      return db.batches.get(recordId);
    case 'order':
      return db.orders.get(recordId);
    case 'line':
      return db.lines.get(recordId);
    case 'adjustment':
      return db.adjustments.get(recordId);
    case 'setting':
      return db.settings.get(recordId);
  }
}

async function deleteLocal(kind: Kind, recordId: string): Promise<void> {
  switch (kind) {
    case 'product':
      await db.products.delete(recordId);
      return;
    case 'batch':
      await db.batches.delete(recordId);
      return;
    case 'order':
      await db.orders.delete(recordId);
      await db.lines.where('orderId').equals(recordId).delete();
      return;
    case 'line':
      await db.lines.delete(recordId);
      return;
    case 'adjustment':
      await db.adjustments.delete(recordId);
      return;
    case 'setting':
      await db.settings.delete(recordId);
      return;
  }
}

interface RemoteRow {
  id: string;
  record_id: string;
  kind: Kind;
  data: unknown;
  updated_at: number;
  deleted: boolean;
}

async function pushOutbox(cfg: SyncConfig, deviceId: string): Promise<number> {
  const rows = await db.outbox.orderBy('queuedAt').limit(300).toArray();
  if (rows.length === 0) return 0;

  const payload: {
    id: string;
    record_id: string;
    ledger: string;
    kind: Kind;
    data: unknown;
    updated_at: number;
    device_id: string;
    deleted: boolean;
  }[] = [];

  for (const row of rows) {
    if (row.kind === 'setting' && SKIP_SETTINGS.has(row.recordId)) continue;
    const local = row.op === 'delete' ? undefined : await getLocal(row.kind, row.recordId);
    payload.push({
      id: `${row.kind}:${row.recordId}`,
      record_id: row.recordId,
      ledger: cfg.ledgerKey,
      kind: row.kind,
      data: local ?? {},
      updated_at: Date.now(),
      device_id: deviceId,
      deleted: row.op === 'delete' || !local
    });
  }

  if (payload.length > 0) {
    await rest(cfg, 'yh_records?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload)
    });
  }
  await db.outbox.bulkDelete(rows.map((r) => r.id));
  return payload.length;
}

async function applyRemote(row: RemoteRow): Promise<void> {
  const pending = await db.outbox.get(`${row.kind}:${row.record_id}`);
  if (pending) return; // 本地还有没推上去的改动，先以本地为准

  if (row.deleted) {
    await deleteLocal(row.kind, row.record_id);
    return;
  }

  switch (row.kind) {
    case 'product': {
      const remote = row.data as Product;
      const cur = await db.products.get(row.record_id);
      if (!cur || (remote.updatedAt ?? '') > (cur.updatedAt ?? '')) {
        await db.products.put({ ...remote, id: row.record_id });
      }
      return;
    }
    case 'order': {
      const remote = row.data as SalesOrder;
      const cur = await db.orders.get(row.record_id);
      if (!cur || Boolean(cur.voided) !== Boolean(remote.voided)) {
        await db.orders.put({ ...remote, id: row.record_id });
      }
      return;
    }
    case 'batch':
      if (!(await db.batches.get(row.record_id))) {
        await db.batches.put({ ...(row.data as Batch), id: row.record_id });
      }
      return;
    case 'line':
      if (!(await db.lines.get(row.record_id))) {
        await db.lines.put({ ...(row.data as SaleLine), id: row.record_id });
      }
      return;
    case 'adjustment':
      if (!(await db.adjustments.get(row.record_id))) {
        await db.adjustments.put({ ...(row.data as Adjustment), id: row.record_id });
      }
      return;
    case 'setting': {
      if (SKIP_SETTINGS.has(row.record_id)) return;
      const remote = row.data as Setting;
      if (remote && typeof remote.key === 'string') {
        await db.settings.put({ key: row.record_id, value: remote.value });
      }
      return;
    }
  }
}

async function pull(cfg: SyncConfig): Promise<number> {
  let since = lastPullAt();
  let pulled = 0;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      ledger: `eq.${cfg.ledgerKey}`,
      updated_at: `gt.${since}`,
      order: 'updated_at.asc',
      limit: '500',
      select: '*'
    });
    const rows = await rest<RemoteRow[]>(cfg, `yh_records?${params.toString()}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      await applyRemote(row);
      since = Math.max(since, Number(row.updated_at) || 0);
      pulled++;
    }
    setLastPull(since);
    if (rows.length < 500) break;
  }
  return pulled;
}

/* ------------------------------------------------------------------ 对外 */

export interface SyncResult {
  pushed: number;
  pulled: number;
}

export async function syncNow(cfg: SyncConfig): Promise<SyncResult> {
  if (!navigator.onLine) throw new Error('当前离线');
  const deviceId = (await db.settings.get('deviceId'))?.value ?? '';
  const pushed = await pushOutbox(cfg, deviceId);
  const pulled = await pull(cfg);
  localStorage.setItem(LS.lastSync, String(Date.now()));
  localStorage.removeItem(LS.error);
  return { pushed, pulled };
}

export async function testSyncConfig(cfg: SyncConfig): Promise<void> {
  await rest(cfg, 'yh_records?select=id&limit=1');
}

/** 清空云端账本（危险操作，与本地清空一起用） */
export async function clearCloud(cfg: SyncConfig): Promise<void> {
  await rest(cfg, `yh_records?ledger=eq.${encodeURIComponent(cfg.ledgerKey)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
}

export async function syncPending(): Promise<number> {
  return pendingCount();
}

export async function markAllDirty(): Promise<void> {
  await enqueueAllLocal();
  syncWanted();
}

/** 合并/导入之后，把本地整库标记为待推送 */
export async function afterMerge(): Promise<void> {
  await markAllDirty();
}

/** 给设置页展示的本地概况 */
export async function localSummary(): Promise<{ products: number; orders: number; pending: number }> {
  const all = await loadAll();
  return {
    products: all.products.length,
    orders: all.orders.length,
    pending: await pendingCount()
  };
}