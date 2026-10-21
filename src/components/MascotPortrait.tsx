import { useEffect, useId, useRef, useState } from 'react';
import cirnoImg from '../assets/cirno.png';
import eyelessImg from '../assets/cirno-eyeless.png';

const EYES = [{ x: 659, y: 697, height: 156 }, { x: 868, y: 652, height: 154 }];

export function MascotPortrait({ active = true }: { active?: boolean }) {
    const portrait = useRef<HTMLSpanElement>(null);
    const gaze = useRef<SVGGElement>(null);
    const eyes = useRef<(SVGGElement | null)[]>([]);
    const patchId = useId();
    const [ready, setReady] = useState(false);

    useEffect(() => {
        const eyeNodes = [...eyes.current];
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        let timer: number | undefined;
        const enabled = () => active && ready && !document.hidden && !reducedMotion.matches;
        const reset = () => {
            if (portrait.current) portrait.current.style.rotate = '0deg';
            if (gaze.current) gaze.current.style.transform = 'translate(0px, 0px)';
        };
        const scheduleBlink = () => {
            timer = window.setTimeout(() => {
                if (!enabled()) return;
                for (const eye of eyeNodes) eye?.animate([
                    { scale: '1 1' }, { scale: '1 0.08', offset: 0.45 }, { scale: '1 1' },
                ], { duration: 160, easing: 'ease-in-out' });
                scheduleBlink();
            }, 4000 + Math.random() * 3000);
        };
        const refresh = () => {
            window.clearTimeout(timer);
            for (const eye of eyeNodes) eye?.getAnimations().forEach(animation => animation.cancel());
            reset();
            if (enabled()) scheduleBlink();
        };
        const follow = (event: globalThis.PointerEvent) => {
            if (!enabled() || event.pointerType !== 'mouse' || !portrait.current || !gaze.current) return;
            const bounds = portrait.current.getBoundingClientRect();
            const dx = event.clientX - (bounds.left + bounds.width / 2);
            const dy = event.clientY - (bounds.top + bounds.height / 2);
            const distance = Math.hypot(dx, dy);
            const proximity = Math.max(0, 1 - distance / 160);
            const x = dx / Math.max(48, distance) * proximity;
            const y = dy / Math.max(48, distance) * proximity;
            gaze.current.style.transform = `translate(${x * 24}px, ${y * 16}px)`;
            portrait.current.style.rotate = `${x * 3.5}deg`;
        };
        refresh();
        document.addEventListener('pointermove', follow, { passive: true });
        document.addEventListener('pointerleave', reset);
        document.addEventListener('visibilitychange', refresh);
        reducedMotion.addEventListener('change', refresh);
        return () => {
            window.clearTimeout(timer);
            for (const eye of eyeNodes) eye?.getAnimations().forEach(animation => animation.cancel());
            document.removeEventListener('pointermove', follow);
            document.removeEventListener('pointerleave', reset);
            document.removeEventListener('visibilitychange', refresh);
            reducedMotion.removeEventListener('change', refresh);
            reset();
        };
    }, [active, ready]);

    return <span ref={portrait} className="mascot-portrait">
        <img src={cirnoImg} alt="Cirno" className="mascot" draggable={false} />
        <svg className="mascot-face" viewBox="0 0 1254 1254" aria-hidden="true" focusable="false" style={{ visibility: ready ? 'visible' : 'hidden' }}>
            <defs><clipPath id={patchId}>
                {EYES.map(eye => <rect key={eye.x} x="-30" y="-84" width="60" height="168" rx="30" transform={`translate(${eye.x} ${eye.y}) rotate(-15)`} />)}
            </clipPath></defs>
            {/* Replace only the baked-in eyes; the rest of the supplied artwork stays untouched. */}
            <image href={eyelessImg} width="1254" height="1254" clipPath={`url(#${patchId})`} onLoad={() => setReady(true)} onError={() => setReady(false)} />
            <g ref={gaze} className="mascot-gaze">
                {EYES.map((eye, index) => <g key={eye.x} transform={`translate(${eye.x} ${eye.y}) rotate(-15)`}>
                    <g className="mascot-eye" ref={node => { eyes.current[index] = node; }}>
                        <rect x="-27" y={-eye.height / 2} width="54" height={eye.height} rx="27" fill="#10110f" />
                    </g>
                </g>)}
            </g>
        </svg>
    </span>;
}
