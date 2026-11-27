import { useCallback, useEffect, useRef, useState } from 'react';
import { deadZone, tiltDelta, type Orientation } from './orientation';

/** 低通权重：越小越稳；配合死区，手抖基本不动 */
const SMOOTHING = 0.1;
/** 相对倾斜多少度算「倾到底」 */
const RANGE_DEG = 28;
/** 打开卡片后先等手拿稳，再取基准，避免一开卡就自己歪 */
const SETTLE_MS = 220;

const clampUnit = (v: number): number => Math.max(-1, Math.min(1, v));

interface OrientationEventCtor {
  requestPermission?: () => Promise<string>;
}

/**
 * 手机姿态 → 归一化倾斜（-1..1）。
 *
 * 体感微动的处理：
 * - 打开卡片后先等 220ms 再取基准（刚抬手时读数最不稳）；
 * - 基准取该时刻的读数，之后整张卡不再重取；
 * - 归一化后过一道死区（约 1.8°）再做低通，手抖不会让卡片跟着抖。
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
    let base: Orientation | null = null;
    let settleAt = 0;
    let smooth: { x: number; y: number } = { x: 0, y: 0 };

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      const current: Orientation = { beta: e.beta, gamma: e.gamma };

      if (!base) {
        if (!settleAt) settleAt = performance.now();
        if (performance.now() - settleAt < SETTLE_MS) return;
        base = current;
        return;
      }

      const delta = tiltDelta(base, current);
      const target = {
        x: deadZone(clampUnit(delta.x / RANGE_DEG)),
        y: deadZone(clampUnit(delta.y / RANGE_DEG))
      };
      smooth = {
        x: smooth.x + (target.x - smooth.x) * SMOOTHING,
        y: smooth.y + (target.y - smooth.y) * SMOOTHING
      };
      callback.current({ x: smooth.x, y: smooth.y });
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
