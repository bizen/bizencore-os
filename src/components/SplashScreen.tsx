import cirnoImg from '../assets/cirno.png';
import { Brand } from './Brand';

interface SplashScreenProps {
    fadingOut?: boolean;
    desktop?: boolean;
}

export function SplashScreen({ fadingOut = false, desktop = false }: SplashScreenProps) {
    return (
        <div className={`splash-root${fadingOut ? ' splash-fade-out' : ''}`}>
            <div className="splash-stack">
                <img src={cirnoImg} alt="" className="splash-cirno" />
                <div className="splash-wordmark"><Brand desktop={desktop} /></div>
                <div className="splash-dots" aria-label="loading">
                    <span />
                    <span />
                    <span />
                </div>
            </div>
        </div>
    );
}
