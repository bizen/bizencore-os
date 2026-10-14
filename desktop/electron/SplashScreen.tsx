import { Brand } from '../../src/components/Brand';

export function SplashScreen({ fadingOut = false }: { fadingOut?: boolean; desktop?: boolean }) {
  return <div className={`splash-root${fadingOut ? ' splash-fade-out' : ''}`}>
    <div className="splash-stack">
      <div className="splash-wordmark"><Brand desktop /></div>
      <div className="splash-dots" aria-label="loading"><span /><span /><span /></div>
    </div>
  </div>;
}
