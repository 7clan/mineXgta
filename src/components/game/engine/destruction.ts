import * as THREE from 'three';

/**
 * Micro-voxel destruction system.
 *
 * Every destructible model (building, ground stratum, tunnel shaft) is stored as an
 * indexed mesh whose triangle edge length is ~0.85-1.0m — a dense "micro-voxel" sampling
 * of the surface volume. A uniform spatial hash maps local cells -> triangle indices.
 *
 * carveAt(worldPoint, radius):
 *  1. converts the impact to local space,
 *  2. gathers candidate triangles from overlapped hash cells,
 *  3. kills every triangle whose centroid lies inside the sphere (chipping away mesh
 *     vertices => smooth realistic deformation & tunneling, never square block cutouts),
 *  4. radially displaces surviving shell vertices => crater lip,
 *  5. compacts the index buffer and reports removed voxel centers for debris.
 *
 * A world-space 1m occupancy grid records carved cells — the hybrid collision engine
 * queries it so players/cars can pass through carved cells (tunneling).
 */

export interface CarveCallbacks {
  debris?: (worldPos: THREE.Vector3, count: number, color: THREE.Color) => void;
  onNewCell?: (entry: DestructionEntry, key: string) => void;
  maxDebris?: number;
}

export type DestructibleLabel = 'building' | 'layer' | 'shaft';

export interface DestructionEntry {
  id: number;
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  label: DestructibleLabel;
  cell: number;
  triCount: number;
  aliveCount: number;
  alive: Uint8Array;
  centers: Float32Array; // local-space triangle centroids
  grid: Map<number, number[]>; // packed cell key -> tri indices
  occ: Set<string>; // world-space carved 1m cells "x,y,z"
  inv: THREE.Matrix4;
  mat: THREE.Matrix4;
  worldBounds: THREE.Box3;
  worldSphere: THREE.Sphere;
  color: THREE.Color;
  deform: boolean;
  grant: 'dirt' | 'cobblestone';
  layerY: number; // for label === 'layer'
  layerCX: number;
  layerCZ: number;
  layerHalf: number;
  dirty: boolean;
  hidden: boolean;
  stampArr: Int32Array;
  vStampArr: Int32Array;
}

export interface CarveResult {
  removed: number;
  entry: DestructionEntry | null;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _sphere = new THREE.Sphere();

/** Pack integer cell coords into a unique numeric hash (no collisions, |coord| < 512). */
function cellKey(ix: number, iy: number, iz: number): number {
  return ((ix + 512) * 1024 + (iy + 512)) * 1024 + (iz + 512);
}

export class DestructionSystem {
  private entries = new Map<number, DestructionEntry>();
  private layers: DestructionEntry[] = [];
  private nextId = 1;
  private stampCounter = 0;
  private vStampCounter = 0;
  totalRemoved = 0;

  register(
    mesh: THREE.Mesh,
    opts: {
      label: DestructibleLabel;
      cell?: number;
      color?: THREE.ColorRepresentation;
      deform?: boolean;
      grant?: 'dirt' | 'cobblestone';
      layerY?: number;
      layerSpan?: number;
    }
  ): DestructionEntry {
    const geo = mesh.geometry as THREE.BufferGeometry;
    if (!geo.index) {
      const count = geo.attributes.position.count;
      const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let i = 0; i < count; i++) arr[i] = i;
      geo.setIndex(new THREE.BufferAttribute(arr, 1));
    }
    mesh.updateMatrixWorld(true);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const index = geo.index!;
    const triCount = Math.floor(index.count / 3);
    const cell = opts.cell ?? 1.0;

    // Triangle centroids in local space + spatial hash.
    const centers = new Float32Array(triCount * 3);
    const grid = new Map<number, number[]>();
    const pa = pos.array as ArrayLike<number>;
    const ia = index.array as ArrayLike<number>;
    for (let t = 0; t < triCount; t++) {
      const a = ia[t * 3] * 3;
      const b = ia[t * 3 + 1] * 3;
      const c = ia[t * 3 + 2] * 3;
      const cx = (pa[a] + pa[b] + pa[c]) / 3;
      const cy = (pa[a + 1] + pa[b + 1] + pa[c + 1]) / 3;
      const cz = (pa[a + 2] + pa[b + 2] + pa[c + 2]) / 3;
      centers[t * 3] = cx;
      centers[t * 3 + 1] = cy;
      centers[t * 3 + 2] = cz;
      const key = cellKey(Math.floor(cx / cell), Math.floor(cy / cell), Math.floor(cz / cell));
      const arr = grid.get(key);
      if (arr) arr.push(t);
      else grid.set(key, [t]);
    }

    const entry: DestructionEntry = {
      id: this.nextId++,
      mesh,
      geo,
      label: opts.label,
      cell,
      triCount,
      aliveCount: triCount,
      alive: new Uint8Array(triCount).fill(1),
      centers,
      grid,
      occ: new Set<string>(),
      inv: mesh.matrixWorld.clone().invert(),
      mat: mesh.matrixWorld.clone(),
      worldBounds: new THREE.Box3().setFromObject(mesh),
      worldSphere: new THREE.Sphere(),
      color: new THREE.Color(opts.color ?? 0x8a8a8a),
      deform: opts.deform ?? true,
      grant: opts.grant ?? 'cobblestone',
      layerY: opts.layerY ?? 0,
      layerCX: mesh.position.x,
      layerCZ: mesh.position.z,
      layerHalf: (opts.layerSpan ?? 0) / 2,
      dirty: false,
      hidden: false,
      stampArr: new Int32Array(triCount),
      vStampArr: new Int32Array(pos.count),
    };
    geo.computeBoundingSphere();
    entry.worldSphere.copy(geo.boundingSphere as THREE.Sphere);
    entry.worldSphere.applyMatrix4(mesh.matrixWorld);
    mesh.userData.destructibleId = entry.id;
    this.entries.set(entry.id, entry);
    if (opts.label === 'layer') this.layers.push(entry);
    return entry;
  }

  unregister(mesh: THREE.Mesh): void {
    const id = mesh.userData.destructibleId as number | undefined;
    if (id === undefined) return;
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    const li = this.layers.indexOf(e);
    if (li >= 0) this.layers.splice(li, 1);
    delete mesh.userData.destructibleId;
  }

  getEntry(mesh: THREE.Mesh): DestructionEntry | null {
    const id = mesh.userData.destructibleId as number | undefined;
    return id !== undefined ? this.entries.get(id) ?? null : null;
  }

  all(): IterableIterator<DestructionEntry> {
    return this.entries.values();
  }

  /** Analytic ray hit against strata layer planes (skips carved cells). */
  analyticLayerHit(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number
  ): { point: THREE.Vector3; distance: number; entry: DestructionEntry } | null {
    let best: { point: THREE.Vector3; distance: number; entry: DestructionEntry } | null = null;
    if (Math.abs(dir.y) < 1e-6) return null;
    for (const e of this.layers) {
      if (e.hidden) continue;
      const t = (e.layerY - origin.y) / dir.y;
      if (t <= 0.01 || t > maxDist) continue;
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      if (Math.abs(px - e.layerCX) > e.layerHalf || Math.abs(pz - e.layerCZ) > e.layerHalf) continue;
      const key = `${Math.floor(px)},${Math.floor(e.layerY)},${Math.floor(pz)}`;
      if (e.occ.has(key)) continue;
      if (!best || t < best.distance) {
        best = { point: new THREE.Vector3(px, e.layerY, pz), distance: t, entry: e };
      }
    }
    return best;
  }

  /** True if the world-space 1m cell was carved. */
  isCarved(x: number, y: number, z: number): boolean {
    const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    for (const e of this.entries.values()) {
      if (e.hidden) continue;
      if (x < e.worldBounds.min.x - 1 || x > e.worldBounds.max.x + 1) continue;
      if (y < e.worldBounds.min.y - 1 || y > e.worldBounds.max.y + 1) continue;
      if (z < e.worldBounds.min.z - 1 || z > e.worldBounds.max.z + 1) continue;
      if (e.occ.has(key)) return true;
    }
    return false;
  }

  /** True if a strata layer at layerY is carved at column (x,z). */
  columnCarved(x: number, z: number, layerY: number): boolean {
    const key = `${Math.floor(x)},${Math.floor(layerY)},${Math.floor(z)}`;
    for (const e of this.layers) {
      if (e.layerY !== layerY || e.hidden) continue;
      if (Math.abs(x - e.layerCX) > e.layerHalf || Math.abs(z - e.layerCZ) > e.layerHalf) continue;
      return e.occ.has(key);
    }
    return false;
  }

  layerExistsAt(layerY: number): boolean {
    return this.layers.some((e) => e.layerY === layerY && !e.hidden);
  }

  /** Meshes whose world bounds are intersected by the ray (cheap prefilter for raycasting). */
  raycastCandidates(ray: THREE.Ray, maxDist: number): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const e of this.entries.values()) {
      if (e.hidden || e.label === 'layer') continue;
      _sphere.center.copy(e.worldSphere.center);
      _sphere.radius = e.worldSphere.radius + 1;
      if (ray.intersectsSphere(_sphere)) out.push(e.mesh);
    }
    void maxDist;
    return out;
  }

  carveAt(worldPoint: THREE.Vector3, radius: number, cb?: CarveCallbacks): CarveResult {
    let removed = 0;
    let lastEntry: DestructionEntry | null = null;
    const maxDebris = cb?.maxDebris ?? 14;
    const debrisSamples: THREE.Vector3[] = [];
    let debrisColor = new THREE.Color(0x888888);

    for (const e of this.entries.values()) {
      if (e.hidden) continue;
      // Quick reject: sphere vs world bounds.
      if (
        worldPoint.x + radius < e.worldBounds.min.x ||
        worldPoint.x - radius > e.worldBounds.max.x ||
        worldPoint.y + radius < e.worldBounds.min.y ||
        worldPoint.y - radius > e.worldBounds.max.y ||
        worldPoint.z + radius < e.worldBounds.min.z ||
        worldPoint.z - radius > e.worldBounds.max.z
      )
        continue;

      _v.copy(worldPoint).applyMatrix4(e.inv); // local impact point
      // Sphere vs bounding sphere (local space).
      const bs = e.geo.boundingSphere;
      if (bs) {
        _v2.copy(_v).sub(bs.center);
        if (_v2.length() > bs.radius + radius) continue;
      }

      this.stampCounter++;
      const stamp = this.stampCounter;
      const r2 = radius * radius;
      const cand: number[] = [];
      const lo = Math.floor((radius + e.cell * 2) / e.cell);
      const cx = Math.floor(_v.x / e.cell);
      const cy = Math.floor(_v.y / e.cell);
      const cz = Math.floor(_v.z / e.cell);
      for (let ix = cx - lo; ix <= cx + lo; ix++) {
        for (let iy = cy - lo; iy <= cy + lo; iy++) {
          for (let iz = cz - lo; iz <= cz + lo; iz++) {
            const arr = e.grid.get(cellKey(ix, iy, iz));
            if (!arr) continue;
            for (const t of arr) {
              if (e.stampArr[t] === stamp || !e.alive[t]) continue;
              e.stampArr[t] = stamp;
              cand.push(t);
            }
          }
        }
      }

      let killed = 0;
      for (const t of cand) {
        const dx = e.centers[t * 3] - _v.x;
        const dy = e.centers[t * 3 + 1] - _v.y;
        const dz = e.centers[t * 3 + 2] - _v.z;
        if (dx * dx + dy * dy + dz * dz < r2) {
          e.alive[t] = 0;
          e.aliveCount--;
          killed++;
          // Occupancy: world-space 1m cell of the dead triangle centroid.
          _v2.set(e.centers[t * 3], e.centers[t * 3 + 1], e.centers[t * 3 + 2]).applyMatrix4(e.mat);
          const key = `${Math.floor(_v2.x)},${Math.floor(_v2.y)},${Math.floor(_v2.z)}`;
          if (!e.occ.has(key)) {
            e.occ.add(key);
            cb?.onNewCell?.(e, key);
          }
          if (debrisSamples.length < maxDebris) {
            debrisSamples.push(_v2.clone());
            debrisColor = e.color;
          }
        }
      }

      if (killed > 0) {
        if (e.deform) this.deformShell(e, _v, radius, cand);
        e.dirty = true;
        removed += killed;
        lastEntry = e;
      }
    }

    if (removed > 0) {
      for (const e of this.entries.values()) if (e.dirty) this.flush(e);
      this.totalRemoved += removed;
      if (debrisSamples.length && cb?.debris) {
        cb.debris(debrisSamples[0], removed, debrisColor);
      }
    }
    return { removed, entry: lastEntry };
  }

  /** Radially push surviving shell vertices outward => smooth crater lip. */
  private deformShell(e: DestructionEntry, localP: THREE.Vector3, radius: number, cand: number[]): void {
    this.vStampCounter++;
    const vs = this.vStampCounter;
    const pos = e.geo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const rOuter = radius * 2.1;
    let touched = false;
    for (const t of cand) {
      if (!e.alive[t]) continue;
      for (let k = 0; k < 3; k++) {
        const vi = (e.geo.index as THREE.BufferAttribute).array[t * 3 + k] as number;
        if (e.vStampArr[vi] === vs) continue;
        e.vStampArr[vi] = vs;
        const vx = arr[vi * 3];
        const vy = arr[vi * 3 + 1];
        const vz = arr[vi * 3 + 2];
        const dx = vx - localP.x;
        const dy = vy - localP.y;
        const dz = vz - localP.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < rOuter && d > 1e-4) {
          const f = 1 - d / rOuter;
          const push = 0.24 * f * f;
          arr[vi * 3] = vx + (dx / d) * push;
          arr[vi * 3 + 1] = vy + (dy / d) * push;
          arr[vi * 3 + 2] = vz + (dz / d) * push;
          touched = true;
        }
      }
    }
    if (touched) pos.needsUpdate = true;
  }

  /** Compact index buffer of dead triangles; update bounds. */
  private flush(e: DestructionEntry): void {
    const indexAttr = e.geo.index as THREE.BufferAttribute;
    const ia = indexAttr.array as ArrayLike<number>;
    let w = 0;
    for (let t = 0; t < e.triCount; t++) {
      if (!e.alive[t]) continue;
      (ia as unknown as number[])[w++] = ia[t * 3];
      (ia as unknown as number[])[w++] = ia[t * 3 + 1];
      (ia as unknown as number[])[w++] = ia[t * 3 + 2];
    }
    indexAttr.needsUpdate = true;
    e.geo.setDrawRange(0, w);
    if (e.deform && e.label === 'building') e.geo.computeVertexNormals();
    e.geo.computeBoundingSphere();
    e.worldSphere.copy(e.geo.boundingSphere as THREE.Sphere).applyMatrix4(e.mat);
    e.dirty = false;
    if (e.aliveCount === 0) {
      e.hidden = true;
      e.mesh.visible = false;
    }
  }

  /** Ratio of alive triangles (for building collapse checks). */
  aliveRatio(e: DestructionEntry): number {
    return e.aliveCount / Math.max(1, e.triCount);
  }

  dispose(): void {
    this.entries.clear();
    this.layers.length = 0;
  }
}
