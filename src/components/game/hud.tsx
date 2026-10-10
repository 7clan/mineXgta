'use client';

import { useMemo, type ReactNode } from 'react';
import { HudState, ItemStack, ItemId } from './engine/types';
import { ICON_URLS, ITEMS, UI_ICONS } from './engine/items';

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
  onSlotClick: (i: number) => void;
  onInventorySwap: (i: number) => void;
  onResume: () => void;
  onRespawn: () => void;
  onPlay: () => void;
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
  ['Space ×2', 'Toggle creative flight'],
  ['Space / C', 'Fly up / down'],
  ['Shift', 'Sprint'],
  ['1–9 / Wheel', 'Select hotbar slot'],
  ['E', 'Inventory'],
  ['F', 'Enter / exit car'],
  ['F5', 'Third-person view'],
  ['F3', 'Debug overlay'],
  ['Esc', 'Pause'],
];

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

      {/* Crosshair */}
      {state.playing && !state.dead && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 mix-blend-difference">
          <div className="relative h-5 w-5">
            <div className="absolute left-1/2 top-0 h-5 w-[2px] -translate-x-1/2 bg-white" />
            <div className="absolute top-1/2 left-0 h-[2px] w-5 -translate-y-1/2 bg-white" />
          </div>
        </div>
      )}

      {/* Stars — GTA chaos level (top right) */}
      {state.playing && (
        <div className="absolute right-4 top-4 flex flex-col items-end gap-1">
          <Stars count={state.stars} />
          <div className="rounded bg-black/55 px-2 py-0.5 text-right text-[11px] font-bold tracking-widest text-white/90">
            CHAOS {state.score}
          </div>
          {state.driving && (
            <div className="mt-1 rounded bg-black/55 px-3 py-1 text-right">
              <div className="text-[10px] uppercase tracking-widest text-amber-300/90">{state.driving.name}</div>
              <div className="text-xl font-black leading-none text-white">
                {Math.round(state.driving.speed)}
                <span className="ml-1 text-[10px] font-bold text-white/60">KM/H</span>
              </div>
            </div>
          )}
        </div>
      )}

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
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-black/40 p-3 text-left text-[11px] text-white/75">
              {CONTROLS.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="font-bold text-amber-300/90">{k}</span>
                  <span className="text-right">{v}</span>
                </div>
              ))}
            </div>
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
              flint &amp; steel, build sky-bridges from smooth dirt slabs, and fly like creative mode.
            </p>
            <button
              onClick={props.onPlay}
              className="mb-8 rounded-lg bg-amber-500 px-14 py-4 text-2xl font-black tracking-wide text-black shadow-[0_6px_0_#8a5a00] transition hover:bg-amber-400 active:translate-y-[3px] active:shadow-[0_3px_0_#8a5a00]"
            >
              ▶ PLAY
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
              Desktop · Mouse &amp; Keyboard · WebGL2 — inspired by GTA-V decompiled scripts &amp; Minecraft
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
