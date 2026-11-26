// 赛季卡册计算：复用报表的 FIFO 结果，按「场次开场日 → 赛季」归属订单，
// 算出本赛季共享毛利、卡册等级与每张商品卡的品质。全部纯函数，不落库。
//
// 口径提醒：FIFO 必须对**全库**重放一次再按赛季过滤。只拿某一季的订单去重放，
// 会把最早的批次算给这一季，毛利虚高。

import type { FifoResult } from './calc';
import { currentSeason, nextSeasonAfter, seasonForDate, seasonRange, type SeasonRange } from './season';
import type { Category, Product, SaleLine, SalesOrder, Session } from './types';
import { isoToLocalDate } from './util';

/** 品质从低到高；下标即高低比较 */
export const RARITY_ORDER = ['R', 'SR', 'SSR', 'UR'] as const;

export type Rarity = (typeof RARITY_ORDER)[number];

/** 单商品本赛季毛利门槛（分）：R 0 / SR 50 元 / SSR 200 元 / UR 500 元 */
export const RARITY_THRESHOLDS_FEN: Record<Rarity, number> = {
  R: 0,
  SR: 5_000,
  SSR: 20_000,
  UR: 50_000
};

/** 卡册基础档门槛（分）：Lv.1–Lv.5 */
const ALBUM_BASE_STEPS_FEN = [0, 250_000, 500_000, 750_000, 1_000_000] as const;

/** 5 级之后每一级需要的毛利（分） */
const ALBUM_STEP_FEN = 1_000_000;

export function rarityForGross(grossFen: number): Rarity {
  const p = Math.max(0, Math.round(grossFen));
  let out: Rarity = 'R';
  for (const key of RARITY_ORDER) {
    if (p >= RARITY_THRESHOLDS_FEN[key]) out = key;
  }
  return out;
}

/** 下一档品质门槛；已是 UR 时返回 null */
export function nextRarityThresholdFen(grossFen: number): number | null {
  const p = Math.max(0, Math.round(grossFen));
  for (const key of RARITY_ORDER) {
    if (p < RARITY_THRESHOLDS_FEN[key]) return RARITY_THRESHOLDS_FEN[key];
  }
  return null;
}

/** 本赛季共享毛利 → 卡册等级；5 级之后每多 1 万元一级，不封顶 */
export function albumLevelForGross(grossFen: number): number {
  const p = Math.max(0, Math.round(grossFen));
  if (p < ALBUM_BASE_STEPS_FEN[1]) return 1;
  if (p < ALBUM_BASE_STEPS_FEN[2]) return 2;
  if (p < ALBUM_BASE_STEPS_FEN[3]) return 3;
  if (p < ALBUM_BASE_STEPS_FEN[4]) return 4;
  return 5 + Math.floor((p - ALBUM_BASE_STEPS_FEN[4]) / ALBUM_STEP_FEN);
}

function albumLevelFloorFen(level: number): number {
  if (level <= 1) return 0;
  if (level <= 5) return ALBUM_BASE_STEPS_FEN[level - 1];
  return ALBUM_STEP_FEN * (level - 4);
}

function albumNextLevelFen(level: number): number {
  if (level <= 4) return ALBUM_BASE_STEPS_FEN[level];
  return ALBUM_STEP_FEN * (level - 3);
}

export interface AlbumLevel {
  level: number;
  /** 规整到 ≥0 的赛季毛利（分） */
  grossFen: number;
  /** 当前等级门槛（分） */
  floorFen: number;
  /** 下一等级门槛（分） */
  nextFen: number;
  /** 当前等级内的进度 0–1 */
  ratio: number;
}

/** 等级 + 区间 + 进度：入口和头卡都只读这一份 */
export function albumLevelInfo(grossFen: number): AlbumLevel {
  const p = Math.max(0, Math.round(grossFen));
  const level = albumLevelForGross(p);
  const floorFen = albumLevelFloorFen(level);
  const nextFen = albumNextLevelFen(level);
  const span = nextFen - floorFen;
  const ratio = span > 0 ? Math.min(1, Math.max(0, (p - floorFen) / span)) : 0;
  return { level, grossFen: p, floorFen, nextFen, ratio };
}

export interface SeasonLedgerEntry {
  /** 本赛季计入的毛利合计（分，可为负） */
  grossFen: number;
  /** 商品 → 本赛季计入的毛利（分） */
  byProductFen: Map<string, number>;
  /** 计入的明细数 */
  countedLines: number;
  /** 因成本待补跳过的明细数 */
  skippedLines: number;
  /** 计入明细里最近一次业务更新时间（ISO）；没有计入明细时为 null */
  lastUpdatedAt?: string | null;
}

/**
 * 一次遍历得到「赛季开始年份 → 账本」。
 *
 * - 订单归属：所属场次的 `startedAt` 日期；场次缺失或已不存在时回退订单 `createdAt`。
 * - 作废订单、孤儿明细、休赛期订单都不进任何赛季。
 * - 成本待补（`lineCost` 缺失或有未覆盖销量）整条排除并计入 `skippedLines`。
 */
export function buildSeasonLedger(args: {
  orders: SalesOrder[];
  lines: SaleLine[];
  sessions: Session[];
  fifo: FifoResult;
}): Map<number, SeasonLedgerEntry> {
  const { orders, lines, sessions, fifo } = args;
  const sessionById = new Map<string, Session>();
  for (const s of sessions) sessionById.set(s.id, s);

  const orderSeasonYear = new Map<string, number | null>();
  const orderUpdatedAt = new Map<string, string>();
  for (const o of orders) {
    if (o.voided) continue;
    const s = o.sessionId ? sessionById.get(o.sessionId) : undefined;
    const date = isoToLocalDate(s?.startedAt ?? o.createdAt);
    orderSeasonYear.set(o.id, seasonForDate(date)?.startYear ?? null);
    orderUpdatedAt.set(o.id, o.updatedAt ?? o.createdAt);
  }

  const ledger = new Map<number, SeasonLedgerEntry>();
  const entryOf = (year: number): SeasonLedgerEntry => {
    const cur = ledger.get(year);
    if (cur) return cur;
    const fresh: SeasonLedgerEntry = {
      grossFen: 0,
      byProductFen: new Map(),
      countedLines: 0,
      skippedLines: 0,
      lastUpdatedAt: null
    };
    ledger.set(year, fresh);
    return fresh;
  };

  for (const line of lines) {
    if (!orderSeasonYear.has(line.orderId)) continue;
    const year = orderSeasonYear.get(line.orderId);
    if (year === null || year === undefined) continue;

    const entry = entryOf(year);
    const cost = fifo.lineCost.get(line.id);
    const uncovered = fifo.uncoveredQtyByLine.get(line.id) ?? 0;
    if (cost === undefined || uncovered > 0) {
      entry.skippedLines += 1;
      continue;
    }
    const gross = line.amountFen - cost;
    entry.grossFen += gross;
    entry.byProductFen.set(line.productId, (entry.byProductFen.get(line.productId) ?? 0) + gross);
    entry.countedLines += 1;

    // ISO 字符串字典序即时间序；取明细或所属订单里较新的那一个
    const at = line.updatedAt ?? orderUpdatedAt.get(line.orderId) ?? null;
    if (at && (entry.lastUpdatedAt === null || at > (entry.lastUpdatedAt ?? ''))) {
      entry.lastUpdatedAt = at;
    }
  }

  return ledger;
}

export interface AlbumCard {
  productId: string;
  name: string;
  category: Category;
  /** 商品已停用：仍留在卡册里，排在末尾 */
  stopped: boolean;
  /** 本赛季该商品毛利（分，可为负） */
  grossFen: number;
  rarity: Rarity;
  /** 下一档品质门槛（分）；UR 为 null */
  nextFen: number | null;
}

export interface AlbumSeasonResult {
  season: SeasonRange;
  level: AlbumLevel;
  /** 未停用在前，同组按毛利降序 */
  cards: AlbumCard[];
  countedLines: number;
  skippedLines: number;
  /** 本赛季数据最近更新时间（ISO）；没有计入明细时为 null */
  lastUpdatedAt: string | null;
}

/** 单个赛季的卡册视图：每张商品卡都出卡，没有销售也显示 R */
export function computeSeasonAlbum(args: {
  season: SeasonRange;
  products: Product[];
  ledger: Map<number, SeasonLedgerEntry>;
}): AlbumSeasonResult {
  const { season, products, ledger } = args;
  const entry = ledger.get(season.startYear);
  const grossFen = entry?.grossFen ?? 0;

  const cards: AlbumCard[] = products.map((p) => {
    const gross = entry?.byProductFen.get(p.id) ?? 0;
    return {
      productId: p.id,
      name: p.name,
      category: p.category,
      stopped: p.archived,
      grossFen: gross,
      rarity: rarityForGross(gross),
      nextFen: nextRarityThresholdFen(gross)
    };
  });
  cards.sort((a, b) => {
    if (a.stopped !== b.stopped) return a.stopped ? 1 : -1;
    if (a.grossFen !== b.grossFen) return b.grossFen - a.grossFen;
    return a.name.localeCompare(b.name, 'zh');
  });

  return {
    season,
    level: albumLevelInfo(grossFen),
    cards,
    countedLines: entry?.countedLines ?? 0,
    skippedLines: entry?.skippedLines ?? 0,
    lastUpdatedAt: entry?.lastUpdatedAt ?? null
  };
}

export interface AlbumSeasonSummary {
  season: SeasonRange;
  grossFen: number;
  level: number;
  /** 该季达到 UR 的商品数 */
  urCount: number;
}

/** 往季归档：只列有有效销售的赛季，按开始年份倒序 */export function computeSeasonSummaries(args: {
  ledger: Map<number, SeasonLedgerEntry>;
  products: Product[];
}): AlbumSeasonSummary[] {
  const out: AlbumSeasonSummary[] = [];
  for (const [year, entry] of args.ledger) {
    if (entry.countedLines === 0 && entry.skippedLines === 0 && entry.byProductFen.size === 0) continue;
    let urCount = 0;
    for (const gross of entry.byProductFen.values()) {
      if (rarityForGross(gross) === 'UR') urCount += 1;
    }
    out.push({
      season: seasonRange(year),
      grossFen: entry.grossFen,
      level: albumLevelForGross(entry.grossFen),
      urCount
    });
  }
  return out.sort((a, b) => b.season.startYear - a.season.startYear);
}

export type AlbumSeasonStatus = 'active' | 'archived' | 'upcoming';

export interface AlbumDisplaySeason {
  season: SeasonRange;
  status: AlbumSeasonStatus;
}

/**
 * 卡册永远有内容可看，不拿「休赛期」拦人：
 * 1. 赛期内 → 当季；
 * 2. 赛季外 → 账本里最近一个赛季（已收官，卡面即最终结果）；
 * 3. 一个赛季都没有 → 下赛季预览（全 R，等开赛）。
 */
export function pickAlbumSeason(
  today: string,
  ledger: Map<number, SeasonLedgerEntry>
): AlbumDisplaySeason {
  const active = currentSeason(today);
  if (active) return { season: active, status: 'active' };

  let latest: number | null = null;
  for (const year of ledger.keys()) {
    if (latest === null || year > latest) latest = year;
  }
  if (latest !== null) return { season: seasonRange(latest), status: 'archived' };

  return { season: nextSeasonAfter(today), status: 'upcoming' };
}
