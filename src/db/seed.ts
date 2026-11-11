// 示例数据：第一次打开时放几个商品，方便照着改成自己的货。
// 设置里可以一键清空。

import { db } from './db';
import { enqueueInTx, syncWanted } from './outbox';
import type { Category, Product } from './types';
import { SETTING_KEYS } from './types';
import { nowIso } from './util';

interface SeedProduct {
  name: string;
  category: Category;
  unitBase: string;
  boxQty: number;
  priceList: number;
}

const SAMPLE: SeedProduct[] = [
  { name: '大地红 1000 响', category: '炮', unitBase: '挂', boxQty: 20, priceList: 2500 },
  { name: '二踢脚', category: '炮', unitBase: '个', boxQty: 100, priceList: 150 },
  { name: '加特林', category: '烟花', unitBase: '支', boxQty: 12, priceList: 1500 },
  { name: '组合烟花 36 发', category: '组合', unitBase: '个', boxQty: 6, priceList: 6800 },
  { name: '仙女棒', category: '儿童', unitBase: '把', boxQty: 30, priceList: 300 },
  { name: '摔炮', category: '儿童', unitBase: '盒', boxQty: 50, priceList: 200 },
  { name: '电光花', category: '儿童', unitBase: '把', boxQty: 30, priceList: 200 },
  { name: '手持烟花棒', category: '烟花', unitBase: '支', boxQty: 40, priceList: 500 }
];

/**
 * 首次启动种入示例商品。
 *
 * 示例商品是**业务数据**（固定 id 让两台设备各自种入时能去重），所以必须和发件箱同事务登记
 * （L-1：原来只写库不入队，示例商品永远推不到另一台手机）。`seeded` 是本机标记，
 * 不进发件箱 —— 否则另一台手机会被别人的「已种入」标记挡住自己的示例数据。
 */
export async function seedIfEmpty(): Promise<boolean> {
  const t = nowIso();
  // 固定 ID：两台设备各自初始化出来的示例商品是同一批记录，导入合并时不会变成两套
  const products: Product[] = SAMPLE.map((s, i) => ({
    id: `sample-${i + 1}`,
    name: s.name,
    category: s.category,
    unitBase: s.unitBase,
    boxQty: s.boxQty,
    priceList: s.priceList,
    negotiable: true,
    sample: true,
    archived: false,
    sortOrder: i,
    createdAt: t,
    updatedAt: t
  }));

  let planted = false;
  // 事务内再检查一次：StrictMode 会把 effect 跑两遍，避免重复种入
  await db.transaction('rw', [db.products, db.settings, db.outbox], async () => {
    const seeded = await db.settings.get(SETTING_KEYS.seeded);
    if (seeded?.value === 'yes') return;
    const count = await db.products.count();
    if (count > 0) {
      await db.settings.put({ key: SETTING_KEYS.seeded, value: 'yes' });
      return;
    }
    await db.products.bulkPut(products);
    await db.settings.put({ key: SETTING_KEYS.seeded, value: 'yes' });
    // 与业务写入同事务入队：入队失败会连商品一起回滚，不会出现「有商品但永远推不上去」
    await enqueueInTx(products.map((p) => ({ kind: 'product' as const, recordId: p.id })));
    planted = true;
  });
  if (planted) syncWanted();
  return planted;
}