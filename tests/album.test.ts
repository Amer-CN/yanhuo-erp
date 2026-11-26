import { describe, expect, it } from 'vitest';
import { fifoAllocate } from '../src/db/calc';
import {
  albumLevelForGross,
  albumLevelInfo,
  buildSeasonLedger,
  computeSeasonAlbum,
  computeSeasonSummaries,
  albumProgress,
  buildSeasonReport,
  nextRarityThresholdFen,
  pickAlbumSeason,
  rarityForGross
} from '../src/db/album';
import { seasonRange } from '../src/db/season';
import type { Batch, Category, Product, SaleLine, SalesOrder, Session } from '../src/db/types';

/** 本地中午的 ISO：任何时区偏移下 `isoToLocalDate` 都落在同一天 */
const isoAt = (y: number, m: number, d: number): string => new Date(y, m - 1, d, 12, 0, 0).toISOString();

function product(id: string, category: Category = '烟花', archived = false): Product {
  return {
    id,
    name: id,
    category,
    unitBase: '个',
    boxQty: 0,
    priceList: 0,
    negotiable: true,
    archived,
    sortOrder: 0,
    createdAt: isoAt(2026, 1, 1),
    updatedAt: isoAt(2026, 1, 1)
  };
}

function batch(id: string, productId: string, qty: number, cost: number, receivedAt: string): Batch {
  return {
    id,
    productId,
    qtyBase: qty,
    unitCostFen: cost,
    receivedAt,
    deviceId: 'd1',
    createdAt: `${receivedAt}T00:00:00.000Z`,
    updatedAt: `${receivedAt}T00:00:00.000Z`
  };
}

function order(id: string, createdAt: string, sessionId?: string, voided = false): SalesOrder {
  return {
    id,
    deviceId: 'd1',
    operator: '我',
    createdAt,
    payMethod: 'cash',
    totalFen: 0,
    ...(sessionId ? { sessionId } : {}),
    ...(voided ? { voided: true } : {}),
    updatedAt: createdAt
  };
}

function line(
  id: string,
  orderId: string,
  productId: string,
  qtyBase: number,
  amountFen: number,
  gift = false
): SaleLine {
  return {
    id,
    orderId,
    productId,
    qtyBase,
    unit: 'base',
    qty: qtyBase,
    listUnitPriceFen: qtyBase > 0 ? Math.round(amountFen / qtyBase) : 0,
    unitPriceFen: qtyBase > 0 ? Math.round(amountFen / qtyBase) : 0,
    amountFen,
    discountFen: 0,
    ...(gift ? { gift: true } : {})
  };
}

function session(id: string, startedAt: string): Session {
  return {
    id,
    deviceId: 'd1',
    startedAt,
    status: 'closed',
    openedBy: '我',
    patchedCount: 0,
    updatedAt: startedAt
  };
}

function ledgerOf(batches: Batch[], orders: SalesOrder[], lines: SaleLine[], sessions: Session[] = []) {
  const fifo = fifoAllocate(batches, orders, lines);
  return buildSeasonLedger({ orders, lines, sessions, fifo });
}

describe('品质阈值', () => {
  it('按分档给出品质，负毛利退回 R', () => {
    expect(rarityForGross(-500)).toBe('R');
    expect(rarityForGross(0)).toBe('R');
    expect(rarityForGross(4999)).toBe('R');
    expect(rarityForGross(5000)).toBe('SR');
    expect(rarityForGross(19999)).toBe('SR');
    expect(rarityForGross(20000)).toBe('SSR');
    expect(rarityForGross(49999)).toBe('SSR');
    expect(rarityForGross(50000)).toBe('UR');
  });

  it('给出下一档门槛，UR 之后没有下一档', () => {
    expect(nextRarityThresholdFen(0)).toBe(5000);
    expect(nextRarityThresholdFen(5000)).toBe(20000);
    expect(nextRarityThresholdFen(49999)).toBe(50000);
    expect(nextRarityThresholdFen(50000)).toBeNull();
  });
});

describe('卡册等级', () => {
  it('五级基础档之后每多一万元升一级', () => {
    expect(albumLevelForGross(0)).toBe(1);
    expect(albumLevelForGross(249999)).toBe(1);
    expect(albumLevelForGross(250000)).toBe(2);
    expect(albumLevelForGross(499999)).toBe(2);
    expect(albumLevelForGross(500000)).toBe(3);
    expect(albumLevelForGross(749999)).toBe(3);
    expect(albumLevelForGross(750000)).toBe(4);
    expect(albumLevelForGross(999999)).toBe(4);
    expect(albumLevelForGross(1000000)).toBe(5);
    expect(albumLevelForGross(1999999)).toBe(5);
    expect(albumLevelForGross(2000000)).toBe(6);
    expect(albumLevelForGross(3000000)).toBe(7);
  });

  it('给出等级区间、下一档和进度', () => {
    const info = albumLevelInfo(260000);
    expect(info.level).toBe(2);
    expect(info.floorFen).toBe(250000);
    expect(info.nextFen).toBe(500000);
    expect(info.ratio).toBeCloseTo(0.04, 5);

    const full = albumLevelInfo(1000000);
    expect(full.level).toBe(5);
    expect(full.nextFen).toBe(2000000);
    expect(full.ratio).toBe(0);
  });

  it('负毛利按 0 处理，不产生负等级', () => {
    expect(albumLevelForGross(-99999)).toBe(1);
    expect(albumLevelInfo(-99999).ratio).toBe(0);
  });
});

describe('赛季归属', () => {
  it('圣诞到元宵的销售都归同一季，收季后不计入', () => {
    const batches = [batch('b1', 'p1', 10, 100, '2026-12-01')];
    const orders = [
      order('o1', isoAt(2026, 12, 25)),
      order('o2', isoAt(2027, 2, 20)),
      order('o3', isoAt(2027, 2, 21))
    ];
    const lines = [
      line('l1', 'o1', 'p1', 1, 1000),
      line('l2', 'o2', 'p1', 1, 1000),
      line('l3', 'o3', 'p1', 1, 1000)
    ];
    const ledger = ledgerOf(batches, orders, lines);
    expect(ledger.get(2026)?.countedLines).toBe(2);
    expect(ledger.get(2026)?.grossFen).toBe(1800);
    expect(ledger.size).toBe(1);
  });

  it('补记到上赛季场次的订单归开场日所在赛季', () => {
    const batches = [batch('b1', 'p1', 5, 100, '2026-12-01')];
    const sessions = [session('s1', isoAt(2027, 2, 10))];
    // 补记发生在 3 月 1 日（已休赛），但挂在 2 月 10 日那一场
    const orders = [order('o1', isoAt(2027, 3, 1), 's1')];
    const lines = [line('l1', 'o1', 'p1', 1, 1000)];
    const ledger = ledgerOf(batches, orders, lines, sessions);
    expect(ledger.get(2026)?.grossFen).toBe(900);
  });

  it('场次缺失时回退订单时间，不抛错也不丢单', () => {
    const batches = [batch('b1', 'p1', 5, 100, '2026-12-01')];
    const orders = [order('o1', isoAt(2027, 1, 5), 'no-such-session')];
    const lines = [line('l1', 'o1', 'p1', 1, 1000)];
    const ledger = ledgerOf(batches, orders, lines, []);
    expect(ledger.get(2026)?.grossFen).toBe(900);
  });

  it('作废订单不计入账本', () => {
    const batches = [batch('b1', 'p1', 5, 100, '2026-12-01')];
    const orders = [order('o1', isoAt(2026, 12, 26), undefined, true)];
    const lines = [line('l1', 'o1', 'p1', 1, 1000)];
    expect(ledgerOf(batches, orders, lines).size).toBe(0);
  });
});

describe('毛利口径', () => {
  it('缺批次成本的明细整条排除，并单独计数', () => {
    const batches = [batch('b1', 'p1', 1, 1000, '2026-12-20')];
    const orders = [order('o1', isoAt(2026, 12, 26)), order('o2', isoAt(2026, 12, 27))];
    const lines = [line('l1', 'o1', 'p1', 1, 2000), line('l2', 'o2', 'p1', 1, 3000)];
    const entry = ledgerOf(batches, orders, lines).get(2026);
    expect(entry?.grossFen).toBe(1000);
    expect(entry?.countedLines).toBe(1);
    expect(entry?.skippedLines).toBe(1);
  });

  it('赠品按成本冲减毛利', () => {
    const batches = [batch('b1', 'p1', 1, 1000, '2026-12-20')];
    const orders = [order('o1', isoAt(2026, 12, 26))];
    const lines = [line('l1', 'o1', 'p1', 1, 0, true)];
    const entry = ledgerOf(batches, orders, lines).get(2026);
    expect(entry?.grossFen).toBe(-1000);
    expect(entry?.countedLines).toBe(1);
  });

  it('同一商品分开累计，互不串账', () => {
    const batches = [batch('b1', 'p1', 10, 100, '2026-12-01'), batch('b2', 'p2', 10, 200, '2026-12-01')];
    const orders = [order('o1', isoAt(2026, 12, 26))];
    const lines = [line('l1', 'o1', 'p1', 2, 1000), line('l2', 'o1', 'p2', 1, 1000)];
    const entry = ledgerOf(batches, orders, lines).get(2026);
    expect(entry?.byProductFen.get('p1')).toBe(800);
    expect(entry?.byProductFen.get('p2')).toBe(800);
    expect(entry?.grossFen).toBe(1600);
  });
});

describe('卡册视图', () => {
  it('停用商品排在末尾，同组按毛利降序', () => {
    const ledger = new Map([
      [
        2026,
        {
          grossFen: 1500,
          byProductFen: new Map([
            ['p1', 500],
            ['p2', 1000]
          ]),
          countedLines: 2,
          skippedLines: 0
        }
      ]
    ]);
    const products = [product('p2', '炮', true), product('p1', '烟花')];
    const album = computeSeasonAlbum({ season: seasonRange(2026), products, ledger });
    expect(album.cards.map((c) => c.productId)).toEqual(['p1', 'p2']);
    expect(album.cards[0].stopped).toBe(false);
    expect(album.cards[1].stopped).toBe(true);
  });

  it('没有销售时所有卡都是 R，且给出下一档', () => {
    const album = computeSeasonAlbum({
      season: seasonRange(2026),
      products: [product('p1'), product('p2', '炮')],
      ledger: new Map()
    });
    expect(album.level.level).toBe(1);
    expect(album.cards.every((c) => c.rarity === 'R')).toBe(true);
    expect(album.cards[0].nextFen).toBe(5000);
  });

  it('单商品毛利换算成品质与下一档差额', () => {
    const ledger = new Map([
      [
        2026,
        {
          grossFen: 6000,
          byProductFen: new Map([['p1', 6000]]),
          countedLines: 1,
          skippedLines: 0
        }
      ]
    ]);
    const album = computeSeasonAlbum({ season: seasonRange(2026), products: [product('p1')], ledger });
    expect(album.cards[0].rarity).toBe('SR');
    expect(album.cards[0].nextFen).toBe(20000);
    expect(album.level.level).toBe(1);
    expect(album.level.nextFen).toBe(250000);
  });
});

describe('往季归档', () => {
  it('按赛季倒序给出摘要，并统计 UR 数量', () => {
    const batches = [batch('b1', 'p1', 10, 100, '2025-12-01')];
    const orders = [order('o1', isoAt(2025, 12, 30)), order('o2', isoAt(2026, 12, 30))];
    const lines = [line('l1', 'o1', 'p1', 1, 5000), line('l2', 'o2', 'p1', 1, 60000)];
    const ledger = ledgerOf(batches, orders, lines);
    const summaries = computeSeasonSummaries({ ledger, products: [product('p1')] });
    expect(summaries.map((s) => s.season.startYear)).toEqual([2026, 2025]);
    expect(summaries[0].grossFen).toBe(59900);
    expect(summaries[0].urCount).toBe(1);
    expect(summaries[1].urCount).toBe(0);
  });
});

describe('稳定性与撤销作废', () => {
  it('撤销作废后同一笔销售重新计入', () => {
    const batches = [batch('b1', 'p1', 5, 100, '2026-12-01')];
    const lines = [line('l1', 'o1', 'p1', 1, 1000)];
    const voided = [order('o1', isoAt(2026, 12, 26), undefined, true)];
    expect(ledgerOf(batches, voided, lines).size).toBe(0);

    const active = [order('o1', isoAt(2026, 12, 26))];
    expect(ledgerOf(batches, active, lines).get(2026)?.grossFen).toBe(900);
  });

  it('同一账本重复计算结果一致，不依赖设备', () => {
    const batches = [batch('b1', 'p1', 5, 100, '2026-12-01')];
    const orders = [order('o1', isoAt(2026, 12, 26)), order('o2', isoAt(2027, 1, 3))];
    const lines = [line('l1', 'o1', 'p1', 1, 1000), line('l2', 'o2', 'p1', 1, 2000)];
    const first = ledgerOf(batches, orders, lines).get(2026);
    const second = ledgerOf(batches, orders, lines).get(2026);
    expect(first?.grossFen).toBe(second?.grossFen);
    expect([...(first?.byProductFen ?? [])]).toEqual([...(second?.byProductFen ?? [])]);
  });
});

describe('数据更新时间', () => {
  it('记录本赛季最近一次明细/订单更新时间', () => {
    const batches = [batch('b1', 'p1', 5, 100, '2026-12-01')];
    const orders = [
      { ...order('o1', isoAt(2026, 12, 26)), updatedAt: isoAt(2026, 12, 26) },
      { ...order('o2', isoAt(2026, 12, 27)), updatedAt: isoAt(2026, 12, 28) }
    ];
    const lines = [line('l1', 'o1', 'p1', 1, 1000), line('l2', 'o2', 'p1', 1, 2000)];
    expect(ledgerOf(batches, orders, lines).get(2026)?.lastUpdatedAt).toBe(isoAt(2026, 12, 28));
  });

  it('没有计入明细时没有更新时间', () => {
    expect(ledgerOf([], [], []).size).toBe(0);
  });

  it('卡册视图透传更新时间', () => {
    const ledger = new Map([
      [2026, { grossFen: 0, byProductFen: new Map(), countedLines: 0, skippedLines: 0, lastUpdatedAt: isoAt(2027, 1, 2) }]
    ]);
    const album = computeSeasonAlbum({ season: seasonRange(2026), products: [product('p1')], ledger });
    expect(album.lastUpdatedAt).toBe(isoAt(2027, 1, 2));
  });
});

describe('卡册展示赛季', () => {
  it('赛期内显示当季', () => {
    const picked = pickAlbumSeason('2027-01-10', new Map());
    expect(picked.status).toBe('active');
    expect(picked.season.startYear).toBe(2026);
  });

  it('赛季外显示最近一个已收官赛季，打开就能看卡', () => {
    const ledger = new Map([
      [2025, { grossFen: 1000, byProductFen: new Map([['p1', 1000]]), countedLines: 1, skippedLines: 0 }]
    ]);
    const picked = pickAlbumSeason('2026-11-26', ledger);
    expect(picked.status).toBe('archived');
    expect(picked.season.startYear).toBe(2025);
  });

  it('没有任何赛季数据时显示下赛季预览', () => {
    const picked = pickAlbumSeason('2026-11-26', new Map());
    expect(picked.status).toBe('upcoming');
    expect(picked.season.startDate).toBe('2026-12-25');
  });

  it('赛期内即使有更早的赛季，也优先显示当季', () => {
    const ledger = new Map([
      [2025, { grossFen: 1000, byProductFen: new Map([['p1', 1000]]), countedLines: 1, skippedLines: 0 }]
    ]);
    expect(pickAlbumSeason('2027-01-10', ledger).status).toBe('active');
  });
});

describe('卡面徽章与卡号', () => {
  it('按毛利排名，只有正毛利参与', () => {
    const ledger = new Map([
      [2026, { grossFen: 900, byProductFen: new Map([['p1', 500], ['p2', 300], ['p3', 100], ['p4', -50]]), countedLines: 4, skippedLines: 0 }]
    ]);
    const album = computeSeasonAlbum({
      season: seasonRange(2026),
      products: [product('p1'), product('p2'), product('p3'), product('p4')],
      ledger
    });
    const rank = Object.fromEntries(album.cards.map((c) => [c.productId, c.rank ?? null]));
    expect(rank.p1).toBe(1);
    expect(rank.p2).toBe(2);
    expect(rank.p3).toBe(3);
    expect(rank.p4).toBeNull();
  });

  it('赛季内新建的商品标为新品', () => {
    const inside = { ...product('p1'), createdAt: isoAt(2027, 1, 5) };
    const outside = { ...product('p2'), createdAt: isoAt(2026, 6, 1) };
    const album = computeSeasonAlbum({ season: seasonRange(2026), products: [inside, outside], ledger: new Map() });
    const byId = Object.fromEntries(album.cards.map((c) => [c.productId, c.isNew]));
    expect(byId.p1).toBe(true);
    expect(byId.p2).toBe(false);
  });

  it('每张卡有稳定的三位卡号，同一商品两次计算一致', () => {
    const a = computeSeasonAlbum({ season: seasonRange(2026), products: [product('p1')], ledger: new Map() });
    const b = computeSeasonAlbum({ season: seasonRange(2026), products: [product('p1')], ledger: new Map() });
    expect(a.cards[0].no).toMatch(/^#\d{3}$/);
    expect(a.cards[0].no).toBe(b.cards[0].no);
  });
});

describe('卡册完成度', () => {
  it('统计已收集与 SR 以上张数', () => {
    const ledger = new Map([
      [2026, { grossFen: 76000, byProductFen: new Map([['p1', 0], ['p2', 6000], ['p3', 20000], ['p4', 50000]]), countedLines: 3, skippedLines: 0 }]
    ]);
    const album = computeSeasonAlbum({
      season: seasonRange(2026),
      products: [product('p1'), product('p2'), product('p3'), product('p4')],
      ledger
    });
    expect(albumProgress(album.cards)).toEqual({ collected: 3, total: 4, srPlus: 3 });
  });
});

describe('赛季战报', () => {
  it('汇总毛利、订单、件数、品质分布与 Top5', () => {
    const ledger = new Map([
      [2026, {
        grossFen: 76000,
        byProductFen: new Map([['p1', 50000], ['p2', 20000], ['p3', 6000]]),
        countedLines: 3,
        skippedLines: 1,
        orderCount: 4,
        qtyBase: 17
      }],
      [2025, {
        grossFen: 38000,
        byProductFen: new Map([['p1', 38000]]),
        countedLines: 2,
        skippedLines: 0,
        orderCount: 2,
        qtyBase: 9
      }]
    ]);
    const report = buildSeasonReport({
      season: seasonRange(2026),
      products: [product('p1'), product('p2'), product('p3'), product('p4')],
      ledger
    });
    expect(report.grossFen).toBe(76000);
    expect(report.orderCount).toBe(4);
    expect(report.qtyBase).toBe(17);
    expect(report.avgGrossFen).toBe(19000);
    expect(report.rarityCounts).toEqual({ R: 1, SR: 1, SSR: 1, UR: 1 });
    expect(report.topProducts.map((p) => p.productId)).toEqual(['p1', 'p2', 'p3']);
    expect(report.skippedLines).toBe(1);
    expect(report.previous?.season.startYear).toBe(2025);
    expect(report.grossDeltaRatio).toBeCloseTo(1, 5);
  });

  it('没有上一季时对比为空', () => {
    const report = buildSeasonReport({ season: seasonRange(2026), products: [product('p1')], ledger: new Map() });
    expect(report.previous).toBeNull();
    expect(report.grossDeltaRatio).toBeNull();
    expect(report.avgGrossFen).toBe(0);
  });
});

describe('手动卡面', () => {
  it('商品自选的家族会带到卡册卡上', () => {
    const p = { ...product('p1'), artFamily: 'windmill' as const };
    const album = computeSeasonAlbum({ season: seasonRange(2026), products: [p], ledger: new Map() });
    expect(album.cards[0].artFamily).toBe('windmill');
  });

  it('没自选时保持为空，交给名字自动匹配', () => {
    const album = computeSeasonAlbum({ season: seasonRange(2026), products: [product('p1')], ledger: new Map() });
    expect(album.cards[0].artFamily).toBeNull();
  });
});
