/**
 * GTA SOURCE PORT — real Los Santos street lattice (gtaMap.ts).
 *
 * Derives the actual game-world street grid from the REAL GTA V road graph
 * (paths.ipl nodes, as downloaded from the source): a window of downtown
 * Los Santos centered on Legion Square is projected 1:1 into game
 * coordinates, street centerlines are recovered from node-density peaks,
 * and the city blocks between them carry REAL extents — including the real
 * Legion Square plaza gap, the real boulevard widths and the real ocean
 * quads that touch the window.
 */
import { GtaRoadGraph, GtaWaterQuad } from './gtaSource';

/** Real-world center of the extracted window: Legion Square, Los Santos. */
export const GTA_CENTER = { x: 195, y: -940 };
/** Half-extent of the real-world window (meters). */
export const GTA_WINDOW = 268;

export interface RealBlock {
  /** Grid index of the block (i between streetsX[i]..streetsX[i+1]). */
  bi: number;
  bj: number;
  /** Bounds in game coords. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Real-world classification hints. */
  kind: 'park' | 'built' | 'lot';
}

export interface RealLattice {
  /** N-S street centerline positions in game coords (x axis). */
  streetsX: number[];
  /** E-W street centerline positions in game coords (z axis). */
  streetsY: number[];
  /** Real blocks between streets. */
  blocks: RealBlock[];
  /** Real water quads projected into the game window. */
  water: { x0: number; x1: number; z0: number; z1: number; y: number }[];
  /** Extent of the window in game coords (half-extent). */
  half: number;
}

/** Project real GTA V world coords into game coords (x east, z = -y ⇒ north = -z). */
export function project(realX: number, realY: number): { x: number; z: number } {
  return { x: realX - GTA_CENTER.x, z: -(realY - GTA_CENTER.y) };
}

/**
 * Recover the street lattice from the real node graph: histogram node
 * positions on each axis, then pick peaks (a street carries many lane-level
 * path nodes; open space carries none).
 */
function streetPeaks(vals: number[], win: number): number[] {
  const bins = 134;
  const w = win * 2;
  const hist = new Float32Array(bins);
  for (const v of vals) {
    const b = Math.floor(((v + win) / w) * bins);
    if (b >= 0 && b < bins) hist[b]++;
  }
  const binMeters = w / bins;
  // Peak = bin clearly above local background, with sub-bin refinement from
  // the mean of member positions.
  const sums = new Float32Array(bins);
  const cnts = new Float32Array(bins);
  for (const v of vals) {
    const b = Math.floor(((v + win) / w) * bins);
    if (b >= 0 && b < bins) {
      sums[b] += v;
      cnts[b]++;
    }
  }
  const peakThreshold = Math.max(20, (vals.length / bins) * 1.25);
  const raw: number[] = [];
  for (let b = 0; b < bins; b++) {
    if (hist[b] < peakThreshold) continue;
    raw.push(cnts[b] ? sums[b] / cnts[b] : (b + 0.5) * binMeters - win);
  }
  // Merge peaks closer than ~9 m (adjacent lanes of the same boulevard).
  const merged: number[] = [];
  for (const p of raw) {
    if (merged.length && Math.abs(p - merged[merged.length - 1]) < 9) {
      merged[merged.length - 1] = (merged[merged.length - 1] + p) / 2;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

/** Build the real street lattice + blocks + water from the source data. */
export function buildRealLattice(
  roads: GtaRoadGraph | null,
  water: GtaWaterQuad[],
): RealLattice {
  const half = GTA_WINDOW;
  // Fallback: the classic uniform grid (used only if the real graph failed
  // to load — e.g. offline dev) so the game never hard-fails.
  if (!roads) {
    const streetsX: number[] = [];
    const streetsY: number[] = [];
    for (let k = -6; k <= 6; k++) {
      streetsX.push(k * 40);
      streetsY.push(k * 40);
    }
    return { streetsX, streetsY, blocks: [], water: [], half };
  }

  // Collect the node positions of the real window (in game coords).
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < roads.x.length; i++) {
    const gx = roads.x[i] - GTA_CENTER.x;
    const gz = -(roads.y[i] - GTA_CENTER.y);
    if (Math.abs(gx) <= half && Math.abs(gz) <= half) {
      xs.push(gx);
      zs.push(gz);
    }
  }

  const streetsX = streetPeaks(xs, half);
  const streetsY = streetPeaks(zs, half);

  // Blocks: rectangles between consecutive real streets.
  const blocks: RealBlock[] = [];
  for (let i = 0; i + 1 < streetsX.length; i++) {
    for (let j = 0; j + 1 < streetsY.length; j++) {
      const x0 = streetsX[i], x1 = streetsX[i + 1];
      const z0 = streetsY[j], z1 = streetsY[j + 1];
      const w = x1 - x0, d = z1 - z0;
      if (w < 12 || d < 12) continue;
      // Real-world block classification: the giant gap between boulevards
      // is Legion Square park; wide shallow blocks read as lots.
      let kind: RealBlock['kind'] = 'built';
      if (w > 90 || d > 90) kind = 'park';
      else if (Math.min(w, d) > 46 && (w > 74 || d > 74)) kind = 'lot';
      blocks.push({ bi: i, bj: j, x0, x1, z0, z1, kind });
    }
  }

  // Real water quads projected into the window.
  const wq: RealLattice['water'] = [];
  for (const q of water) {
    const a = project(q.minX, q.maxY); // (minX, north edge)
    const b = project(q.maxX, q.minY);
    const x0 = Math.max(-half, a.x), x1 = Math.min(half, b.x);
    const z0 = Math.max(-half, a.z), z1 = Math.min(half, b.z);
    if (x1 - x0 < 4 || z1 - z0 < 4) continue;
    wq.push({ x0, x1, z0, z1, y: q.z ?? 0 });
  }

  return { streetsX, streetsY, blocks, water: wq, half };
}
