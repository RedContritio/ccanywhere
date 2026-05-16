import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app.js';
import { ErrorBoundary } from './components/error-boundary.js';
import { recordOp } from './state/ops-log.js';
import './styles/tokens.css';
import './styles/xterm-overrides.css';

// m-server-state-tanstack-query: server-state cache for new features
// (quota panel / shares list / feedback list). zustand stores stay for
// UI state (modal open / theme / selection). Don't enable refetch-on-
// window-focus globally — ccanywhere is single-user single-tab so the
// dedupe / refresh thrashing buys nothing.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

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
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
