/**
 * Project Hyperion — chaos contract system ("missions").
 *
 * A tiny GTA-style contract loop: every so often the engine offers a timed
 * contract (wreck cars / carve voxels / collapse a building / rampage).
 * The player accepts with M and must complete the objective before the
 * timer runs out; rewards are Minecraft items + CHAOS score.
 *
 * The game orchestrator feeds events (onCarWreck / onVoxels / onCollapse /
 * onPed) and reads `snapshot()` for the HUD each emit.
 */

export type MissionKind = 'wreck' | 'voxels' | 'collapse' | 'peds';

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
}

export interface MissionSnapshot {
  title: string;
  desc: string;
  progress: number;
  target: number;
  timeLeft: number;
  reward: string;
  offered: boolean;
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
];

const OFFER_TTL = 15;
const OFFER_DELAY = 40;

interface Callbacks {
  toast: (msg: string) => void;
  complete: (def: MissionDef) => void;
}

export class Missions {
  private lastIdx = -1;
  private offerTimer = 18; // first offer lands ~18s in
  private offered: { def: MissionDef; ttl: number } | null = null;
  private active: { def: MissionDef; progress: number; timeLeft: number } | null = null;

  constructor(private cb: Callbacks) {}

  /** Accept the pending offer. Returns true if a contract was accepted. */
  accept(): boolean {
    if (this.active || !this.offered) return false;
    this.active = { def: this.offered.def, progress: 0, timeLeft: this.offered.def.time };
    this.offered = null;
    this.cb.toast(`CONTRACT ACCEPTED — ${this.active.def.desc}`);
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
  onCollapse(): void {
    this.progress('collapse', 1);
  }
  onPed(): void {
    this.progress('peds', 1);
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
  snapshot(): MissionSnapshot | null {
    if (this.active) {
      const a = this.active;
      return {
        title: a.def.title,
        desc: a.def.desc,
        progress: Math.min(a.progress, a.def.target),
        target: a.def.target,
        timeLeft: Math.max(0, a.timeLeft),
        reward: a.def.rewardLabel,
        offered: false,
      };
    }
    if (this.offered) {
      const o = this.offered;
      return {
        title: o.def.title,
        desc: o.def.desc,
        progress: 0,
        target: o.def.target,
        timeLeft: Math.max(0, o.ttl),
        reward: o.def.rewardLabel,
        offered: true,
      };
    }
    return null;
  }
}
