// 春节赛季日历：每年 12-25 开赛，到次年元宵节（正月初一 + 14 天）收季。
// 只放一张春节日期表，不引入农历库；表外年份回退到 3-5 并标记待更新。

import { addDays, localDate } from './util';

export const SEASON_START_DATE = '12-25';
export const FALLBACK_SEASON_END = '03-05';

/**
 * 农历正月初一的公历日期。
 *
 * 2025–2037 在设计与实现阶段已核对；2038–2040 尚未二次复核。
 * 表外年份不猜日期，直接走 `FALLBACK_SEASON_END`，界面会提示「结束日待更新」。
 */
export const CHINESE_NEW_YEAR: Readonly<Record<number, string>> = {
  2025: '2025-01-29',
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
  2029: '2029-02-13',
  2030: '2030-02-03',
  2031: '2031-01-23',
  2032: '2032-02-11',
  2033: '2033-01-31',
  2034: '2034-02-19',
  2035: '2035-02-08',
  2036: '2036-01-28',
  2037: '2037-02-15',
  2038: '2038-02-04',
  2039: '2039-01-24',
  2040: '2040-02-12'
};

export interface SeasonRange {
  /** 赛季开始年份，也是赛季名里的年份 */
  startYear: number;
  /** 本地日期 YYYY-MM-DD，含 */
  startDate: string;
  /** 本地日期 YYYY-MM-DD，含 */
  endDate: string;
  /** 界面展示名，如「2026 赛季」 */
  label: string;
  /** 结束日是否来自表外兜底 */
  endDateEstimated: boolean;
}

/**
 * 某个开始年份的赛季区间。
 *
 * 结束日取「开始年份 + 1」那一年元宵节：2026 赛季 = 2026-12-25 → 2027 元宵节。
 */
export function seasonRange(startYear: number): SeasonRange {
  const startDate = `${startYear}-${SEASON_START_DATE}`;
  const cny = CHINESE_NEW_YEAR[startYear + 1];
  const endDate = cny ? addDays(cny, 14) : `${startYear + 1}-${FALLBACK_SEASON_END}`;
  return {
    startYear,
    startDate,
    endDate,
    label: `${startYear} 赛季`,
    endDateEstimated: !cny
  };
}

/**
 * 本地日期属于哪个赛季；休赛期返回 null。
 *
 * 用本地日期字符串直接比较，不拿毫秒差算：跨时区、跨夏令时都不会把边界那天算错。
 */
export function seasonForDate(dateLocal: string): SeasonRange | null {
  const year = Number(dateLocal.slice(0, 4));
  if (!Number.isInteger(year) || year < 1970) return null;
  if (dateLocal >= `${year}-${SEASON_START_DATE}`) return seasonRange(year);
  if (dateLocal <= seasonRange(year - 1).endDate) return seasonRange(year - 1);
  return null;
}

/** 今天（或给定日期）所在赛季；休赛期返回 null。 */
export function currentSeason(today: string = localDate()): SeasonRange | null {
  return seasonForDate(today);
}

/** 给定日期之后（含当天仍处休赛期的情形）最近一个即将或正在进行的赛季。 */
export function nextSeasonAfter(dateLocal: string): SeasonRange {
  const year = Number(dateLocal.slice(0, 4));
  if (!Number.isInteger(year)) return seasonRange(new Date().getFullYear());
  return seasonRange(dateLocal < `${year}-${SEASON_START_DATE}` ? year : year + 1);
}
