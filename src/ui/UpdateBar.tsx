import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw } from 'lucide-react';
import { Btn } from './kit';

const LATER_KEY = 'yh-update-later';

/**
 * 新版本提示条：只提示，不自动刷新。
 * 摊位正在开单时点「稍后」，本次会话不再打扰；收摊后可从设置页重新加载。
 */
export default function UpdateBar() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker
  } = useRegisterSW();
  const [later, setLater] = useState(() => {
    try {
      return sessionStorage.getItem(LATER_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (!needRefresh || later) return null;

  const dismiss = () => {
    setLater(true);
    try {
      sessionStorage.setItem(LATER_KEY, '1');
    } catch {
      /* 隐私模式忽略 */
    }
  };

  return (
    <div
      className="glass-nav"
      role="status"
      style={{
        width: '100%',
        maxWidth: 'var(--yh-page-max)',
        margin: '0 auto',
        gap: 10,
        padding: '6px var(--yh-page-pad)',
        background: 'color-mix(in srgb, var(--yh-canvas) 88%, transparent)',
        borderBottom: '1px solid var(--yh-border-subtle)',
        backdropFilter: 'blur(var(--gl-blur-light))',
        WebkitBackdropFilter: 'blur(var(--gl-blur-light))',
        fontSize: 'var(--yh-text-sm)'
      }}
    >
      <span className="icon-text">
        <RefreshCw size={16} aria-hidden="true" /> 有新版本，收摊后再更新
      </span>
      <div className="row" style={{ gap: 8, flex: '0 0 auto' }}>
        <Btn block={false} size="sm" variant="secondary" onClick={dismiss}>
          稍后
        </Btn>
        <Btn block={false} size="sm" onClick={() => void updateServiceWorker(true)}>
          更新
        </Btn>
      </div>
    </div>
  );
}