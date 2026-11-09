import { useEffect, useRef, useState, type ReactNode } from 'react';

// The radio part of the sidebar: without a radio a small radio waits for a USB plug that keeps
// reaching for its socket; when one is connected the plug clicks in, then the list of radios folds open.
// Same file in all apps of this family.

const FOUND_MS = 1300; // how long the plugged-in radio shows before the list opens
const AWAY = 150; // plug position (svg units) at rest, just before the socket, plugged in
const NEAR = 122;
const IN = 102;

const CSS = `
.cr-fold { display: grid; grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows .35s ease, opacity .3s ease; }
.cr-fold > div { overflow: hidden; min-height: 0; }
.cr-fold.cr-shut { grid-template-rows: 0fr; opacity: 0; }
.cr-radio .cr-plug { transform: translate(${AWAY}px, 64px); }
.cr-radio .cr-knob { transition: transform .12s ease-out; }
.cr-radio .cr-dot { fill: #5aa9ff; }
.cr-radio .cr-check { fill: none; stroke: #4ade80; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 20; stroke-dashoffset: 20; }
.cr-radio .cr-ring { fill: none; stroke: #4ade80; stroke-width: 2; opacity: 0; transform-box: fill-box; transform-origin: center; }
.cr-look .cr-plug { animation: cr-reach 2.6s ease-in-out infinite; }
@keyframes cr-reach { 0%, 100% { transform: translate(${AWAY}px, 64px); } 45%, 60% { transform: translate(${NEAR}px, 64px); } }
.cr-look .cr-dot { animation: cr-dot 1.2s ease-in-out infinite; }
.cr-look .cr-dot:nth-of-type(2) { animation-delay: .2s; }
.cr-look .cr-dot:nth-of-type(3) { animation-delay: .4s; }
@keyframes cr-dot { 0%, 100% { opacity: .25; } 40% { opacity: 1; } }
.cr-found .cr-dot { opacity: 0; }
.cr-found .cr-check { stroke-dashoffset: 0; transition: stroke-dashoffset .35s ease .1s; }
.cr-found .cr-ring { animation: cr-ring .8s ease-out .2s 1 backwards; }
@keyframes cr-ring { from { opacity: .9; transform: scale(.6); } to { opacity: 0; transform: scale(1.5); } }
@media (prefers-reduced-motion: reduce) {
  .cr-fold, .cr-radio *, .cr-radio *::after { animation: none !important; transition: none !important; }
  .cr-look .cr-plug { transform: translate(${NEAR + 2}px, 64px); }
  .cr-look .cr-dot { opacity: .7; }
}
`;

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Radio({ plugged }: { plugged: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  const plug = useRef<SVGGElement>(null);
  const knobs = useRef<(SVGCircleElement | null)[]>([]);
  const before = useRef<boolean>(undefined);

  useEffect(() => {
    const root = svg.current!;
    const el = plug.current!;
    const timers: number[] = [];
    const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, still() ? 0 : ms));
    const move = (x: number, transition: string) => {
      el.style.transition = still() ? 'none' : transition;
      el.style.transform = `translate(${x}px, 64px)`;
    };
    const was = before.current;
    before.current = plugged;
    if (was === plugged) return;
    if (was === undefined) {
      // already connected when the app opens: plugged in without a show
      if (plugged) {
        root.classList.replace('cr-look', 'cr-found');
        move(IN, 'none');
      }
      return;
    }
    if (plugged) {
      // freeze the plug where its searching loop has it, then let it click into the socket
      move(new DOMMatrix(getComputedStyle(el).transform).e, 'none');
      root.classList.replace('cr-look', 'cr-found');
      el.getBoundingClientRect();
      move(IN, 'transform .22s cubic-bezier(.5, 0, .9, .5)');
      // a short happy wiggle of both sticks
      const wiggle = [[4, -3, -4, 3], [-4, 3, 4, -3], [3, 3, -3, -3], [-3, -3, 3, 3], [0, 0, 0, 0]];
      if (!still())
        wiggle.forEach(([lx, ly, rx, ry], i) =>
          later(220 + i * 110, () => {
            knobs.current[0]?.style.setProperty('transform', `translate(${lx}px, ${ly}px)`);
            knobs.current[1]?.style.setProperty('transform', `translate(${rx}px, ${ry}px)`);
          }),
        );
    } else {
      // pulled out while the radio folds back in, then reaching for the socket again
      later(300, () => move(AWAY, 'transform .4s ease-out'));
      later(750, () => {
        el.style.transition = el.style.transform = '';
        root.classList.replace('cr-found', 'cr-look');
      });
    }
    return () => timers.forEach(clearTimeout);
  }, [plugged]);

  return (
    <svg ref={svg} className="cr-radio cr-look block overflow-visible" viewBox="0 20 200 70" width={160} height={56} aria-hidden="true">
      <defs>
        <linearGradient id="cr-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#DDEBFB" />
          <stop offset="1" stopColor="#BCD3EE" />
        </linearGradient>
        <linearGradient id="cr-cable" gradientUnits="userSpaceOnUse" x1="30" y1="0" x2="95" y2="0">
          <stop offset="0" stopColor="#71717a" />
          <stop offset="1" stopColor="#71717a" stopOpacity="0" />
        </linearGradient>
        <clipPath id="cr-clip">
          <rect x="6" y="40" width="108" height="48" rx="16" />
        </clipPath>
      </defs>
      {/* USB-C plug, drawn first so its tip hides behind the radio when plugged in */}
      <g ref={plug} className="cr-plug">
        <g transform="scale(1.4)">
          <line x1="29" y1="0" x2="95" y2="0" stroke="url(#cr-cable)" strokeWidth="4" strokeLinecap="round" />
          <rect x="0" y="-3.5" width="9" height="7" rx="2.5" fill="#c9ced6" />
          <rect x="8" y="-5.5" width="16" height="11" rx="3" fill="#d4d4d8" />
          <rect x="23" y="-3.5" width="7" height="7" rx="2" fill="#a1a1aa" />
        </g>
      </g>
      <line x1="24" y1="26" x2="32" y2="44" stroke="#D3E5F9" strokeWidth="5" strokeLinecap="round" />
      <line x1="96" y1="26" x2="88" y2="44" stroke="#D3E5F9" strokeWidth="5" strokeLinecap="round" />
      <rect x="6" y="40" width="108" height="48" rx="16" fill="url(#cr-body)" />
      <rect x="6" y="40" width="108" height="18" fill="#fff" opacity=".28" clipPath="url(#cr-clip)" />
      <rect x="110.5" y="56.3" width="3.5" height="15.4" rx="1.5" fill="#16263a" />
      <circle className="cr-ring" cx="114" cy="64" r="14" />
      {[28, 92].map((x, i) => (
        <g key={x}>
          <circle cx={x} cy="68" r="12.5" fill="#A6C0DD" />
          <circle cx={x} cy="68" r="9" fill="#D2E3F7" />
          <circle ref={(el) => void (knobs.current[i] = el)} className="cr-knob" cx={x} cy="68" r="3.2" fill="#234E78" />
        </g>
      ))}
      {/* screen: three dots while waiting, a check once plugged in */}
      <rect x="45" y="49" width="30" height="20" rx="3.5" fill="#16263a" />
      <g>
        <circle className="cr-dot" cx="53" cy="59" r="1.8" />
        <circle className="cr-dot" cx="60" cy="59" r="1.8" />
        <circle className="cr-dot" cx="67" cy="59" r="1.8" />
      </g>
      <path className="cr-check" d="M 53 59.5 L 58 64 L 67 54.5" />
    </svg>
  );
}

export function ConnectedRadios<T>(props: { radios?: T[]; text: string; children: (radios: T[]) => ReactNode }) {
  const { radios, text, children } = props;
  const count = radios?.length ?? 0;
  const [seen, setSeen] = useState<number>(); // count at the last render, undefined before the first state
  const [showing, setShowing] = useState(false); // plugged-in radio still on show
  const [last, setLast] = useState<T[]>([]); // kept while the list folds away
  if (radios !== undefined && count !== seen) {
    setSeen(count);
    if (seen === 0) setShowing(true);
  }
  if (count > 0 && radios !== last) setLast(radios!);

  useEffect(() => {
    if (!showing) return;
    const id = window.setTimeout(() => setShowing(false), still() ? 0 : FOUND_MS);
    return () => clearTimeout(id);
  }, [showing]);

  if (radios === undefined) return null;
  return (
    <>
      <style>{CSS}</style>
      <div className={`cr-fold ${count === 0 || showing ? '' : 'cr-shut'}`}>
        <div>
          <div className="flex flex-col gap-1.5 px-2 pt-1">
            <Radio plugged={count > 0} />
            <p className="m-0 text-sm text-zinc-400">{text}</p>
          </div>
        </div>
      </div>
      <div className={`cr-fold ${count > 0 && !showing ? '' : 'cr-shut'}`}>
        <div className="flex flex-col gap-1.5">{last.length > 0 && children(last)}</div>
      </div>
    </>
  );
}
