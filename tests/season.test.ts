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

  it('赛季内找下一个赛季是明年那一届', () => {
    expect(nextSeasonAfter('2027-01-10').startDate).toBe('2027-12-25');
  });

  it('currentSeason 在赛期内返回当季、休赛期返回 null', () => {
    expect(currentSeason('2027-01-10')?.startYear).toBe(2026);
    expect(currentSeason('2027-06-01')).toBeNull();
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
