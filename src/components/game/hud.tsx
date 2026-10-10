'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { HudState, ItemStack, ItemId } from './engine/types';
import { ICON_URLS, ITEMS, UI_ICONS } from './engine/items';
import { HyperionAudio } from './engine/audio';
import type { HyperionGame } from './engine/game';

const SLOT_BASE =
  'relative flex items-center justify-center bg-[#8b8b8b] border-2 border-t-[#373737] border-l-[#373737] border-b-[#c6c6c6] border-r-[#c6c6c6]';

function ItemIcon({ id, size = 40 }: { id: ItemId; size?: number }) {
  const src = ICON_URLS[id];
  if (!src) return null;
  return (
    <img
      src={src}
      alt={ITEMS[id].name}
      width={size}
      height={size}
      style={{ imageRendering: 'pixelated' }}
      className="drop-shadow-[2px_2px_0_rgba(0,0,0,0.45)]"
      draggable={false}
    />
  );
}

function Slot({
  stack,
  selected,
  onClick,
  size = 48,
}: {
  stack: ItemStack | null;
  selected?: boolean;
  onClick?: () => void;
  size?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`${SLOT_BASE} ${selected ? 'outline outline-[3px] outline-white z-10 scale-110' : ''} transition-transform`}
      style={{ width: size, height: size }}
      aria-label={stack ? ITEMS[stack.id].name : 'empty slot'}
    >
      {stack && <ItemIcon id={stack.id} size={size - 14} />}
      {stack && stack.count > 1 && (
        <span className="absolute bottom-0 right-1 text-white text-[13px] font-bold leading-none [text-shadow:2px_2px_0_#000]">
          {stack.count}
        </span>
      )}
    </button>
  );
}

function Hearts({ health }: { health: number }) {
  const hearts: ReactNode[] = [];
  for (let i = 0; i < 10; i++) {
    const full = health >= (i + 1) * 2;
    hearts.push(
      <img
        key={i}
        src={full ? UI_ICONS.heartFull : UI_ICONS.heartEmpty}
        alt={full ? 'heart' : 'empty heart'}
        width={22}
        height={22}
        style={{ imageRendering: 'pixelated' }}
        draggable={false}
      />
    );
  }
  return <div className="flex gap-[2px]">{hearts}</div>;
}

function Stars({ count }: { count: number }) {
  const stars: ReactNode[] = [];
  for (let i = 0; i < 5; i++) {
    stars.push(
      <img
        key={i}
        src={i < count ? UI_ICONS.starFull : UI_ICONS.starEmpty}
        alt={i < count ? 'wanted star' : 'empty star'}
        width={30}
        height={30}
        style={{ imageRendering: 'auto' }}
        className={i < count ? 'drop-shadow-[0_0_6px_rgba(255,255,255,0.7)]' : 'opacity-60'}
        draggable={false}
      />
    );
  }
  return <div className="flex flex-col items-end gap-[2px]">{stars}</div>;
}

export interface HudProps {
  state: HudState;
  toast: string | null;
  game: HyperionGame | null;
  onSlotClick: (i: number) => void;
  onInventorySwap: (i: number) => void;
  onResume: () => void;
  onRespawn: () => void;
  onPlay: () => void;
  onContinue: () => void;
  onSave: () => void;
  paused: boolean;
  inventoryOpen: boolean;
  onCloseInventory: () => void;
  showStart: boolean;
}

const CONTROLS: Array<[string, string]> = [
  ['W A S D', 'Move'],
  ['Mouse', 'Look'],
  ['LMB (hold)', 'Dig / carve micro-voxels'],
  ['RMB', 'Place block / use item'],
  ['LMB (tank)', 'Fire the cannon'],
  ['RMB (hold) 🚀', 'Jetpack thrust (selected)'],
  ['Space ×2', 'Toggle creative flight'],
  ['Space / C', 'Fly up / down'],
  ['Shift', 'Sprint'],
  ['1–9 / Wheel', 'Select hotbar slot'],
  ['E', 'Inventory'],
  ['F', 'Enter / exit car'],
  ['M', 'Accept / quit contract'],
  ["🎨 Drive in", "Pay'n'Spray — clear heat + repair"],
  ['🛞 Spike strips', '4★ roadblocks shred tires — respray to fix'],
  ['R', 'Car radio station'],
  ['F5', 'Third-person view'],
  ['F3', 'Debug overlay'],
  ['Esc', 'Pause'],
];

/** Contract chain tier labels (3 contracts per tier). */
const CHAIN_TIERS: Array<{ label: string; icon: string }> = [
  { label: '→ Jetpack', icon: '🔥' },
  { label: '→ Tank', icon: '🪖' },
  { label: '→ TNT Mega', icon: '💥' },
];

/** Contract tracker — GTA-style offer/active chip with progress + countdown. */
function MissionChip({ mission }: { mission: NonNullable<HudState['mission']> }) {
  const pct = mission.target > 0 ? Math.min(100, (mission.progress / mission.target) * 100) : 0;
  const offer = mission.offered;
  const tierIdx = Math.min(mission.chainTier, CHAIN_TIERS.length - 1);
  const tier = CHAIN_TIERS[tierIdx];
  return (
    <div
      className={`hyperion-missionchip absolute left-1/2 top-4 w-[300px] max-w-[80vw] -translate-x-1/2 rounded-lg border bg-black/70 px-3 py-2 backdrop-blur-[2px] ${
        offer ? 'hyperion-offer border-amber-400/70' : 'border-amber-400/25'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.16em] text-amber-300">
          <span className="text-[13px] leading-none">{offer ? '📡' : '🎯'}</span>
          {offer ? 'CONTRACT OFFER' : 'CONTRACT'} · {mission.title}
        </div>
        <div className={`text-[12px] font-black tabular-nums ${mission.timeLeft < 10 && !offer ? 'text-red-400' : 'text-white/90'}`}>
          {Math.ceil(mission.timeLeft)}s
        </div>
      </div>
      <div className="mt-1 text-[11px] font-bold text-white/80">
        {offer ? `${mission.desc} — press M to accept` : mission.desc}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${offer ? 'w-full bg-amber-400/50' : 'bg-amber-400'}`}
          style={offer ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[9px] font-bold uppercase tracking-widest text-white/45">
        <span>
          {offer ? 'Reward' : `${mission.progress} / ${mission.target}`}
          {mission.marker && (
            <span className="ml-2 text-amber-300/90">◆ {Math.round(mission.marker.dist)}m</span>
          )}
        </span>
        <span>{mission.reward}</span>
      </div>
      {/* Contract chain — each 3 completions unlock the next tier reward */}
      <div className="mt-1 flex items-center justify-between border-t border-white/10 pt-1">
        <span className="text-[8px] font-black uppercase tracking-[0.22em] text-white/40">Chain bonus</span>
        <span className="flex items-center gap-1">
          {CHAIN_TIERS.slice(0, mission.chainTier).map((t, i) => (
            <span key={i} className="text-[10px] leading-none">{t.icon}</span>
          ))}
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`inline-block h-[7px] w-[7px] rotate-45 rounded-[1px] ${
                i < mission.chain ? 'bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.8)]' : 'bg-white/15'
              }`}
            />
          ))}
          <span className="ml-1 text-[9px] font-black uppercase tracking-widest text-white/55">{tier.label}</span>
        </span>
      </div>
    </div>
  );
}

/** Animated radio equalizer bars. */
function EqBars() {
  return (
    <span className="flex h-3 items-end gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="hyperion-eqbar block h-3 w-[3px] rounded-sm bg-emerald-400/90" />
      ))}
    </span>
  );
}

/** Weather chip — clear / overcast / rain with animated droplets + wet-roads tag. */
function WeatherChip({ weather }: { weather: HudState['weather'] }) {
  const rain = weather.state === 'rain';
  const over = weather.state === 'overcast';
  const wet = weather.wet > 0.3;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 backdrop-blur-[2px] transition-colors duration-700 ${
        rain
          ? 'border-sky-300/30 bg-[#0d1420]/70'
          : over
            ? 'border-white/15 bg-black/55'
            : 'border-amber-300/20 bg-black/45'
      }`}
      title={`Weather: ${weather.state}${wet ? ' · wet roads' : ''}`}
    >
      {rain ? (
        <span className="relative block h-4 w-4 overflow-hidden">
          <span className="absolute left-[3px] top-0 hyperion-drop h-[5px] w-[2px] rounded-full bg-sky-300" />
          <span className="absolute left-[8px] top-0 hyperion-drop h-[5px] w-[2px] rounded-full bg-sky-300" style={{ animationDelay: '0.35s' }} />
          <span className="absolute left-[13px] top-0 hyperion-drop h-[5px] w-[2px] rounded-full bg-sky-300" style={{ animationDelay: '0.7s' }} />
        </span>
      ) : (
        <span className={`text-[13px] leading-none ${over ? 'opacity-70' : ''}`}>{over ? '☁️' : '☀️'}</span>
      )}
      <div className="leading-tight">
        <div className="text-[8px] font-bold uppercase tracking-[0.24em] text-white/45">Weather</div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-black uppercase tracking-wider ${rain ? 'text-sky-300' : over ? 'text-white/70' : 'text-amber-200/90'}`}>
            {weather.state}
          </span>
          {wet && !rain && (
            <span className="rounded bg-sky-400/15 px-1 text-[8px] font-black uppercase tracking-widest text-sky-300/90">💧 wet</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** "LOSING THEM" evade progress — amber sweep that fills as the cops lose sight. */
function EvadeChip({ evading }: { evading: number }) {
  return (
    <div className="hyperion-losing mt-1 w-32 rounded border border-amber-300/35 bg-black/65 px-2 py-1">
      <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-[0.18em] text-amber-300">
        <span>👁 LOSING THEM</span>
        <span className="tabular-nums">{Math.round(evading * 100)}%</span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-emerald-400 transition-[width] duration-200"
          style={{ width: `${Math.round(evading * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Jetpack fuel gauge — shown while a Chaos Jetpack is selected (or thrusting). */
function JetFuelChip({ fuel, thrusting }: { fuel: number; thrusting: boolean }) {
  const pct = Math.round(fuel * 100);
  const low = fuel < 0.22;
  return (
    <div
      className={`mt-1 w-36 rounded border px-2 py-1 backdrop-blur-[2px] transition-colors duration-300 ${
        thrusting ? 'border-orange-400/70 bg-[#1d1005]/80 shadow-[0_0_14px_rgba(255,120,30,0.35)]' : 'border-white/15 bg-black/60'
      }`}
    >
      <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-[0.18em]">
        <span className={thrusting ? 'text-orange-300' : 'text-white/60'}>
          {thrusting ? <span className="hyperion-flame">🔥 BURNING</span> : '🚀 JETPACK'}
        </span>
        <span className={`tabular-nums ${low ? 'text-red-400' : 'text-white/85'}`}>{pct}%</span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-150 ${
            low ? 'bg-gradient-to-r from-red-500 to-orange-400' : 'bg-gradient-to-r from-orange-500 via-amber-400 to-yellow-300'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-0.5 text-right text-[8px] font-bold uppercase tracking-widest text-white/35">Hold RMB — thrust</div>
    </div>
  );
}

/** Air support chip — radar sweep + blinking border (5-star chopper). */
function HeliChip() {
  return (
    <div className="hyperion-policechip mt-1 flex items-center gap-2 rounded border border-red-400/45 bg-black/60 px-2 py-1">
      <span className="relative block h-4 w-4 overflow-hidden rounded-full border border-red-300/60 bg-black/60">
        <span className="hyperion-radar absolute inset-0" />
      </span>
      <span className="text-[10px] font-black uppercase tracking-[0.18em] text-red-300">🚁 Air support</span>
    </div>
  );
}

/** SPOTTED chip — the chopper searchlight has the player lit. */
function SpottedChip({ level }: { level: number }) {
  return (
    <div className="hyperion-spotted mt-1 flex items-center gap-2 rounded border bg-black/70 px-2 py-1">
      <span className="hyperion-flame text-[14px] leading-none">🔦</span>
      <div>
        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-200">Spotted</div>
        <div className="mt-0.5 h-1 w-20 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-400 to-red-500 transition-[width] duration-150"
            style={{ width: `${Math.max(8, level * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/** Roadblock warning chip — animated hazard stripes + live distance. */
function RoadblockChip({ dist }: { dist: number }) {
  const close = dist < 45;
  return (
    <div
      className={`mt-1 flex items-center gap-2 rounded border border-red-400/60 bg-black/70 px-2 py-1 ${close ? 'hyperion-roadblock-close' : ''}`}
    >
      <span className="hyperion-hazard block h-4 w-7 rounded-[3px] border border-white/25" />
      <div>
        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-red-300">🚧 Roadblock</div>
        <div className={`text-[9px] font-bold tabular-nums ${close ? 'text-red-200' : 'text-white/55'}`}>
          {Math.round(dist)}m {close ? '· DODGE OR SMASH' : 'ahead'}
        </div>
      </div>
    </div>
  );
}

/** Vehicle speedometer — SVG arc gauge + hull integrity + tank cannon reload. */
function Speedo({ driving }: { driving: NonNullable<HudState['driving']> }) {
  const max = driving.tank ? 60 : 130;
  const pct = Math.max(0, Math.min(1, driving.speed / max));
  const angle = (-90 + pct * 180) * (Math.PI / 180);
  const needleLen = 44;
  const nx = 75 + needleLen * Math.sin(angle);
  const ny = 74 - needleLen * Math.cos(angle);
  const hpct = Math.max(0, Math.min(1, driving.health / (driving.tank ? 400 : 100)));
  const lowHealth = hpct < 0.3;
  return (
    <div
      className={`mt-1 rounded-lg border px-2 pb-1.5 pt-1 backdrop-blur-[2px] ${
        driving.tank ? 'border-lime-400/40 bg-[#0d1206]/75' : 'border-white/15 bg-black/60'
      }`}
    >
      <svg width="150" height="88" viewBox="0 0 150 88">
        {/* gauge arc */}
        <path d="M 23 74 A 52 52 0 0 1 127 74" fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth="7" strokeLinecap="round" />
        <path
          d="M 23 74 A 52 52 0 0 1 127 74"
          fill="none"
          stroke={driving.tank ? '#a3e635' : '#fbbf24'}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${pct * 163.4} 400`}
        />
        {/* ticks */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const a = (-90 + t * 180) * (Math.PI / 180);
          const x1 = 75 + 40 * Math.sin(a);
          const y1 = 74 - 40 * Math.cos(a);
          const x2 = 75 + 45 * Math.sin(a);
          const y2 = 74 - 45 * Math.cos(a);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.4)" strokeWidth="1.6" />;
        })}
        {/* needle */}
        <line x1="75" y1="74" x2={nx} y2={ny} stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="75" cy="74" r="4" fill="#ffffff" />
        <text x="75" y="58" textAnchor="middle" fill="#ffffff" fontSize="19" fontWeight="800" className="tabular-nums">
          {Math.round(driving.speed)}
        </text>
        <text x="75" y="86" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="8" letterSpacing="3">
          KM/H
        </text>
      </svg>
      {/* hull integrity */}
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            lowHealth ? 'bg-gradient-to-r from-red-600 to-orange-400' : 'bg-gradient-to-r from-sky-400/80 to-emerald-400'
          }`}
          style={{ width: `${hpct * 100}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-[9px] font-black uppercase tracking-[0.14em] ${driving.tank ? 'text-lime-300/90' : 'text-amber-300/90'}`}>
          {driving.name}
        </span>
        {!driving.tires && (
          <span className="hyperion-flame rounded bg-red-500/25 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-red-300">
            🛞 Shredded
          </span>
        )}
        {driving.tank && (
          <span
            className={`rounded px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest ${
              driving.reload >= 1 ? 'bg-lime-400/20 text-lime-300' : 'bg-white/10 text-white/45'
            }`}
          >
            {driving.reload >= 1 ? '● LMB · FIRE' : `RELOAD ${Math.round(driving.reload * 100)}%`}
          </span>
        )}
      </div>
      {driving.tank && driving.reload < 1 && (
        <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-lime-400/70 transition-[width] duration-100" style={{ width: `${driving.reload * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/** Mobile/touch control layer — analog joystick, drag-look, action buttons.
 *  Rendered above the canvas but below chips/hotbar so HUD taps still work. */
function TouchControls({ game, state }: { game: HyperionGame; state: HudState }) {
  const input = game.input;
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [sprintOn, setSprintOn] = useState(false);
  const padRef = useRef<HTMLDivElement | null>(null);
  const joyId = useRef<number | null>(null);
  const lookId = useRef<number | null>(null);
  const lookLast = useRef<{ x: number; y: number } | null>(null);
  const R = 50;

  const moveJoy = (e: React.PointerEvent) => {
    const el = padRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let dx = e.clientX - (rect.left + rect.width / 2);
    let dy = e.clientY - (rect.top + rect.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) {
      dx = (dx / d) * R;
      dy = (dy / d) * R;
    }
    setKnob({ x: dx, y: dy });
    input.setVirtualMove(dx / R, -dy / R);
  };

  const endJoy = () => {
    joyId.current = null;
    setKnob({ x: 0, y: 0 });
    input.setVirtualMove(0, 0);
  };

  // Look layer handlers (full-screen drag area)
  const onLookDown = (e: React.PointerEvent) => {
    if (lookId.current !== null) return;
    lookId.current = e.pointerId;
    lookLast.current = { x: e.clientX, y: e.clientY };
  };
  const onLookMove = (e: React.PointerEvent) => {
    if (lookId.current !== e.pointerId || !lookLast.current) return;
    input.addLook((e.clientX - lookLast.current.x) * 2.1, (e.clientY - lookLast.current.y) * 2.1);
    lookLast.current = { x: e.clientX, y: e.clientY };
  };
  const onLookUp = (e: React.PointerEvent) => {
    if (lookId.current === e.pointerId) {
      lookId.current = null;
      lookLast.current = null;
    }
  };

  // Generic press-and-hold button that simulates a keyboard key.
  const keyBtn = (label: string, code: string, cls = 'h-14 w-14 text-lg') => (
    <button
      className={`hyperion-touchbtn pointer-events-auto flex items-center justify-center rounded-full border border-white/25 bg-black/45 font-black text-white/90 backdrop-blur-[2px] ${cls}`}
      onPointerDown={(e) => {
        e.preventDefault();
        input.pressCode(code);
      }}
      onPointerUp={() => input.releaseCode(code)}
      onPointerLeave={() => input.releaseCode(code)}
      onPointerCancel={() => input.releaseCode(code)}
      aria-label={label}
    >
      {label}
    </button>
  );

  const inTank = !!state.driving?.tank;

  // DIG (on foot, hold) / FIRE (tank tap / horn while driving)
  const digFireBtn = (
    <button
      className="hyperion-touchbtn pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full border border-white/25 bg-black/45 text-xl font-black text-white/90 backdrop-blur-[2px]"
      onPointerDown={(e) => {
        e.preventDefault();
        if (state.driving) input.tapFire();
        else input.setVirtualDig(true);
      }}
      onPointerUp={() => {
        input.setVirtualDig(false);
      }}
      onPointerLeave={() => {
        input.setVirtualDig(false);
      }}
      onPointerCancel={() => {
        input.setVirtualDig(false);
      }}
      aria-label={inTank ? 'fire cannon' : state.driving ? 'horn' : 'dig'}
    >
      {inTank ? '🔥' : state.driving ? '📢' : '⛏'}
    </button>
  );

  // USE / PLACE — tap places a block or uses the item; hold = jetpack thrust.
  const useBtn = (
    <button
      className="hyperion-touchbtn pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/25 bg-black/45 text-lg font-black text-white/90 backdrop-blur-[2px]"
      onPointerDown={(e) => {
        e.preventDefault();
        input.setVirtualUseHold(true);
        input.tapUse();
      }}
      onPointerUp={() => {
        input.setVirtualUseHold(false);
      }}
      onPointerLeave={() => {
        input.setVirtualUseHold(false);
      }}
      onPointerCancel={() => {
        input.setVirtualUseHold(false);
      }}
      aria-label="use item"
    >
      🧱
    </button>
  );

  return (
    <div className="absolute inset-0" style={{ touchAction: 'none' }}>
      {/* Look-drag layer (below all buttons / HUD elements in DOM order) */}
      <div
        className="absolute inset-0"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />

      {/* Analog joystick (bottom-left) */}
      <div
        ref={padRef}
        className="hyperion-touchbtn pointer-events-auto absolute bottom-24 left-5 h-[124px] w-[124px] rounded-full border-2 border-white/20 bg-black/35 backdrop-blur-[2px]"
        onPointerDown={(e) => {
          e.preventDefault();
          joyId.current = e.pointerId;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          moveJoy(e);
        }}
        onPointerMove={(e) => {
          if (joyId.current === e.pointerId) moveJoy(e);
        }}
        onPointerUp={endJoy}
        onPointerCancel={endJoy}
        aria-label="movement joystick"
      >
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="h-12 w-12 rounded-full border border-white/40 bg-white/25 shadow-[0_0_12px_rgba(255,255,255,0.25)] transition-transform duration-75"
            style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
          />
        </div>
        <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] font-black uppercase tracking-widest text-white/40">
          move
        </div>
      </div>

      {/* Action cluster (bottom-right) */}
      <div className="absolute bottom-24 right-5 flex flex-col items-end gap-2">
        <div className="flex items-end gap-2">
          {keyBtn('E', 'KeyE', 'h-12 w-12 text-sm')}
          {keyBtn('M', 'KeyM', 'h-12 w-12 text-sm')}
          {keyBtn('F', 'KeyF', 'h-12 w-12 text-sm')}
        </div>
        <div className="flex items-end gap-2">
          {keyBtn('⬇', 'KeyC', 'h-12 w-12 text-sm')}
          <button
            className={`hyperion-touchbtn pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-black/45 text-sm font-black text-white/90 backdrop-blur-[2px] ${sprintOn ? 'text-amber-300' : ''}`}
            data-active={sprintOn}
            onPointerDown={(e) => {
              e.preventDefault();
              setSprintOn(input.toggleVirtualSprint());
            }}
            aria-label="sprint toggle"
          >
            ⚡
          </button>
          {keyBtn('⬆', 'Space', 'h-14 w-14 text-base')}
          {useBtn}
          {digFireBtn}
        </div>
      </div>
    </div>
  );
}

/** Pause-menu settings block: volume, radio presets, touch toggle. */
function SettingsPanel({ game, state }: { game: HyperionGame; state: HudState }) {
  const [vol, setVol] = useState(Math.round((game.volume ?? 0.8) * 100));
  const [station, setStation] = useState(game.radioStation ?? 0);
  return (
    <div className="mt-3 rounded-lg bg-black/40 p-3 text-left">
      <div className="mb-2 text-[10px] font-black uppercase tracking-[0.25em] text-white/40">Settings</div>
      {/* Master volume */}
      <div className="mb-2.5 flex items-center gap-2">
        <span className="w-14 text-[11px] font-bold text-amber-300/90">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={vol}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVol(v);
            game.setVolume(v / 100);
          }}
          className="hyperion-vol flex-1"
          aria-label="master volume"
        />
        <span className="w-10 text-right text-[11px] tabular-nums text-white/70">{vol}%</span>
      </div>
      {/* Radio presets */}
      <div className="mb-2.5 flex items-center gap-2">
        <span className="w-14 text-[11px] font-bold text-amber-300/90">Radio</span>
        <div className="flex flex-1 flex-wrap gap-1">
          {HyperionAudio.STATIONS.map((s, i) => (
            <button
              key={s.name}
              onClick={() => {
                setStation(i);
                game.setRadioStation(i);
              }}
              className={`rounded px-2 py-1 text-[9px] font-black uppercase tracking-wider transition ${
                station === i ? 'bg-emerald-500/30 text-emerald-200 outline outline-1 outline-emerald-400/50' : 'bg-white/8 text-white/55 hover:bg-white/15'
              }`}
            >
              {i === 0 ? 'OFF' : s.name}
            </button>
          ))}
        </div>
      </div>
      {/* Touch controls */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-amber-300/90">Touch controls</span>
        <button
          onClick={() => game.setTouch(!state.touch)}
          className={`rounded px-3 py-1 text-[10px] font-black uppercase tracking-widest transition ${
            state.touch ? 'bg-cyan-500/25 text-cyan-200 outline outline-1 outline-cyan-400/50' : 'bg-white/10 text-white/50 hover:bg-white/20'
          }`}
        >
          {state.touch ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}

export function Hud(props: HudProps) {
  const { state, toast } = props;

  const itemName = useMemo(() => {
    const it = state.hotbar[state.slot];
    return it ? ITEMS[it.id].name : null;
  }, [state.hotbar, state.slot]);

  return (
    <div className="pointer-events-none fixed inset-0 select-none font-mono">
      {/* damage vignette */}
      <div
        className="absolute inset-0 transition-opacity duration-200"
        style={{
          opacity: state.hurt * 0.55,
          background: 'radial-gradient(ellipse at center, rgba(255,0,0,0) 40%, rgba(180,0,0,0.85) 100%)',
        }}
      />

      {/* cinematic vignette (always on while playing) */}
      {state.playing && (
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 58%, rgba(0,0,0,0.3) 100%)' }}
        />
      )}

      {/* Crosshair */}
      {state.playing && !state.dead && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 mix-blend-difference">
          <div className="relative h-5 w-5">
            <div className="absolute left-1/2 top-0 h-5 w-[2px] -translate-x-1/2 bg-white" />
            <div className="absolute top-1/2 left-0 h-[2px] w-5 -translate-y-1/2 bg-white" />
          </div>
        </div>
      )}

      {/* Hit marker — remounts per hit via key, replaying the pop animation */}
      {state.playing && !state.dead && state.hitMark > 0 && (
        <div key={state.hitMark} className="hyperion-hitmark absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <svg width="26" height="26" viewBox="0 0 26 26">
            <g stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round">
              <line x1="4" y1="4" x2="10" y2="10" />
              <line x1="22" y1="4" x2="16" y2="10" />
              <line x1="4" y1="22" x2="10" y2="16" />
              <line x1="22" y1="22" x2="16" y2="16" />
            </g>
          </svg>
        </div>
      )}

      {/* Police light wash across screen edges (only with active pursuit) */}
      {state.playing && !state.dead && state.police > 0 && <div className="hyperion-policeflash absolute inset-0" />}

      {/* Touch controls (mobile / manually enabled) — below chips in DOM order */}
      {state.playing && !state.dead && !props.paused && !props.inventoryOpen && !props.showStart && state.touch && props.game && (
        <TouchControls game={props.game} state={state} />
      )}

      {/* Contract tracker (top center) */}
      {state.playing && !state.dead && state.mission && <MissionChip mission={state.mission} />}

      {/* Stars — GTA chaos level (top right) */}
      {state.playing && (
        <div className="absolute right-4 top-4 flex flex-col items-end gap-1">
          <Stars count={state.stars} />
          <div className="rounded bg-black/55 px-2 py-0.5 text-right text-[11px] font-bold tracking-widest text-white/90">
            CHAOS {state.score}
          </div>
          <div className="h-1 w-24 overflow-hidden rounded-full bg-black/50">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-500 to-red-400 transition-[width] duration-300"
              style={{ width: `${Math.min(100, ((state.score % 150) / 150) * 100)}%` }}
            />
          </div>
          {state.police > 0 && (
            <div className="hyperion-policechip mt-1 rounded border border-red-400/40 bg-black/60 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.18em] text-red-300">
              🚓 Police ×{state.police}
            </div>
          )}
          {state.heli && <HeliChip />}
          {state.spotted > 0 && <SpottedChip level={state.spotted} />}
          {state.roadblock !== null && <RoadblockChip dist={state.roadblock} />}
          {state.police > 0 && state.evading > 0 && <EvadeChip evading={state.evading} />}
          {(() => {
            const sel = state.hotbar[state.slot];
            const showJet = state.playing && !state.dead && (sel?.id === 'jetpack' || state.jetThrusting);
            return showJet ? <JetFuelChip fuel={state.jetFuel} thrusting={state.jetThrusting} /> : null;
          })()}
          {state.driving && !state.dead && (
            <div className="mt-1 flex justify-end">
              <Speedo driving={state.driving} />
            </div>
          )}
        </div>
      )}

      {/* Depth chip — underground mining readout */}
      {state.playing && !state.dead && state.depth > 0 && (
        <div className="absolute bottom-4 right-4 rounded border border-emerald-400/30 bg-black/65 px-3 py-1.5 text-right">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-300/90">Depth</div>
          <div className="text-lg font-black leading-none text-emerald-200">
            −{state.depth}
            <span className="ml-1 text-[10px] font-bold text-emerald-400/70">M</span>
          </div>
        </div>
      )}

      {/* Quick-hints chip (bottom right) */}
      {state.playing && !state.dead && state.depth <= 0 && (
        <div className="absolute bottom-6 right-4 rounded bg-black/45 px-2.5 py-1 text-right text-[10px] font-bold leading-relaxed tracking-wide text-white/55">
          <div>E INVENTORY · F5 VIEW</div>
          <div>F CAR · M CONTRACT</div>
        </div>
      )}

      {/* Radio chip — animated EQ + station name while driving */}
      {state.playing && !state.dead && state.radio && (
        <div className="absolute bottom-24 right-4 flex items-center gap-2 rounded-lg border border-emerald-400/25 bg-black/65 px-3 py-1.5">
          <EqBars />
          <div>
            <div className="text-[9px] font-bold uppercase tracking-[0.22em] text-emerald-300/80">Radio · R</div>
            <div className="text-[11px] font-black leading-tight text-white/90">{state.radio}</div>
          </div>
        </div>
      )}

      {/* Weather chip — above the minimap */}
      {state.playing && !state.dead && <div className="absolute bottom-[172px] left-4"><WeatherChip weather={state.weather} /></div>}

      {/* Minimap — GTA style bottom-left */}
      {state.playing && (
        <div className="absolute bottom-4 left-4 overflow-hidden rounded-lg border-2 border-black/70 shadow-lg shadow-black/50">
          <canvas id="hyperion-minimap" width={208} height={140} className="block bg-black" />
          <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/10" />
        </div>
      )}

      {/* Debug (F3) */}
      {state.debug && state.playing && (
        <div className="absolute left-4 top-4 space-y-0.5 rounded bg-black/60 px-3 py-2 text-[11px] leading-relaxed text-emerald-200">
          <div className="font-bold text-white">PROJECT HYPERION · debug</div>
          <div>FPS: {state.fps}</div>
          <div>
            XYZ: {state.pos[0].toFixed(1)} / {state.pos[1].toFixed(1)} / {state.pos[2].toFixed(1)}
          </div>
          <div>Depth: {state.depth} m</div>
          <div>Micro-voxels carved: {state.removed.toLocaleString()}</div>
          <div>Mode: {state.driving ? 'driving' : state.flying ? 'creative flight' : 'walking'}</div>
        </div>
      )}

      {/* Hint */}
      {state.hint && state.playing && !state.dead && (
        <div className="absolute bottom-32 left-1/2 -translate-x-1/2 rounded bg-black/60 px-4 py-1.5 text-sm font-bold text-white/90">
          {state.hint}
        </div>
      )}

      {/* Actionbar toast + selected item name */}
      <div className="absolute bottom-28 left-1/2 -translate-x-1/2 text-center">
        {toast && !toast.startsWith('__') && (
          <div
            key={toast}
            className="hyperion-toast rounded bg-black/65 px-4 py-1.5 text-sm font-bold text-white [text-shadow:1px_1px_0_#000]"
          >
            {toast}
          </div>
        )}
      </div>

      {/* Bottom center: hearts + hotbar */}
      {state.playing && !state.dead && (
        <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2">
          <div className="mb-1 flex items-end justify-between px-1">
            <Hearts health={state.health} />
            <div className="text-[11px] font-bold text-white/85 [text-shadow:1px_1px_0_#000]">
              {state.flying ? '✦ CREATIVE FLIGHT' : itemName ? itemName : ''}
            </div>
          </div>
          <div className="flex gap-[3px] rounded border-2 border-black/60 bg-black/40 p-[3px]">
            {state.hotbar.map((s, i) => (
              <Slot key={i} stack={s} selected={i === state.slot} onClick={() => props.onSlotClick(i)} />
            ))}
          </div>
        </div>
      )}

      {/* Inventory overlay */}
      {props.inventoryOpen && (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
          <div className="w-[430px] max-w-[92vw] rounded-lg border-4 border-[#1d1d1f] bg-[#c6c6c6] p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-black tracking-wide text-[#3a3a3a]">Inventory</div>
              <button
                onClick={props.onCloseInventory}
                className="rounded bg-[#8b8b8b] px-3 py-1 text-sm font-bold text-white hover:bg-[#9c9c9c]"
              >
                Close (E)
              </button>
            </div>
            <div className="grid grid-cols-9 gap-[3px]">
              {state.inventory.map((s, i) => (
                <Slot key={i} stack={s} onClick={() => props.onInventorySwap(i)} size={44} />
              ))}
            </div>
            <div className="my-3 h-[2px] bg-[#8b8b8b]" />
            <div className="grid grid-cols-9 gap-[3px]">
              {state.hotbar.map((s, i) => (
                <Slot key={i} stack={s} selected={i === state.slot} onClick={() => props.onSlotClick(i)} size={44} />
              ))}
            </div>
            <div className="mt-3 text-center text-[11px] font-bold text-[#555]">
              Click an item to swap it into the selected hotbar slot
            </div>
          </div>
        </div>
      )}

      {/* Pause menu */}
      {props.paused && !props.showStart && !state.dead && (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/65 backdrop-blur-sm">
          <div className="w-[440px] max-w-[94vw] rounded-xl border border-white/10 bg-[#141416]/95 p-6 text-center shadow-2xl">
            <div className="mb-1 text-xs font-bold uppercase tracking-[0.3em] text-amber-400/90">Paused</div>
            <div className="mb-5 text-3xl font-black italic tracking-tight text-white">PROJECT HYPERION</div>
            <button
              onClick={props.onResume}
              className="mb-4 w-full rounded-lg bg-amber-500 py-3 text-lg font-black text-black transition hover:bg-amber-400 active:scale-[0.98]"
            >
              RESUME
            </button>
            <button
              onClick={props.onSave}
              className="mb-4 w-full rounded-lg border border-emerald-400/40 bg-emerald-500/15 py-2 text-sm font-black uppercase tracking-widest text-emerald-300 transition hover:bg-emerald-500/25 active:scale-[0.98]"
            >
              💾 Save world
            </button>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-black/40 p-3 text-left text-[11px] text-white/75">
              {CONTROLS.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="font-bold text-amber-300/90">{k}</span>
                  <span className="text-right">{v}</span>
                </div>
              ))}
            </div>
            {props.game && <SettingsPanel game={props.game} state={state} />}
          </div>
        </div>
      )}

      {/* Death screen */}
      {state.dead && (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-red-950/70 backdrop-blur-sm">
          <div className="text-center">
            <div className="mb-2 text-5xl font-black tracking-tight text-red-200 [text-shadow:3px_3px_0_#000]">
              You died!
            </div>
            <div className="mb-6 text-sm font-bold text-red-100/80">
              Chaos score: {state.score} · Voxels carved: {state.removed.toLocaleString()}
            </div>
            <button
              onClick={props.onRespawn}
              className="rounded-lg bg-white px-8 py-3 text-lg font-black text-red-900 transition hover:bg-red-100 active:scale-[0.98]"
            >
              RESPAWN
            </button>
          </div>
        </div>
      )}

      {/* Start screen */}
      {props.showStart && (
        <div className="pointer-events-auto absolute inset-0 overflow-hidden">
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: 'url(/hyperion-splash.png)' }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/55 to-black/30" />
          <div className="relative flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.5em] text-amber-400">
              Los Santos · Micro-Voxel Engine
            </div>
            <h1 className="mb-3 text-6xl font-black italic leading-none tracking-tighter text-white drop-shadow-[0_4px_0_rgba(0,0,0,0.8)] md:text-8xl">
              PROJECT
              <span className="ml-4 text-amber-400">HYPERION</span>
            </h1>
            <p className="mb-8 max-w-xl text-sm leading-relaxed text-white/80 md:text-base">
              A photoreal GTA-style open city, tunneled apart by Minecraft freedom. Every building, road and
              sidewalk is a dense micro-voxel lattice — dig through downtown with your pickaxe, rig engines with
              flint &amp; steel, build sky-bridges from smooth dirt slabs, and fly like creative mode. Contract
              chains unlock the 🔥 Chaos Jetpack, then the 🪖 Rhino Tank — but at five stars a police chopper
              joins the hunt, and only the tunnels can hide you. At four stars the cops set 🚧 roadblocks with
              spike strips that wreck your tires. Too hot? Drive into a 🎨 Pay&apos;n&apos;Spray bay to respray,
              get new rubber and lose the heat — or blow a 💧 hydrant and watch the main geyser douse the chaos.
            </p>
            {state.hasSave && (
              <button
                onClick={props.onContinue}
                className="mb-3 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-10 py-2.5 text-base font-black tracking-wide text-emerald-300 transition hover:bg-emerald-500/25 active:scale-[0.98]"
              >
                ⟳ CONTINUE SAVED CITY
              </button>
            )}
            <button
              onClick={props.onPlay}
              className="mb-8 rounded-lg bg-amber-500 px-14 py-4 text-2xl font-black tracking-wide text-black shadow-[0_6px_0_#8a5a00] transition hover:bg-amber-400 active:translate-y-[3px] active:shadow-[0_3px_0_#8a5a00]"
            >
              ▶ NEW GAME
            </button>
            <div className="grid max-w-2xl grid-cols-2 gap-x-8 gap-y-1 rounded-xl bg-black/55 p-4 text-left text-[11px] text-white/75 md:grid-cols-3">
              {CONTROLS.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="font-bold text-amber-300/90">{k}</span>
                  <span className="text-right">{v}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 text-[10px] uppercase tracking-widest text-white/40">
              Desktop · Touch supported (Settings → Touch) · Mouse &amp; Keyboard · WebGL2 — inspired by GTA-V
              decompiled scripts &amp; Minecraft
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
