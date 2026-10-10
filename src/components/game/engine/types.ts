import * as THREE from 'three';

/** Shared types for the Hyperion engine. Avoids circular imports between actor modules. */

export type AimKind = 'layer' | 'building' | 'block' | 'car' | 'npc' | 'tnt' | 'shaft';

export interface AimHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  kind: AimKind;
  /** What digging this grants (undefined for cars/npcs/tnt). */
  grant?: 'dirt' | 'cobblestone' | 'planks' | 'glass';
  object?: THREE.Object3D;
  /** For placed blocks: the grid key so it can be broken. */
  blockKey?: string;
  /** Car reference when kind === 'car'. */
  carId?: number;
}

/** Item identifiers — the universal Minecraft item map. */
export type ItemId =
  | 'pickaxe'
  | 'sword'
  | 'tnt'
  | 'dirt'
  | 'cobblestone'
  | 'planks'
  | 'glass'
  | 'flint'
  | 'pearl'
  | 'apple'
  | 'jetpack';

export interface ItemStack {
  id: ItemId;
  count: number;
}

export interface HudState {
  playing: boolean;
  health: number;
  flying: boolean;
  thirdPerson: boolean;
  driving: null | { name: string; speed: number };
  slot: number;
  hotbar: (ItemStack | null)[];
  inventory: (ItemStack | null)[];
  stars: number;
  score: number;
  pos: [number, number, number];
  depth: number;
  removed: number;
  fps: number;
  hint: string | null;
  dead: boolean;
  hurt: number;
  debug: boolean;
  removedPerSecond: number;
  clock: string;
  hitMark: number;
  police: number;
  /** Active or offered chaos contract (missions system). */
  mission: null | {
    title: string;
    desc: string;
    progress: number;
    target: number;
    timeLeft: number;
    reward: string;
    offered: boolean;
    /** World-space marker (contract target) + live distance from the player. */
    marker: null | { x: number; z: number; dist: number };
    /** Contracts completed toward the chain bonus (0..CHAIN_GOAL). */
    chain: number;
    /** True once the chain bonus (jetpack) has been claimed. */
    chainDone: boolean;
  };
  /** Current car-radio station name (null = radio off / not driving). */
  radio: string | null;
  /** True when a localStorage save file exists (start screen CONTINUE button). */
  hasSave: boolean;
  /** Weather machine readout for the HUD chip. */
  weather: { state: 'clear' | 'overcast' | 'rain'; intensity: number; wet: number };
  /** Police pursuit evade progress 0..1 (0 = not evading / not wanted). */
  evading: number;
  /** Jetpack fuel 0..1 (shown by the HUD when a jetpack is selected). */
  jetFuel: number;
  /** True while jetpack thrust is active (hold RMB with jetpack selected). */
  jetThrusting: boolean;
}

export const HUD_INITIAL: HudState = {
  playing: false,
  health: 20,
  flying: false,
  thirdPerson: false,
  driving: null,
  slot: 0,
  hotbar: new Array(9).fill(null),
  inventory: new Array(18).fill(null),
  stars: 0,
  score: 0,
  pos: [0, 0, 0],
  depth: 0,
  removed: 0,
  fps: 60,
  hint: null,
  dead: false,
  hurt: 0,
  debug: false,
  removedPerSecond: 0,
  clock: '17:20',
  hitMark: 0,
  police: 0,
  mission: null,
  radio: null,
  hasSave: false,
  weather: { state: 'clear', intensity: 0, wet: 0 },
  evading: 0,
  jetFuel: 1,
  jetThrusting: false,
};

/**
 * The world-services contract the game orchestrator provides to actors
 * (player, vehicles, npcs). Implemented by HyperionGame.
 */
export interface World {
  floorHeightAt(x: number, z: number, feetY: number): number;
  /** Push a circle (x,z) out of buildings/blocks; mutates pos. */
  resolveCircleXZ(pos: THREE.Vector3, radius: number, feetY: number, height: number): void;
  /** Micro-voxel carve. Returns number of removed voxel-tris. */
  carveSphere(point: THREE.Vector3, radius: number, color?: THREE.Color): number;
  spawnDebris(p: THREE.Vector3, n: number, color: THREE.Color, power?: number): void;
  aimRaycast(): AimHit | null;
  audio: {
    dig(): void;
    breakBlock(): void;
    place(): void;
    boom(far: number): void;
    horn(far: number): void;
    ignite(far: number): void;
    pearl(): void;
    eat(): void;
    hurt(): void;
    thud(far: number): void;
    enterCar(): void;
    pickup(): void;
  };
  addScore(n: number): void;
  playerPos(): THREE.Vector3;
  playerEyeY(): number;
  damagePlayer(n: number): void;
  ragdollNPCsNear(pos: THREE.Vector3, r: number): void;
  fleeNPCs(pos: THREE.Vector3, r: number): void;
  igniteCarsNear(pos: THREE.Vector3, r: number, excludeId?: number): void;
  isOnRoad(x: number, z: number): boolean;
  shake(amount: number): void;
}
