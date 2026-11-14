// B02：真实 fake-indexeddb + 业务写入口；只让首次 POST 响应停在显式 gate 上。
import Dexie, { type Transaction } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { deleteRecord, saveRecord, updateRecord, type RecordInput } from '../src/db/repo';
import { restoreLocalSnapshot, syncNow, type SyncResult } from '../src/db/sync';
import { DEVICE, makeSession, resetDb, T0 } from './helpers';

const CFG = { url: 'http://127.0.0.1:54321', anonKey: 'test-key', ledgerKey: 'test-ledger' };
const NOW = Date.parse(T0);

type PushRecord = { id: string; record_id: string; kind: string; deleted: boolean; data: Record<string, unknown> };

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const store = new Map<string, string>();
let firstPost: ReturnType<typeof gate<void>>;
let firstResponse: ReturnType<typeof gate<number>>;
let applyRelease: ReturnType<typeof gate<void>> | undefined;
let running: Promise<SyncResult> | undefined;
let pushBodies: PushRecord[][];
let pages: unknown[][];
let fetchTransactions: (Transaction | undefined)[];

function input(amountFen = 1000): RecordInput {
  return {
    deviceId: DEVICE, operator: '我', sessionId: 's1', payMethod: 'cash',
    lines: [{ productId: 'p1', qtyBase: 1, unit: 'base', qty: 1, listUnitPriceFen: 1000, unitPriceFen: amountFen, amountFen }]
  };
}

function startSync(): Promise<SyncResult> {
  running = syncNow(CFG);
  // gate 释放前测试可能先失败；由 afterEach 收尾，防止悬挂的请求污染下一例。
  void running.catch(() => {});
  return running;
}

function pushedOrder(batch: number, id: string): PushRecord | undefined {
  return pushBodies[batch]?.find((row) => row.id === `order:${id}`);
}

beforeEach(async () => {
  await resetDb();
  await db.sessions.put(makeSession('s1'));
  store.clear();
  store.set('yh-sync-disabled', '1');
  // 只固定 Date，IndexedDB 与 HTTP 超时仍使用真实任务队列；无需 sleep/推进计时器。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  firstPost = gate<void>();
  firstResponse = gate<number>();
  applyRelease = undefined;
  running = undefined;
  pushBodies = [];
  pages = [];
  fetchTransactions = [];
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key)
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/rpc/yh_sync_capabilities')) return Response.json({ code: 'PGRST202' }, { status: 404 });
    expect(new URL(String(url)).origin).toBe(CFG.url);
    fetchTransactions.push(Dexie.currentTransaction);
    if (init?.method === 'POST') {
      pushBodies.push(JSON.parse(String(init.body)) as PushRecord[]);
      const first = pushBodies.length === 1;
      if (first) firstPost.resolve();
      const status = first ? await firstResponse.promise : 201;
      return new Response(status >= 400 ? 'failed POST' : null, { status });
    }
    const marker = new URL(String(url)).searchParams.has('id');
    return new Response(JSON.stringify(marker ? [] : pages.shift() ?? []), { status: 200 });
  }));
});

afterEach(async () => {
  firstResponse.resolve(201);
  applyRelease?.resolve();
  await running?.catch(() => {});
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (!db.isOpen()) await db.open();
  await resetDb();
});

describe('推送确认只清除本次发送的版本', () => {
  it('saveRecord 的 POST 等待响应时 deleteRecord 同 id：删除仍 pending，下一轮发墓碑', async () => {
    const order = await saveRecord(input());
    const line = (await db.lines.where('orderId').equals(order.id).toArray())[0];
    const sync = startSync();
    await firstPost.promise;
    expect(pushedOrder(0, order.id)).toMatchObject({ deleted: false, data: { totalFen: 1000 } });

    await deleteRecord(order.id);
    const deletion = await db.outbox.get(`order:${order.id}`);
    expect(deletion?.op).toBe('delete');
    firstResponse.resolve(201);
    await sync;

    expect(await db.orders.get(order.id)).toBeUndefined();
    expect(await db.outbox.get(`order:${order.id}`)).toEqual(deletion);
    expect(await db.outbox.get(`line:${line.id}`)).toMatchObject({ op: 'delete' });
    await syncNow(CFG);
    expect(pushedOrder(1, order.id)).toMatchObject({ deleted: true, data: {} });
    expect(pushBodies[1].find((row) => row.id === `line:${line.id}`)?.deleted).toBe(true);
    expect(await db.outbox.count()).toBe(0);
  });

  it('同一毫秒连续两次 updateRecord：旧确认不清最新 upsert，下一轮发送最新金额', async () => {
    const order = await saveRecord(input());
    const sent = await db.outbox.get(`order:${order.id}`);
    const sync = startSync();
    await firstPost.promise;
    await updateRecord(order.id, input(2000));
    await updateRecord(order.id, input(3000));
    const latest = await db.outbox.get(`order:${order.id}`);
    expect(latest?.queuedAt).toBe(sent?.queuedAt);
    firstResponse.resolve(201);
    await sync;

    expect(await db.outbox.get(`order:${order.id}`)).toEqual(latest);
    expect((await db.orders.get(order.id))?.totalFen).toBe(3000);
    await syncNow(CFG);
    expect(pushedOrder(1, order.id)).toMatchObject({ deleted: false, data: { totalFen: 3000 } });
    expect(await db.outbox.count()).toBe(0);
  });

  it('同毫秒 upsert → delete → upsert：op 与 queuedAt 相同仍保留最后一次恢复', async () => {
    const order = await saveRecord(input());
    const lines = await db.lines.where('orderId').equals(order.id).toArray();
    const sent = await db.outbox.get(`order:${order.id}`);
    const sync = startSync();
    await firstPost.promise;
    await deleteRecord(order.id);
    await restoreLocalSnapshot({
      type: 'removed', kind: 'order', recordId: order.id, label: '这单',
      local: { ...order, note: '恢复后的版本' }, children: lines.map((line) => ({ ...line }))
    });
    const latest = await db.outbox.get(`order:${order.id}`);
    expect(latest).toMatchObject({ op: sent?.op, queuedAt: sent?.queuedAt });
    firstResponse.resolve(201);
    await sync;

    expect(await db.outbox.get(`order:${order.id}`)).toEqual(latest);
    await syncNow(CFG);
    expect(pushedOrder(1, order.id)).toMatchObject({ deleted: false, data: { note: '恢复后的版本' } });
    expect(await db.lines.where('orderId').equals(order.id).count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it('失败 POST 保留当前版本及业务数据，下一轮成功后才清除', async () => {
    const order = await saveRecord(input());
    const sync = startSync();
    await firstPost.promise;
    await updateRecord(order.id, input(4000));
    const latest = await db.outbox.toArray();
    firstResponse.resolve(500);
    await expect(sync).rejects.toThrow('Supabase 500');

    expect(await db.outbox.toArray()).toEqual(latest);
    expect((await db.orders.get(order.id))?.totalFen).toBe(4000);
    expect(store.get('yh-sync-last-sync')).toBeUndefined();
    await syncNow(CFG);
    expect(pushedOrder(1, order.id)).toMatchObject({ data: { totalFen: 4000 }, deleted: false });
    expect(await db.outbox.count()).toBe(0);
  });

  it('旧行没有 revision 且未被替换：成功后正常清除', async () => {
    const order = await saveRecord(input());
    const legacy = { ...(await db.outbox.get(`order:${order.id}`))! };
    delete legacy.revision;
    await db.outbox.put(legacy);
    const sync = startSync();
    await firstPost.promise;
    firstResponse.resolve(201);
    await sync;

    expect(pushedOrder(0, order.id)).toMatchObject({ deleted: false, data: { totalFen: 1000 } });
    expect(await db.outbox.count()).toBe(0);
  });

  it('旧无 revision upsert 被同毫秒新 revision upsert 替代：旧确认不能清新行', async () => {
    const order = await saveRecord(input());
    const legacy = { ...(await db.outbox.get(`order:${order.id}`))! };
    delete legacy.revision;
    await db.outbox.put(legacy);
    const sync = startSync();
    await firstPost.promise;
    await updateRecord(order.id, input(5000));
    const latest = await db.outbox.get(`order:${order.id}`);
    expect(latest).toMatchObject({ queuedAt: legacy.queuedAt, op: legacy.op });
    firstResponse.resolve(201);
    await sync;

    expect(await db.outbox.get(`order:${order.id}`)).toEqual(latest);
    await syncNow(CFG);
    expect(pushedOrder(1, order.id)).toMatchObject({ data: { totalFen: 5000 } });
    expect(await db.outbox.count()).toBe(0);
  });

  it.each(['queuedAt', 'op'] as const)('两端均无 revision 但 %s 已变：旧确认保留替换行', async (field) => {
    const order = await saveRecord(input());
    const legacy = { ...(await db.outbox.get(`order:${order.id}`))! };
    delete legacy.revision;
    await db.outbox.put(legacy);
    const sync = startSync();
    await firstPost.promise;
    const replacement = { ...legacy, ...(field === 'op' ? { op: 'delete' as const } : { queuedAt: NOW + 1 }) };
    await db.outbox.put(replacement);
    firstResponse.resolve(201);
    await sync;

    expect(await db.outbox.get(legacy.id)).toEqual(replacement);
    await syncNow(CFG);
    expect(pushedOrder(1, order.id)?.deleted).toBe(field === 'op');
    expect(await db.outbox.count()).toBe(0);
  });

  it('DB close/reopen 后新 revision 仍存活，迟到的旧确认不能清掉它', async () => {
    const order = await saveRecord(input());
    const sync = startSync();
    await firstPost.promise;
    await updateRecord(order.id, input(6000));
    const latest = await db.outbox.get(`order:${order.id}`);
    expect(latest?.revision).toEqual(expect.any(String));
    db.close();
    await db.open();
    expect(await db.outbox.get(`order:${order.id}`)).toEqual(latest);
    firstResponse.resolve(201);
    await sync;

    expect(await db.outbox.get(`order:${order.id}`)).toEqual(latest);
    await syncNow(CFG);
    expect(pushedOrder(1, order.id)).toMatchObject({ data: { totalFen: 6000 } });
    expect(await db.outbox.count()).toBe(0);
  });

  it('另一路已清走当前行时，迟到的成功响应仍可完成', async () => {
    await saveRecord(input());
    const sync = startSync();
    await firstPost.promise;
    await db.outbox.clear();
    firstResponse.resolve(201);
    await expect(sync).resolves.toMatchObject({ pushed: 2 });
    expect(await db.outbox.count()).toBe(0);
  });

  it('outbox 与业务快照共用只读事务，等待 HTTP 时事务已经结束', async () => {
    const order = await saveRecord(input());
    let queuedTx: Transaction | undefined;
    let orderTx: Transaction | undefined;
    const onQueued = (row: unknown) => {
      const tx = Dexie.currentTransaction;
      // 协议预检也读取 outbox；只观察真正同时包含业务表的推送快照事务。
      if (tx?.storeNames.includes('orders')) queuedTx ??= tx;
      return row;
    };
    const onOrder = (row: unknown) => { orderTx ??= Dexie.currentTransaction; return row; };
    db.outbox.hook('reading', onQueued);
    db.orders.hook('reading', onOrder);
    try {
      const sync = startSync();
      await firstPost.promise;
      expect(queuedTx).toBeDefined();
      expect(orderTx === queuedTx).toBe(true);
      expect(queuedTx?.mode).toBe('readonly');
      expect(queuedTx?.storeNames).toEqual(expect.arrayContaining([
        'outbox', 'products', 'batches', 'orders', 'lines', 'adjustments', 'sessions', 'settings'
      ]));
      expect(fetchTransactions).toHaveLength(1);
      expect(fetchTransactions.some(Boolean)).toBe(false);
      // 挂起 HTTP 不占用 IDB 事务，业务删除仍可完成。
      await deleteRecord(order.id);
      firstResponse.resolve(201);
      await sync;
      expect(await db.outbox.get(`order:${order.id}`)).toMatchObject({ op: 'delete' });
    } finally {
      db.outbox.hook('reading').unsubscribe(onQueued);
      db.orders.hook('reading').unsubscribe(onOrder);
    }
  });
});

describe('入站应用的 pending 事务边界', () => {
  it('排队等待应用事务时提交的业务编辑必须被 pending 过滤，不被更晚远端覆盖', async () => {
    const order = await saveRecord(input());
    firstResponse.resolve(201);
    pages = [[{
      id: `order:${order.id}`, record_id: order.id, kind: 'order', deleted: false,
      updated_at: NOW + 1, record_updated_at: Date.parse('2099-01-01T00:00:00Z'),
      data: { ...order, totalFen: 9900, updatedAt: '2099-01-01T00:00:00Z' }
    }]];
    const applyEntered = gate<void>();
    applyRelease = gate<void>();
    const transaction = db.transaction;
    let paused = false;
    vi.spyOn(db, 'transaction').mockImplementation(function (...args: unknown[]) {
      const [mode, tables] = args;
      if (!paused && mode === 'rw' && Array.isArray(tables) && tables.includes(db.conflicts)) {
        paused = true;
        applyEntered.resolve();
        return Dexie.Promise.resolve(applyRelease!.promise).then(() => Reflect.apply(transaction, db, args));
      }
      return Reflect.apply(transaction, db, args);
    } as typeof db.transaction);
    const sync = startSync();
    await applyEntered.promise;
    await updateRecord(order.id, input(7000));
    const pending = await db.outbox.get(`order:${order.id}`);
    applyRelease.resolve();
    const result = await sync;

    expect((await db.orders.get(order.id))?.totalFen).toBe(7000);
    expect(await db.outbox.get(`order:${order.id}`)).toEqual(pending);
    expect(await db.conflicts.count()).toBe(0);
    expect(result).toMatchObject({ pulled: 0, pulledOrders: 0, impact: { overwritten: [], removed: [], restored: [] } });
    expect(store.get('yh-sync-warn')).toContain('本地待推送 1 行');
    // pending 的远端行未被记成已见过/复活记录。
    expect(store.get('yh-sync-known-ids')).toBeUndefined();
    await syncNow(CFG);
    expect(pushedOrder(1, order.id)).toMatchObject({ data: { totalFen: 7000 } });
    expect(await db.outbox.count()).toBe(0);
  });
});
