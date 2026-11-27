// 取自 react-holo-card v0.3.7 的 useHoloTilt（MIT）。
// Copyright (c) Allen Labrague — https://github.com/codeweb-dev/holo-card
// 原文件：src/useHoloTilt.ts（未修改算法，仅补 TypeScript 类型与注释）。
//
// 与 react-parallax-tilt 的分工：指针倾斜交给 Tilt；这里只负责陀螺仪——
// 用重力向量推导「手机往哪边倾」，低通平滑，首次读数作中性基准，iOS 首次点击申请权限。
// 传感器接管时调用方应把 Tilt 的 tiltEnable 关掉，避免手指与陀螺仪抢同一张卡。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** 设备俯仰多少度扫完整张卡 */
const GYRO_RANGE_DEG = 28;
/** 左右滚动的范围（同样角度下滚动对朝向影响更小，所以收紧） */
const GYRO_ROLL_RANGE_DEG = 14;
/** 每个传感器读数的低通权重 */
const GYRO_SMOOTHING = 0.12;
const DEG = Math.PI / 180;

/** 手机往哪边倾（度）：x = 右边缘下沉，y = 上边缘下沉 */
export function leanFromOrientation(beta: number, gamma: number) {
  const b = beta * DEG;
  const g = gamma * DEG;
  return {
    x: Math.asin(clamp(Math.cos(b) * Math.sin(g), -1, 1)) / DEG,
    y: Math.asin(clamp(-Math.sin(b), -1, 1)) / DEG
  };
}

/** 只有 iOS 13+ 需要用户手势授权 */
const needsPermission = () =>
  typeof window !== 'undefined' &&
  typeof (window as unknown as { DeviceOrientationEvent?: { requestPermission?: unknown } })
    .DeviceOrientationEvent?.requestPermission === 'function';

export function useHoloTilt(maxTiltDeg = 30, gyro = true) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const frame = useRef<number | null>(null);
  const pointing = useRef(false);
  const [permitted, setPermitted] = useState(false);
  const [gyroLive, setGyroLive] = useState(false);

  const write = useCallback(
    (px: number, py: number, tilt: boolean) => {
      const el = elRef.current;
      if (!el) return;
      const rx = tilt ? (0.5 - py) * maxTiltDeg : 0;
      const ry = tilt ? (px - 0.5) * maxTiltDeg : 0;
      const dx = (px - 0.5) * 2;
      const dy = (py - 0.5) * 2;
      const distance = clamp(Math.sqrt(dx * dx + dy * dy), 0, 1);
      const style = el.style;
      style.setProperty('--rx', `${rx.toFixed(2)}deg`);
      style.setProperty('--ry', `${ry.toFixed(2)}deg`);
      style.setProperty('--mx', `${(px * 100).toFixed(2)}%`);
      style.setProperty('--my', `${(py * 100).toFixed(2)}%`);
      style.setProperty('--distance', distance.toFixed(3));
      el.setAttribute('data-holo-active', 'true');
    },
    [maxTiltDeg]
  );

  const schedule = useCallback(
    (px: number, py: number, tilt: boolean) => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => write(px, py, tilt));
    },
    [write]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const el = elRef.current;
      if (!el) return;
      if (gyroLive && e.pointerType !== 'mouse') return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      pointing.current = true;
      schedule(
        clamp((e.clientX - rect.left) / rect.width, 0, 1),
        clamp((e.clientY - rect.top) / rect.height, 0, 1),
        false
      );
    },
    [schedule, gyroLive]
  );

  const onPointerLeave = useCallback(() => {
    pointing.current = false;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const el = elRef.current;
    if (!el) return;
    const style = el.style;
    style.setProperty('--rx', '0deg');
    style.setProperty('--ry', '0deg');
    style.setProperty('--mx', '50%');
    style.setProperty('--my', '50%');
    style.setProperty('--distance', '0');
    el.removeAttribute('data-holo-active');
  }, []);

  useEffect(() => {
    if (!gyro || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
    if (needsPermission() && !permitted) return;

    let base: { x: number; y: number } | null = null;
    let smooth: { x: number; y: number } | null = null;

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      setGyroLive(true);
      if (pointing.current) return;
      const lean = leanFromOrientation(e.beta, e.gamma);
      if (!base) base = lean;
      smooth = smooth
        ? {
            x: smooth.x + (lean.x - smooth.x) * GYRO_SMOOTHING,
            y: smooth.y + (lean.y - smooth.y) * GYRO_SMOOTHING
          }
        : lean;

      schedule(
        0.5 + clamp((smooth.x - base.x) / (GYRO_ROLL_RANGE_DEG * 2), -0.5, 0.5),
        0.5 + clamp((smooth.y - base.y) / (GYRO_RANGE_DEG * 2), -0.5, 0.5),
        true
      );
    };

    window.addEventListener('deviceorientation', onOrient);
    return () => {
      setGyroLive(false);
      window.removeEventListener('deviceorientation', onOrient);
    };
  }, [gyro, permitted, schedule]);

  /** iOS 13+ 只在对应用户手势里发放方向数据 */
  const requestGyro = useCallback(() => {
    if (!gyro || permitted || !needsPermission()) return;
    const ctor = (
      window as unknown as { DeviceOrientationEvent: { requestPermission: () => Promise<string> } }
    ).DeviceOrientationEvent;
    ctor
      .requestPermission()
      .then((state: string) => setPermitted(state === 'granted'))
      .catch(() => {
        // 非安全来源（http://192.168.x.x）会 reject；当作没授权
      });
  }, [gyro, permitted]);

  return { elRef, onPointerMove, onPointerLeave, requestGyro, gyroLive };
}
