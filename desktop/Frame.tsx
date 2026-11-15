import type { ReactNode } from 'react';
import type {} from './bridge';

export function DesktopFrame({ children }: { children: ReactNode }) {
  if (!window.bizencoreDesktop?.integratedTitlebar) return <>{children}</>;
  return <div className="desktop-frame">
    <div className="desktop-titlebar" aria-hidden="true" />
    <div className="desktop-frame-content">{children}</div>
  </div>;
}
