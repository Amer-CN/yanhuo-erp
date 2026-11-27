import { describe, expect, it } from 'vitest';
import { deadZone, normalizeDeg, tiltAngles, tiltDelta } from '../src/ui/album/orientation';

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

describe('体感映射到卡面角度', () => {
  it('左右倾斜只做横滚，前后倾斜只做俯仰', () => {
    expect(tiltAngles({ x: 1, y: 0 })).toEqual({ x: 0, z: 12 });
    expect(tiltAngles({ x: 0, y: 1 })).toEqual({ x: -12, z: 0 });
  });

  it('中间值按比例收窄', () => {
    expect(tiltAngles({ x: 0.5, y: -0.5 })).toEqual({ x: 6, z: 6 });
  });
});

describe('体感微动死区', () => {
  it('小于死区的抖动直接归零', () => {
    expect(deadZone(0.03)).toBe(0);
    expect(deadZone(-0.05)).toBe(0);
  });

  it('死区外按剩余量程线性放大', () => {
    expect(deadZone(0.06)).toBeCloseTo(0, 5);
    expect(deadZone(0.53)).toBeCloseTo(0.5, 5);
    expect(deadZone(-0.53)).toBeCloseTo(-0.5, 5);
  });

  it('满量程与负满量程仍为 ±1', () => {
    expect(deadZone(1)).toBeCloseTo(1, 5);
    expect(deadZone(-1)).toBeCloseTo(-1, 5);
  });
});
