import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@jungherz-de/glasskit/glasskit.min.css';
import './tokens.css';
import './styles.css';
import './ui/record.css';
import App from './App';
import { ErrorBoundary, ShellErrorFallback } from './ui/ErrorBoundary';
import { AppUpdateProvider } from './ui/useAppUpdate';

createRoot(document.getElementById('root')!).render(
  // 注册 hook 的初始化会注册 SW，放在 StrictMode 外避免开发期重复初始化。
  <AppUpdateProvider>
    <StrictMode>
      {/* 外壳级错误边界：致命错误时不白屏，给「重新打开」 */}
      <ErrorBoundary fallback={<ShellErrorFallback />}>
        <App />
      </ErrorBoundary>
    </StrictMode>
  </AppUpdateProvider>
);
