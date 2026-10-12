import { useEffect } from 'react';
import { useAuth, watchAuth } from './auth/authStore';
import { liveClient } from './live/liveClient';
import { syncPrefs } from './workspace/workspaceStore';
import { LoginScreen } from './components/LoginScreen';
import { TopBar } from './components/TopBar';
import { Workspace } from './components/Workspace';
import { Sidebar } from './sidebar/Sidebar';
import { Toasts } from './components/Toasts';

export function App() {
  const status = useAuth((s) => s.status);
  const serverError = useAuth((s) => s.serverError);

  useEffect(() => watchAuth(), []);
  const loggedIn = status?.state === 'logged_in';
  useEffect(() => {
    if (!loggedIn) return;
    liveClient.start();
    const stopPrefs = syncPrefs();
    return () => {
      liveClient.stop();
      stopPrefs();
    };
  }, [loggedIn]);

  if (!status) {
    return (
      <div className="splash">
        {serverError ? (
          <div className="notice notice-warn">{serverError} Retrying…</div>
        ) : (
          <div className="spinner" aria-label="Loading" />
        )}
      </div>
    );
  }

  if (status.state === 'logged_out') return <LoginScreen status={status} />;

  return (
    <div className="app">
      <TopBar status={status} />
      {serverError && <div className="banner banner-warn">{serverError} Retrying…</div>}
      <div className="main">
        <Workspace />
        <Sidebar />
      </div>
      <Toasts />
    </div>
  );
}
