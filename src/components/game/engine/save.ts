/**
 * Project Hyperion — world save/load (localStorage).
 *
 * Persists the things that can be restored losslessly: placed blocks
 * (sky-bridges etc.), player transform + health, inventory, hotbar,
 * time of day, CHAOS heat and the micro-voxel carve counter.
 * Building-carve geometry is intentionally NOT serialized (tri-level
 * state) — the city regenerates pristine; the carve counter carries over.
 */
import type { ItemStack } from './types';

const KEY = 'hyperion-save-v1';

export interface SaveData {
  v: 1;
  t: number; // real timestamp
  player: { x: number; y: number; z: number; yaw: number; pitch: number; health: number; flying: boolean };
  timeT: number;
  heat: number;
  removed: number;
  slot: number;
  hotbar: (ItemStack | null)[];
  inventory: (ItemStack | null)[];
  /** [ix, iy, iz, typeIndex] — typeIndex into SAVE_TYPES. */
  placed: number[][];
  /** Car-radio station index (0 = off) — optional for v1 saves made before this field. */
  radio?: number;
}

export const SAVE_TYPES = ['dirt', 'cobblestone', 'planks', 'glass'] as const;

export function hasSave(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function writeSave(d: SaveData): boolean {
  try {
    if (typeof window === 'undefined') return false;
    window.localStorage.setItem(KEY, JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

export function loadSave(): SaveData | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SaveData;
    if (!d || d.v !== 1 || !Array.isArray(d.placed)) return null;
    return d;
  } catch {
    return null;
  }
}

export function clearSave(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
