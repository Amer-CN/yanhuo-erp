import { useCallback, useEffect, useRef, useState } from 'react';
import { leanFromOrientation, type Lean } from './orientation';

/** 低通权重：越小越稳、越跟手越差 */
const SMOOTHING = 0.12;
/** 把 ±RANGE_DEG 的倾斜归一化到 ±1 */
const RANGE_DEG = 30;

const clampUnit = (v: number): number => Math.max(-1, Math.min(1, v));

interface OrientationEventCtor {
  requestPermission?: () => Promise<string>;
}

/**
 * 手机姿态 → 归一化倾斜（-1..1）。
 *
 * - 首次读数记作基准，回调的是**变化量**；竖直握持时 y 的绝对值约 -90°，不能直接用。
 * - iOS 13+ 的 `DeviceOrientationEvent.requestPermission()` 必须由用户手势触发，
 *   所以只暴露 `requestPermission()` 给按钮调用，组件挂载时不偷偷申请。
 * - `enabled=false`（例如正在手指拖动）时移除监听；重新启用会重新取基准，不会跳变。
 */
export function useDeviceTilt({
  enabled,
  onLean
}: {
  enabled: boolean;
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
    if (!supported || !enabled || !permitted) return;
    let base: Lean | null = null;
    let smooth: Lean | null = null;

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      const lean = leanFromOrientation(e.beta, e.gamma);
      if (!base) base = lean;
      smooth = smooth
        ? {
            x: smooth.x + (lean.x - smooth.x) * SMOOTHING,
            y: smooth.y + (lean.y - smooth.y) * SMOOTHING
          }
        : lean;
      callback.current({
        x: clampUnit((smooth.x - base.x) / RANGE_DEG),
        y: clampUnit((smooth.y - base.y) / RANGE_DEG)
      });
      if (!activeRef.current) {
        activeRef.current = true;
        setActive(true);
      }
    };

    window.addEventListener('deviceorientation', onOrient);
    return () => window.removeEventListener('deviceorientation', onOrient);
  }, [supported, enabled, permitted]);

  return { supported, needsPermission, requestPermission, active };
}
