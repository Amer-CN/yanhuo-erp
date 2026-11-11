import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { __resetSyncFlagsForTest } from '../src/db/sync';

/**
 * 每个用例结束后复位 sync.ts 的模块级状态（缺列降级标志 + 回推节流表）。
 *
 * 为什么必须在全局 setup 里做：`sync.ts` 被同一个测试文件的多个用例共享同一模块实例，
 * 一旦某个用例把 `recordColumnMissing` 置真、或让某条记录进了 30s 回推节流表，
 * 后续用例会静默走 legacy 列清单 / 静默不回推 —— 表现为「改一行代码，另一个用例莫名其妙变绿」。
 */
afterEach(() => {
  __resetSyncFlagsForTest();
});