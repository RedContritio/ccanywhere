import type { JSX, ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from './pages/login.js';
import { WorkspacePage } from './pages/workspace.js';
import { useAuthStore } from './state/auth.js';
import { useApplyTheme } from './state/use-theme.js';

function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const token = useAuthStore((s) => s.token);
  if (token === null) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RedirectIfAuth({ children }: { children: ReactNode }): JSX.Element {
  const token = useAuthStore((s) => s.token);
  if (token !== null) return <Navigate to="/workspace" replace />;
  return <>{children}</>;
}

export function App(): JSX.Element {
  useApplyTheme();
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            <RedirectIfAuth>
              <LoginPage />
            </RedirectIfAuth>
          }
        />
        <Route
          path="/workspace"
          element={
            <RequireAuth>
              <WorkspacePage />
            </RequireAuth>
          }
        />
        <Route
          path="/workspace/:id"
          element={
            <RequireAuth>
              <WorkspacePage />
            </RequireAuth>
          }
        />
        <Route path="/history" element={<Navigate to="/workspace" replace />} />
        <Route path="/settings" element={<Navigate to="/workspace" replace />} />
        <Route path="*" element={<Navigate to="/workspace" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
