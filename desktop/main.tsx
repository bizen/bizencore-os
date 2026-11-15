import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from '../src/App';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { applyTheme, readTheme } from '../src/lib/theme';
import { AgentWorkspace } from './workspace';
import { DesktopAuthentication } from './auth';
import { DesktopFrame } from './Frame';
import '../src/index.css';
import './workspace.css';
import { installInputValidation } from './validation';

applyTheme(readTheme());
installInputValidation();
createRoot(document.getElementById('root')!).render(
  <DesktopFrame><ErrorBoundary>
    <DesktopAuthentication>
      <BrowserRouter><AgentWorkspace><App desktop /></AgentWorkspace></BrowserRouter>
    </DesktopAuthentication>
  </ErrorBoundary></DesktopFrame>,
);
