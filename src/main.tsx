import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@jungherz-de/glasskit/glasskit.min.css';
import './tokens.css';
import './styles.css';
import './ui/record.css';
import App from './App';
import { ErrorBoundary, ShellErrorFallback } from './ui/ErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 外壳级错误边界：致命错误时不白屏，给「重新打开」 */}
    <ErrorBoundary fallback={<ShellErrorFallback />}>
      <App />
    </ErrorBoundary>
  </StrictMode>
);