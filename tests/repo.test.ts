import { beforeEach, describe, expect, it } from 'vitest';
import { fifoAllocate, inventoryMap, sessionReport } from '../src/db/calc';
import { db } from '../src/db/db';
import {
  addPatchedRecord,
  clearAllData,
  closeSession,
  createAdjustment,
  createBatch,
  createProduct,
  deleteBatch,
  deleteProduct,
  deleteRecord,
  ensureBootstrapSettings,
  ensureDeviceId,
  getAllSettings,
  getOpenSession,
  getSetting,
  loadAll,
  refreshSessionSummary,
  reopenSession,
  restoreOrder,
  saveRecord,
  setSetting,
  updateProduct,
  updateRecord,
  voidOrder,
  type RecordInput,
  type RecordLineInput
} from '../src/db/repo';
import { SETTING_KEYS } from '../src/db/types';
import { DEVICE, makeBatch, makeProduct, resetDb } from './helpers';

function line(amountFen: number, overrides: Partial<RecordLineInput> = {}): RecordLineInput {
  return {
    productId: 'p1',
    qtyBase: 1,
    unit: 'base',
    qty: 1,
    listUnitPriceFen: amountFen,
    unitPriceFen: amountFen,
    amountFen,
    ...overrides
  };
}

function input(lines: RecordLineInput[], overrides: Partial<RecordInput> = {}): RecordInput {
  return { deviceId: DEVICE, operator: '我', payMethod: 'cash', lines, ...overrides };
}

beforeEach(resetDb);

describe('saveRecord', () => {
  it('新建自动开一场，金额=明细之和，outbox 有 order + 每条 line', async () => {
    const order = await saveRecord(input([line(1800), line(500, { productId: 'p2', qtyBase: 2 })]));

    expect(order.sessionId).toBeTruthy();
    const session = await getOpenSession(DEVICE);
    expect(session?.id).toBe(order.sessionId);
    expect(order.totalFen).toBe(2300);

    const lines = await db.lines.where('orderId').equals(order.id).toArray();
    expect(lines).toHaveLength(2);
    expect(await db.outbox.get(`order:${order.id}`)).toMatchObject({ kind: 'order', op: 'upsert' });
    for (const l of lines) {
      expect(await db.outbox.get(`line:${l.id}`)).toMatchObject({ kind: 'line', op: 'upsert' });
    }
  });

  it('已结账场次抛 SESSION_CLOSED', async () => {
    const order = await saveRecord(input([line(1000)]));
    await closeSession(order.sessionId as string, '我');

    await expect(
      saveRecord(input([line(1000)], { sessionId: order.sessionId }))
    ).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });

  it('空明细 / 数量 / 金额 / 0 元非赠品各有明确错误码', async () => {
    await expect(saveRecord(input([]))).rejects.toMatchObject({ code: 'EMPTY_LINES' });
    await expect(saveRecord(input([line(100, { qtyBase: 0 })]))).rejects.toMatchObject({
      code: 'INVALID_QTY'
    });
    await expect(saveRecord(input([line(-1)]))).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(saveRecord(input([line(0)]))).rejects.toMatchObject({
      code: 'ZERO_AMOUNT_NOT_GIFT'
    });

    // 赠品允许 0 元
    const gift = await saveRecord(input([line(0, { gift: true })]));
    expect(gift.totalFen).toBe(0);
    const giftLine = (await db.lines.where('orderId').equals(gift.id).toArray())[0];
    expect(giftLine.gift).toBe(true);
    expect(giftLine.amountFen).toBe(0);
  });
});

describe('updateRecord / deleteRecord', () => {
  it('编辑整组替换明细，旧 line 入队 delete，totalFen 重算', async () => {
    const order = await saveRecord(input([line(1800)]));
    const oldLines = await db.lines.where('orderId').equals(order.id).toArray();
    expect(oldLines).toHaveLength(1);

    const updated = await updateRecord(
      order.id,
      input([line(1000), line(500, { productId: 'p2', qtyBase: 2 })])
    );

    expect(updated.totalFen).toBe(1500);
    const newLines = await db.lines.where('orderId').equals(order.id).toArray();
    expect(newLines).toHaveLength(2);
    expect(newLines.reduce((s, l) => s + l.amountFen, 0)).toBe(1500);
    expect(await db.outbox.get(`line:${oldLines[0].id}`)).toMatchObject({ op: 'delete' });
    for (const l of newLines) {
      expect(await db.outbox.get(`line:${l.id}`)).toMatchObject({ op: 'upsert' });
    }
  });

  it('open 场次可删；closed 场次删除抛 SESSION_CLOSED', async () => {
    const open = await saveRecord(input([line(1000)]));
    await deleteRecord(open.id);
    expect(await db.orders.get(open.id)).toBeUndefined();
    expect(await db.lines.where('orderId').equals(open.id).count()).toBe(0);
    expect(await db.outbox.get(`order:${open.id}`)).toMatchObject({ op: 'delete' });

    const closed = await saveRecord(input([line(1000)]));
    await closeSession(closed.sessionId as string, '我');
    await expect(deleteRecord(closed.id)).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
    expect(await db.orders.get(closed.id)).toBeTruthy();
  });
});

describe('voidOrder / restoreOrder', () => {
  it('作废/恢复切换 voided，库存与报表随之变化', async () => {
    await db.products.put(makeProduct('p1'));
    await db.batches.put(makeBatch('b1', 'p1', 10, 100));
    const order = await saveRecord(input([line(2000, { qtyBase: 2 })], { payMethod: 'cash' }));

    const load = async () => {
      const [batches, orders, lines, adjustments] = await Promise.all([
        db.batches.toArray(),
        db.orders.toArray(),
        db.lines.toArray(),
        db.adjustments.toArray()
      ]);
      return {
        inventory: inventoryMap(batches, orders, lines, adjustments).get('p1'),
        summary: sessionReport(
          order.sessionId as string,
          orders,
          lines,
          fifoAllocate(batches, orders, lines)
        )
      };
    };

    expect((await load()).inventory).toBe(8);
    expect((await load()).summary.orderCount).toBe(1);

    await voidOrder(order.id);
    expect((await db.orders.get(order.id))?.voided).toBe(true);
    expect((await load()).inventory).toBe(10);
    expect((await load()).summary.orderCount).toBe(0);
    expect((await load()).summary.revenueFen).toBe(0);

    await restoreOrder(order.id);
    expect((await db.orders.get(order.id))?.voided).toBeUndefined();
    expect((await load()).inventory).toBe(8);
    expect((await load()).summary.revenueFen).toBe(2000);
  });

  it('已结账场次作废/恢复会重算快照；open 场次不写快照', async () => {
    await db.products.put(makeProduct('p1'));
    await db.batches.put(makeBatch('b1', 'p1', 10, 100));
    const order = await saveRecord(input([line(2000, { qtyBase: 2 })]));
    const sessionId = order.sessionId as string;

    // open 场次：报表实时算，不落快照
    await voidOrder(order.id);
    expect((await db.sessions.get(sessionId))?.summary).toBeUndefined();
    await restoreOrder(order.id);
    expect((await db.sessions.get(sessionId))?.summary).toBeUndefined();

    const closed = await closeSession(sessionId, '我');
    expect(closed.summary).toMatchObject({ orderCount: 1, revenueFen: 2000 });

    await voidOrder(order.id);
    const voided = await db.sessions.get(sessionId);
    expect(voided?.summary?.revenueFen).toBe(0);
    expect(voided?.summary?.orderCount).toBe(0);

    await restoreOrder(order.id);
    const restored = await db.sessions.get(sessionId);
    expect(restored?.summary?.revenueFen).toBe(2000);
    expect(restored?.summary?.orderCount).toBe(1);
  });
});

describe('closeSession', () => {
  it('写 summary 并标记 closed；重复结账抛 ALREADY_CLOSED', async () => {
    await db.products.put(makeProduct('p1'));
    await db.batches.put(makeBatch('b1', 'p1', 10, 100));
    const order = await saveRecord(input([line(1800)]));

    const closed = await closeSession(order.sessionId as string, '老板娘');
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toBeTruthy();
    expect(closed.closedBy).toBe('老板娘');
    expect(closed.summary).toMatchObject({
      orderCount: 1,
      revenueFen: 1800,
      costFen: 100,
      grossFen: 1700
    });
    expect(await getOpenSession(DEVICE)).toBeUndefined();

    await expect(closeSession(order.sessionId as string, '我')).rejects.toMatchObject({
      code: 'ALREADY_CLOSED'
    });
  });
});

describe('addPatchedRecord / refreshSessionSummary', () => {
  it('补记只允许 closed：patchedCount 递增且 summary 更新', async () => {
    const order = await saveRecord(input([line(1800)]));
    const sessionId = order.sessionId as string;
    await closeSession(sessionId, '我');

    const first = await addPatchedRecord({
      ...input([line(500)], { payMethod: 'wechat' }),
      sessionId
    });
    expect(first.sessionId).toBe(sessionId);
    let session = await db.sessions.get(sessionId);
    expect(session?.patchedCount).toBe(1);
    expect(session?.summary?.revenueFen).toBe(2300);
    expect(session?.summary?.wechatFen).toBe(500);

    await addPatchedRecord({ ...input([line(200)]), sessionId });
    session = await db.sessions.get(sessionId);
    expect(session?.patchedCount).toBe(2);
    expect(session?.summary?.revenueFen).toBe(2500);

    const open = await saveRecord(input([line(300)]));
    await expect(
      addPatchedRecord({ ...input([line(100)]), sessionId: open.sessionId as string })
    ).rejects.toMatchObject({ code: 'NOT_CLOSED' });
  });

  it('refreshSessionSummary 重算并写回；场次不存在返回 undefined', async () => {
    const order = await saveRecord(input([line(1200)]));
    await updateRecord(order.id, input([line(1500)]));

    const summary = await refreshSessionSummary(order.sessionId as string);
    expect(summary?.revenueFen).toBe(1500);
    expect((await db.sessions.get(order.sessionId as string))?.summary?.revenueFen).toBe(1500);
    expect(await refreshSessionSummary('missing-session')).toBeUndefined();
  });
});

describe('商品 / 进货 / 设置 / 调整', () => {
  it('商品新增会 trim 并夹紧数值；编辑标记非示例；被流水引用的删除改为停用', async () => {
    const p = await createProduct({
      name: '  大地红  ',
      category: '炮',
      unitBase: '  ',
      boxQty: 3.9,
      priceList: 25.6,
      negotiable: true
    });
    expect(p.name).toBe('大地红');
    expect(p.unitBase).toBe('个');
    expect(p.boxQty).toBe(3);
    expect(p.priceList).toBe(26);
    expect(p.sample).toBeUndefined();

    await updateProduct(p.id, { name: ' 新名字 ', priceList: 3000 });
    const updated = await db.products.get(p.id);
    expect(updated?.name).toBe('新名字');
    expect(updated?.priceList).toBe(3000);
    expect(updated?.updatedAt).not.toBe(p.updatedAt);

    // 没有流水 → 直接删
    const unused = await createProduct({
      name: '没卖过',
      category: '烟花',
      unitBase: '支',
      boxQty: 1,
      priceList: 100,
      negotiable: false
    });
    await deleteProduct(unused.id);
    expect(await db.products.get(unused.id)).toBeUndefined();

    // 有批次引用 → 停用而不是删除
    await createBatch({ productId: p.id, qtyBase: 5, unitCostFen: 100 }, DEVICE);
    await deleteProduct(p.id);
    expect((await db.products.get(p.id))?.archived).toBe(true);
  });

  it('进货默认按本地日期入账；删除批次会入队 delete', async () => {
    const p = await createProduct({
      name: '二踢脚',
      category: '炮',
      unitBase: '个',
      boxQty: 100,
      priceList: 150,
      negotiable: true
    });
    const b = await createBatch(
      { productId: p.id, qtyBase: 10.9, unitCostFen: 12.6, batchNo: '  A1  ' },
      DEVICE
    );
    expect(b.qtyBase).toBe(10);
    expect(b.unitCostFen).toBe(13);
    expect(b.batchNo).toBe('A1');
    expect(b.receivedAt).toBeTruthy();
    expect(await db.outbox.get(`batch:${b.id}`)).toMatchObject({ op: 'upsert' });

    await deleteBatch(b.id);
    expect(await db.batches.get(b.id)).toBeUndefined();
    expect(await db.outbox.get(`batch:${b.id}`)).toMatchObject({ op: 'delete' });
  });

  it('已卖出的批次不能删（BATCH_IN_USE）；没卖过的照常删除', async () => {
    await db.products.put(makeProduct('p1'));
    const sold = await createBatch({ productId: 'p1', qtyBase: 10, unitCostFen: 100 }, DEVICE);
    await saveRecord(input([line(900, { productId: 'p1', qtyBase: 3 })]));

    // 卖掉 3 个 → FIFO 剩余 7 < 10，删了会让历史成本退回兜底均价
    await expect(deleteBatch(sold.id)).rejects.toMatchObject({
      code: 'BATCH_IN_USE',
      message: '这批货已经卖出去了，不能删；只能改数量'
    });
    expect(await db.batches.get(sold.id)).toBeTruthy();
    expect(await db.outbox.get(`batch:${sold.id}`)).toMatchObject({ op: 'upsert' });

    // 没被动过的批次仍可删
    const untouched = await createBatch({ productId: 'p1', qtyBase: 10, unitCostFen: 100 }, DEVICE);
    await deleteBatch(untouched.id);
    expect(await db.batches.get(untouched.id)).toBeUndefined();
    expect(await db.outbox.get(`batch:${untouched.id}`)).toMatchObject({ op: 'delete' });
  });

  it('设置读写、设备 ID 稳定、启动默认设置只补缺失项', async () => {
    await setSetting('k', 'v');
    expect(await getSetting('k')).toBe('v');
    expect(await getSetting('nope')).toBeUndefined();

    const id1 = await ensureDeviceId();
    const id2 = await ensureDeviceId();
    expect(id1).toBe(id2);
    expect(await getSetting(SETTING_KEYS.deviceId)).toBe(id1);

    await setSetting('operatorA', '我');
    await ensureBootstrapSettings({ operatorA: '不应该覆盖', expiryWarnDays: '30' });
    const all = await getAllSettings();
    expect(all.operatorA).toBe('我');
    expect(all.expiryWarnDays).toBe('30');
    expect(await db.outbox.get('setting:expiryWarnDays')).toBeTruthy();
  });

  it('库存调整写入并登记发件箱', async () => {
    const a = await createAdjustment({ productId: 'p1', qtyBase: -2.4, type: 'loss', reason: ' 碎了 ' }, DEVICE);
    expect(a.qtyBase).toBe(-2);
    expect(a.reason).toBe('碎了');
    expect(a.deviceId).toBe(DEVICE);
    expect(await db.adjustments.get(a.id)).toBeTruthy();
    expect(await db.outbox.get(`adjustment:${a.id}`)).toMatchObject({ op: 'upsert' });
  });

  it('loadAll 返回全部 7 张表；clearAllData 清库并重置迁移标记', async () => {
    await db.products.put(makeProduct('p1'));
    await db.batches.put(makeBatch('b1', 'p1', 5, 100));
    const order = await saveRecord(input([line(1000)]));
    await setSetting(SETTING_KEYS.sessionsMigrated, '1');

    const all = await loadAll();
    expect(all.products).toHaveLength(1);
    expect(all.batches).toHaveLength(1);
    expect(all.orders).toHaveLength(1);
    expect(all.lines.length).toBeGreaterThan(0);
    expect(Array.isArray(all.sessions)).toBe(true);
    expect(Array.isArray(all.settings)).toBe(true);

    await clearAllData();
    expect(await db.products.count()).toBe(0);
    expect(await db.orders.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await getSetting(SETTING_KEYS.sessionsMigrated)).toBe('');
    expect(await getSetting(SETTING_KEYS.seeded)).toBe('');
    expect(order.id).toBeTruthy();
  });
});

describe('reopenSession', () => {
  it('结账后可重开并清理结账字段；下一场已开始则拒绝', async () => {
    const first = await saveRecord(input([line(800)]));
    const firstId = first.sessionId as string;
    await closeSession(firstId, '我');

    const reopened = await reopenSession(firstId);
    expect(reopened.status).toBe('open');
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.closedBy).toBeUndefined();
    expect(reopened.summary).toBeUndefined();

    await expect(reopenSession(firstId)).rejects.toMatchObject({ code: 'NOT_CLOSED' });

    await closeSession(firstId, '我');
    // 固定第一场的开始时间，避免同毫秒内创建新场导致断言不稳定
    const stored = await db.sessions.get(firstId);
    expect(stored).toBeTruthy();
    await db.sessions.put({
      ...(stored as NonNullable<typeof stored>),
      startedAt: '2020-01-01T00:00:00.000Z'
    });
    // 新一场（开始时间晚于第一场）已存在 → 不允许撤销结账
    await saveRecord(input([line(100)]));
    await expect(reopenSession(firstId)).rejects.toMatchObject({ code: 'NEXT_SESSION_STARTED' });
  });
});