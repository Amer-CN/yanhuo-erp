# 夫妻共享烟花卡册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有烟花进销存 PWA 里增加按春节赛季计算的共享卡册页、商品品质卡与 3D 详情交互。

**Architecture:** 卡册不落库：先对全库做一次 `fifoAllocate`，再按“场次开场日 → 赛季”归属订单，纯函数算出本赛季共享毛利、卡册等级与每张商品卡品质；往季归档也从同一份账本实时派生。UI 新增懒加载子页 `album`，详情卡用 Motion 做旋转惯性、用 `deviceorientation` 做跟手倾斜。

**Tech Stack:** React 18 + TypeScript + Vite、Dexie、现有 `src/db/calc.ts` 的 FIFO、Vitest（node 环境，纯函数测试）、Motion（`motion/react`）、原生 CSS 3D。

**Spec:** `docs/superpowers/specs/2026-11-26-shared-card-album-design.md`

## Global Constraints

- 金额一律用整数「分」；赛季、等级、品质阈值都在分上计算，展示时才 `fenToStr`。
- 不升 Dexie schema、不改 Supabase 表 / RLS、不新增 outbox kind 或同步设置项、不做 push / deploy / 生产 SQL。
- 测试环境是 node（`vitest.config.ts` 的 `environment: 'node'`），不要写依赖 DOM 的组件测试；纯逻辑必须抽成可测函数。
- 覆盖率门槛只作用于 `src/db/**`（lines 60 / functions 60 / branches 50），新增的 `src/db/season.ts`、`src/db/album.ts` 必须有充分测试。
- UI 文案用中文，沿用 `src/tokens.css` 令牌与 `src/ui/kit.tsx` 组件，不新增第二套设计语言。
- 卡册计算不得写入真实账本；本轮所有验证只读现有数据。
- 提交只包含本任务相关文件；工作区已有大量未跟踪文件，不要 `git add -A`。

## Review Focus

- **完全缺成本的明细**：整条排除，不能被当成 0 成本计入；否则漏记进货会被当成暴利。
- **赠品与 0 元行**：销售额 0、成本照算，卡册必须跟着冲减，而不是跳过。
- **订单缺少场次或场次已被替换**：回退到订单自身的 `createdAt`，不能抛错，也不能丢单。
- **赛季边界当天**：12-25 00:00 起算新赛季、元宵节 23:59:59 仍算当季；用本地日期字符串比较，不用毫秒差。
- **停用后的商品**：有销售记录的商品只会停用不会删除；卡册里仍要出现，排在末尾并标「已停售」。

---

### Task 1: 赛季日历

**Files:**
- Create: `src/db/season.ts`
- Test: `tests/season.test.ts`

**Interfaces:**
- Consumes: `src/db/util.ts` 的 `addDays(dateStr, days)`。
- Produces:
  - `CHINESE_NEW_YEAR: Readonly<Record<number, string>>`
  - `SEASON_START_DATE = '12-25'`、`FALLBACK_SEASON_END = '03-05'`
  - `interface SeasonRange { startYear: number; startDate: string; endDate: string; label: string; endDateEstimated: boolean }`
  - `seasonRange(startYear: number): SeasonRange`
  - `seasonForDate(dateLocal: string): SeasonRange | null`
  - `currentSeason(today?: string): SeasonRange | null`（默认 `localDate()`）
  - `nextSeasonAfter(dateLocal: string): SeasonRange`

- [ ] **Step 1: 写失败的测试**

`tests/season.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { CHINESE_NEW_YEAR, currentSeason, nextSeasonAfter, seasonForDate, seasonRange } from '../src/db/season';

describe('赛季区间', () => {
  it('从 12-25 开始，到次年元宵节结束', () => {
    const s = seasonRange(2026);
    expect(s.startDate).toBe('2026-12-25');
    expect(s.endDate).toBe('2027-02-20');
    expect(s.label).toBe('2026 赛季');
    expect(s.endDateEstimated).toBe(false);
  });

  it('表外年份回退到 3 月 5 日并标记待更新', () => {
    const s = seasonRange(2099);
    expect(s.endDate).toBe('2100-03-05');
    expect(s.endDateEstimated).toBe(true);
  });
});

describe('日期归属赛季', () => {
  it('圣诞节当天算新赛季', () => {
    expect(seasonForDate('2026-12-25')?.startYear).toBe(2026);
  });

  it('平安夜仍属休赛期', () => {
    expect(seasonForDate('2026-12-24')).toBeNull();
  });

  it('元宵节当天仍算当季，次日进入休赛期', () => {
    expect(seasonForDate('2027-02-20')?.startYear).toBe(2026);
    expect(seasonForDate('2027-02-21')).toBeNull();
  });

  it('跨年 2 月归上一年开赛的赛季', () => {
    expect(seasonForDate('2027-02-01')?.startYear).toBe(2026);
  });

  it('休赛期找下一个赛季', () => {
    expect(nextSeasonAfter('2026-11-26').startDate).toBe('2026-12-25');
  });

  it('currentSeason 在赛期内返回当季、休赛期返回 null', () => {
    expect(currentSeason('2027-01-10')?.startYear).toBe(2026);
    expect(currentSeason('2027-06-01')).toBeNull();
  });

  it('赛季内找下一个赛季是明年那一届', () => {
    expect(nextSeasonAfter('2027-01-10').startDate).toBe('2027-12-25');
  });
});

describe('春节表', () => {
  it('覆盖 2025–2040 且日期都落在一月或二月', () => {
    for (let y = 2025; y <= 2040; y++) {
      const d = CHINESE_NEW_YEAR[y];
      expect(d, `缺少 ${y}`).toBeTruthy();
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number(d.slice(5, 7))).toBeLessThanOrEqual(2);
    }
  });

  it('抽查已知春节日期', () => {
    expect(CHINESE_NEW_YEAR[2026]).toBe('2026-02-17');
    expect(CHINESE_NEW_YEAR[2027]).toBe('2027-02-06');
    expect(CHINESE_NEW_YEAR[2029]).toBe('2029-02-13');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/season.test.ts`
Expected: FAIL，`Failed to resolve import "../src/db/season"`。

- [ ] **Step 3: 实现 `src/db/season.ts`**

按下面的合同实现：

```ts
export const SEASON_START_DATE = '12-25';
export const FALLBACK_SEASON_END = '03-05';

/** 农历正月初一的公历日期；表外年份回退。2025–2037 已核对，2038–2040 待复核。 */
export const CHINESE_NEW_YEAR: Readonly<Record<number, string>> = { /* 见规格表 */ };

export interface SeasonRange { startYear: number; startDate: string; endDate: string; label: string; endDateEstimated: boolean }

export function seasonRange(startYear: number): SeasonRange;
export function seasonForDate(dateLocal: string): SeasonRange | null;
export function currentSeason(today?: string): SeasonRange | null;
export function nextSeasonAfter(dateLocal: string): SeasonRange;
```

实现要点（不要偏离）：

- `seasonRange(y)`：`startDate = \`${y}-12-25\``；查 `CHINESE_NEW_YEAR[y + 1]`，存在则 `endDate = addDays(cny, 14)`，否则 `endDate = \`${y + 1}-03-05\`` 且 `endDateEstimated = true`。
- `seasonForDate(date)`：取 `year = Number(date.slice(0, 4))`；`date >= \`${year}-12-25\`` → `seasonRange(year)`；否则若 `date <= seasonRange(year - 1).endDate` → `seasonRange(year - 1)`；都不满足返回 `null`（休赛期）。非法输入返回 `null`。
- `nextSeasonAfter(date)`：`date < \`${year}-12-25\`` 返回 `seasonRange(year)`，否则 `seasonRange(year + 1)`。
- 表内 16 个年份的日期必须与规格表逐字一致（2025-01-29 … 2040-02-12）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/season.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/db/season.ts tests/season.test.ts
git commit -m "feat(album): 春节赛季日历"
```

---

### Task 2: 赛季账本与卡册计算

**Files:**
- Create: `src/db/album.ts`
- Test: `tests/album.test.ts`

**Interfaces:**
- Consumes: `src/db/calc.ts` 的 `fifoAllocate` 与 `FifoResult`（`lineCost`、`uncoveredQtyByLine`）、`src/db/season.ts`、`src/db/util.ts` 的 `isoToLocalDate`。
- Produces:
  - `RARITY_ORDER = ['R', 'SR', 'SSR', 'UR'] as const`；`type Rarity`
  - `RARITY_THRESHOLDS_FEN: Record<Rarity, number>`（R 0 / SR 5000 / SSR 20000 / UR 50000）
  - `rarityForGross(grossFen: number): Rarity`
  - `nextRarityThresholdFen(grossFen: number): number | null`
  - `albumLevelForGross(grossFen: number): number`
  - `albumLevelInfo(grossFen: number): { level: number; grossFen: number; floorFen: number; nextFen: number; ratio: number }`
  - `interface SeasonLedgerEntry { grossFen: number; byProductFen: Map<string, number>; countedLines: number; skippedLines: number }`
  - `buildSeasonLedger(args: { orders: SalesOrder[]; lines: SaleLine[]; sessions: Session[]; fifo: FifoResult }): Map<number, SeasonLedgerEntry>`（key 为赛季开始年份）
  - `interface AlbumCard { productId: string; name: string; category: Category; stopped: boolean; grossFen: number; rarity: Rarity; nextFen: number | null }`
  - `interface AlbumSeasonResult { season: SeasonRange; level: ReturnType<typeof albumLevelInfo>; cards: AlbumCard[]; countedLines: number; skippedLines: number }`
  - `computeSeasonAlbum(args: { season: SeasonRange; products: Product[]; ledger: Map<number, SeasonLedgerEntry> }): AlbumSeasonResult`
  - `interface AlbumSeasonSummary { season: SeasonRange; grossFen: number; level: number; urCount: number }`
  - `computeSeasonSummaries(args: { ledger: Map<number, SeasonLedgerEntry>; products: Product[] }): AlbumSeasonSummary[]`（按 `startYear` 倒序）

- [ ] **Step 1: 写失败的测试**

`tests/album.test.ts`：用最小工厂函数造 `Batch / SalesOrder / SaleLine / Session / Product`，覆盖下面每一组断言。

```ts
import { describe, expect, it } from 'vitest';
import { fifoAllocate } from '../src/db/calc';
import {
  albumLevelForGross,
  albumLevelInfo,
  buildSeasonLedger,
  computeSeasonAlbum,
  computeSeasonSummaries,
  nextRarityThresholdFen,
  rarityForGross
} from '../src/db/album';
import { seasonRange } from '../src/db/season';
```

必须覆盖的用例（名称可微调，断言值不可改）：

1. 品质边界：`rarityForGross(4999) === 'R'`、`5000 === 'SR'`、`19999 === 'SSR'`、`20000 === 'SSR'`、`49999 === 'SSR'`、`50000 === 'UR'`；负数返回 `'R'`。
2. 下一档：`nextRarityThresholdFen(0) === 5000`、`(5000) === 20000`、`(50000) === null`。
3. 等级边界：`albumLevelForGross(249999) === 1`、`250000 === 2`、`749999 === 3`、`999999 === 4`、`1000000 === 5`、`1999999 === 5`、`2000000 === 6`、`3000000 === 7`。
4. 等级信息：`albumLevelInfo(260000)` 返回 `{ level: 2, floorFen: 250000, nextFen: 500000 }` 且 `ratio` 约等于 `0.04`；`albumLevelInfo(1000000)` 的 `nextFen` 为 `2000000`、`ratio` 为 `0`。
5. 赛季归属：用两笔销售分别落在 `2026-12-25` 与 `2027-02-20`，都进 `2026` 赛季；`2027-02-21` 的销售不进任何赛季。
6. 场次优先：订单 `createdAt` 在 3 月 1 日、所属场次 `startedAt` 在 2 月 10 日，必须归 `2026` 赛季。
7. 缺场次回退：`sessionId` 指向不存在的场次时按订单 `createdAt` 归属，不抛错。
8. 缺成本排除：只有一笔进货成本、两笔销售（第二笔无批次可扣）时，`skippedLines` 为 1，毛利只算第一笔。
9. 赠品冲减：赠品行 `amountFen = 0` 且成本完整时，`grossFen` 为负。
10. 作废排除：`voided: true` 的订单不进账本。
11. 卡册排序：停用商品排在末尾；同组按毛利降序。
12. 归档：两个赛季都有销售时 `computeSeasonSummaries` 返回两条且按年份倒序，`urCount` 正确。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/album.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/db/album.ts`**

实现要点：

- 常量全部用分：`250_000 / 500_000 / 750_000 / 1_000_000`，5 级之后每级 `1_000_000`。
- `albumLevelInfo` 先把毛利规整到 `p = Math.max(0, Math.round(grossFen))`，再算 `floor/next/ratio`；`ratio` 用 `Math.min(1, Math.max(0, (p - floor) / (next - floor)))`。
- `buildSeasonLedger`：
  1. 建 `sessionById`；`orderDate(order) = isoToLocalDate(sessionById.get(order.sessionId)?.startedAt ?? order.createdAt)`。
  2. 只处理 `!order.voided` 的订单，建立 `orderId → 赛季开始年份 | null`（`seasonForDate` 返回 `null` 时记 `null`；规则之后遇到 `null` 直接跳过，不记入 `skippedLines`）。
  3. 逐条明细：订单不在 map 里跳过；`const cost = fifo.lineCost.get(line.id)`，若 `cost === undefined` 或 `(fifo.uncoveredQtyByLine.get(line.id) ?? 0) > 0` → 该赛季 `skippedLines += 1` 并跳过；否则 `gross = line.amountFen - cost`，累加 `grossFen` 与 `byProductFen`。
  4. 赛季未出现时也建 entry（用于统计 skipped）。
- `computeSeasonAlbum`：从 `ledger.get(season.startYear)` 取数（没有则全 0）；为**每个商品**生成一张卡（`products` 里 `archived` 的排后面）；`nextFen` 用 `nextRarityThresholdFen(grossFen)`。
- `computeSeasonSummaries`：遍历 ledger 的 key，跳过没有有效订单的赛季（`countedLines + skippedLines === 0` 且 `byProductFen` 为空），`urCount` 为该季达到 UR 的商品数；按 `startYear` 降序。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/album.test.ts` 然后 `pnpm vitest run tests/calc.test.ts`
Expected: 两个文件都 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/db/album.ts tests/album.test.ts
git commit -m "feat(album): 赛季毛利账本与卡册等级计算"
```

---

### Task 3: 卡册页与入口

**Files:**
- Create: `src/ui/album/CategoryArt.tsx`（四类插画，纯 SVG，`currentColor` + 令牌变量）
- Create: `src/ui/album/AlbumCardTile.tsx`（网格卡）
- Create: `src/ui/pages/AlbumPage.tsx`
- Modify: `src/ui/AppShell.tsx`（`SubPage` 增加 `'album'`、`SUB_TITLE`、懒加载导入、`SUB_PAGES`、预取列表）
- Modify: `src/ui/MorePage.tsx`（新增入口行，`onOpen('album')`）
- Modify: `src/styles.css`（卡册样式）
- Test: 无新增单测（纯函数已在 Task 2 覆盖）；验证方式见步骤 4

**Interfaces:**
- Consumes: Task 1/2 的 `currentSeason`、`nextSeasonAfter`、`buildSeasonLedger`、`computeSeasonAlbum`、`computeSeasonSummaries`、`AlbumCard`；`useAppData()` 的 `data`、`fifo`。
- Produces:
  - `AlbumPage` props：`{ products: Product[]; orders: SalesOrder[]; lines: SaleLine[]; sessions: Session[]; fifo: FifoResult }`
  - `AlbumCardTile` props：`{ card: AlbumCard; onOpen: (productId: string) => void }`
  - `CategoryArt` props：`{ category: Category; className?: string }`

- [ ] **Step 1: 接入路由与入口**

- `AppShell.tsx`：`export type SubPage = 'products' | 'history' | 'album' | 'settings' | null;`
- `SUB_TITLE` 增加 `album: '我们的卡册'`。
- 顶部加 `const AlbumPage = lazy(() => import('./pages/AlbumPage'));`，并把它加进 `preloadOtherPages`。
- 新增适配组件：

```tsx
function AlbumSubPage() {
  const { data, fifo } = useAppData();
  return (
    <AlbumPage
      products={data.products}
      orders={data.orders}
      lines={data.lines}
      sessions={data.sessions}
      fifo={fifo}
    />
  );
}
```

- `SUB_PAGES` 类型改为 `Record<'products' | 'history' | 'album', ComponentType>` 并登记 `album: AlbumSubPage`；`SubPageView` 的取表条件同步加上 `'album'`。
- `MorePage.tsx`：在「销售记录」之后插入一行入口，标题「我们的卡册」，副标题固定写「按春节赛季收集商品卡」，`onOpen('album')`。

- [ ] **Step 2: 写卡册页**

`AlbumPage` 结构（自上而下）：

1. `const today = localDate();`
2. `const ledger = useMemo(() => buildSeasonLedger({ orders, lines, sessions, fifo }), [orders, lines, sessions, fifo]);`
3. 当前赛季：`const season = currentSeason(today)`；为空时用 `nextSeasonAfter(today)` 展示休赛期。
4. `const album = season ? computeSeasonAlbum({ season, products, ledger }) : null;`，用 `useMemo` 包住，依赖 `[season?.startYear, products, ledger]`。
5. `const archive = computeSeasonSummaries({ ledger, products }).filter((s) => s.season.startYear !== season?.startYear);`，同样用 `useMemo` 包住。
6. 渲染：
   - 赛季头卡：赛季名、`startDate → endDate`、本赛季毛利、等级、下一级差额与进度条；头卡按等级加 `.album--lv2` … `.album--lv5` 类，Lv.6 起复用 `.album--lv5` 并只显示等级数字与称号。
   - 休赛期提示卡：说明「休赛期销售不计入卡册」并给出下次开赛日期；**休赛期不渲染网格**，只保留下面的归档列表。
   - 筛选（仅赛期内渲染）：分类分段控件（全部 / 炮 / 烟花 / 儿童 / 组合）与品质分段控件（全部 / R / SR / SSR / UR），用现有 `glass-segmented`。
   - 网格（仅赛期内渲染）：`grid-template-columns: repeat(auto-fill, minmax(96px, 1fr))`，渲染 `AlbumCardTile`。
   - 空态：没有商品时用 `Empty` 提示去建商品。
   - 归档列表：始终渲染；`<ul className="glass-list">`，每行「2025 赛季 · Lv.3 · ¥1,240.00」。
7. 点击卡 → `setOpenId(productId)`；`AlbumCardDetail` 在 Task 4 接入，本任务先渲染一个占位 `Sheet`（标题=商品名、正文=当前品质与毛利、无 3D）。

`AlbumCardTile` 合同：

```tsx
<div className={`album-card album-card--${card.rarity.toLowerCase()}`}>
  <div className="album-card__frame">
    <CategoryArt category={card.category} className="album-card__art" />
    <span className="album-card__rarity">{card.rarity}</span>
  </div>
  <p className="album-card__name">{card.name}</p>
  <p className="album-card__gross">¥{fenToStr(card.grossFen)}</p>
  {card.stopped ? <span className="glass-badge">已停售</span> : null}
</div>
```

整张卡是一个 `<button type="button">`，`aria-label` 为 `${card.name}，${card.rarity} 卡，本赛季毛利 ¥${fenToStr(card.grossFen)}`。

- [ ] **Step 3: 写样式**

在 `src/styles.css` 追加（用令牌，不写裸色值）：
- `.album-grid`、`.album-card`、`.album-card__frame`、`.album-card__art`、`.album-card__name`、`.album-card__gross`。
- 四档品质只改边框/阴影/背景：`.album-card--r` 用 `--yh-border-medium`；`--sr` 用 `--yh-ink-ok`；`--ssr` 用 `--yh-ink-price`；`--ur` 用 `conic-gradient` 边框 + `--yh-ink-accent` 文字。
- 网格卡只做 CSS 轻倾斜，不加 JS：`.album-card:hover .album-card__frame { transform: rotateX(6deg) rotateY(-6deg); }`，并在 `@media (hover: none)` 下关闭。
- 触控目标高度 ≥ `--yh-touch-min`。
- 等级档只改头卡边框/角标：`.album--lv2` 微光、`.album--lv3` 银边、`.album--lv4` 金边、`.album--lv5` 赤金；不新增插画资源。

`CategoryArt`：四个 `<svg viewBox="0 0 48 48">`，`fill="none"`、`stroke="currentColor"`、`stroke-width="2"`，分别画鞭炮串、烟花放射、手持仙女棒、礼盒；无法识别分类时返回烟花。

- [ ] **Step 4: 验证**

Run: `pnpm build`
Expected: `tsc --noEmit` 与 `vite build` 都通过，无新增类型错误。

Run: `pnpm test`
Expected: 全部 PASS（含 Task 1/2 新增用例）。

手工验证（`pnpm dev`，`http://127.0.0.1:5173`）：
- 「更多 → 我们的卡册」能进入，顶部箭头能返回。
- 当前休赛期显示提示与下次开赛日期。
- 用示例数据造 1–2 笔销售后，卡册出现对应商品卡与毛利。
- 分类与品质筛选生效，空结果有说明。

- [ ] **Step 5: 提交**

```bash
git add src/ui/album/CategoryArt.tsx src/ui/album/AlbumCardTile.tsx src/ui/pages/AlbumPage.tsx src/ui/AppShell.tsx src/ui/MorePage.tsx src/styles.css
git commit -m "feat(album): 卡册页、网格与入口"
```

---

### Task 4: 卡片详情 3D、惯性旋转与陀螺仪

**Files:**
- Create: `src/ui/album/orientation.ts`（纯函数）
- Create: `src/ui/album/upgrade.ts`（纯函数）
- Test: `tests/orientation.test.ts`、`tests/album-upgrade.test.ts`
- Create: `src/ui/album/useDeviceTilt.ts`
- Create: `src/ui/album/AlbumCardDetail.tsx`
- Modify: `src/ui/album/AlbumCardTile.tsx`（新增 `flash?: boolean`）
- Modify: `src/ui/pages/AlbumPage.tsx`（详情组件替换占位 Sheet；升级高亮）
- Modify: `src/styles.css`（3D 卡样式、升级一次性动画）
- Modify: `package.json`（新增 `motion`）

**Interfaces:**
- Consumes: Task 2 的 `AlbumCard`、`Rarity`、Task 3 的 `CategoryArt`；`src/ui/kit.tsx` 的 `Sheet`、`Btn`。
- Produces:
  - `leanFromOrientation(beta: number, gamma: number): { x: number; y: number }`（单位：度）
  - `detectUpgradedIds(prev: Map<string, Rarity>, cards: AlbumCard[]): string[]`（只返回品质变高的商品 id）
  - `useDeviceTilt(options: { enabled: boolean; onLean: (lean: { x: number; y: number }) => void }): { supported: boolean; needsPermission: boolean; requestPermission: () => Promise<boolean>; active: boolean }`
  - `AlbumCardDetail` props：`{ card: AlbumCard; onClose: () => void }`

- [ ] **Step 1: 安装依赖**

Run: `pnpm add motion`
Expected: `package.json` 出现 `motion`，`pnpm-lock.yaml` 更新。若安装失败（网络或镜像不可达），停止并报告，不要手写一套惯性物理替代。

- [ ] **Step 2: 写失败的陀螺仪数学测试**

`tests/orientation.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { leanFromOrientation } from '../src/ui/album/orientation';

describe('重力向量推导倾斜', () => {
  it('竖直握持无倾斜', () => {
    const lean = leanFromOrientation(90, 0);
    expect(lean.x).toBeCloseTo(0, 5);
    expect(lean.y).toBeCloseTo(0, 5);
  });

  it('向右滚 10 度时 x 为正', () => {
    expect(leanFromOrientation(90, 10).x).toBeGreaterThan(0);
  });

  it('在竖直姿态附近轻微转动不会翻转方向', () => {
    const a = leanFromOrientation(89, 2).x;
    const b = leanFromOrientation(91, 2).x;
    expect(Math.sign(a)).toBe(Math.sign(b));
  });

  it('输出被限制在 ±90 度内', () => {
    for (const [beta, gamma] of [[0, 0], [180, 0], [90, 90], [45, -120]] as const) {
      const lean = leanFromOrientation(beta, gamma);
      expect(Math.abs(lean.x)).toBeLessThanOrEqual(90.0001);
      expect(Math.abs(lean.y)).toBeLessThanOrEqual(90.0001);
    }
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run tests/orientation.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现 `src/ui/album/orientation.ts`**

用重力向量而不是直接 `beta/gamma`：`x = asin(clamp(cos(beta) * sin(gamma)))`、`y = asin(clamp(-sin(beta)))`，beta/gamma 先转弧度，结果转回度。对 `cos*sin` 与 `-sin` 都做 `Math.max(-1, Math.min(1, v))` 夹取。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/orientation.test.ts`
Expected: PASS。

- [ ] **Step 6: 写失败的升级检测测试**

`tests/album-upgrade.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { detectUpgradedIds } from '../src/ui/album/upgrade';
import type { AlbumCard, Rarity } from '../src/db/album';

const card = (productId: string, rarity: Rarity): AlbumCard => ({
  productId,
  name: productId,
  category: '烟花',
  stopped: false,
  grossFen: 0,
  rarity,
  nextFen: null
});

describe('升级检测', () => {
  it('首次载入（没有旧快照）不返回任何升级', () => {
    expect(detectUpgradedIds(new Map(), [card('p1', 'UR')])).toEqual([]);
  });

  it('品质升高才算升级', () => {
    const prev = new Map<string, Rarity>([['p1', 'R'], ['p2', 'SSR']]);
    expect(detectUpgradedIds(prev, [card('p1', 'SR'), card('p2', 'SR')])).toEqual(['p1']);
  });

  it('新出现的商品不算升级', () => {
    const prev = new Map<string, Rarity>([['p1', 'R']]);
    expect(detectUpgradedIds(prev, [card('p1', 'R'), card('p2', 'UR')])).toEqual([]);
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `pnpm vitest run tests/album-upgrade.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 8: 实现 `src/ui/album/upgrade.ts`**

按 `RARITY_ORDER.indexOf(rarity)` 比较高低；`prev` 为空或该商品不在 `prev` 里都跳过；返回按 `cards` 顺序的商品 id 数组。

- [ ] **Step 9: 实现陀螺仪 hook**

`useDeviceTilt.ts` 合同：

- `supported`：`typeof window !== 'undefined' && 'DeviceOrientationEvent' in window`。
- `needsPermission`：`typeof DeviceOrientationEvent.requestPermission === 'function'`。
- 首次读数记为基准，之后 `smooth = prev + (lean - prev) * 0.12`，再按 ±30° 范围归一化后回调 `onLean({ x, y })`。
- `enabled === false` 时不挂监听；卸载时移除。
- `requestPermission()` 只在用户手势里调用，`granted` 返回 `true`，其余 `false` 且不抛错。

- [ ] **Step 10: 实现详情卡**

`AlbumCardDetail`：
- `const rotate = useMotionValue(0)`；拖动用 Pointer Events + `setPointerCapture`，位移映射为角度（横向 `1px ≈ 0.6°`）。
- 松手：`animate(rotate, rotate.get(), { type: 'inertia', velocity, power: 0.6, restDelta: 0.5, modifyTarget: (v) => Math.round(v / 180) * 180 })`，让惯性自然停在一张正面或反面。
- 点击（位移 < 3px）：`animate(rotate, Math.round(rotate.get() / 180 + 1) * 180, { type: 'spring', stiffness: 240, damping: 30 })` 翻到另一面。
- 卡片结构：外层 `perspective: 1200px`，内层 `transform-style: preserve-3d`，正反面 `backface-visibility: hidden`，背面 `rotateY(180deg)`；用 `style={{ rotateY: rotate }}`。
- 陀螺仪：`rotateX`/`rotateY` 各一条 spring motion value，仅在未拖动且 `enabled` 时更新；范围 ±8°。iOS 显示「开启体感倾斜」按钮。
- `prefers-reduced-motion: reduce` 时：不启动惯性（松手直接 `rotate.jump` 到最近面），不做持续流光。
- 详情内容：商品名、当前品质、本赛季毛利、下一档差额、分类插画；关闭按钮通过 `Sheet` 的 `onClose`。

- [ ] **Step 11: 写 3D 样式**

`src/styles.css` 追加 `.album-detail`、`.album-detail__stage`、`.album-detail__card`、`.album-detail__face`、`.album-detail__face--back`、`.album-detail__glare`、`.album-detail__sheen`。关键声明必须包含：

```css
.album-detail__stage { perspective: 1200px; }
.album-detail__card { transform-style: preserve-3d; touch-action: pan-y; }
.album-detail__face { backface-visibility: hidden; position: absolute; inset: 0; }
.album-detail__face--back { transform: rotateY(180deg); }
```

`touch-action: pan-y` 保证纵向滚动不被拖动劫持；`.album-detail__stage` 的祖先不要加 `overflow/filter/mask/mix-blend-mode`。

- [ ] **Step 12: 接入详情与升级高亮**

`AlbumPage`：
- 把 Task 3 的占位 `Sheet` 换成 `<AlbumCardDetail card={selected} onClose={() => setOpenId(null)} />`；`selected` 从当前 `album.cards` 里按 id 取。
- 升级高亮：`const prevRarities = useRef<Map<string, Rarity>>(new Map());`、`const [flashId, setFlashId] = useState<string | null>(null);`。用一个 `useEffect`（依赖 `album?.cards`）：
  1. `if (!album) return;`
  2. `const ids = detectUpgradedIds(prevRarities.current, album.cards);`
  3. `prevRarities.current = new Map(album.cards.map((c) => [c.productId, c.rarity]));`
  4. 若 `ids.length > 0` 且 `prevRarities` 初次为空则不触发（`detectUpgradedIds` 已保证），否则 `setFlashId(ids[0])` 并 `setTimeout(() => setFlashId(null), 1400)`（卸载时清理计时器）。
- `AlbumCardTile` 增加 `flash?: boolean`，命中时加 `album-card--flash` 类。

CSS：`.album-card--flash .album-card__frame { animation: album-flash 1.2s var(--yh-ease-out) once; }`，关键帧只做一次金色/彩虹外发光；`@media (prefers-reduced-motion: reduce) { .album-card--flash .album-card__frame { animation: none; } }`。

- [ ] **Step 13: 验证**

Run: `pnpm build` → 通过。
Run: `pnpm test` → 全部 PASS。

手工验证（真机或 DevTools 触摸模拟）：
- 横向拖动卡片能连续旋转，松手后惯性减速并停在正面或反面。
- 点击卡片翻到另一面。
- 手机开启体感后倾斜有轻微跟随；手指拖动时不抢方向。
- 关闭详情后再次打开，角度从正面开始。
- 系统开启「减弱动态效果」后无惯性、无持续流光。
- 首次打开卡册不播放升级高亮；停在卡册页时新增销售触发升级才闪一次。

- [ ] **Step 14: 提交**

```bash
git add package.json pnpm-lock.yaml src/ui/album/orientation.ts src/ui/album/upgrade.ts src/ui/album/useDeviceTilt.ts src/ui/album/AlbumCardDetail.tsx src/ui/album/AlbumCardTile.tsx src/ui/pages/AlbumPage.tsx src/styles.css tests/orientation.test.ts tests/album-upgrade.test.ts
git commit -m "feat(album): 卡片 3D 详情、惯性旋转、体感倾斜与升级高亮"
```
```

---

### Task 5: 收尾门禁与文档

**Files:**
- Modify: `docs/superpowers/specs/2026-11-26-shared-card-album-design.md`（仅在实现与本规格有偏差时同步）
- Modify: `docs/02-使用说明.md`（新增「我们的卡册」一节：赛季、等级、品质阈值、休赛期规则）
- Test: 全量门禁

- [ ] **Step 1: 更新使用说明**

在 `docs/02-使用说明.md` 增加一节，写清：入口位置、赛季起止、共享等级门槛、品质阈值、成本待补不计入、休赛期不计入。

- [ ] **Step 2: 跑全量门禁**

Run: `pnpm test`
Expected: 全部 PASS，无 skip 由本功能新增。

Run: `pnpm build`
Expected: 通过。

Run: `pnpm lint`
Expected: 无新增 error（仓库既有 warning 不计）。

- [ ] **Step 3: 检查规格一致性**

逐条对照规格的「验收 → 计算单测」清单，确认每个边界都有对应测试；不一致处改实现或同步规格，并在提交信息里说明。

- [ ] **Step 4: 提交**

```bash
git add docs/02-使用说明.md docs/superpowers/specs/2026-11-26-shared-card-album-design.md
git commit -m "docs(album): 卡册使用说明与规格同步"
```

---

## 完成后的人工验收（不做自动化）

- 两台手机、同一账本：A 开单后 B 联网同步能看到同一卡册数字。
- 作废一笔销售后，卡册毛利与等级回退。
- 目标真机（iPhone + Android）各试一次体感倾斜与拖动惯性。
- 不执行 push / deploy / 生产 SQL。
