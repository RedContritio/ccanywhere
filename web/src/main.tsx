import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { ErrorBoundary } from './components/error-boundary.js';
import { recordOp } from './state/ops-log.js';
import './styles/reset.css';
import './styles/themes.css';
import './styles/app.css';

// Capture any uncaught error / unhandled promise rejection into ops-log so
// the next feedback submission carries the trace. Mobile users can't open
// devtools easily — this is the primary observability path.
window.addEventListener('error', (e) => {
  recordOp('window.error', {
    message: String(e.message ?? ''),
    source: e.filename ?? null,
    lineno: e.lineno ?? null,
    colno: e.colno ?? null,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  let reason: string;
  try {
    reason = String(e.reason);
  } catch {
    reason = '<unstringifiable>';
  }
  recordOp('window.unhandledrejection', { reason: reason.slice(0, 1000) });
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('root element not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
