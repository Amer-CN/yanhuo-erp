import { useCallback, useEffect, useRef, useState } from 'react';
import { tiltDelta, type Orientation } from './orientation';

/** 低通权重：越小越稳、越跟手越差 */
const SMOOTHING = 0.18;
/** 相对倾斜多少度算「倾到底」 */
const RANGE_DEG = 25;

const clampUnit = (v: number): number => Math.max(-1, Math.min(1, v));

interface OrientationEventCtor {
  requestPermission?: () => Promise<string>;
}

/**
 * 手机姿态 → 归一化倾斜（-1..1）。
 *
 * 关键约定：**基准只在第一次拿到读数时取一次**，之后不再重置。
 * 早期版本每次重新启用监听都重取基准，结果手指一碰卡片、卡片就悄悄回正，
 * 看起来像体感和手势在打架。现在监听从挂载起就常驻，基准固定。
 */
export function useDeviceTilt({
  onLean
}: {
  onLean: (lean: { x: number; y: number }) => void;
}): {
  supported: boolean;
  needsPermission: boolean;
  requestPermission: () => Promise<boolean>;
  active: boolean;
} {
  const supported = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  const ctor = supported
    ? (window.DeviceOrientationEvent as unknown as OrientationEventCtor)
    : undefined;
  const needsPermission = typeof ctor?.requestPermission === 'function';

  const [permitted, setPermitted] = useState(!needsPermission);
  const [active, setActive] = useState(false);
  const callback = useRef(onLean);
  callback.current = onLean;
  const activeRef = useRef(false);
  const baseRef = useRef<Orientation | null>(null);
  const smoothRef = useRef<{ x: number; y: number } | null>(null);

  const requestPermission = useCallback(async () => {
    if (!needsPermission) return false;
    try {
      const state = await ctor!.requestPermission!();
      const ok = state === 'granted';
      setPermitted(ok);
      return ok;
    } catch {
      // 非安全来源（http://192.168.x.x）会直接 reject；当作没授权
      return false;
    }
  }, [ctor, needsPermission]);

  useEffect(() => {
    if (!supported || !permitted) return;

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      const current: Orientation = { beta: e.beta, gamma: e.gamma };
      // 基准只取一次：用户在什么姿势下打开卡片就以那个姿势为「平」
      if (!baseRef.current) baseRef.current = current;
      const delta = tiltDelta(baseRef.current, current);
      const prev = smoothRef.current;
      const smooth = prev
        ? { x: prev.x + (delta.x - prev.x) * SMOOTHING, y: prev.y + (delta.y - prev.y) * SMOOTHING }
        : delta;
      smoothRef.current = smooth;
      callback.current({
        x: clampUnit(smooth.x / RANGE_DEG),
        y: clampUnit(smooth.y / RANGE_DEG)
      });
      if (!activeRef.current) {
        activeRef.current = true;
        setActive(true);
      }
    };

    window.addEventListener('deviceorientation', onOrient);
    return () => window.removeEventListener('deviceorientation', onOrient);
  }, [supported, permitted]);

  return { supported, needsPermission, requestPermission, active };
}
