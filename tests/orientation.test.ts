import { describe, expect, it } from 'vitest';
import { leanFromOrientation } from '../src/ui/album/orientation';

/**
 * 公式给出的是「重力方向在屏幕上的分量」，竖直握持时 y 约为 -90°。
 * 因此所有断言都看**相对首次读数的变化量**，绝对值为 0 不是期望行为。
 */
describe('重力向量推导倾斜', () => {
  it('同一姿态相对基准没有变化', () => {
    const base = leanFromOrientation(90, 0);
    const same = leanFromOrientation(90, 0);
    expect(same.x - base.x).toBeCloseTo(0, 5);
    expect(same.y - base.y).toBeCloseTo(0, 5);
  });

  it('向右滚 10 度时 x 相对基准为正', () => {
    // 取 60° 握持角：竖直（90°）时在平面内滚动不改变重力投影，x 恒为 0
    const base = leanFromOrientation(60, 0);
    expect(leanFromOrientation(60, 10).x - base.x).toBeGreaterThan(0);
  });

  it('前倾 10 度让 y 相对基准变化约 10 度', () => {
    const base = leanFromOrientation(90, 0);
    const delta = Math.abs(leanFromOrientation(80, 0).y - base.y);
    expect(delta).toBeGreaterThan(5);
    expect(delta).toBeLessThan(15);
  });

  it('竖直姿态附近连续，不会突然翻向', () => {
    const a = leanFromOrientation(88, 2).x;
    const b = leanFromOrientation(90, 2).x;
    const c = leanFromOrientation(92, 2).x;
    expect(Math.abs(a - b)).toBeLessThan(1);
    expect(Math.abs(b - c)).toBeLessThan(1);
  });

  it('输出被限制在 ±90 度内', () => {
    for (const [beta, gamma] of [
      [0, 0],
      [180, 0],
      [90, 90],
      [45, -120]
    ] as const) {
      const lean = leanFromOrientation(beta, gamma);
      expect(Math.abs(lean.x)).toBeLessThanOrEqual(90.0001);
      expect(Math.abs(lean.y)).toBeLessThanOrEqual(90.0001);
    }
  });
});
