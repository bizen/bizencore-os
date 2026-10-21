import { useEffect, useId, useRef, useState } from 'react';
import cirnoImg from '../assets/cirno.png';
import eyelessImg from '../assets/cirno-eyeless.png';

const EYES = [{ x: 659, y: 697, height: 156 }, { x: 868, y: 652, height: 154 }];

export type MascotMood = 'idle' | 'curious' | 'dragging' | 'expectant' | 'happy';

export function MascotPortrait({ active = true, mood = 'idle', decorative = false }: { active?: boolean; mood?: MascotMood; decorative?: boolean }) {
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
            if (portrait.current) {
                portrait.current.style.rotate = '0deg';
                delete portrait.current.dataset.near;
            }
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
            if (portrait.current) portrait.current.style.animationPlayState = document.hidden ? 'paused' : 'running';
            if (enabled()) scheduleBlink();
        };
        const follow = (event: globalThis.PointerEvent) => {
            if (!enabled() || event.pointerType !== 'mouse' || !portrait.current || !gaze.current) return;
            const bounds = (portrait.current.closest('button') ?? portrait.current).getBoundingClientRect();
            const dx = event.clientX - (bounds.left + bounds.width / 2);
            const dy = event.clientY - (bounds.top + bounds.height / 2);
            const distance = Math.hypot(dx, dy);
            const proximity = Math.max(0, 1 - distance / 300);
            const x = dx / Math.max(48, distance) * proximity;
            const y = dy / Math.max(48, distance) * proximity;
            portrait.current.dataset.near = String(proximity > 0);
            gaze.current.style.transform = `translate(${x * 44}px, ${y * 30}px)`;
            portrait.current.style.rotate = `${x * 9}deg`;
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

    return <span ref={portrait} className="mascot-portrait" data-mood={mood} data-active={active && ready} aria-hidden={decorative || undefined}>
        <img src={cirnoImg} alt={decorative ? '' : 'Cirno'} className="mascot" draggable={false} />
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
        {mood === 'curious' ? <span className="mascot-reaction mascot-question" aria-hidden="true">?</span> : null}
        {mood === 'dragging' ? <svg className="mascot-reaction mascot-sweat" viewBox="0 0 24 32" aria-hidden="true"><path d="M12 2C10 8 3 16 3 21a9 9 0 0 0 18 0C21 16 14 8 12 2Z" fill="#75cefa" stroke="#267bad" strokeWidth="2" /><path d="M8 20v3" stroke="white" strokeWidth="3" strokeLinecap="round" /></svg> : null}
        {mood === 'expectant' || mood === 'happy' ? <span className="mascot-reaction mascot-sparkle" aria-hidden="true">✦</span> : null}
    </span>;
}
