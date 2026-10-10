/** Project Hyperion — global tuning constants. 1 unit = 1 meter. */

// ---- City layout -----------------------------------------------------------
export const ROAD_W = 8; // road width (m)
export const BLOCK = 32; // grid pitch: road center to road center (m)
export const GRID_HALF = 6; // roads at k*BLOCK for k in [-GRID_HALF..GRID_HALF]
export const CITY_HALF = GRID_HALF * BLOCK; // 192
export const GROUND_SPAN = 480; // ground plane size (m)
export const GROUND_CORE = 400; // finely destructible ground core (m)
export const LAYER0_Y = 0; // street surface height
export const SIDEWALK_H = 0.12; // raised sidewalk slab height
export const SIDEWALK_W = 2.6; // sidewalk band width inside each block edge

// ---- Player ----------------------------------------------------------------
export const EYE_HEIGHT = 1.62;
export const PLAYER_RADIUS = 0.32;
export const PLAYER_HEIGHT = 1.8;
export const GRAVITY = 27;
export const JUMP_SPEED = 8.8;
export const WALK_SPEED = 4.4;
export const SPRINT_SPEED = 6.2;
export const FLY_SPEED = 11;
export const FLY_SPRINT_SPEED = 19;

// ---- Digging / destruction -------------------------------------------------
export const REACH = 6.5; // interaction ray distance
export const PICK_RADIUS = 1.35; // diamond pickaxe carve radius
export const HAND_RADIUS = 0.45; // bare/weak tool carve radius
export const PICK_COOLDOWN = 0.16; // seconds between digs
export const HAND_COOLDOWN = 0.3;
export const BEDROCK_Y = -64;

// ---- Strata ----------------------------------------------------------------
export const LAYER_GAP = 3.2; // vertical distance between dig-down strata layers
export const LAYER_SPAN = 240; // strata layer plane size (m)
export const MAX_STRATA = 10; // active strata layers

// ---- Traffic ---------------------------------------------------------------
export const LANE_OFF = 2.0; // lane offset from road centerline
export const TRAFFIC_CARS = 20;
export const PARKED_CARS = 10;

// ---- NPCs ------------------------------------------------------------------
export const NPC_COUNT = 26;

// ---- Explosions ------------------------------------------------------------
export const TNT_RADIUS = 6.4;
export const TNT_FUSE = 3.2;
export const CAR_EXPLODE_RADIUS = 5.2;

export const SUN_DIR = { x: -0.55, y: 0.42, z: -0.72 }; // golden-hour sun

/** Small deterministic RNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
