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
  | 'apple';

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
