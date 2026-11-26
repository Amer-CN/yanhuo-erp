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
 * - 基准取监听开始后的第一次读数，回调的是**变化量**，任何握持姿势都一致。
 * - iOS 13+ 的 `DeviceOrientationEvent.requestPermission()` 必须由用户手势触发，
 *   浏览器不允许自动申请；调用方应在第一次触摸卡片时调用 `requestPermission()`。
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
    let base: Orientation | null = null;
    let smooth: { x: number; y: number } | null = null;

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      const current: Orientation = { beta: e.beta, gamma: e.gamma };
      if (!base) base = current;
      const delta = tiltDelta(base, current);
      smooth = smooth
        ? {
            x: smooth.x + (delta.x - smooth.x) * SMOOTHING,
            y: smooth.y + (delta.y - smooth.y) * SMOOTHING
          }
        : delta;
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
  }, [supported, enabled, permitted]);

  return { supported, needsPermission, requestPermission, active };
}
