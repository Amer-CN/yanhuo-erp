import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db';
import {
  exportBackup,
  importMerge,
  parseBackup,
  replaceAll,
  type BackupFile
} from '../src/db/merge';
import { mergeSessionPair } from '../src/db/sessionLogic';
import { EMPTY_DATA } from '../src/db/types';
import {
  DEVICE,
  T0,
  makeBatch,
  makeLine,
  makeOrder,
  makeProduct,
  makeSession,
  resetDb
} from './helpers';

function makeBackup(data: Partial<BackupFile['data']> = {}, extra: Partial<BackupFile> = {}): BackupFile {
  return {
    app: 'yanhuo-erp',
    version: 2,
    exportedAt: T0,
    deviceId: 'other-device',
    data: { ...structuredClone(EMPTY_DATA), ...data },
    ...extra
  };
}

beforeEach(resetDb);

describe('importMerge', () => {
  it('流水只增：同 id 订单/明细/批次不覆盖，新 id 才追加', async () => {
    await db.orders.put(makeOrder('o1', 1000));
    await db.lines.put(makeLine('l1', 'o1', 'p1', 1, 1000));
    await db.batches.put(makeBatch('b1', 'p1', 5, 100));

    const result = await importMerge(
      makeBackup({
        orders: [makeOrder('o1', 9999), makeOrder('o2', 500)],
        lines: [makeLine('l1', 'o1', 'p1', 99, 9999), makeLine('l2', 'o2', 'p1', 1, 500)],
        batches: [makeBatch('b1', 'p1', 999, 9), makeBatch('b2', 'p1', 2, 200)]
      })
    );

    expect(result.ordersAdded).toBe(1);
    expect(result.linesAdded).toBe(1);
    expect(result.batchesAdded).toBe(1);
    expect((await db.orders.get('o1'))?.totalFen).toBe(1000);
    expect((await db.lines.get('l1'))?.qtyBase).toBe(1);
    expect((await db.batches.get('b1'))?.qtyBase).toBe(5);
    expect(await db.orders.get('o2')).toBeTruthy();
    expect(await db.lines.get('l2')).toBeTruthy();
    expect(await db.batches.get('b2')).toBeTruthy();
  });

  it('keeps a divergent same-id complete order by default instead of trusting device time', async () => {
    const oldLine = makeLine('old-line', 'o1', 'p1', 1, 1000, { updatedAt: '2026-11-01T00:00:00.000Z' });
    await db.orders.put(makeOrder('o1', 1000, 's1', { updatedAt: '2026-11-01T00:00:00.000Z', lineIds: [oldLine.id] }));
    await db.lines.put(oldLine);

    const nextLines = [
      makeLine('new-line-a', 'o1', 'p1', 1, 1000, { updatedAt: '2026-11-02T00:00:00.000Z' }),
      makeLine('new-line-b', 'o1', 'p2', 1, 500, { updatedAt: '2026-11-02T00:00:00.000Z' })
    ];
    const nextOrder = makeOrder('o1', 1500, 's1', {
      note: 'edited', updatedAt: '2026-11-02T00:00:00.000Z', lineIds: nextLines.map((line) => line.id)
    });
    const result = await importMerge(makeBackup({
      products: [makeProduct('p1'), makeProduct('p2')],
      orders: [nextOrder],
      lines: nextLines
    }));

    expect(result).toMatchObject({ ordersAdded: 0, ordersUpdated: 0, ordersKept: 0, ordersConflicted: 1,
      linesAdded: 0, linesRemoved: 0 });
    expect(await db.orders.get('o1')).toMatchObject({ totalFen: 1000, lineIds: ['old-line'] });
    expect(await db.lines.where('orderId').equals('o1').toArray()).toEqual([oldLine]);
    expect(await db.outbox.get('line:old-line')).toBeUndefined();
  });

  it('replaces a complete same-id order only after an explicit incoming choice', async () => {
    const oldLine = makeLine('old-line', 'o1', 'p1', 1, 1000, { updatedAt: '2026-11-01T00:00:00.000Z' });
    await db.orders.put(makeOrder('o1', 1000, 's1', { updatedAt: '2026-11-01T00:00:00.000Z', lineIds: [oldLine.id] }));
    await db.lines.put(oldLine);

    const nextLines = [
      makeLine('new-line-a', 'o1', 'p1', 1, 1000, { updatedAt: '2026-11-02T00:00:00.000Z' }),
      makeLine('new-line-b', 'o1', 'p2', 1, 500, { updatedAt: '2026-11-02T00:00:00.000Z' })
    ];
    const nextOrder = makeOrder('o1', 1500, 's1', {
      note: 'edited', updatedAt: '2026-11-02T00:00:00.000Z', lineIds: nextLines.map((line) => line.id)
    });
    const result = await importMerge(makeBackup({
      products: [makeProduct('p1'), makeProduct('p2')],
      orders: [nextOrder],
      lines: nextLines
    }), { orderChoices: { o1: 'incoming' } });

    expect(result).toMatchObject({ ordersAdded: 0, ordersUpdated: 1, ordersKept: 0, ordersConflicted: 0,
      linesAdded: 2, linesRemoved: 1 });
    expect(await db.orders.get('o1')).toMatchObject({ totalFen: 1500, note: 'edited', lineIds: ['new-line-a', 'new-line-b'] });
    expect(await db.lines.where('orderId').equals('o1').toArray()).toEqual(nextLines);
    expect(await db.outbox.get('order:o1')).toMatchObject({ op: 'upsert' });
    expect(await db.outbox.get('line:old-line')).toMatchObject({ op: 'delete' });
    for (const line of nextLines) expect(await db.outbox.get(`line:${line.id}`)).toMatchObject({ op: 'upsert' });
  });

  it('keeps same-id orphan lines by default when importing a new complete order', async () => {
    const orphan = makeLine('orphan-line', 'o1', 'p1', 1, 900);
    await db.lines.put(orphan);
    const incomingLine = makeLine('incoming-line', 'o1', 'p2', 1, 500);
    const incomingOrder = makeOrder('o1', 500, 's1', { lineIds: [incomingLine.id] });

    const result = await importMerge(makeBackup({
      products: [makeProduct('p2')], orders: [incomingOrder], lines: [incomingLine]
    }));

    expect(result).toMatchObject({ ordersAdded: 0, ordersConflicted: 1, linesAdded: 0, linesRemoved: 0 });
    expect(await db.orders.get('o1')).toBeUndefined();
    expect(await db.lines.where('orderId').equals('o1').toArray()).toEqual([orphan]);
    expect(await db.outbox.get('order:o1')).toBeUndefined();
    expect(await db.outbox.get('line:incoming-line')).toBeUndefined();
    expect(await db.outbox.get('line:orphan-line')).toBeUndefined();
  });

  it('deletes same-id orphan lines only after an explicit incoming choice', async () => {
    const orphan = makeLine('orphan-line', 'o1', 'p1', 1, 900);
    await db.lines.put(orphan);
    const incomingLine = makeLine('incoming-line', 'o1', 'p2', 1, 500);
    const incomingOrder = makeOrder('o1', 500, 's1', { lineIds: [incomingLine.id] });

    const result = await importMerge(makeBackup({
      products: [makeProduct('p2')], orders: [incomingOrder], lines: [incomingLine]
    }), { orderChoices: { o1: 'incoming' } });

    expect(result).toMatchObject({ ordersAdded: 1, linesAdded: 1, linesRemoved: 1 });
    expect(await db.lines.where('orderId').equals('o1').toArray()).toEqual([incomingLine]);
    expect(await db.outbox.get('line:orphan-line')).toMatchObject({ op: 'delete' });
    expect(await db.outbox.get('line:incoming-line')).toMatchObject({ op: 'upsert' });
  });

  it('keeps and reports an older divergent complete order as a conflict', async () => {
    const currentLine = makeLine('current-line', 'o1', 'p1', 1, 1000);
    await db.orders.put(makeOrder('o1', 1000, 's1', { updatedAt: '2026-11-03T00:00:00.000Z', lineIds: [currentLine.id] }));
    await db.lines.put(currentLine);
    const oldLine = makeLine('old-import-line', 'o1', 'p1', 1, 500);
    const oldOrder = makeOrder('o1', 500, 's1', { updatedAt: '2026-11-02T00:00:00.000Z', lineIds: [oldLine.id] });

    const result = await importMerge(makeBackup({
      products: [makeProduct('p1')], orders: [oldOrder], lines: [oldLine]
    }));

    expect(result).toMatchObject({ ordersKept: 0, ordersConflicted: 1, linesAdded: 0, linesRemoved: 0 });
    expect(await db.orders.get('o1')).toMatchObject({ totalFen: 1000, lineIds: ['current-line'] });
    expect(await db.lines.where('orderId').equals('o1').toArray()).toEqual([currentLine]);
  });

  it('keeps and reports an equal-time divergent complete order', async () => {
    const currentLine = makeLine('current-line', 'o1', 'p1', 1, 1000);
    await db.orders.put(makeOrder('o1', 1000, 's1', { updatedAt: '2026-11-03T00:00:00.000Z', lineIds: [currentLine.id] }));
    await db.lines.put(currentLine);
    const conflictingLine = makeLine('conflicting-line', 'o1', 'p2', 1, 900);
    const conflictingOrder = makeOrder('o1', 900, 's1', {
      updatedAt: '2026-11-03T00:00:00.000Z', lineIds: [conflictingLine.id]
    });

    const result = await importMerge(makeBackup({
      products: [makeProduct('p1'), makeProduct('p2')],
      orders: [conflictingOrder], lines: [conflictingLine]
    }));

    expect(result).toMatchObject({ ordersKept: 0, ordersConflicted: 1, linesAdded: 0, linesRemoved: 0 });
    expect(await db.orders.get('o1')).toMatchObject({ totalFen: 1000, lineIds: ['current-line'] });
    expect(await db.lines.where('orderId').equals('o1').toArray()).toEqual([currentLine]);
  });

  it('keeps a same-id legacy order and does not append its unmanifested lines', async () => {
    const currentLine = makeLine('current-line', 'o1', 'p1', 1, 1000);
    await db.orders.put(makeOrder('o1', 1000));
    await db.lines.put(currentLine);
    const incomingLine = makeLine('unmanifested-line', 'o1', 'p2', 1, 500);

    const result = await importMerge(makeBackup({
      orders: [makeOrder('o1', 1500)],
      lines: [incomingLine]
    }));

    expect(result).toMatchObject({ ordersConflicted: 1, linesAdded: 0 });
    expect(await db.orders.get('o1')).toMatchObject({ totalFen: 1000 });
    expect(await db.lines.where('orderId').equals('o1').toArray()).toEqual([currentLine]);
  });

  it.each([
    ['duplicate manifest ids', ['new-line', 'new-line'], [makeLine('new-line', 'o2', 'p1', 1, 100)], 100, {}],
    ['missing manifest child', ['missing-line'], [], 100, {}],
    ['unlisted child', ['new-line'], [makeLine('new-line', 'o2', 'p1', 1, 100), makeLine('extra-line', 'o2', 'p1', 1, 100)], 200, {}],
    ['incorrect order total', ['new-line'], [makeLine('new-line', 'o2', 'p1', 1, 100)], 101, {}],
    ['empty manifest', [], [], 0, {}],
    ['negative quantity', ['new-line'], [makeLine('new-line', 'o2', 'p1', -1, 100)], 100, {}],
    ['negative amount', ['new-line'], [makeLine('new-line', 'o2', 'p1', 1, -100)], -100, {}],
    ['invalid timestamp', ['new-line'], [makeLine('new-line', 'o2', 'p1', 1, 100)], 100, { createdAt: 'not-a-date' }],
    ['missing product reference', ['new-line'], [makeLine('new-line', 'o2', 'missing-product', 1, 100)], 100, {}]
  ] as const)('rejects %s before mutating any imported table', async (_case, lineIds, lines, totalFen, orderOverrides) => {
    await db.products.put(makeProduct('existing'));
    const backup = makeBackup({
      products: [makeProduct('incoming'), makeProduct('p1')],
      orders: [makeOrder('o2', totalFen, 's1', { lineIds: [...lineIds], ...orderOverrides })],
      lines: [...lines]
    });

    await expect(importMerge(backup)).rejects.toThrow();

    expect(await db.products.get('incoming')).toBeUndefined();
    expect(await db.orders.get('o2')).toBeUndefined();
    expect(await db.lines.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('rejects incoming orphan lines that have no parent order in backup or local data', async () => {
    const orphan = makeLine('orphan-no-parent', 'missing-order', 'p1', 1, 100);
    await expect(importMerge(makeBackup({
      products: [makeProduct('p1')], orders: [], lines: [orphan]
    }))).rejects.toThrow(/父单|订单|parent/i);
    expect(await db.lines.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('rejects duplicate incoming line ids even when their parent orders differ', async () => {
    const line = makeLine('duplicate-line', 'o2', 'p1', 1, 100);
    const backup = makeBackup({
      products: [makeProduct('p1')],
      orders: [
        makeOrder('o2', 100, 's1', { lineIds: [line.id] }),
        makeOrder('o3', 100, 's1', { lineIds: [line.id] })
      ],
      lines: [line, { ...line, orderId: 'o3' }]
    });

    await expect(importMerge(backup)).rejects.toThrow(/重复|duplicate/i);
    expect(await db.orders.count()).toBe(0);
    expect(await db.lines.count()).toBe(0);
  });

  it('clears pending lines, stale conflicts, and remote undo snapshots for an imported complete order', async () => {
    const incomingLine = makeLine('incoming-line', 'o1', 'p1', 1, 500);
    const incomingOrder = makeOrder('o1', 500, 's1', { lineIds: [incomingLine.id] });
    await db.products.put(makeProduct('p1'));
    await db.remotePendingLines.put({
      id: 'pending-extra', orderId: 'o1', receivedAt: 1,
      row: { id: 'line:pending-extra', record_id: 'pending-extra', kind: 'line',
        data: { ...makeLine('pending-extra', 'o1', 'p1', 1, 900) }, updated_at: 1, deleted: false }
    });
    await db.conflicts.put({ at: T0, kind: 'order', recordId: 'o1', local: '{}', remote: '{}' });
    await db.remoteOrderUndo.put({
      orderId: 'o1', capturedAt: 1, beforeOrder: makeOrder('o1', 100), beforeLines: [],
      beforeFingerprint: 'before', beforeComplete: true, remoteVersionKey: 'v1',
      afterFingerprint: 'after', canUndo: true
    });

    const result = await importMerge(makeBackup({ orders: [incomingOrder], lines: [incomingLine] }));

    expect(result).toMatchObject({ ordersAdded: 1, pendingLinesRemoved: 1, conflictsCleared: 1 });
    expect(await db.remotePendingLines.where('orderId').equals('o1').count()).toBe(0);
    expect(await db.conflicts.where('[kind+recordId]').equals(['order', 'o1']).count()).toBe(0);
    expect(await db.remoteOrderUndo.get('o1')).toBeUndefined();
    expect(await db.outbox.get('line:pending-extra')).toMatchObject({ op: 'delete' });
    expect(await db.outbox.get('line:incoming-line')).toMatchObject({ op: 'upsert' });
  });

  it('recalculates a closed session summary from the final merged order and lines', async () => {
    await db.products.put(makeProduct('p1'));
    await db.sessions.put(makeSession('s1', {
      status: 'closed', closedAt: T0,
      summary: { orderCount: 0, lineCount: 0, revenueFen: 0, cashFen: 0, wechatFen: 0,
        alipayFen: 0, costFen: 0, grossFen: 0, discountFen: 0, giftCostFen: 0, giftQty: 0 }
    }));
    const line = makeLine('line-o1', 'o1', 'p1', 2, 500);
    const order = makeOrder('o1', 500, 's1', { lineIds: [line.id] });

    const result = await importMerge(makeBackup({ orders: [order], lines: [line] }));

    expect(result.summariesUpdated).toBe(1);
    expect((await db.sessions.get('s1'))?.summary).toMatchObject({
      orderCount: 1, lineCount: 1, revenueFen: 500, grossFen: 500
    });
    expect(await db.outbox.get('session:s1')).toMatchObject({ op: 'upsert' });
  });

  it('rejects a merge when local data changed after the preview fingerprint', async () => {
    await db.products.put(makeProduct('p1'));
    const line = makeLine('line-stale-preview', 'o-stale-preview', 'p1', 1, 500);
    const order = makeOrder('o-stale-preview', 500, 's1', { lineIds: [line.id] });
    const backup = makeBackup({ orders: [order], lines: [line] });

    await expect(importMerge(backup, { expectedLocalFingerprint: 'stale-preview' }))
      .rejects.toThrow(/预览|preview|本机数据/);

    expect(await db.orders.get('o-stale-preview')).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
  });

  it('commits lastImportAt and the persistent undo pointer with the merge', async () => {
    const line = makeLine('line-meta', 'o-meta', 'p1', 1, 500);
    const order = makeOrder('o-meta', 500, 's1', { lineIds: [line.id] });

    await importMerge(makeBackup({ products: [makeProduct('p1')], orders: [order], lines: [line] }), { undoSnapshotId: 42 });

    expect(await db.settings.get('lastImportAt')).toMatchObject({ value: expect.any(String) });
    expect(await db.settings.get('mergeUndoSnapshotId')).toEqual({ key: 'mergeUndoSnapshotId', value: '42' });
    expect(await db.outbox.get('setting:mergeUndoSnapshotId')).toBeUndefined();
    expect(await db.outbox.get('order:o-meta')).toMatchObject({ op: 'upsert' });
  });

  it('rolls back merge metadata when outbox enqueue fails', async () => {
    await db.settings.put({ key: 'lastImportAt', value: 'old' });
    await db.settings.put({ key: 'mergeUndoSnapshotId', value: '7' });
    const line = makeLine('line-rollback', 'o-rollback', 'p1', 1, 500);
    const order = makeOrder('o-rollback', 500, 's1', { lineIds: [line.id] });
    const hook = () => { throw new Error('enqueue failed'); };
    db.outbox.hook('creating', hook);
    try {
      await expect(importMerge(makeBackup({ products: [makeProduct('p1')], orders: [order], lines: [line] }), { undoSnapshotId: 42 }))
        .rejects.toThrow('enqueue failed');
    } finally {
      db.outbox.hook('creating').unsubscribe(hook);
    }
    expect(await db.settings.get('lastImportAt')).toEqual({ key: 'lastImportAt', value: 'old' });
    expect(await db.settings.get('mergeUndoSnapshotId')).toEqual({ key: 'mergeUndoSnapshotId', value: '7' });
    expect(await db.orders.get('o-rollback')).toBeUndefined();
  });

  it('marks exported backups with complete-order manifest capability', async () => {
    const file = await exportBackup(DEVICE);
    expect(file.capabilities).toEqual({ completeOrderManifest: true });
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.capabilities).toEqual({ completeOrderManifest: true });
  });

  it('商品按 updatedAt 新者胜；相同或更旧不写', async () => {
    await db.products.bulkPut([
      makeProduct('p1', { updatedAt: '2026-11-01T00:00:00.000Z' }),
      makeProduct('p3', { updatedAt: '2026-12-01T00:00:00.000Z' }),
      makeProduct('p4', { updatedAt: '2026-11-05T00:00:00.000Z' })
    ]);

    const result = await importMerge(
      makeBackup({
        products: [
          makeProduct('p1', { name: '新名字', updatedAt: '2026-11-02T00:00:00.000Z' }),
          makeProduct('p2', { updatedAt: '2026-11-02T00:00:00.000Z' }),
          makeProduct('p3', { name: '更旧', updatedAt: '2026-11-01T00:00:00.000Z' }),
          makeProduct('p4', { name: '一样新', updatedAt: '2026-11-05T00:00:00.000Z' })
        ]
      })
    );

    expect(result.productsAdded).toBe(1);
    expect(result.productsUpdated).toBe(1);
    expect(result.productsKept).toBe(2);
    expect((await db.products.get('p1'))?.name).toBe('新名字');
    expect((await db.products.get('p3'))?.name).not.toBe('更旧');
    expect((await db.products.get('p4'))?.name).not.toBe('一样新');
  });

  it('设置导入跳过本机身份与操作人，其余覆盖', async () => {
    await db.settings.put({ key: 'deviceId', value: 'local' });
    await db.settings.put({ key: 'operatorA', value: '本机' });

    const result = await importMerge(
      makeBackup({
        settings: [
          { key: 'deviceId', value: 'other' },
          { key: 'operatorA', value: '对方' },
          { key: 'expiryWarnDays', value: '7' }
        ]
      })
    );

    expect(result.settingsImported).toBe(1);
    expect((await db.settings.get('deviceId'))?.value).toBe('local');
    expect((await db.settings.get('operatorA'))?.value).toBe('本机');
    expect((await db.settings.get('expiryWarnDays'))?.value).toBe('7');
  });

  it('导入不覆盖本机 operatorSelf（本机身份键）', async () => {
    await db.settings.put({ key: 'operatorSelf', value: '001' });

    const result = await importMerge(
      makeBackup({
        settings: [
          { key: 'operatorSelf', value: '999' },
          { key: 'expiryWarnDays', value: '7' }
        ]
      })
    );

    expect(result.settingsImported).toBe(1);
    expect((await db.settings.get('operatorSelf'))?.value).toBe('001');
    expect((await db.settings.get('expiryWarnDays'))?.value).toBe('7');
  });
});

describe('场次合并', () => {
  it('mergeSessionPair：closed 优先，patchedCount 取 max', () => {
    const open = makeSession('s1', {
      status: 'open',
      updatedAt: '2026-11-02T00:00:00.000Z',
      patchedCount: 1
    });
    const closed = makeSession('s1', {
      status: 'closed',
      updatedAt: '2026-11-01T00:00:00.000Z',
      patchedCount: 4
    });
    const merged = mergeSessionPair(open, closed);
    expect(merged.status).toBe('closed');
    expect(merged.patchedCount).toBe(4);

    const newer = mergeSessionPair(
      makeSession('s1', { status: 'closed', updatedAt: '2026-11-02T00:00:00.000Z', patchedCount: 2 }),
      makeSession('s1', { status: 'closed', updatedAt: '2026-11-01T00:00:00.000Z', patchedCount: 5 })
    );
    expect(newer.updatedAt).toBe('2026-11-02T00:00:00.000Z');
    expect(newer.patchedCount).toBe(5);
  });

  it('importMerge 走 mergeSessionPair：本地 open 不被远端 open 覆盖为 closed 之外的状态', async () => {
    await db.sessions.put(
      makeSession('s1', { status: 'open', patchedCount: 1, updatedAt: '2026-11-02T00:00:00.000Z' })
    );

    const result = await importMerge(
      makeBackup({
        sessions: [
          makeSession('s1', {
            status: 'closed',
            patchedCount: 4,
            updatedAt: '2026-11-01T00:00:00.000Z',
            closedAt: '2026-11-01T12:00:00.000Z'
          })
        ]
      })
    );

    expect(result.sessionsUpdated).toBe(1);
    const session = await db.sessions.get('s1');
    expect(session?.status).toBe('closed');
    expect(session?.patchedCount).toBe(4);
  });
});

describe('replaceAll / exportBackup / parseBackup', () => {
  it('replaceAll 整库替换后可读回，旧数据被清掉', async () => {
    await db.products.put(makeProduct('old'));
    await db.orders.put(makeOrder('old-order', 1));
    await db.settings.put({ key: 'k', value: 'old' });

    const file = makeBackup({
      products: [makeProduct('new')],
      orders: [makeOrder('new-order', 800, 's-new')],
      lines: [makeLine('new-line', 'new-order', 'new', 1, 800)],
      sessions: [makeSession('s-new')]
    });
    await replaceAll(file);

    expect(await db.products.count()).toBe(1);
    expect((await db.products.toArray())[0].id).toBe('new');
    expect(await db.orders.get('old-order')).toBeUndefined();
    expect((await db.orders.get('new-order'))?.totalFen).toBe(800);
    expect(await db.lines.count()).toBe(1);
    expect(await db.sessions.count()).toBe(1);
  });

  it('exportBackup 导出当前库；parseBackup 可回读且拒绝非法文件', async () => {
    await db.products.put(makeProduct('p1'));
    await db.orders.put(makeOrder('o1', 1000));

    const file = await exportBackup(DEVICE);
    expect(file.app).toBe('yanhuo-erp');
    expect(file.version).toBe(2);
    expect(file.deviceId).toBe(DEVICE);
    expect(file.data.products).toHaveLength(1);
    expect(file.data.orders).toHaveLength(1);

    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.data.orders[0].id).toBe('o1');

    const minimal = parseBackup(
      JSON.stringify({ app: 'yanhuo-erp', data: { products: [], orders: [] } })
    );
    expect(minimal.data.sessions).toEqual([]);
    expect(minimal.version).toBe(1);

    expect(() => parseBackup('{}')).toThrow('不是本工具导出的备份文件');
    expect(() => parseBackup(JSON.stringify({ app: 'yanhuo-erp', data: {} }))).toThrow(
      '备份文件结构不完整'
    );
  });
});