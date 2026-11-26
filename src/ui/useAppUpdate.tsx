import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const LATER_KEY = 'yh-update-later';
/** 等新 worker 装好的上限：刚部署完 sw.js 可能要几秒 */
const INSTALL_WAIT_MS = 8000;
/** 点了更新后等页面接管的兜底：超时提示手动重开，不把按钮永远卡在「更新中」 */
const RELOAD_WAIT_MS = 12000;

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
  /** 检查并更新：一次点击走完「查→装→接管→重载」 */
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

/**
 * 浏览器会用 HTTP 缓存拿 sw.js（GitHub Pages 上是 max-age=600）。
 * 刚部署完就点检查，很容易拿到旧文件而判定「没有更新」，所以先用
 * `cache: 'reload'` 把 sw.js 拉一份新的进缓存，再让 registration.update() 去比。
 */
async function refreshServiceWorkerScript(reg: ServiceWorkerRegistration) {
  const url = reg.active?.scriptURL ?? new URL('sw.js', window.location.href).href;
  try {
    await fetch(url, { cache: 'reload' });
  } catch {
    // 离线时照常走 registration.update()，失败由它报错
  }
}

/** 等 installing 变成 installed；已经过了安装阶段就直接看 waiting */
function waitForInstalled(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (reg.waiting) return Promise.resolve(reg.waiting);
  const installing = reg.installing;
  if (!installing) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(reg.waiting ?? null);
    }, INSTALL_WAIT_MS);
    const onChange = () => {
      if (installing.state === 'installed') {
        cleanup();
        resolve(installing);
      } else if (installing.state === 'redundant') {
        cleanup();
        resolve(null);
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      installing.removeEventListener('statechange', onChange);
    };
    installing.addEventListener('statechange', onChange);
  });
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

  const update = async () => {
    if (busy.current || unavailable) return;
    busy.current = true;
    setChecking(true);
    setUpdating(true);
    setError(null);
    setChecked(false);

    // 兜底计时器：新 worker 没接管时别让按钮永远转圈
    let settled = false;
    /** 已经交给插件去激活新版本：等它重载，失败由 giveUp 兜底 */
    let awaitingReload = false;
    const giveUp = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      busy.current = false;
      setChecking(false);
      setUpdating(false);
      setError('新版本已下载但还没接管页面：请完全关闭应用后重新打开。');
    }, RELOAD_WAIT_MS);

    try {
      const reg =
        registration ??
        (await navigator.serviceWorker.getRegistration()) ??
        undefined;
      if (!reg) throw new Error('应用更新尚未就绪，请关闭后重新打开应用再试');

      await refreshServiceWorkerScript(reg);
      await reg.update();

      const waiting = await waitForInstalled(reg);
      if (!waiting) {
        // 没有待装版本：这次就是最新，按钮回到可点状态
        settled = true;
        window.clearTimeout(giveUp);
        busy.current = false;
        setChecking(false);
        setUpdating(false);
        setChecked(true);
        return;
      }

      // 插件负责发 SKIP_WAITING；它自己依赖 workbox 的 controlling 事件重载，
      // 实测在「先 update 再激活」的路径上不一定触发。所以发完消息后等一小段：
      // 插件重载了页面就已经卸载，这段代码根本不会执行；没重载才由我们兜底重载。
      await updateServiceWorker(true);
      awaitingReload = true;
      // 插件的 reload 与我们的兜底不能同时发生：一旦页面开始卸载就不要再 reload 第二次
      let unloading = false;
      const markUnloading = () => {
        unloading = true;
      };
      window.addEventListener('beforeunload', markUnloading);
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 800);
      });
      window.removeEventListener('beforeunload', markUnloading);
      if (!unloading) window.location.reload();
    } catch (cause) {
      if (!settled) {
        settled = true;
        window.clearTimeout(giveUp);
        busy.current = false;
        setChecking(false);
        setUpdating(false);
        setError(`更新失败：${errorMessage(cause)}。当前版本可继续使用。`);
      }
    } finally {
      if (!settled && !awaitingReload) {
        busy.current = false;
        setChecking(false);
        setUpdating(false);
      }
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
