/**
 * Project Hyperion — chaos contract system ("missions").
 *
 * A tiny GTA-style contract loop: every so often the engine offers a timed
 * contract (wreck cars / carve voxels / collapse a building / rampage /
 * demolish a MARKED building / steal a police cruiser). The player accepts
 * with M and must complete the objective before the timer runs out; rewards
 * are Minecraft items + CHAOS score.
 *
 * Location contracts carry a world-space marker (drawn on the minimap + a
 * beacon pillar in-world) that the game reads from `snapshot()`.
 */

export type MissionKind = 'wreck' | 'voxels' | 'collapse' | 'peds' | 'steal';

export interface MissionDef {
  kind: MissionKind;
  title: string;
  desc: string;
  target: number;
  time: number;
  rewardScore: number;
  /** Item rewards granted on completion. */
  rewards: Array<{ id: string; count: number }>;
  rewardLabel: string;
  /** 'building' = pin a specific nearby skyscraper as the ONLY valid target. */
  locate?: 'building';
}

export interface MissionSnapshot {
  title: string;
  desc: string;
  progress: number;
  target: number;
  timeLeft: number;
  reward: string;
  offered: boolean;
  /** Contract target marker in world XZ (location contracts only). */
  marker: { x: number; z: number } | null;
}

const DEFS: MissionDef[] = [
  {
    kind: 'wreck',
    title: 'WRECKAGE',
    desc: 'Wreck 3 vehicles',
    target: 3,
    time: 75,
    rewardScore: 120,
    rewards: [{ id: 'tnt', count: 8 }],
    rewardLabel: 'TNT ×8 · +120 CHAOS',
  },
  {
    kind: 'voxels',
    title: 'DEMOLITION',
    desc: 'Carve 900 micro-voxels',
    target: 900,
    time: 60,
    rewardScore: 100,
    rewards: [
      { id: 'cobblestone', count: 32 },
      { id: 'tnt', count: 4 },
    ],
    rewardLabel: 'Cobblestone ×32 · TNT ×4 · +100 CHAOS',
  },
  {
    kind: 'collapse',
    title: 'SKYLINE DEMOLITION',
    desc: 'Collapse a building',
    target: 1,
    time: 90,
    rewardScore: 200,
    rewards: [{ id: 'tnt', count: 16 }],
    rewardLabel: 'TNT ×16 · +200 CHAOS',
  },
  {
    kind: 'peds',
    title: 'RAMPAGE',
    desc: 'Knock down 6 pedestrians',
    target: 6,
    time: 60,
    rewardScore: 140,
    rewards: [{ id: 'apple', count: 3 }],
    rewardLabel: 'Golden Apple ×3 · +140 CHAOS',
  },
  {
    kind: 'collapse',
    title: 'DEMOLISH THE TOWER',
    desc: 'Level the MARKED tower',
    target: 1,
    time: 120,
    rewardScore: 260,
    rewards: [
      { id: 'tnt', count: 24 },
      { id: 'apple', count: 2 },
    ],
    rewardLabel: 'TNT ×24 · Golden Apple ×2 · +260 CHAOS',
    locate: 'building',
  },
  {
    kind: 'steal',
    title: 'GRAND THEFT',
    desc: 'Steal a police cruiser',
    target: 1,
    time: 110,
    rewardScore: 220,
    rewards: [
      { id: 'pearl', count: 8 },
      { id: 'apple', count: 2 },
    ],
    rewardLabel: 'Ender Pearl ×8 · Golden Apple ×2 · +220 CHAOS',
  },
];

const OFFER_TTL = 15;
const OFFER_DELAY = 40;

interface Callbacks {
  toast: (msg: string) => void;
  complete: (def: MissionDef) => void;
  /** Pick a tall standing building near the player for location contracts. */
  pickBuilding?: () => { id: number; x: number; z: number } | null;
}

export class Missions {
  private lastIdx = -1;
  private offerTimer = 18; // first offer lands ~18s in
  private offered: { def: MissionDef; ttl: number } | null = null;
  private active: { def: MissionDef; progress: number; timeLeft: number; buildingId?: number } | null = null;

  constructor(private cb: Callbacks) {}

  /** Accept the pending offer. Returns true if a contract was accepted. */
  accept(): boolean {
    if (this.active || !this.offered) return false;
    const def = this.offered.def;
    let buildingId: number | undefined;
    if (def.locate === 'building') {
      const pick = this.cb.pickBuilding?.();
      if (!pick) {
        this.cb.toast('No target tower nearby — contract unavailable');
        this.offered = null;
        this.offerTimer = 12;
        return false;
      }
      buildingId = pick.id;
    }
    this.active = { def, progress: 0, timeLeft: def.time, buildingId };
    this.offered = null;
    this.cb.toast(`CONTRACT ACCEPTED — ${def.desc}`);
    return true;
  }

  abandon(): boolean {
    if (!this.active) return false;
    this.cb.toast(`Contract abandoned: ${this.active.def.title}`);
    this.active = null;
    this.offerTimer = OFFER_DELAY;
    return true;
  }

  // ---- event feed from the game ------------------------------------------
  onCarWreck(): void {
    this.progress('wreck', 1);
  }
  onVoxels(n: number): void {
    this.progress('voxels', n);
  }
  /** A building started collapsing — `id` is its index in city.buildings.
   *  Location contracts only progress when the MARKED building falls. */
  onCollapse(id?: number): void {
    const a = this.active;
    if (a && a.def.kind === 'collapse' && a.def.locate === 'building') {
      if (id === undefined || a.buildingId === undefined || id !== a.buildingId) return;
    }
    this.progress('collapse', 1);
  }
  onPed(): void {
    this.progress('peds', 1);
  }
  /** The player entered a car of `type` (GRAND THEFT: 'police'). */
  onCarEnter(type: string): void {
    if (type === 'police') this.progress('steal', 1);
  }

  private progress(kind: MissionKind, n: number): void {
    const a = this.active;
    if (!a || a.def.kind !== kind) return;
    a.progress += n;
    if (a.progress >= a.def.target) {
      this.active = null;
      this.cb.toast(`CONTRACT COMPLETE — ${a.def.rewardLabel}`);
      this.cb.complete(a.def);
      this.offerTimer = 45;
    }
  }

  /** Tick the offer/active cycle. */
  update(dt: number): void {
    if (this.active) {
      this.active.timeLeft -= dt;
      if (this.active.timeLeft <= 0) {
        this.cb.toast(`CONTRACT FAILED — ${this.active.def.title}`);
        this.active = null;
        this.offerTimer = OFFER_DELAY;
      }
      return;
    }
    if (this.offered) {
      this.offered.ttl -= dt;
      if (this.offered.ttl <= 0) {
        this.offered = null;
        this.offerTimer = OFFER_DELAY;
      }
      return;
    }
    this.offerTimer -= dt;
    if (this.offerTimer <= 0) {
      let idx = Math.floor(Math.random() * DEFS.length);
      if (idx === this.lastIdx) idx = (idx + 1) % DEFS.length;
      this.lastIdx = idx;
      const def = DEFS[idx];
      this.offered = { def, ttl: OFFER_TTL };
      this.cb.toast(`CONTRACT OFFER — ${def.desc} · press M to accept`);
    }
  }

  /** HUD snapshot: active contract first, then pending offer, else null. */
  snapshot(markerFor?: (m: MissionDef, buildingId?: number) => { x: number; z: number } | null): MissionSnapshot | null {
    const mk = (def: MissionDef, buildingId?: number) => ({
      title: def.title,
      desc: def.desc,
      progress: 0,
      target: def.target,
      timeLeft: 0,
      reward: def.rewardLabel,
      offered: false,
      marker: markerFor ? markerFor(def, buildingId) : null,
    });
    if (this.active) {
      const a = this.active;
      return {
        ...mk(a.def, a.buildingId),
        progress: Math.min(a.progress, a.def.target),
        timeLeft: Math.max(0, a.timeLeft),
        offered: false,
      };
    }
    if (this.offered) {
      const o = this.offered;
      return {
        ...mk(o.def),
        timeLeft: Math.max(0, o.ttl),
        offered: true,
      };
    }
    return null;
  }
}
