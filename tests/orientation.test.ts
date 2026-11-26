import { describe, expect, it } from 'vitest';
import { normalizeDeg, tiltDelta } from '../src/ui/album/orientation';

describe('角度归一', () => {
  it('把差值折回 (-180, 180]', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(190)).toBe(-170);
    expect(normalizeDeg(-190)).toBe(170);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-2)).toBe(-2);
  });
});

describe('相对基准的倾斜差', () => {
  it('姿态没变就没有倾斜', () => {
    const base = { beta: 70, gamma: 5 };
    expect(tiltDelta(base, { ...base })).toEqual({ x: 0, y: 0 });
  });

  it('向右滚 gamma 变大，横向为正', () => {
    const base = { beta: 70, gamma: 0 };
    expect(tiltDelta(base, { beta: 70, gamma: 12 }).x).toBeCloseTo(12, 5);
  });

  it('前倾 beta 变小，纵向为负', () => {
    const base = { beta: 70, gamma: 0 };
    expect(tiltDelta(base, { beta: 58, gamma: 0 }).y).toBeCloseTo(-12, 5);
  });

  it('beta 跨过 ±180 时差值仍然连续', () => {
    const base = { beta: 179, gamma: 0 };
    expect(tiltDelta(base, { beta: -179, gamma: 0 }).y).toBeCloseTo(2, 5);
  });

  it('平放和竖直握持都能给出差值，不依赖绝对姿态', () => {
    expect(tiltDelta({ beta: 0, gamma: 0 }, { beta: 0, gamma: 10 }).x).toBeCloseTo(10, 5);
    expect(tiltDelta({ beta: 90, gamma: 0 }, { beta: 90, gamma: 10 }).x).toBeCloseTo(10, 5);
  });
});
