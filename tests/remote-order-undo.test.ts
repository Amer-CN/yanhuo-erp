// B04：真实 syncNow → impact → restore，网络只允许严格解析的 loopback fake fetch。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { remoteChangeList, restoreLocalSnapshot, syncNow, type Kind, type RemoteChange } from '../src/db/sync';
import { updateProduct, voidOrder, restoreOrder } from '../src/db/repo';
import { canonicalJson } from '../src/db/canonical';
import { restoreLocalBackup } from '../src/db/dataRecovery';
import { EMPTY_DATA, type SalesOrder, type SessionSummary } from '../src/db/types';
import { localDate } from '../src/db/util';
import { remoteOrderVersionKey } from '../src/db/remoteOrderUndo';
import { makeLine, makeOrder, makeProduct, makeSession, resetDb, T0 } from './helpers';

const CFG = { url: 'http://127.0.0.1:54321', anonKey: 'fake-b04', ledgerKey: 'b04-test-only' };
const BASE = Date.parse('2026-11-02T10:00:00.000Z');
const REMOTE_AT = '2026-11-03T10:00:00.000Z';
type CloudRow = { id: string; record_id: string; kind: Kind; data: Record<string, unknown>;
  updated_at: number; record_updated_at: number; deleted: boolean; ledger: string };
type UndoChange = RemoteChange & { canUndo?: boolean; undoDisabledReason?: string; undoVersionKey?: string };
let cloud: CloudRow[];
let store: Map<string, string>;
let posted: CloudRow[][];

function remote(kind: Kind, id: string, data: object, stamp = BASE, deleted = false): CloudRow {
  return { id: `${kind}:${id}`, record_id: id, kind, data: { ...data }, updated_at: stamp,
    record_updated_at: Date.parse(String((data as { updatedAt?: string }).updatedAt ?? T0)),
    deleted, ledger: CFG.ledgerKey };
}
function order(id: string, totalFen: number, lineIds?: string[], updatedAt = T0): SalesOrder {
  return { ...makeOrder(id, totalFen, 's1', { updatedAt }), ...(lineIds ? { lineIds } : {}) };
}
function editRows(id = 'x', stamp = BASE): CloudRow[] {
  return [remote('line', `${id}-old`, {}, stamp, true),
    remote('order', id, order(id, 2000, [`${id}-new`], REMOTE_AT), stamp + 1),
    remote('line', `${id}-new`, makeLine(`${id}-new`, id, 'p1', 2, 2000, { updatedAt: REMOTE_AT }), stamp + 2)];
}
function summary(revenueFen: number): SessionSummary {
  return { orderCount: 1, lineCount: 1, revenueFen, cashFen: revenueFen, wechatFen: 0, alipayFen: 0,
    costFen: 0, grossFen: revenueFen, discountFen: 0, giftCostFen: 0, giftQty: 0 };
}
async function seed(id = 'x', manifest = true): Promise<void> {
  await db.sessions.put(makeSession('s1'));
  await db.orders.put(order(id, 1000, manifest ? [`${id}-old`] : undefined));
  await db.lines.put(makeLine(`${id}-old`, id, 'p1', 1, 1000, { updatedAt: T0 }));
}
function changes(result: Awaited<ReturnType<typeof syncNow>>): UndoChange[] {
  return remoteChangeList(result.impact).filter((change) => change.kind === 'order') as UndoChange[];
}

function filteredRows(url: URL): CloudRow[] {
  const allowed = new Set(['ledger', 'id', 'kind', 'record_id', 'updated_at', 'or', 'order', 'select', 'limit']);
  for (const key of url.searchParams.keys()) expect(allowed.has(key), `unexpected query ${key}`).toBe(true);
  let rows = cloud.filter((row) => row.ledger === CFG.ledgerKey);
  for (const field of ['ledger', 'id', 'kind', 'record_id'] as const) {
    const value = url.searchParams.get(field);
    if (!value) continue;
    if (field === 'record_id' && value.startsWith('in.(')) {
      const values = JSON.parse(`[${value.slice(4, -1)}]`) as string[];
      rows = rows.filter((row) => values.includes(row.record_id));
    } else {
      expect(value.startsWith('eq.')).toBe(true);
      rows = rows.filter((row) => row[field] === value.slice(3));
    }
  }
  const timestamp = url.searchParams.get('updated_at');
  if (timestamp) {
    const match = /^(gte|gt)\.(\d+)$/.exec(timestamp);
    if (!match) throw new Error(`invalid timestamp ${timestamp}`);
    rows = rows.filter((row) => match[1] === 'gte' ? row.updated_at >= Number(match[2]) : row.updated_at > Number(match[2]));
  }
  const composite = url.searchParams.get('or');
  if (composite) {
    const match = /^\(updated_at\.gt\.(\d+),and\(updated_at\.eq\.(\d+),id\.gt\.(.*)\)\)$/.exec(composite);
    if (!match) throw new Error(`invalid cursor ${composite}`);
    rows = rows.filter((row) => row.updated_at > Number(match[1]) ||
      (row.updated_at === Number(match[2]) && row.id > match[3]));
  }
  if (!url.searchParams.has('id')) expect(url.searchParams.get('order')).toBe('updated_at.asc,id.asc');
  return rows.sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Number(url.searchParams.get('limit')));
}

beforeEach(async () => {
  await db.open();
  await resetDb();
  cloud = [];
  posted = [];
  store = new Map([['yh-sync-disabled', '1'], ['yh-sync-last-pull', String(BASE - 1)],
    ['yh-sync-last-replay', localDate()], ['yh-sync-last-sync', String(BASE - 1)]]);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)), removeItem: (key: string) => store.delete(key) });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/rpc/yh_sync_capabilities')) return Response.json({ code: 'PGRST202' }, { status: 404 });
    const url = new URL(String(input));
    expect(url.origin).toBe(CFG.url);
    expect(url.pathname).toBe('/rest/v1/yh_records');
    expect(new Headers(init?.headers).get('x-ledger-key')).toBe(CFG.ledgerKey);
    if (init?.method === 'POST') {
      expect(url.searchParams.get('on_conflict')).toBe('id');
      const body = JSON.parse(String(init.body)) as CloudRow[];
      expect(body.every((row) => row.ledger === CFG.ledgerKey)).toBe(true);
      posted.push(body);
      for (const row of body) {
        cloud = cloud.filter((prev) => prev.id !== row.id || prev.ledger !== row.ledger);
        cloud.push(row);
      }
      return new Response(null, { status: 201 });
    }
    expect(init?.method ?? 'GET').toBe('GET');
    return new Response(JSON.stringify(filteredRows(url)), { status: 200 });
  }));
});
afterEach(async () => {
  await db.open();
  await resetDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('完整订单远端撤销', () => {
  it('远端版本键必须包含 lineIds，即使写入与业务毫秒相同也分成不同快照组', () => {
    const base = remote('order', 'x', order('x', 2000, ['line-a'], REMOTE_AT), BASE);
    const sameTimeReplacement = remote('order', 'x', order('x', 2000, ['line-b'], REMOTE_AT), BASE);
    expect(remoteOrderVersionKey(base)).not.toBe(remoteOrderVersionKey(sameTimeReplacement));
  });
  it('rejects a product undo after a newer same-generation local edit', async () => {
    const before = makeProduct('p1', { priceList: 100 });
    const remote = makeProduct('p1', { priceList: 200, updatedAt: REMOTE_AT });
    await db.products.put(remote);
    await db.products.update('p1', { priceList: 300, updatedAt: '2026-11-04T10:00:00.000Z' });

    await expect(updateProduct('p1', { priceList: before.priceList }, undefined, canonicalJson(remote)))
      .rejects.toThrow(/修改|变化|新/);

    expect((await db.products.get('p1'))?.priceList).toBe(300);
  });

  it('rejects order void and restore undos after a newer same-generation local edit', async () => {
    const current = makeOrder('o1', 1000, 's1', { updatedAt: REMOTE_AT });
    await db.orders.put(current);
    await db.orders.update('o1', { totalFen: 3000, updatedAt: '2026-11-04T10:00:00.000Z' });

    await expect(voidOrder('o1', undefined, canonicalJson(current))).rejects.toThrow(/修改|变化|新/);
    await expect(restoreOrder('o1', undefined, canonicalJson(current))).rejects.toThrow(/修改|变化|新/);
    expect((await db.orders.get('o1'))?.totalFen).toBe(3000);
  });

  it('rejects a generic session undo after a newer same-generation local edit', async () => {
    const before = makeSession('s1', { status: 'closed', closedAt: T0, note: 'before' });
    const remote = makeSession('s1', { status: 'closed', closedAt: T0, note: 'remote', updatedAt: REMOTE_AT });
    await db.sessions.put(remote);
    await db.sessions.update('s1', { note: 'newer-local', updatedAt: '2026-11-04T10:00:00.000Z' });

    await expect(restoreLocalSnapshot({
      type: 'overwritten', kind: 'session', recordId: 's1', label: 's1', local: { ...before },
      currentFingerprint: canonicalJson(remote)
    })).rejects.toThrow(/修改|变化|新/);

    expect((await db.sessions.get('s1'))?.note).toBe('newer-local');
  });

  it('rejects an undo intent created before a local recovery', async () => {
    await seed();
    cloud = editRows();
    const [change] = changes(await syncNow(CFG));
    expect(change).toBeTruthy();

    await restoreLocalBackup({ app: 'yanhuo-erp', version: 2, exportedAt: T0,
      deviceId: 'other-device', data: structuredClone(EMPTY_DATA) });

    await expect(restoreLocalSnapshot(change)).rejects.toThrow(/账本已更新|数据已|恢复|刷新/);
    expect(await db.orders.get('x')).toBeUndefined();
    expect(await db.lines.where('orderId').equals('x').count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('真实 syncNow 改成 20元/2件后撤销为 10元/1件，删除新明细并用新业务版本回推', async () => {
    await seed();
    cloud = editRows();
    const [change] = changes(await syncNow(CFG));
    expect(change).toBeTruthy();
    await restoreLocalSnapshot(change);
    const restored = (await db.orders.get('x'))!;
    const lines = await db.lines.where('orderId').equals('x').toArray();
    expect(restored.totalFen).toBe(1000);
    expect(lines.map((line) => line.id)).toEqual(['x-old']);
    expect(lines.reduce((n, line) => n + line.qtyBase, 0)).toBe(1);
    expect(lines.reduce((n, line) => n + line.amountFen, 0)).toBe(1000);
    expect(restored.createdAt).toBe(T0);
    expect(Date.parse(restored.updatedAt!)).toBeGreaterThan(Date.parse(REMOTE_AT));
    expect(lines[0].updatedAt).toBe(restored.updatedAt);
    expect(await db.outbox.get('line:x-new')).toMatchObject({ op: 'delete' });
    expect(await db.outbox.get('line:x-old')).toMatchObject({ op: 'upsert' });
    expect(change.canUndo).toBe(true);
    expect(change.undoVersionKey).toBeTruthy();
    await syncNow(CFG);
    await syncNow(CFG);
    expect((await db.orders.get('x'))?.totalFen).toBe(1000);
    expect(posted.flat().find((row) => row.id === 'line:x-new')).toMatchObject({ deleted: true });
  });

  it('Toast 后本地再次改动时拒绝撤销并完整保留当前账本', async () => {
    await seed();
    cloud = editRows();
    const [change] = changes(await syncNow(CFG));
    await db.orders.update('x', { note: '用户后来填写', updatedAt: '2026-11-04T10:00:00.000Z' });
    const before = await db.orders.get('x');
    await expect(restoreLocalSnapshot(change)).rejects.toThrow(/后来|再次|已.*修改|变化/);
    expect(await db.orders.get('x')).toEqual(before);
    expect(await db.lines.get('x-new')).toBeTruthy();
    expect(await db.outbox.count()).toBe(0);
  });

  it('定稿后的撤销指纹不被旧远端重放重新授权，保留用户后改备注', async () => {
    await seed();
    cloud = editRows();
    const [change] = changes(await syncNow(CFG));
    const frozen = (await db.remoteOrderUndo.get('x'))!.afterFingerprint;
    await db.orders.update('x', { note: '用户后来填写', updatedAt: '2026-11-04T10:00:00.000Z' });
    store.set('yh-sync-last-replay', '2000-01-01');
    await syncNow(CFG);
    const before = await db.orders.get('x');
    const queued = await db.outbox.toArray();
    expect((await db.remoteOrderUndo.get('x'))?.afterFingerprint).toBe(frozen);
    await expect(restoreLocalSnapshot(change)).rejects.toThrow(/后来|再次|已.*修改|变化/);
    expect(await db.orders.get('x')).toEqual(before);
    expect((await db.orders.get('x'))?.note).toBe('用户后来填写');
    expect(await db.outbox.toArray()).toEqual(queued);
  });

  it('订单在第一页、明细第二页时，累计改动在组完整后可撤销', async () => {
    await seed();
    cloud = [
      remote('order', 'x', order('x', 2000, ['x-new'], REMOTE_AT), BASE),
      ...Array.from({ length: 499 }, (_, i) => remote('setting', `pad-${i}`, { key: `pad-${i}`, value: 'pad' }, BASE + 1 + i)),
      remote('line', 'x-old', {}, BASE + 600, true),
      remote('line', 'x-new', makeLine('x-new', 'x', 'p1', 2, 2000, { updatedAt: REMOTE_AT }), BASE + 601)
    ];
    const [change] = changes(await syncNow(CFG));
    expect(change.canUndo).toBe(true);
    await restoreLocalSnapshot(change);
    expect((await db.lines.where('orderId').equals('x').toArray()).map((line) => line.id)).toEqual(['x-old']);
    expect((await db.orders.get('x'))?.totalFen).toBe(1000);
  });

  it('同时间戳换行清单必须开启新撤销组，撤销只回退到紧邻的前一版', async () => {
    await seed();
    cloud = [
      remote('order', 'x', order('x', 2000, ['x-middle'], REMOTE_AT), BASE),
      remote('line', 'x-old', {}, BASE + 1, true),
      remote('line', 'x-middle', makeLine('x-middle', 'x', 'p1', 2, 2000, { updatedAt: REMOTE_AT }), BASE + 2)
    ];
    const [first] = changes(await syncNow(CFG));
    expect(first.canUndo).toBe(true);
    cloud = [
      remote('order', 'x', order('x', 2000, ['x-final'], '2026-11-04T10:00:00.000Z'), BASE + 1000),
      remote('line', 'x-middle', {}, BASE + 1001, true),
      remote('line', 'x-final', makeLine('x-final', 'x', 'p1', 1, 2000, { updatedAt: '2026-11-04T10:00:00.000Z' }), BASE + 1002)
    ];
    const [second] = changes(await syncNow(CFG));
    expect(second.canUndo).toBe(true);
    expect(second.undoVersionKey).not.toBe(first.undoVersionKey);
    await restoreLocalSnapshot(second);
    expect((await db.orders.get('x'))?.lineIds).toEqual(['x-middle']);
    expect((await db.lines.where('orderId').equals('x').toArray()).map((line) => line.id)).toEqual(['x-middle']);
  });

  it('同一远端版本重放不替换首次 before 快照', async () => {
    await seed();
    cloud = editRows();
    const [first] = changes(await syncNow(CFG));
    const saved = (await db.remoteOrderUndo.get('x'))!;
    await db.remoteOrderUndo.update('x', { beforeOrder: { ...saved.beforeOrder, note: '原始 before' } });
    store.set('yh-sync-last-replay', '2000-01-01');
    const replayed = await syncNow(CFG);
    expect(replayed.pulled).toBeGreaterThanOrEqual(0);
    const after = await db.remoteOrderUndo.get('x');
    expect(after?.beforeOrder.note).toBe('原始 before');
    expect(after?.remoteVersionKey).toBe(first.undoVersionKey);
  });

  it('closed 汇总重算失败不回滚或伪报整单撤销失败', async () => {
    await db.sessions.put(makeSession('s1', { status: 'closed', summary: summary(1000) }));
    await seed();
    cloud = [...editRows(), remote('session', 's1', {
      ...makeSession('s1', { status: 'closed', summary: summary(2000), updatedAt: REMOTE_AT }),
      summary: summary(2000)
    }, BASE + 3)];
    const [change] = changes(await syncNow(CFG));
    const hook = () => { throw new Error('summary storage failed'); };
    db.sessions.hook('updating', hook);
    let result: Awaited<ReturnType<typeof restoreLocalSnapshot>>;
    try { result = await restoreLocalSnapshot(change); }
    finally { db.sessions.hook('updating').unsubscribe(hook); }
    expect(result).toMatchObject({ sessionSummaryUpdated: false });
    expect((await db.orders.get('x'))?.totalFen).toBe(1000);
    expect((await db.lines.get('x-old'))?.amountFen).toBe(1000);
  });

  it('撤销 closed 场订单后重算本地场次汇总', async () => {
    const closed = makeSession('s1', { status: 'closed', summary: summary(1000) });
    await db.sessions.put(closed);
    const oldOrder = order('x', 1000, ['x-old']);
    await db.orders.put(oldOrder);
    await db.lines.put(makeLine('x-old', 'x', 'p1', 1, 1000, { updatedAt: T0 }));
    cloud = [...editRows(), remote('session', 's1', {
      ...closed, updatedAt: REMOTE_AT, summary: summary(2000)
    }, BASE + 3)];
    const [change] = changes(await syncNow(CFG));
    expect(change.canUndo).toBe(true);
    expect((await db.sessions.get('s1'))?.summary?.revenueFen).toBe(2000);
    await restoreLocalSnapshot(change);
    expect((await db.sessions.get('s1'))?.summary?.revenueFen).toBe(1000);
  });

  it('旧明细墓碑早一轮到达，重开数据库后仍恢复首次变更前的完整订单', async () => {
    await seed();
    cloud = [editRows()[0]];
    await syncNow(CFG);
    expect(await db.lines.get('x-old')).toBeUndefined();
    db.close();
    await db.open();
    cloud.push(...editRows().slice(1));
    const [change] = changes(await syncNow(CFG));
    expect(change.canUndo).toBe(true);
    await restoreLocalSnapshot(change);
    expect((await db.lines.get('x-old'))?.amountFen).toBe(1000);
    expect((await db.lines.get('x-old'))?.qtyBase).toBe(1);
  });

  it('本地旧单明细不完整时不能制造可撤销快照', async () => {
    await seed();
    await db.lines.update('x-old', { amountFen: 500 });
    cloud = editRows();
    const [change] = changes(await syncNow(CFG));
    expect(change.canUndo).toBe(false);
    await expect(restoreLocalSnapshot(change)).rejects.toThrow(/完整|明细/);
    expect((await db.orders.get('x'))?.totalFen).toBe(2000);
  });

  it('指纹核验与恢复同事务：应用前已提交的本地编辑不能被撤销覆盖', async () => {
    await seed();
    cloud = editRows();
    const [change] = changes(await syncNow(CFG));
    const transaction = db.transaction;
    let injected = false;
    vi.spyOn(db, 'transaction').mockImplementation(function (...args: unknown[]) {
      if (!injected && args[0] === 'rw') {
        injected = true;
        return db.orders.update('x', { note: '事务前刚提交' }).then(() => Reflect.apply(transaction, db, args));
      }
      return Reflect.apply(transaction, db, args);
    } as typeof db.transaction);
    await expect(restoreLocalSnapshot(change)).rejects.toThrow(/后来|再次|修改|变化/);
    expect((await db.orders.get('x'))?.note).toBe('事务前刚提交');
  });

  it('仅最新20份完整撤销组占容量，不完整记录不挤掉可用快照', async () => {
    for (let i = 0; i < 21; i++) await seed(`valid-${i}`);
    for (let i = 0; i < 5; i++) await seed(`legacy-${i}`, false);
    cloud = [
      ...Array.from({ length: 21 }, (_, i) => editRows(`valid-${i}`, BASE + i * 10)).flat(),
      ...Array.from({ length: 5 }, (_, i) => {
        const rows = editRows(`legacy-${i}`, BASE + 1000 + i * 10);
        delete rows[1].data.lineIds;
        return rows;
      }).flat()
    ];
    const result = await syncNow(CFG);
    const snapshots = await db.remoteOrderUndo.toArray();
    expect(snapshots.filter((row) => row.canUndo)).toHaveLength(20);
    expect(snapshots.filter((row) => !row.canUndo)).toHaveLength(5);
    const missing = changes(result).filter((change) => !snapshots.some((row) => row.orderId === change.recordId));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ canUndo: false });
    expect(missing[0].undoDisabledReason).toMatch(/保留|到期|快照/);
  });

  it('legacy 无 manifest 仍同步明细，但提示仅查看核对且撤销明确拒绝', async () => {
    await seed('x', false);
    cloud = editRows();
    delete cloud[1].data.lineIds;
    const [change] = changes(await syncNow(CFG));
    expect((await db.orders.get('x'))?.totalFen).toBe(2000);
    expect(await db.lines.get('x-new')).toBeTruthy();
    expect(change.canUndo).toBe(false);
    expect(change.undoDisabledReason).toMatch(/明细|完整|清单/);
    await expect(restoreLocalSnapshot(change)).rejects.toThrow(/明细|完整|清单/);
    expect((await db.orders.get('x'))?.totalFen).toBe(2000);
  });
});
