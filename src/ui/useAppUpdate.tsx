import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const LATER_KEY = 'yh-update-later';

interface AppUpdate {
  needRefresh: boolean;
  later: boolean;
  checking: boolean;
  updating: boolean;
  checked: boolean;
  registration: ServiceWorkerRegistration | undefined;
  unavailable: string | null;
  error: string | null;
  dismiss: () => void;
  check: () => Promise<void>;
  update: () => Promise<void>;
}

const AppUpdateContext = createContext<AppUpdate | null>(null);

function readLater() {
  try {
    return sessionStorage.getItem(LATER_KEY) === '1';
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** 根节点唯一注册；设置页离开/返回、横幅隐藏均保留这份更新状态。 */
export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [error, setError] = useState<string | null>(null);
  const [later, setLater] = useState(readLater);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [checked, setChecked] = useState(false);
  const busy = useRef(false);
  const unavailable = import.meta.env.DEV
    ? '开发环境未启用应用更新，请在正式版本中检查。'
    : !('serviceWorker' in navigator)
      ? '当前环境不支持应用更新，请在支持离线应用的浏览器中打开正式版本。'
      : null;
  const initialController = useRef(unavailable ? null : navigator.serviceWorker.controller);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker
  } = useRegisterSW({
    onRegisteredSW(_url, value) {
      setRegistration(value);
    },
    onRegisterError(cause: unknown) {
      setError(`应用更新注册失败：${errorMessage(cause)}。联网后重新打开应用再试。`);
    }
  });

  const dismiss = () => {
    setLater(true);
    try {
      sessionStorage.setItem(LATER_KEY, '1');
    } catch {
      // 存储不可用时仍隐藏本次打开的横幅，不影响设置入口。
    }
  };

  const check = async () => {
    if (busy.current || unavailable || !registration) return;
    busy.current = true;
    setChecking(true);
    setError(null);
    setChecked(false);
    try {
      await registration.update();
      setChecked(true);
    } catch (cause) {
      setError(`检查更新失败：${errorMessage(cause)}。请确认联网后重试。`);
    } finally {
      busy.current = false;
      setChecking(false);
    }
  };

  const update = async () => {
    if (busy.current || unavailable) return;
    busy.current = true;
    setUpdating(true);
    setError(null);
    let cleanup = () => {};
    try {
      const waiting = registration?.waiting;
      if (!waiting) throw new Error('待更新版本尚未就绪，请检查更新后再试');
      // 消息发送成功不等于更新成功，等新 worker 接管后才结束等待。
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (navigator.serviceWorker.controller !== waiting) return;
          cleanup();
          // 插件只为注册时已有 controller 的页面自动重载；首次安装后在同页
          // 检查到更新时补这一条。两个分支都只在用户点击后触发。
          if (!initialController.current) window.location.reload();
          resolve();
        };
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error('新版本未能接管，请稍后重试'));
        }, 15000);
        cleanup = () => {
          window.clearTimeout(timeout);
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
        };
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        // 唯一发送 SKIP_WAITING 的路径，只响应用户点击。
        void updateServiceWorker(true).catch(reject);
      });
    } catch (cause) {
      setError(`更新失败：${errorMessage(cause)}。当前版本可继续使用。`);
    } finally {
      cleanup();
      busy.current = false;
      setUpdating(false);
    }
  };

  return (
    <AppUpdateContext.Provider
      value={{
        needRefresh,
        later,
        checking,
        updating,
        checked,
        registration,
        unavailable,
        error,
        dismiss,
        check,
        update
      }}
    >
      {children}
    </AppUpdateContext.Provider>
  );
}

export function useAppUpdate() {
  const value = useContext(AppUpdateContext);
  if (!value) throw new Error('useAppUpdate 需要 AppUpdateProvider');
  return value;
}
