import { useCallback, useEffect, useState } from 'react';

interface OrientationEventCtor {
  requestPermission?: () => Promise<string>;
}

/**
 * 只管体感权限，不管读数：读数交给 react-parallax-tilt。
 * iOS 只允许在用户手势里申请，所以第一次摸卡片时调用 requestPermission。
 */
export function useGyroPermission(): {
  supported: boolean;
  needsPermission: boolean;
  requestPermission: () => Promise<boolean>;
  granted: boolean;
} {
  const supported = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  const ctor = supported
    ? (window.DeviceOrientationEvent as unknown as OrientationEventCtor)
    : undefined;
  const needsPermission = typeof ctor?.requestPermission === 'function';
  const [granted, setGranted] = useState(!needsPermission);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!needsPermission) setGranted(true);
  }, [needsPermission]);

  const requestPermission = useCallback(async () => {
    if (!needsPermission || !ctor) return false;
    try {
      const state = await ctor.requestPermission!();
      const ok = state === 'granted';
      setGranted(ok);
      return ok;
    } catch {
      return false;
    }
  }, [ctor, needsPermission]);

  return { supported, needsPermission, requestPermission, granted };
}
