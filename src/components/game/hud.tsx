'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import * as THREE from 'three';
import { HudState, ItemStack, ItemId } from './engine/types';
import { ICON_URLS, ITEMS, UI_ICONS } from './engine/items';
import { HyperionAudio } from './engine/audio';
import type { HyperionGame } from './engine/game';
import type { Player } from './engine/player';
import { clearSkinChoice, fetchTlauncherSkin, saveSkinChoice } from './engine/skin';

/** Hotbar slot — classic MC dark cell: translucent black fill, inset 2px borders
 *  (dark top/left #2b2b2b, light bottom/right #5a5a5a) + 1px black outer ring. Sharp corners. */
const HOTBAR_SLOT =
  'relative flex items-center justify-center border-2 border-t-[#2b2b2b] border-l-[#2b2b2b] border-b-[#5a5a5a] border-r-[#5a5a5a] ring-1 ring-black/35 bg-[rgba(0,0,0,0.42)]';

/** Inventory slot — classic MC creative gray cell: #8b8b8b fill, inset 2px borders
 *  (dark top/left #373737, light bottom/right #ffffff). Sharp corners. */
const INV_SLOT =
  'group relative flex items-center justify-center border-2 border-t-[#373737] border-l-[#373737] border-b-[#ffffff] border-r-[#ffffff] bg-[#8b8b8b]';

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
  variant = 'hotbar',
  infinite = false,
}: {
  stack: ItemStack | null;
  selected?: boolean;
  onClick?: () => void;
  size?: number;
  variant?: 'hotbar' | 'inventory';
  infinite?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`${variant === 'hotbar' ? HOTBAR_SLOT : INV_SLOT} ${selected ? 'z-10' : ''}`}
      style={{ width: size, height: size }}
      aria-label={stack ? ITEMS[stack.id].name : 'empty slot'}
    >
      {stack && <ItemIcon id={stack.id} size={size - 12} />}
      {stack && (infinite || stack.count > 1) && (
        <span className="absolute bottom-0 right-1 text-white text-[13px] font-bold leading-none [text-shadow:2px_2px_0_#000]">
          {infinite ? '∞' : stack.count}
        </span>
      )}
      {/* inventory hover highlight */}
      {variant === 'inventory' && (
        <span className="pointer-events-none absolute inset-0 z-10 hidden bg-white/40 group-hover:block" aria-hidden />
      )}
      {/* iconic MC white selection frame — 3px, extends ~3px past the slot bounds with a soft white glow */}
      {selected && (
        <span
          className="pointer-events-none absolute -inset-[3px] z-20 border-[3px] border-[#f0f0f0]"
          style={{ boxShadow: '0 0 8px rgba(255,255,255,0.45)' }}
          aria-hidden
        />
      )}
    </button>
  );
}

function Hearts({ health, maxHealth = 20 }: { health: number; maxHealth?: number }) {
  const total = Math.max(10, Math.ceil(maxHealth / 2));
  const hearts: ReactNode[] = [];
  for (let i = 0; i < total; i++) {
    const full = health >= (i + 1) * 2;
    hearts.push(
      <img
        key={i}
        src={full ? UI_ICONS.heartFull : UI_ICONS.heartEmpty}
        alt={full ? 'heart' : 'empty heart'}
        width={18}
        height={18}
        style={{ imageRendering: 'pixelated', filter: 'drop-shadow(1px 1px 0 #000)' }}
        draggable={false}
      />
    );
  }
  return <div className="flex gap-[2px]">{hearts}</div>;
}

/** Pixel-art drumstick (9×9) for the decorative hunger bar — brown meat blob top-left,
 *  lighter highlight, tan bone running to the bottom-right, dark outline. Built once, cached. */
let DRUMSTICK_URL: string | null = null;
function drumstickIconURL(): string {
  if (DRUMSTICK_URL) return DRUMSTICK_URL;
  if (typeof document === 'undefined') return '';
  const rows = [
    '..ooooo..',
    '.ohmmmmo.',
    '.ohmmmmo.',
    '.ommmmmo.',
    '..ommmo..',
    '....obo..',
    '.....obo.',
    '.....obbo',
    '.....oooo',
  ];
  const palette: Record<string, string> = {
    o: '#3b2a1e', // dark outline
    m: '#b5654a', // brown meat
    h: '#d8936e', // meat highlight
    b: '#e8dcc0', // tan bone
  };
  const cv = document.createElement('canvas');
  cv.width = 9;
  cv.height = 9;
  const ctx = cv.getContext('2d')!;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const color = palette[rows[y][x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  DRUMSTICK_URL = cv.toDataURL();
  return DRUMSTICK_URL;
}

/** Hunger bar — decorative & always full: 10 drumsticks on the right side of the survival
 *  row, each flipped so the bone points bottom-left (mirroring the hearts side, like MC). */
function HungerBar() {
  const url = drumstickIconURL();
  if (!url) return null;
  const drumsticks: ReactNode[] = [];
  for (let i = 0; i < 10; i++) {
    drumsticks.push(
      <img
        key={i}
        src={url}
        alt=""
        width={18}
        height={18}
        style={{ imageRendering: 'pixelated', filter: 'drop-shadow(1px 1px 0 #000)', transform: 'scaleX(-1)' }}
        draggable={false}
      />
    );
  }
  return (
    <div className="flex gap-[2px]" aria-hidden>
      {drumsticks}
    </div>
  );
}

/** XP bar — 6px MC-style bar spanning exactly the hotbar width. Driven by the chaos score:
 *  level = floor(score / 100), progress = (score % 100) / 100. */
function XpBar({ score }: { score: number }) {
  const level = Math.floor(score / 100);
  const progress = (score % 100) / 100;
  return (
    <div className="relative mb-[3px] h-[6px] w-full border border-black bg-[#1c1c1c]">
      <div
        className="h-full"
        style={{ width: `${progress * 100}%`, background: '#7efc20', boxShadow: 'inset 0 1px 0 rgba(216,255,150,0.85)' }}
      />
      {/* level number centered on the bar — bright green with a heavy black outline (MC style) */}
      <span
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] font-bold leading-none tabular-nums text-[#7efc20]"
        style={{
          textShadow:
            '1px 0 0 #000, -1px 0 0 #000, 0 1px 0 #000, 0 -1px 0 #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000',
        }}
      >
        {level}
      </span>
    </div>
  );
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

/** Creative/Survival mode chip (top-left) — J toggles. */
function ModeChip({ mode }: { mode: 'survival' | 'creative' }) {
  const creative = mode === 'creative';
  return (
    <div
      className={`absolute left-4 top-4 rounded border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.22em] ${
        creative
          ? 'border-amber-300/60 bg-amber-400/15 text-amber-200 [text-shadow:0_0_10px_rgba(255,200,60,0.55)]'
          : 'border-white/20 bg-black/55 text-white/60'
      }`}
    >
      {creative ? '✦ Creative · J' : '⛏ Survival · J'}
    </div>
  );
}

/** NPC dialogue bubble (E near an NPC) — speaker name + line + procedural voice. */
function DialogueBubble({ dialogue }: { dialogue: NonNullable<HudState['dialogue']> }) {
  const tone =
    dialogue.kind === 'gang'
      ? 'border-purple-400/50 text-purple-200'
      : dialogue.kind === 'boss'
        ? 'border-red-500/60 text-red-200'
        : dialogue.kind === 'cop'
          ? 'border-sky-400/50 text-sky-200'
          : 'border-white/25 text-white/90';
  return (
    <div className="hyperion-dialogue absolute bottom-[132px] left-1/2 w-[440px] max-w-[86vw] -translate-x-1/2 rounded-lg border bg-black/75 px-4 py-2 backdrop-blur-[2px]">
      <div className={`text-[10px] font-black uppercase tracking-[0.2em] ${tone}`}>{dialogue.name}</div>
      <div className="mt-0.5 text-[12px] font-bold leading-snug text-white/90 [text-shadow:1px_1px_0_#000]">
        “{dialogue.text}”
      </div>
    </div>
  );
}

/** Boss health bar (top center, under the mission chip). */
function BossBar({ boss }: { boss: NonNullable<HudState['boss']> }) {
  const pct = Math.max(0, Math.min(100, (boss.hp / boss.maxHp) * 100));
  return (
    <div className="absolute left-1/2 top-16 w-[360px] max-w-[80vw] -translate-x-1/2">
      <div className="mb-1 text-center text-[10px] font-black uppercase tracking-[0.24em] text-red-300 [text-shadow:1px_1px_0_#000]">
        👑 {boss.name}
      </div>
      <div className="h-[10px] w-full overflow-hidden rounded-sm border border-black/70 bg-black/60">
        <div
          className="hyperion-bossbar h-full"
          style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#7f1d1d,#ef4444,#fca5a5)' }}
        />
      </div>
    </div>
  );
}

/** Cinematic cutscene overlay: letterbox bars + title cards + skip hint. */
function CutsceneOverlay({ cutscene }: { cutscene: NonNullable<HudState['cutscene']> }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      <div className="absolute inset-x-0 top-0 h-[13vh] bg-black" />
      <div className="absolute inset-x-0 bottom-0 h-[13vh] bg-black" />
      <div className="absolute inset-x-0 top-[20vh] text-center">
        <div className="text-4xl font-black italic tracking-tight text-white [text-shadow:2px_3px_0_rgba(0,0,0,0.7)]">
          {cutscene.title}
        </div>
        <div className="mt-2 text-[12px] font-bold uppercase tracking-[0.34em] text-amber-300/90">
          {cutscene.sub}
        </div>
        <div className="mt-6 text-[10px] font-bold uppercase tracking-[0.3em] text-white/40">
          Space / click — skip
        </div>
      </div>
    </div>
  );
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
  ['J', 'Creative ⇄ Survival — infinite inventory + invulnerable'],
  ['E', 'Inventory — or talk to an NPC when close'],
  ['RMB 🚀 RPG', 'Fire the rocket launcher'],
  ['Space ×2', 'Toggle creative flight'],
  ['Space / C', 'Fly up / down'],
  ['Shift', 'Sprint'],
  ['1–9 / Wheel', 'Select hotbar slot'],
  ['F', 'Enter / exit car'],
  ['M', 'Accept / quit contract'],
  ["🎨 Drive in", "Pay'n'Spray — clear heat + repair"],
  ['🛞 Spike strips', '4★ roadblocks shred tires — respray to fix'],
  ['🛫 Stunt ramps', 'Hit them at speed — air time = CHAOS'],
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
          {offer ? 'Reward' : `${mission.target % 1 === 0 ? mission.progress : mission.progress.toFixed(1)} / ${mission.target}`}
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

/** AIR TIME overlay — live counter while airborne + scored landing pop.
 *  The pop unmounts when the engine clears it (airPop null) after 2.2 s. */
function AirTimeOverlay({ air, best, pop }: { air: number; best: number; pop: HudState['airPop'] }) {
  const live = air > 0.12;
  if (!live && !pop) return null;
  return (
    <div className="pointer-events-none absolute bottom-[31%] left-1/2 z-10 -translate-x-1/2 text-center">
      {live ? (
        <div className="hyperion-airlive">
          <div className="text-[10px] font-black uppercase tracking-[0.4em] text-amber-300 drop-shadow-[0_1px_0_rgba(0,0,0,0.8)]">
            Air time
          </div>
          <div className="bg-gradient-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-5xl font-black italic leading-none tabular-nums text-transparent drop-shadow-[0_3px_0_rgba(0,0,0,0.65)]">
            {air.toFixed(1)}
            <span className="text-2xl">s</span>
          </div>
          {best > 0 && (
            <div className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.2em] text-white/55">best {best.toFixed(1)}s</div>
          )}
        </div>
      ) : pop ? (
        <div key={pop.key} className="hyperion-airpop">
          <div className="bg-gradient-to-b from-emerald-100 via-emerald-300 to-emerald-500 bg-clip-text text-4xl font-black italic leading-none text-transparent drop-shadow-[0_3px_0_rgba(0,0,0,0.65)]">
            +{pop.score} CHAOS
          </div>
          <div className="mt-1 text-[11px] font-black uppercase tracking-[0.22em] text-amber-300 drop-shadow-[0_1px_0_rgba(0,0,0,0.8)]">
            🛫 {pop.sec.toFixed(1)}s air time{pop.record ? ' · 🏆 NEW RECORD!' : ''}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Vehicle speedometer — SVG arc gauge + hull integrity + tank cannon reload. */
function Speedo({ driving, air }: { driving: NonNullable<HudState['driving']>; air: number }) {
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
        <span className="flex items-center gap-1">
          {air > 0.12 && (
            <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-amber-300">
              🪂 Airborne
            </span>
          )}
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
        </span>
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
  const [gfx, setGfx] = useState(game.graphics ?? 'auto');
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
      {/* Graphics quality preset */}
      <div className="mb-2.5 flex items-center gap-2">
        <span className="w-14 text-[11px] font-bold text-amber-300/90">Graphics</span>
        <div className="flex flex-1 flex-wrap gap-1">
          {(['auto', 'low', 'medium', 'high'] as const).map((p) => (
            <button
              key={p}
              onClick={() => {
                setGfx(p);
                game.setGraphics(p);
              }}
              className={`rounded px-2 py-1 text-[9px] font-black uppercase tracking-wider transition ${
                gfx === p ? 'bg-amber-500/30 text-amber-200 outline outline-1 outline-amber-400/50' : 'bg-white/8 text-white/55 hover:bg-white/15'
              }`}
            >
              {p === 'auto' ? 'AUTO ✨' : p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {/* Touch controls */}
      <div className="mb-2.5 flex items-center justify-between">
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
      {/* Bloom glow (cinematic post-processing) */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-amber-300/90">✨ Bloom glow</span>
        <button
          onClick={() => game.setBloom(!game.bloom)}
          className={`rounded px-3 py-1 text-[10px] font-black uppercase tracking-widest transition ${
            game.bloom ? 'bg-fuchsia-500/25 text-fuchsia-200 outline outline-1 outline-fuchsia-400/50' : 'bg-white/10 text-white/50 hover:bg-white/20'
          }`}
        >
          {game.bloom ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}

/** Inventory tabs — the Character tab (survival-style layout: player preview +
 *  skin picker + full grid) plus the creative kind-filter tabs (`kinds`). */
const INV_TABS: Array<{ id: string; label: string; kinds: string[] | null }> = [
  { id: 'character', label: '🧍 Character', kinds: null },
  { id: 'blocks', label: '🧱 Blocks', kinds: ['placeable', 'tnt'] },
  { id: 'tools', label: '⚔️ Tools', kinds: ['tool', 'weapon', 'igniter'] },
  { id: 'misc', label: '🍎 Misc', kinds: ['food', 'throwable', 'jetpack'] },
];

/** Live 3D preview of the character — a mini offscreen renderer showing the
 *  installed skin (base + overlay layers). Drag to rotate, Minecraft-inventory
 *  style. Rebuilt whenever the applied skin changes (skinKey). */
function SkinPreview({ player, skinKey }: { player: Player | null; skinKey: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const rootRef = useRef<THREE.Group | null>(null);
  const yawRef = useRef(0.55);

  // One-time renderer/scene setup (disposed on unmount).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = 168;
    const H = 236;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(38, W / H, 0.1, 60);
    cam.position.set(0, 1, 3);
    cam.lookAt(0, 0.98, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.92));
    const key = new THREE.DirectionalLight(0xfff1dc, 1.2);
    key.position.set(1.6, 2.6, 2.4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9db4ff, 0.5);
    rim.position.set(-2.2, 1.8, -1.6);
    scene.add(rim);
    const root = new THREE.Group();
    scene.add(root);
    rootRef.current = root;
    const render = () => {
      root.rotation.y = yawRef.current;
      renderer.render(scene, cam);
    };
    renderRef.current = render;
    // QA debug handle (harmless in production — mirrors window.__hyperion).
    (window as unknown as Record<string, unknown>).__hyperionSkinPreview = { root, cam, render };
    // Drag to rotate the model (pointer capture keeps it smooth).
    let dragging = false;
    let lastX = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yawRef.current += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
      renderRef.current();
    };
    const up = () => {
      dragging = false;
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    render();
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      root.clear();
      renderer.dispose();
      rootRef.current = null;
      renderRef.current = () => {};
    };
  }, []);

  // Rebuild the model clone whenever the skin changes (materials are shared
  // with the live player — a fresh clone picks up the new materials).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.clear();
    if (player) {
      const clone = player.group.clone(true);
      clone.visible = true; // the live group is hidden in first person
      // Strip the player's live world transform — the clone would otherwise
      // render ~14 units away from the preview camera (out of frame).
      clone.position.set(0, 0, 0);
      clone.rotation.set(0, 0, 0);
      clone.updateMatrixWorld(true);
      root.add(clone);
    }
    renderRef.current();
  }, [player, skinKey]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Character preview — drag to rotate"
      className="block cursor-grab touch-none"
      style={{
        width: 168,
        height: 236,
        background: 'linear-gradient(rgba(0,0,0,0.10), rgba(0,0,0,0) 60%), #b3b3b3',
        boxShadow: 'inset 2px 2px 0 rgba(255,255,255,0.5), inset -2px -2px 0 rgba(0,0,0,0.14)',
      }}
    />
  );
}

/** MC-styled skin picker — load the user's own TLauncher skin by nickname
 *  (proxied through /api/skin), upload a skin PNG, or reset to default.
 *  The choice is persisted to localStorage and restored on next boot. */
function SkinPicker({ game, skin }: { game: HyperionGame | null; skin: HudState['skin'] }) {
  const [nick, setNick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const loadTlauncher = async (): Promise<void> => {
    const name = nick.trim();
    if (!name || !game || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { model, png } = await fetchTlauncherSkin(name);
      const ok = await game.applySkinPng(png, model, 'tlauncher', name);
      if (!ok) setErr('TLauncher returned an unusable skin file.');
      else saveSkinChoice({ source: 'tlauncher', name, model, png });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !game) return;
    setErr(null);
    const fr = new FileReader();
    fr.onload = () => {
      const png = String(fr.result);
      void game.applySkinPng(png, 'auto', 'file', f.name).then((ok) => {
        if (ok) saveSkinChoice({ source: 'file', name: f.name, model: game.skinInfo.model, png });
        else setErr('Not a valid skin PNG — must be 64×64 or 64×32.');
      });
    };
    fr.onerror = () => setErr('Could not read that file.');
    fr.readAsDataURL(f);
  };

  const reset = (): void => {
    game?.resetSkin();
    clearSkinChoice();
    setErr(null);
  };

  const btn =
    'border-2 border-t-[#ffffff] border-l-[#ffffff] border-b-[#4a4a4a] border-r-[#4a4a4a] bg-[#8b8b8b] text-[12px] font-bold text-[#1c1c1c] transition-colors hover:bg-[#a3a3a3] active:translate-y-[1px] disabled:opacity-60';

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="text-center text-[11px] font-bold text-[#3f3f3f]">
        {skin.source === 'default'
          ? 'Default Hyperion skin'
          : `${skin.name ?? 'file'} · ${skin.model === 'slim' ? 'slim' : 'classic'} model`}
      </div>
      <div className="flex gap-[3px]">
        <input
          value={nick}
          onChange={(e) => setNick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void loadTlauncher();
            }
          }}
          placeholder="TLauncher nickname"
          disabled={busy}
          maxLength={32}
          className="min-w-0 flex-1 border-2 border-t-[#373737] border-l-[#373737] border-b-[#ffffff] border-r-[#ffffff] bg-[#8b8b8b] px-2 py-[5px] text-[12px] font-bold text-[#1c1c1c] placeholder:text-[#5a5a5a] focus:outline-none"
        />
        <button onClick={() => void loadTlauncher()} disabled={busy || !game} className={`${btn} px-2 py-[5px]`}>
          {busy ? '…' : 'Load'}
        </button>
      </div>
      <div className="flex gap-[3px]">
        <button onClick={() => fileRef.current?.click()} disabled={!game} className={`${btn} flex-1 py-[5px]`}>
          📁 Upload .png
        </button>
        <button onClick={reset} disabled={!game} aria-label="Reset to default skin" className={`${btn} px-2 py-[5px]`}>
          ↺
        </button>
        <input ref={fileRef} type="file" accept="image/png" className="hidden" onChange={onFile} />
      </div>
      {err && <div className="text-center text-[11px] font-bold text-[#a01616]">{err}</div>}
    </div>
  );
}

/** Minecraft inventory — raised-bevel gray panel with the Character tab
 *  (survival-style: live 3D player preview + skin picker + full grid + hotbar)
 *  and the creative kind-filter tabs. All swap/close behavior unchanged. */
function InventoryOverlay({
  state,
  game,
  onInventorySwap,
  onSlotClick,
  onCloseInventory,
}: {
  state: HudState;
  game: HyperionGame | null;
  onInventorySwap: (i: number) => void;
  onSlotClick: (i: number) => void;
  onCloseInventory: () => void;
}) {
  const [tabId, setTabId] = useState('character');
  const tab = INV_TABS.find((t) => t.id === tabId) ?? INV_TABS[0];
  const filtered = useMemo(() => {
    if (!tab.kinds) return [];
    const kinds = new Set<string>(tab.kinds);
    return state.inventory
      .map((stack, index) => ({ stack, index }))
      .filter(({ stack }) => stack !== null && kinds.has(ITEMS[stack.id].kind));
  }, [state.inventory, tab.kinds]);
  const skinKey = `${state.skin.source}:${state.skin.name}:${state.skin.model}`;

  return (
    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div
        className={`flex ${tab.kinds === null ? 'w-[660px]' : 'w-[470px]'} min-w-[340px] max-w-[94vw] flex-col`}
      >
        {/* tabs — attached to the panel top (active tab merges with the panel face) */}
        <div className="relative z-10 -mb-[2px] flex items-end gap-[2px] pl-3">
          {INV_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTabId(t.id)}
              className={`rounded-t-[6px] border-2 border-b-0 border-black px-3 pb-2 pt-1 text-[12px] font-bold text-black transition-colors ${
                t.id === tabId ? 'bg-[#c6c6c6]' : 'bg-[#8b8b8b] hover:bg-[#9c9c9c]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* panel — 2px black outer border + raised bevel (light top/left, dark bottom/right) */}
        <div className="border-2 border-black bg-[#c6c6c6] shadow-2xl shadow-black/60">
          <div className="hyperion-mc-scroll max-h-[calc(82vh-52px)] overflow-y-auto border-[3px] border-t-[#ffffff] border-l-[#ffffff] border-b-[#555555] border-r-[#555555] p-4 md:p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-black tracking-wide text-[#3f3f3f]">
                {tab.kinds === null ? 'Inventory' : 'Creative Inventory'}
              </div>
              {/* MC beveled close button */}
              <button
                onClick={onCloseInventory}
                aria-label="Close inventory"
                className="flex h-7 w-7 items-center justify-center border-2 border-t-[#ffffff] border-l-[#ffffff] border-b-[#4a4a4a] border-r-[#4a4a4a] bg-[#8b8b8b] text-[13px] font-black leading-none text-[#1c1c1c] transition-colors hover:bg-[#a3a3a3] active:translate-y-[1px] active:border-b-[#ffffff] active:border-l-[#4a4a4a] active:border-r-[#ffffff] active:border-t-[#4a4a4a]"
              >
                ✕
              </button>
            </div>

            {tab.kinds === null ? (
              /* ---- Character tab: player preview + skin picker + full grid + hotbar ---- */
              <div className="flex flex-col gap-4 md:flex-row">
                <div className="flex w-[184px] shrink-0 flex-col items-center gap-3">
                  <SkinPreview player={game?.player ?? null} skinKey={skinKey} />
                  <SkinPicker game={game} skin={state.skin} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  {/* full 18-slot main grid (2 × 9) — original indices */}
                  <div className="flex flex-col gap-[3px]">
                    {[0, 1].map((row) => (
                      <div key={row} className="flex gap-[3px]">
                        {state.inventory.slice(row * 9, row * 9 + 9).map((s, i) => (
                          <Slot
                            key={row * 9 + i}
                            stack={s}
                            onClick={() => onInventorySwap(row * 9 + i)}
                            size={44}
                            variant="inventory"
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="my-3 h-[2px] bg-[#8b8b8b]" />
                  {/* hotbar mirror row — white selection frame on the active slot */}
                  <div className="flex flex-wrap gap-[3px]">
                    {state.hotbar.map((s, i) => (
                      <Slot
                        key={i}
                        stack={s}
                        selected={i === state.slot}
                        onClick={() => onSlotClick(i)}
                        size={44}
                        variant="inventory"
                      />
                    ))}
                  </div>
                  <div className="mt-3 text-center text-[11px] font-bold text-[#555555]">
                    Drag the model to rotate · click an item to swap it into the selected hotbar slot
                  </div>
                </div>
              </div>
            ) : (
              /* ---- creative kind-filter tabs ---- */
              <>
                {filtered.length > 0 ? (
                  <div className="flex flex-wrap content-start gap-[3px]">
                    {filtered.map(({ stack, index }) => (
                      <Slot key={index} stack={stack} onClick={() => onInventorySwap(index)} size={44} variant="inventory" />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-[124px] items-center justify-center border-2 border-t-[#373737] border-l-[#373737] border-b-[#ffffff] border-r-[#ffffff] bg-[#8b8b8b] text-[12px] font-bold text-[#2c2c2c]">
                    Nothing in this tab yet
                  </div>
                )}
                <div className="my-3 h-[2px] bg-[#8b8b8b]" />
                {/* hotbar mirror row — same MC inset slots + white selection frame */}
                <div className="flex flex-wrap gap-[3px]">
                  {state.hotbar.map((s, i) => (
                    <Slot
                      key={i}
                      stack={s}
                      selected={i === state.slot}
                      onClick={() => onSlotClick(i)}
                      size={44}
                      variant="inventory"
                    />
                  ))}
                </div>
                <div className="mt-3 text-center text-[11px] font-bold text-[#555555]">
                  Click an item to swap it into the selected hotbar slot
                </div>
              </>
            )}
          </div>
        </div>
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
      {/* cutscene letterbox + title cards (intro flyover / boss reveal) */}
      {state.cutscene && state.playing && <CutsceneOverlay cutscene={state.cutscene} />}

      {/* creative/survival transform flash — golden burst that fades fast */}
      {state.modeFlash > 0 && (
        <div
          className="hyperion-modeflash pointer-events-none fixed inset-0"
          style={{ opacity: state.modeFlash }}
        />
      )}

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

      {/* Mode chip (top-left) + boss bar (top center under mission) */}
      {state.playing && !state.cutscene && <ModeChip mode={state.mode} />}
      {state.playing && !state.dead && state.boss && <BossBar boss={state.boss} />}

      {/* NPC dialogue bubble */}
      {state.playing && !state.dead && state.dialogue && <DialogueBubble dialogue={state.dialogue} />}

      {/* Stars — GTA chaos level (top right) */}
      {state.playing && (
        <div className="absolute right-4 top-4 flex flex-col items-end gap-1">
          <Stars count={state.stars} />
          <div className="rounded-sm bg-black/55 px-2.5 py-0.5 text-right">
            <span className="mr-1.5 align-middle text-[9px] font-black tracking-[0.22em] text-white/45">CHAOS</span>
            <span
              className="text-[17px] font-black italic tabular-nums text-[#7bde7b]"
              style={{ fontFamily: '"Arial Black", Arial, sans-serif', textShadow: '1px 2px 0 #0b3d0b, 2px 3px 3px rgba(0,0,0,0.65)' }}
            >
              ${state.score.toLocaleString()}
            </span>
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
              <Speedo driving={state.driving} air={state.air} />
            </div>
          )}
        </div>
      )}

      {/* AIR TIME — live airborne counter + scored landing pop */}
      {state.playing && !state.dead && <AirTimeOverlay air={state.air} best={state.airBest} pop={state.airPop} />}

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
          <div>E INVENTORY · F5 VIEW · J MODE</div>
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

      {/* Minimap — GTA style bottom-left: thick frame, clock strip, health bar */}
      {state.playing && (
        <div className="absolute bottom-4 left-4">
          <div className="overflow-hidden rounded-md border-[3px] border-black/85 shadow-xl shadow-black/60">
            <div className="relative">
              <canvas id="hyperion-minimap" width={208} height={140} className="block bg-black" />
              {/* Clock + city strip over the map top */}
              <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/80 to-transparent px-1.5 pb-2 pt-0.5">
                <span className="text-[9px] font-black tabular-nums tracking-[0.18em] text-white/85">{state.clock}</span>
                <span className="text-[8px] font-black tracking-[0.24em] text-white/45">LOS SANTOS</span>
              </div>
              <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/10" />
            </div>
            {/* GTA5-style health strip under the map */}
            <div className="w-full bg-black/85 px-[3px] py-[2px]">
              <div className="h-[4px] w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full transition-[width] duration-200"
                  style={{
                    width: `${Math.max(0, Math.min(1, state.health / Math.max(1, state.maxHealth))) * 100}%`,
                    background:
                      state.health <= 6
                        ? 'linear-gradient(90deg,#dc2626,#f87171)'
                        : 'linear-gradient(90deg,#16a34a,#4ade80)',
                  }}
                />
              </div>
            </div>
          </div>
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

      {/* Bottom center: MC survival stack — actionbar line / XP bar / hearts+hunger / hotbar */}
      {state.playing && !state.dead && (
        <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-stretch">
          {/* actionbar line — creative flight tag / selected item name (MC shows it above the status rows) */}
          <div className="mb-1.5 min-h-[16px] text-center text-[11px] font-bold text-white/85 [text-shadow:1px_1px_0_#000]">
            {state.flying
              ? '✦ CREATIVE FLIGHT'
              : state.mode === 'creative'
                ? '✦ CREATIVE — infinite supplies'
                : itemName
                  ? itemName
                  : ''}
          </div>
          {/* XP bar + hearts/hunger hidden in creative (MC creative has no survival stats) */}
          {state.mode === 'survival' && (
            <>
              <XpBar score={state.score} />
              {/* mirrored survival row: hearts left of the center line, hunger right */}
              <div className="mb-[3px] flex items-end justify-between px-[2px]">
                <Hearts health={state.health} maxHealth={state.maxHealth} />
                <HungerBar />
              </div>
            </>
          )}
          {/* hotbar — 9 sharp MC slots, no outer frame (counts show ∞ in creative) */}
          <div className="flex gap-[2px]">
            {state.hotbar.map((s, i) => (
              <Slot
                key={i}
                stack={s}
                selected={i === state.slot}
                onClick={() => props.onSlotClick(i)}
                infinite={state.mode === 'creative'}
              />
            ))}
          </div>
        </div>
      )}

      {/* Inventory overlay — Minecraft panel: Character tab + creative tabs */}
      {props.inventoryOpen && (
        <InventoryOverlay
          state={state}
          game={props.game}
          onInventorySwap={props.onInventorySwap}
          onSlotClick={props.onSlotClick}
          onCloseInventory={props.onCloseInventory}
        />
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
              Feel like showing off? Hit the 🛫 yellow stunt ramps at speed — air time stacks CHAOS, feeds the
              STUNT MAN contract and chases your record.
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
