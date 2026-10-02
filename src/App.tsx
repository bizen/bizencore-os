import { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppHeaderAuth } from './components/AppHeaderAuth';
import { Mascot } from './components/Mascot';
import { SplashScreen } from './components/SplashScreen';
import { SettingsPanel } from './components/SettingsPanel';
import { SyncBridge } from './components/SyncBridge';
import { isCloudConfigured } from './lib/cloudConfig';
import { CountPage } from './pages/CountPage';
import { TasksPage } from './pages/TasksPage';
import { applyTheme, readTheme, saveTheme, type Theme } from './lib/theme';
import { Brand } from './components/Brand';

const SPLASH_VISIBLE_MS = 1100;
const SPLASH_FADE_MS = 450;

/** ⌘K / Ctrl+K で tasks と count を行き来する */
function usePageSwitchShortcut() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.code !== 'KeyK') return;
      event.preventDefault();
      navigate(location.pathname.startsWith('/count') ? '/' : '/count');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, location.pathname]);
}

export default function App() {
  const [splashState, setSplashState] = useState<'visible' | 'fading' | 'gone'>('visible');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  usePageSwitchShortcut();

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'bizencore.theme') return;
      const next = readTheme();
      setTheme(next);
      applyTheme(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const changeTheme = (next: Theme) => {
    setTheme(next);
    saveTheme(next);
  };

  useEffect(() => {
    const fadeTimer = setTimeout(() => setSplashState('fading'), SPLASH_VISIBLE_MS);
    const goneTimer = setTimeout(
      () => setSplashState('gone'),
      SPLASH_VISIBLE_MS + SPLASH_FADE_MS
    );
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(goneTimer);
    };
  }, []);

  return (
    <>
      {splashState !== 'gone' && <SplashScreen fadingOut={splashState === 'fading'} />}

      <SyncBridge />

      <div className="app-shell">
        <header className="app-header">
          <Brand />
          <div className="app-header-end">
            <nav className="app-nav">
              <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                tasks
              </NavLink>
              <NavLink to="/count" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                count
              </NavLink>
            </nav>
            <button
              type="button"
              className="app-settings-btn"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-label="設定"
              title="設定"
              aria-expanded={settingsOpen}
              aria-controls="app-settings-panel"
            >
              <Settings2 size={17} aria-hidden />
            </button>
            {isCloudConfigured ? (
              <div className="app-header-auth">
                <AppHeaderAuth />
              </div>
            ) : null}
          </div>
        </header>

        <main className="app-main">
          <Routes>
            <Route path="/" element={<TasksPage />} />
            <Route path="/count" element={<CountPage />} />
            <Route path="/tasks/*" element={<Navigate to="/" replace />} />
            <Route path="/plan/*" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        <Mascot />
        {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} theme={theme} onThemeChange={changeTheme} /> : null}
      </div>
    </>
  );
}
