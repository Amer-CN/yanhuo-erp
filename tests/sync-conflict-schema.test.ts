// conflicts 表 v4 → v5 迁移回归（H2.2）。
//
// 这条用例单独成文件：它必须关掉单例、删库，再以 v4 结构造「老数据」后重新打开，
// 会让本文件里的数据库短暂处于只有 conflicts 表的中间态 —— 放在别的测试文件里
// 会污染同文件的其它用例。跑完删除数据库，避免影响后续复用的 worker。
import Dexie from 'dexie';
import { afterAll, expect, it } from 'vitest';
import { db } from '../src/db/db';

const DB_NAME = 'yanhuo-erp';

afterAll(async () => {
  db.close();
  await Dexie.delete(DB_NAME);
});

it('v4 旧冲突行在升到 v5 后仍可读，重复的 (kind,recordId) 折叠成最新一条', async () => {
  db.close();
  await Dexie.delete(DB_NAME);

  // 用 v4 的老结构（自增主键 + 没有 [kind+recordId] 复合索引）造数据
  const old = new Dexie(DB_NAME);
  old.version(4).stores({ conflicts: '++id, at, kind, recordId' });
  await old.open();
  await old.table('conflicts').bulkAdd([
    {
      at: '2026-11-01T10:00:00.000Z',
      kind: 'order',
      recordId: 'o1',
      local: '{"totalFen":1000}',
      remote: '{"totalFen":2000}'
    },
    {
      at: '2026-11-02T10:00:00.000Z',
      kind: 'order',
      recordId: 'o1',
      local: '{"totalFen":1000}',
      remote: '{"totalFen":3000}'
    }
  ]);
  old.close();

  // 重新打开单例：触发 v5 升级 + 迁移
  await db.open();

  const rows = await db.conflicts.toArray();
  // 旧数据没丢，但同一 (kind,recordId) 的历史重复被折叠
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe('order');
  expect(rows[0].recordId).toBe('o1');
  expect(rows[0].local).toBe('{"totalFen":1000}');
  // 保留 at 最新的那一条
  expect(JSON.parse(rows[0].remote).totalFen).toBe(3000);
});