import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  BLOCK,
  CITY_HALF,
  GROUND_CORE,
  GROUND_SPAN,
  GRID_HALF,
  LANE_OFF,
  LAYER_GAP,
  LAYER_SPAN,
  ROAD_W,
  SIDEWALK_H,
  SIDEWALK_W,
  mulberry32,
} from './constants';
import { DestructionSystem, DestructionEntry } from './destruction';
import {
  makeAsphaltNormal,
  makeAsphaltTile,
  makeFacadeTexture,
  makeFrondTexture,
  makeGrassTile,
  makeLayerTexture,
  makeRoofTexture,
  makeSidewalkNormal,
  makeSidewalkTile,
  makeStorefrontTexture,
  makeTrunkTexture,
} from './textures';

export type BlockType = 'built' | 'park' | 'lot';

// ---------------------------------------------------------------- districts
/** Los Santos district ids — the map zoning mirrored off the GTA V level
 *  layout (downtown core + angled neighborhood ring). */
export type DistrictId =
  | 'downtown' | 'hollywood' | 'koreatown' | 'scentral' | 'venice'
  | 'warehouse' | 'sunset' | 'silverlake' | 'marina';

export interface DistrictMeta {
  id: DistrictId;
  label: string;
  styles: Array<'concrete' | 'glass' | 'brick' | 'white' | 'stucco'>;
  hMin: number;
  hVar: number;
  /** Probability a block edge row gets a palm line. */
  palms: number;
  /** Storefront shell + parapet dressing (retail strips). */
  retail: boolean;
}

const DISTRICTS: Record<DistrictId, DistrictMeta> = {
  downtown: { id: 'downtown', label: 'Downtown', styles: ['glass', 'glass', 'white', 'concrete'], hMin: 24, hVar: 44, palms: 0.12, retail: true },
  hollywood: { id: 'hollywood', label: 'Hollywood', styles: ['stucco', 'brick', 'white', 'concrete'], hMin: 10, hVar: 13, palms: 0.45, retail: true },
  koreatown: { id: 'koreatown', label: 'Koreatown', styles: ['stucco', 'stucco', 'brick', 'white'], hMin: 9, hVar: 11, palms: 0.25, retail: true },
  warehouse: { id: 'warehouse', label: 'Warehouse District', styles: ['concrete', 'concrete', 'brick'], hMin: 5, hVar: 8, palms: 0.06, retail: false },
  scentral: { id: 'scentral', label: 'South Central', styles: ['stucco', 'concrete', 'brick', 'stucco'], hMin: 5, hVar: 7, palms: 0.16, retail: false },
  marina: { id: 'marina', label: 'Marina', styles: ['white', 'stucco', 'white'], hMin: 6, hVar: 6, palms: 0.5, retail: false },
  venice: { id: 'venice', label: 'Venice', styles: ['stucco', 'white', 'stucco'], hMin: 4, hVar: 5, palms: 0.62, retail: false },
  silverlake: { id: 'silverlake', label: 'Silver Lake', styles: ['white', 'stucco', 'concrete'], hMin: 7, hVar: 9, palms: 0.32, retail: false },
  sunset: { id: 'sunset', label: 'Sunset', styles: ['stucco', 'white', 'brick', 'concrete'], hMin: 8, hVar: 10, palms: 0.42, retail: true },
};

// Ring sector lookup, counterclockwise from west (-x) with -z as north:
// [W, NW, N, NE, E, SE, S, SW]
const RING_SECTORS: DistrictMeta[] = [
  DISTRICTS.venice, DISTRICTS.sunset, DISTRICTS.hollywood, DISTRICTS.silverlake,
  DISTRICTS.koreatown, DISTRICTS.warehouse, DISTRICTS.scentral, DISTRICTS.marina,
];

export interface BuildingRec {
  group: THREE.Group;
  mesh: THREE.Mesh;
  entry: DestructionEntry;
  aabb: THREE.Box3;
  h: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  collapsing: boolean;
  collapseT: number;
  collapsed: boolean;
  /** Downtown district only: carve-registered storefront shell (unregistered on collapse). */
  shellMesh?: THREE.Mesh;
  shellEntry?: DestructionEntry;
}

/** Procedural Los Santos-style city: road grid, district zoning (downtown glass
 *  core + neighborhood ring), destructible buildings, props, strata. */
export class City {
  group = new THREE.Group();
  buildings: BuildingRec[] = [];
  parkingLots: THREE.Vector3[] = [];
  parkCenters: THREE.Vector3[] = [];
  roadCoords: number[] = [];
  blockTypes = new Map<string, BlockType>();
  private districtCache = new Map<string, DistrictMeta>();
  groundEntry: DestructionEntry | null = null;
  private scene: THREE.Scene;
  private destruction: DestructionSystem;
  private facadeCache = new Map<string, { map: THREE.Texture; normalMap: THREE.Texture; emissiveMap: THREE.Texture }>();
  /** Storefront shell materials (3 variants, cached + shared). */
  private storefrontCache: THREE.MeshStandardMaterial[] = [];
  private corniceMat: THREE.MeshStandardMaterial | null = null;
  private corniceGeoCache = new Map<string, THREE.BufferGeometry>();
  private roofMat: THREE.MeshStandardMaterial;
  private innerMat: THREE.MeshStandardMaterial;
  private rubbleMat: THREE.MeshStandardMaterial;
  /** Composite city ground (asphalt + sidewalks) — driven by the rain wetness. */
  private groundMat: THREE.MeshStandardMaterial | null = null;
  private rng = mulberry32(1337);
  nightMaterials: THREE.MeshStandardMaterial[] = [];
  private headMat: THREE.MeshStandardMaterial | null = null;
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  onCollapseStart?: (b: BuildingRec) => void;
  onCollapseDust?: (pos: THREE.Vector3, radius: number) => void;
  onCollapsed?: (b: BuildingRec) => void;

  constructor(scene: THREE.Scene, destruction: DestructionSystem) {
    this.scene = scene;
    this.destruction = destruction;
    for (let k = -GRID_HALF; k <= GRID_HALF; k++) this.roadCoords.push(k * BLOCK);
    this.roofMat = new THREE.MeshStandardMaterial({ map: makeRoofTexture(), roughness: 0.95 });
    this.innerMat = new THREE.MeshStandardMaterial({ color: 0x161311, roughness: 1, side: THREE.BackSide });
    this.rubbleMat = new THREE.MeshStandardMaterial({ color: 0x6f6a63, roughness: 1 });
    this.disposables.push(this.roofMat, this.innerMat, this.rubbleMat);
    this.buildGround();
    this.buildBlocks();
    this.buildPalms();
    this.buildStreetLights();
    this.buildHills();
    this.buildDistrictGreenery();
    scene.add(this.group);
  }

  /** Downtown street life: broadleaf street trees, benches, waste bins along
   *  the district sidewalks (visual dressing — no collision, like the palms). */
  private buildDistrictGreenery(): void {
    const rng = mulberry32(2027);
    const trunkPos: THREE.Vector3[] = [];
    const benchPos: Array<{ x: number; z: number; yaw: number }> = [];
    const binPos: Array<{ x: number; z: number }> = [];
    for (const bi of this.blockRange()) {
      for (const bj of this.blockRange()) {
        const dc = Math.max(Math.abs(bi + 0.5), Math.abs(bj + 0.5)) / GRID_HALF;
        if (dc >= 0.38 || this.blockType(bi, bj) !== 'built') continue;
        // Sidewalk mid-band ring around the block
        const c0 = bi * BLOCK + ROAD_W / 2, c1 = (bi + 1) * BLOCK - ROAD_W / 2;
        const d0 = bj * BLOCK + ROAD_W / 2, d1 = (bj + 1) * BLOCK - ROAD_W / 2;
        const mid = 1.35; // inset from block edge
        for (let t = c0 + 4; t < c1 - 3; t += 7.5) {
          if (rng() < 0.55) trunkPos.push(new THREE.Vector3(t, SIDEWALK_H, d0 + mid));
          if (rng() < 0.55) trunkPos.push(new THREE.Vector3(t, SIDEWALK_H, d1 - mid));
          if (rng() < 0.3) benchPos.push({ x: t + 2, z: d0 + mid + 0.6, yaw: 0 });
          if (rng() < 0.3) benchPos.push({ x: t + 2, z: d1 - mid - 0.6, yaw: Math.PI });
        }
        for (let t = d0 + 4; t < d1 - 3; t += 7.5) {
          if (rng() < 0.55) trunkPos.push(new THREE.Vector3(c0 + mid, SIDEWALK_H, t));
          if (rng() < 0.55) trunkPos.push(new THREE.Vector3(c1 - mid, SIDEWALK_H, t));
          if (rng() < 0.25) binPos.push({ x: c0 + mid, z: t });
          if (rng() < 0.25) binPos.push({ x: c1 - mid, z: t });
        }
      }
    }
    if (!trunkPos.length) return;

    // --- street trees: tapered trunk + 3-blob canopy, instanced ----------------
    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.7, 7, 3);
    trunkGeo.translate(0, 1.35, 0);
    const canopyGeos: THREE.BufferGeometry[] = [];
    const blob = (dx: number, dy: number, dz: number, r: number) => {
      const g = new THREE.IcosahedronGeometry(r, 1);
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
            p.setXYZ(i, p.getX(i) * (0.85 + rng() * 0.3), p.getY(i) * (0.75 + rng() * 0.25), p.getZ(i) * (0.85 + rng() * 0.3));
          }
          g.computeVertexNormals();
          g.translate(dx, dy, dz);
          return g;
    };
    canopyGeos.push(blob(0, 3.4, 0, 1.5), blob(0.85, 2.9, 0.35, 1.05), blob(-0.7, 3.0, -0.5, 1.0), blob(0.1, 4.15, -0.2, 0.9));
    const canopyGeo = mergeGeometries(canopyGeos)!;
    canopyGeos.forEach((g) => g.dispose());
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6a543a, roughness: 0.95 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x4a5a2e, roughness: 0.88 });
    this.disposables.push(trunkGeo, canopyGeo, trunkMat, canopyMat);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trunkPos.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, trunkPos.length);
    trunks.castShadow = canopies.castShadow = true;
    canopies.receiveShadow = true;
    const dummy = new THREE.Object3D();
    const leafTint = new THREE.Color();
    trunkPos.forEach((p, i) => {
      dummy.position.copy(p);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.85 + rng() * 0.4);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      canopies.setMatrixAt(i, dummy.matrix);
      // Per-instance canopy tint: sun-washed LA green → olive → dry khaki variety.
      leafTint.setHSL(0.19 + rng() * 0.1, 0.34 + rng() * 0.22, 0.26 + rng() * 0.13);
      canopies.setColorAt(i, leafTint);
    });
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    this.group.add(trunks, canopies);

    // --- benches: seat + backrest + legs merged, instanced --------------------
    if (benchPos.length) {
      const parts: THREE.BufferGeometry[] = [];
      const seat = new THREE.BoxGeometry(1.9, 0.09, 0.52);
      seat.translate(0, 0.5, 0);
      parts.push(seat);
      const back = new THREE.BoxGeometry(1.9, 0.52, 0.08);
      back.translate(0, 0.82, -0.24);
      parts.push(back);
      for (const sx of [-0.78, 0.78]) {
        const leg = new THREE.BoxGeometry(0.09, 0.5, 0.46);
        leg.translate(sx, 0.25, 0.02);
        parts.push(leg);
      }
      const benchGeo = mergeGeometries(parts)!;
      parts.forEach((p) => p.dispose());
      const benchMat = new THREE.MeshStandardMaterial({ color: 0x7a5c3e, roughness: 0.85, metalness: 0.1 });
      this.disposables.push(benchGeo, benchMat);
      const benches = new THREE.InstancedMesh(benchGeo, benchMat, benchPos.length);
      benches.castShadow = true;
      benchPos.forEach((b, i) => {
        dummy.position.set(b.x, SIDEWALK_H, b.z);
        dummy.rotation.set(0, b.yaw, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        benches.setMatrixAt(i, dummy.matrix);
      });
      this.group.add(benches);
    }

    // --- waste bins: cylinder + rim, instanced --------------------------------
    if (binPos.length) {
      const binGeo = new THREE.CylinderGeometry(0.34, 0.28, 0.85, 8, 1);
      binGeo.translate(0, 0.42, 0);
      const binMat = new THREE.MeshStandardMaterial({ color: 0x2e4632, roughness: 0.7, metalness: 0.25 });
      this.disposables.push(binGeo, binMat);
      const bins = new THREE.InstancedMesh(binGeo, binMat, binPos.length);
      bins.castShadow = true;
      binPos.forEach((b, i) => {
        dummy.position.set(b.x, SIDEWALK_H, b.z);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        bins.setMatrixAt(i, dummy.matrix);
      });
      this.group.add(bins);
    }
  }

  // ------------------------------------------------------------------ ground
  private buildGround(): void {
    const tex = new THREE.CanvasTexture(this.compositeGroundCanvas(2048));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.disposables.push(tex);
    // Micro-bump normal map for the asphalt (subtle grain + wheel-wear patches).
    const gNorm = makeAsphaltNormal();
    gNorm.repeat.set(90, 90);
    this.disposables.push(gNorm);
    const segs = Math.floor(GROUND_CORE / 1.05);
    const geo = new THREE.PlaneGeometry(GROUND_SPAN, GROUND_SPAN, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ map: tex, normalMap: gNorm, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.85, metalness: 0.06, envMapIntensity: 0.3 });
    this.disposables.push(geo, mat);
    this.groundMat = mat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.groundEntry = this.destruction.register(mesh, {
      label: 'layer',
      cell: GROUND_SPAN / segs,
      color: 0x4a4a4c,
      deform: true,
      grant: 'cobblestone',
      layerY: 0,
      layerSpan: GROUND_SPAN,
    });
    // Outer skirt beyond the destructible ground — dry LA basin scrub.
    const skirtGeo = new THREE.PlaneGeometry(3200, 3200);
    skirtGeo.rotateX(-Math.PI / 2);
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0x7c7248, roughness: 1 });
    this.disposables.push(skirtGeo, skirtMat);
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.position.y = -0.35;
    this.group.add(skirt);
  }

  /** Compose the full city ground texture (grass, sidewalks, roads, markings). */
  private compositeGroundCanvas(size: number): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d')!;
    const S = size / GROUND_SPAN; // px per meter
    const w2p = (m: number) => (m + GROUND_SPAN / 2) * S; // world -> px

    // Grass base
    ctx.fillStyle = ctx.createPattern(makeGrassTile(), 'repeat')!;
    ctx.fillRect(0, 0, size, size);
    // subtle grass variation
    const rng = mulberry32(7);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rng() < 0.5 ? 'rgba(60,90,40,0.12)' : 'rgba(120,150,80,0.08)';
      const r = 8 + rng() * 40;
      ctx.beginPath();
      ctx.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sidewalk bands inside every block
    const sw = ctx.createPattern(makeSidewalkTile(), 'repeat')!;
    ctx.fillStyle = sw;
    for (const bi of this.blockRange()) {
      for (const bj of this.blockRange()) {
        const x0 = w2p(bi * BLOCK + ROAD_W / 2);
        const z0 = w2p(bj * BLOCK + ROAD_W / 2);
        const s = BLOCK - ROAD_W;
        ctx.fillRect(x0, z0, s * S, s * S);
      }
    }

    // Parking lots
    ctx.fillStyle = ctx.createPattern(makeAsphaltTile(), 'repeat')!;
    for (const bi of this.blockRange()) {
      for (const bj of this.blockRange()) {
        if (this.blockType(bi, bj) !== 'lot') continue;
        const x0 = w2p(bi * BLOCK + ROAD_W / 2 + SIDEWALK_W);
        const z0 = w2p(bj * BLOCK + ROAD_W / 2 + SIDEWALK_W);
        const s = BLOCK - ROAD_W - SIDEWALK_W * 2;
        ctx.fillRect(x0, z0, s * S, s * S);
        // stalls
        ctx.strokeStyle = 'rgba(230,230,230,0.75)';
        ctx.lineWidth = Math.max(1, 0.12 * S);
        for (let m = 1; m < 5; m++) {
          ctx.beginPath();
          ctx.moveTo(x0 + (s * m * S) / 5, z0 + 2 * S);
          ctx.lineTo(x0 + (s * m * S) / 5, z0 + s * S - 2 * S);
          ctx.stroke();
        }
      }
    }

    // Roads
    ctx.fillStyle = ctx.createPattern(makeAsphaltTile(), 'repeat')!;
    for (const c of this.roadCoords) {
      ctx.fillRect(w2p(c - ROAD_W / 2), 0, ROAD_W * S, size);
      ctx.fillRect(0, w2p(c - ROAD_W / 2), size, ROAD_W * S);
    }
    // Road wear streaks
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (const c of this.roadCoords) {
      ctx.fillRect(w2p(c - 1.6), 0, 3.2 * S, size);
      ctx.fillRect(0, w2p(c - 1.6), size, 3.2 * S);
    }

    // Lane markings: double yellow center + white edges + dashed lane lines
    const dash = (x1: number, y1: number, x2: number, y2: number, width: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * S;
      ctx.setLineDash([3 * S, 3.4 * S]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    for (const c of this.roadCoords) {
      const v = w2p(c);
      // vertical road (along z)
      dash(v - 0.3, 0, v - 0.3, size, 0.16, '#d8ae2e');
      dash(v + 0.3, 0, v + 0.3, size, 0.16, '#d8ae2e');
      ctx.fillStyle = 'rgba(238,238,238,0.9)';
      ctx.fillRect(w2p(c - ROAD_W / 2 + 0.32), 0, 0.16 * S, size);
      ctx.fillRect(w2p(c + ROAD_W / 2 - 0.48), 0, 0.16 * S, size);
      // LA avenue lane dashes between center and edge lines (traffic lanes)
      dash(v - LANE_OFF, 0, v - LANE_OFF, size, 0.14, 'rgba(226,224,216,0.62)');
      dash(v + LANE_OFF, 0, v + LANE_OFF, size, 0.14, 'rgba(226,224,216,0.62)');
      // horizontal road (along x)
      dash(0, v - 0.3, size, v - 0.3, 0.16, '#d8ae2e');
      dash(0, v + 0.3, size, v + 0.3, 0.16, '#d8ae2e');
      ctx.fillRect(0, w2p(c - ROAD_W / 2 + 0.32), size, 0.16 * S);
      ctx.fillRect(0, w2p(c + ROAD_W / 2 - 0.48), size, 0.16 * S);
      dash(0, v - LANE_OFF, size, v - LANE_OFF, 0.14, 'rgba(226,224,216,0.62)');
      dash(0, v + LANE_OFF, size, v + LANE_OFF, 0.14, 'rgba(226,224,216,0.62)');
    }

    // Crosswalks at intersections
    ctx.fillStyle = 'rgba(242,242,242,0.95)';
    for (const cx of this.roadCoords) {
      for (const cz of this.roadCoords) {
        for (let i = 0; i < 6; i++) {
          const off = -3.4 + i * 1.36;
          ctx.fillRect(w2p(cx + off), w2p(cz + ROAD_W / 2 + 0.5), 0.8 * S, 1.6 * S);
          ctx.fillRect(w2p(cx + off), w2p(cz - ROAD_W / 2 - 2.1), 0.8 * S, 1.6 * S);
          ctx.fillRect(w2p(cx + ROAD_W / 2 + 0.5), w2p(cz + off), 1.6 * S, 0.8 * S);
          ctx.fillRect(w2p(cx - ROAD_W / 2 - 2.1), w2p(cz + off), 1.6 * S, 0.8 * S);
        }
        // stop bars on the approach lanes
        ctx.fillStyle = 'rgba(238,238,238,0.92)';
        ctx.fillRect(w2p(cx + 1.0), w2p(cz + ROAD_W / 2 + 2.2), 2.6 * S, 0.35 * S);
        ctx.fillRect(w2p(cx - 3.6), w2p(cz - ROAD_W / 2 - 2.55), 2.6 * S, 0.35 * S);
        ctx.fillRect(w2p(cx + ROAD_W / 2 + 2.2), w2p(cz - 3.6), 0.35 * S, 2.6 * S);
        ctx.fillRect(w2p(cx - ROAD_W / 2 - 2.55), w2p(cz + 1.0), 0.35 * S, 2.6 * S);
        ctx.fillStyle = 'rgba(235,235,235,0.85)';
      }
    }
    // Manhole covers along the right-hand lane centers (skip intersections)
    ctx.fillStyle = '#2a2a2c';
    ctx.strokeStyle = 'rgba(90,90,92,0.9)';
    ctx.lineWidth = Math.max(1, 0.05 * S);
    for (const c of this.roadCoords) {
      for (let j = -GRID_HALF; j < GRID_HALF; j++) {
        if ((j + GRID_HALF) % 2 !== 1) continue;
        const mid = j * BLOCK + BLOCK / 2;
        for (const [mx, mz] of [[c + 1.9, mid], [mid, c - 1.9]] as Array<[number, number]>) {
          ctx.beginPath();
          ctx.arc(w2p(mx), w2p(mz), 0.55 * S, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    return cv;
  }

  private blockRange(): number[] {
    const out: number[] = [];
    for (let k = -GRID_HALF; k < GRID_HALF; k++) out.push(k);
    return out;
  }

  blockType(bi: number, bj: number): BlockType {
    const key = `${bi},${bj}`;
    const t = this.blockTypes.get(key);
    if (t) return t;
    const r = this.rng();
    const dc = Math.max(Math.abs(bi + 0.5), Math.abs(bj + 0.5)) / GRID_HALF;
    let type: BlockType = 'built';
    if (r < 0.08 && dc > 0.3) type = 'park';
    else if (r < 0.16 && dc > 0.2) type = 'lot';
    this.blockTypes.set(key, type);
    if (type === 'park') this.parkCenters.push(new THREE.Vector3(bi * BLOCK + BLOCK / 2, 0, bj * BLOCK + BLOCK / 2));
    if (type === 'lot') this.parkingLots.push(new THREE.Vector3(bi * BLOCK + BLOCK / 2, 0, bj * BLOCK + BLOCK / 2));
    return type;
  }

  // ------------------------------------------------------------------ blocks
  private buildBlocks(): void {
    const slabGeo = new THREE.BoxGeometry(BLOCK - ROAD_W, SIDEWALK_H, BLOCK - ROAD_W);
    this.disposables.push(slabGeo);
    const swTex = new THREE.CanvasTexture(makeSidewalkTile());
    swTex.colorSpace = THREE.SRGBColorSpace;
    swTex.wrapS = swTex.wrapT = THREE.RepeatWrapping;
    swTex.repeat.set(6, 6);
    this.disposables.push(swTex);
    const swNorm = makeSidewalkNormal();
    swNorm.repeat.set(6, 6);
    this.disposables.push(swNorm);
    const slabMat = new THREE.MeshStandardMaterial({ map: swTex, normalMap: swNorm, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.92 });
    this.disposables.push(slabMat);
    const slabCount = GRID_HALF * 2 * GRID_HALF * 2;
    const slabs = new THREE.InstancedMesh(slabGeo, slabMat, slabCount);
    slabs.receiveShadow = true;
    const dummy = new THREE.Object3D();
    let n = 0;
    for (const bi of this.blockRange()) {
      for (const bj of this.blockRange()) {
        dummy.position.set(bi * BLOCK + BLOCK / 2, SIDEWALK_H / 2, bj * BLOCK + BLOCK / 2);
        dummy.updateMatrix();
        slabs.setMatrixAt(n++, dummy.matrix);
        if (this.blockType(bi, bj) !== 'built') continue;
        this.placeBuildings(bi, bj);
      }
    }
    this.group.add(slabs);
  }

  private facade(style: string) {
    let f = this.facadeCache.get(style);
    if (!f) {
      const seed = ({ concrete: 11, glass: 23, brick: 37, white: 41, stucco: 53 } as Record<string, number>)[style] ?? 7;
      const made = makeFacadeTexture(style as 'concrete' | 'glass' | 'brick' | 'white' | 'stucco', seed * 97 + 13);
      f = { map: made.map, normalMap: made.normalMap, emissiveMap: made.emissiveMap };
      this.facadeCache.set(style, f);
      this.disposables.push(made.map, made.normalMap, made.emissiveMap);
    }
    return f;
  }

  /** District lookup by block indices: chebyshev core = downtown, else an
   *  angle sector of the neighborhood ring (LA-flavored zoning). */
  districtAt(bi: number, bj: number): DistrictMeta {
    const key = `${bi},${bj}`;
    const hit = this.districtCache.get(key);
    if (hit) return hit;
    const dc = Math.max(Math.abs(bi + 0.5), Math.abs(bj + 0.5)) / GRID_HALF;
    let d: DistrictMeta;
    if (dc < 0.34) {
      d = DISTRICTS.downtown;
    } else {
      const ang = Math.atan2(bj, bi); // -pi..pi
      const sector = Math.floor(((ang + Math.PI) / (Math.PI / 4))) % 8;
      d = RING_SECTORS[sector] ?? DISTRICTS.scentral;
    }
    this.districtCache.set(key, d);
    return d;
  }

  /** Shared storefront shell material for a variant (dark matte top, lit fascia). */
  private shellTopMat: THREE.MeshStandardMaterial | null = null;

  private storefront(variant: number): THREE.MeshStandardMaterial {
    if (!this.storefrontCache.length) {
      for (let v = 0; v < 3; v++) {
        const made = makeStorefrontTexture(v as 0 | 1 | 2);
        const mat = new THREE.MeshStandardMaterial({
          map: made.map,
          normalMap: made.normalMap,
          emissiveMap: made.emissiveMap,
          emissive: new THREE.Color(0xffffff),
          emissiveIntensity: 0.9,
          roughness: 0.62,
          metalness: 0.05,
          envMapIntensity: 0.5,
          side: THREE.DoubleSide,
        });
        this.nightMaterials.push(mat);
        this.disposables.push(made.map, made.normalMap, made.emissiveMap, mat);
        this.storefrontCache.push(mat);
      }
    }
    return this.storefrontCache[variant % this.storefrontCache.length];
  }

  /** Hollow parapet/cornice ring geometry (cached per rounded footprint). */
  private corniceGeo(w: number, d: number): THREE.BufferGeometry {
    const key = `${Math.round(w * 2) / 2}|${Math.round(d * 2) / 2}`;
    let g = this.corniceGeoCache.get(key);
    if (!g) {
      const parts: THREE.BufferGeometry[] = [];
      const t = 0.32, ch = 0.42, ow = w + 0.5, od = d + 0.5;
      for (const sz of [-1, 1]) {
        const b = new THREE.BoxGeometry(ow, ch, t);
        b.translate(0, ch / 2, (sz * (od - t)) / 2);
        parts.push(b);
      }
      for (const sx of [-1, 1]) {
        const b = new THREE.BoxGeometry(t, ch, od - t * 2);
        b.translate((sx * (ow - t)) / 2, ch / 2, 0);
        parts.push(b);
      }
      g = mergeGeometries(parts)!;
      parts.forEach((p) => p.dispose());
      this.corniceGeoCache.set(key, g);
      this.disposables.push(g);
    }
    return g;
  }

  private placeBuildings(bi: number, bj: number): void {
    const r = this.rng;
    const x0 = bi * BLOCK + ROAD_W / 2 + SIDEWALK_W + 0.4;
    const z0 = bj * BLOCK + ROAD_W / 2 + SIDEWALK_W + 0.4;
    const span = BLOCK - ROAD_W - SIDEWALK_W * 2 - 0.8;
    const dc = Math.max(Math.abs(bi + 0.5), Math.abs(bj + 0.5)) / GRID_HALF;
    const two = r() < 0.45;
    const plots: Array<{ x: number; z: number; w: number; d: number }> = [];
    if (two) {
      const vertical = r() < 0.5;
      const w = vertical ? span * 0.46 : span * (0.75 + r() * 0.2);
      const d = vertical ? span * (0.75 + r() * 0.2) : span * 0.46;
      const gap = span - (vertical ? w * 2 : d * 2);
      if (vertical) {
        plots.push({ x: x0 + w / 2, z: z0 + d / 2, w, d });
        plots.push({ x: x0 + w * 1.5 + gap, z: z0 + d / 2, w, d });
      } else {
        plots.push({ x: x0 + w / 2, z: z0 + d / 2, w, d });
        plots.push({ x: x0 + w / 2, z: z0 + d * 1.5 + gap, w, d });
      }
    } else {
      const w = span * (0.62 + r() * 0.38);
      const d = span * (0.62 + r() * 0.38);
      plots.push({ x: x0 + span / 2, z: z0 + span / 2, w, d });
    }
    for (const p of plots) {
      const d = this.districtAt(bi, bj);
      // Downtown towers keep a proximity boost; the ring is flat LA sprawl.
      const coreBoost = d.id === 'downtown' ? (1 - dc) * 30 : 0;
      const h = Math.max(4.5, d.hMin + coreBoost + r() * d.hVar);
      const style = d.styles[Math.floor(r() * d.styles.length)] ?? 'stucco';
      // Retail strips (downtown core + boulevard districts) get the shells.
      this.makeBuilding(p.x, p.z, p.w, p.d, h, style, d.retail);
    }
  }

  private makeBuilding(cx: number, cz: number, w: number, d: number, h: number, style: string, district = false): void {
    const seg = (dim: number, cap: number) => Math.min(cap, Math.max(2, Math.round(dim / 0.85)));
    const geo = new THREE.BoxGeometry(w, h, d, seg(w, 24), seg(h, 34), seg(d, 24));
    // Scale UVs so facade tiles cover ~3m each.
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const su = Math.max(w, d) / 3;
    const sv = h / 3;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
    const f = this.facade(style);
    const glassy = style === 'glass';
    const mat = new THREE.MeshStandardMaterial({
      map: f.map,
      normalMap: f.normalMap,
      normalScale: new THREE.Vector2(glassy ? 0.55 : 1.0, glassy ? 0.55 : 1.0),
      emissiveMap: f.emissiveMap,
      emissive: new THREE.Color(0xffd9a0),
      emissiveIntensity: 0.9,
      roughness: glassy ? 0.14 : 0.82,
      metalness: glassy ? 0.7 : 0.04,
      envMapIntensity: glassy ? 1.4 : 0.28,
      side: THREE.DoubleSide,
    });
    this.nightMaterials.push(mat);
    this.disposables.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const y0 = SIDEWALK_H;
    mesh.position.set(cx, y0 + h / 2, cz);

    const roofGeo = new THREE.PlaneGeometry(w - 0.08, d - 0.08);
    roofGeo.rotateX(-Math.PI / 2);
    this.disposables.push(roofGeo);
    const roof = new THREE.Mesh(roofGeo, this.roofMat);
    roof.position.set(cx, y0 + h + 0.04, cz);
    roof.receiveShadow = true;

    const innerGeo = new THREE.BoxGeometry(w * 0.93, h - 0.25, d * 0.93);
    this.disposables.push(innerGeo);
    const inner = new THREE.Mesh(innerGeo, this.innerMat);
    inner.position.set(cx, y0 + h / 2, cz);

    const group = new THREE.Group();
    group.add(mesh, roof, inner);

    // --- Downtown district dressing: storefront shell + parapet cornice -------
    let shellMesh: THREE.Mesh | undefined;
    let shellEntry: DestructionEntry | undefined;
    if (district && h > 10) {
      const shellH = 4.2;
      const sw = w + 0.24, sd = d + 0.24;
      const shellGeo = new THREE.BoxGeometry(sw, shellH, sd, seg(sw, 10), 4, seg(sd, 10));
      const suv = shellGeo.attributes.uv as THREE.BufferAttribute;
      const ssu = Math.max(sw, sd) / 3;
      for (let i = 0; i < suv.count; i++) {
        suv.setXY(i, suv.getX(i) * ssu, suv.getY(i));
      }
      if (!this.corniceMat) {
        this.corniceMat = new THREE.MeshStandardMaterial({ color: 0x9a938a, roughness: 0.8, metalness: 0.05, envMapIntensity: 0.3 });
        this.disposables.push(this.corniceMat);
      }
      if (!this.shellTopMat) {
        this.shellTopMat = new THREE.MeshStandardMaterial({ color: 0x35322e, roughness: 0.9 });
        this.disposables.push(this.shellTopMat);
      }
      const topMat = this.shellTopMat;
      this.disposables.push(shellGeo);
      const vidx = (n: number) => Math.abs(Math.round(n)) % 3;
      shellMesh = new THREE.Mesh(shellGeo, [
        this.storefront(vidx(cx * 3 + cz)),
        this.storefront(vidx(cx - cz * 2)),
        topMat,
        topMat,
        this.storefront(vidx(cx * 2 + cz * 3)),
        this.storefront(vidx(cz * 2 - cx)),
      ]);
      shellMesh.position.set(cx, y0 + shellH / 2, cz);
      shellMesh.castShadow = true;
      shellMesh.receiveShadow = true;
      group.add(shellMesh);
      shellEntry = this.destruction.register(shellMesh, {
        label: 'building',
        cell: 0.9,
        color: 0x6e675e,
        deform: true,
        grant: 'cobblestone',
      });

      const cornice = new THREE.Mesh(this.corniceGeo(w, d), this.corniceMat);
      cornice.position.set(cx, y0 + h - 0.06, cz);
      cornice.castShadow = true;
      cornice.receiveShadow = true;
      group.add(cornice);
    }

    this.group.add(group);

    const entry = this.destruction.register(mesh, {
      label: 'building',
      cell: 0.9,
      color: style === 'brick' ? 0x7a4a38 : style === 'glass' ? 0x3c4a55 : 0x8a8478,
      deform: true,
      grant: 'cobblestone',
    });
    const aabb = new THREE.Box3(
      new THREE.Vector3(cx - w / 2, y0, cz - d / 2),
      new THREE.Vector3(cx + w / 2, y0 + h + 0.1, cz + d / 2)
    );
    this.buildings.push({
      group,
      mesh,
      entry,
      aabb,
      h,
      cx,
      cz,
      w,
      d,
      collapsing: false,
      collapseT: 0,
      collapsed: false,
      shellMesh,
      shellEntry,
    });
  }

  // ------------------------------------------------------------------ props
  private buildPalms(): void {
    const rng = mulberry32(99);
    const positions: THREE.Vector3[] = [];
    for (const c of this.parkCenters) {
      const n = 5 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        positions.push(
          new THREE.Vector3(c.x + (rng() - 0.5) * 16, SIDEWALK_H, c.z + (rng() - 0.5) * 16)
        );
      }
    }
    // Palm-lined block edges — density follows the district (Venice/Marina
    // boulevards vs. sparse Downtown/Warehouse).
    for (const bi of this.blockRange()) {
      for (const bj of this.blockRange()) {
        const p = this.districtAt(bi, bj).palms;
        if (rng() < p) {
          positions.push(
            new THREE.Vector3(bi * BLOCK + BLOCK / 2 + (rng() - 0.5) * 18, SIDEWALK_H, bj * BLOCK + ROAD_W / 2 + 1.3)
          );
        }
        if (rng() < p * 0.7) {
          positions.push(
            new THREE.Vector3(bi * BLOCK + ROAD_W / 2 + 1.3, SIDEWALK_H, bj * BLOCK + BLOCK / 2 + (rng() - 0.5) * 18)
          );
        }
      }
    }
    if (!positions.length) return;

    // Frond template: drooped blade, 11 copies merged around Y (denser crowns).
    const frondGeos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 11; i++) {
      const g = new THREE.PlaneGeometry(3.2, 0.9, 8, 1);
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < p.count; v++) {
        const x = p.getX(v) + 1.65;
        const t = x / 3.2;
        p.setX(v, x);
        p.setY(v, p.getY(v) - t * t * 1.8);
      }
      g.computeVertexNormals();
      g.rotateY((i / 11) * Math.PI * 2 + rng() * 0.3);
      g.rotateZ(-0.28 - rng() * 0.38);
      frondGeos.push(g);
    }
    const frondGeo = mergeGeometries(frondGeos)!;
    frondGeos.forEach((g) => g.dispose());
    const frondTex = makeFrondTexture();
    const frondMat = new THREE.MeshStandardMaterial({
      map: frondTex,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 0.9,
    });
    this.disposables.push(frondGeo, frondMat, frondTex);

    const trunkGeo = new THREE.CylinderGeometry(0.13, 0.26, 4.6, 7, 5);
    const tp = trunkGeo.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < tp.count; v++) {
      const t = (tp.getY(v) + 2.3) / 4.6;
      tp.setX(v, tp.getX(v) + t * t * 0.7);
    }
    trunkGeo.computeVertexNormals();
    const trunkTex = makeTrunkTexture();
    const trunkMat = new THREE.MeshStandardMaterial({ map: trunkTex, roughness: 1 });
    this.disposables.push(trunkGeo, trunkMat, trunkTex);

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, positions.length);
    const fronds = new THREE.InstancedMesh(frondGeo, frondMat, positions.length);
    trunks.castShadow = fronds.castShadow = true;
    const dummy = new THREE.Object3D();
    positions.forEach((p, i) => {
      const s = 0.85 + rng() * 0.5;
      dummy.position.copy(p);
      dummy.scale.setScalar(s);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      const bend = 0.7 * s * s;
      dummy.position.set(p.x + bend, p.y + 4.55 * s, p.z);
      dummy.updateMatrix();
      fronds.setMatrixAt(i, dummy.matrix);
    });
    this.group.add(trunks, fronds);
  }

  private buildStreetLights(): void {
    const poleGeos: THREE.BufferGeometry[] = [];
    const pole1 = new THREE.CylinderGeometry(0.07, 0.11, 5.4, 6);
    pole1.translate(0, 2.7, 0);
    const arm = new THREE.CylinderGeometry(0.05, 0.05, 1.7, 5);
    arm.rotateZ(Math.PI / 2);
    arm.translate(0.85, 5.3, 0);
    poleGeos.push(pole1, arm);
    const poleGeo = mergeGeometries(poleGeos)!;
    poleGeos.forEach((g) => g.dispose());
    const headGeo = new THREE.BoxGeometry(0.55, 0.14, 0.24);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c2e30, roughness: 0.6, metalness: 0.6 });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfff2cf,
      emissive: 0xffd9a0,
      emissiveIntensity: 1.6,
      roughness: 0.4,
    });
    this.headMat = headMat;
    this.disposables.push(poleGeo, headGeo, poleMat, headMat);

    const spots: Array<{ x: number; z: number; flip: boolean }> = [];
    for (const c of this.roadCoords) {
      for (let j = -GRID_HALF; j < GRID_HALF; j++) {
        const mid = j * BLOCK + BLOCK / 2;
        if ((j + GRID_HALF) % 2 === 0) spots.push({ x: c + ROAD_W / 2 + 0.55, z: mid, flip: false });
        else spots.push({ x: c - ROAD_W / 2 - 0.55, z: mid, flip: true });
        spots.push({ x: mid, z: c + ROAD_W / 2 + 0.55, flip: false });
      }
    }
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length);
    const heads = new THREE.InstancedMesh(headGeo, headMat, spots.length);
    const dummy = new THREE.Object3D();
    spots.forEach((s, i) => {
      dummy.position.set(s.x, SIDEWALK_H, s.z);
      dummy.rotation.set(0, s.flip ? Math.PI : 0, 0);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);
      const dir = s.flip ? -1 : 1;
      dummy.position.set(s.x + dir * 1.7, SIDEWALK_H + 5.32, s.z);
      dummy.updateMatrix();
      heads.setMatrixAt(i, dummy.matrix);
    });
    this.group.add(poles, heads);
  }

  private buildHills(): void {
    const rng = mulberry32(4242);
    // Dry golden basin hills (GTA Vinewood-style scrubland, not lush green).
    const mat = new THREE.MeshStandardMaterial({ color: 0x8f7f4a, roughness: 1 });
    const geo = new THREE.SphereGeometry(1, 10, 7);
    this.disposables.push(mat, geo);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + rng() * 0.4;
      const dist = 620 + rng() * 380;
      const m = new THREE.Mesh(geo, mat);
      m.position.set(Math.cos(a) * dist, -30, Math.sin(a) * dist);
      m.scale.set(180 + rng() * 160, 60 + rng() * 90, 180 + rng() * 160);
      this.group.add(m);
    }
    this.buildHillsideSign();
  }

  /** HYPERION hillside sign — white block letters on the north ridge,
   *  the LA-landmark silhouette of the map (game's own name, not a copy). */
  private buildHillsideSign(): void {
    const CELL = 2.0; // m per pixel cell of the 5x7 letter grid (14m tall letters)
    const THICK = 0.6;
    // 5x7 bitmap letters: H Y P E R I O N
    const GLYPHS: string[][] = [
      ['10001', '10001', '11111', '10001', '10001', '10001', '10001'],
      ['10001', '10001', '10001', '01110', '00100', '00100', '00100'],
      ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
      ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
      ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
      ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
      ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
      ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
    ];
    const parts: THREE.BufferGeometry[] = [];
    let cursor = 0;
    const advance = 5 * CELL + 2.4; // letter width + spacing
    for (const rows of GLYPHS) {
      for (let ry = 0; ry < rows.length; ry++) {
        const row = rows[ry] ?? '';
        for (let rx = 0; rx < row.length; rx++) {
          if (row[rx] !== '1') continue;
          const b = new THREE.BoxGeometry(CELL, CELL, THICK);
          b.translate(cursor + rx * CELL, (rows.length - 1 - ry) * CELL, 0);
          parts.push(b);
        }
      }
      cursor += advance;
    }
    const signGeo = mergeGeometries(parts)!;
    parts.forEach((p) => p.dispose());
    const signMat = new THREE.MeshStandardMaterial({
      color: 0xf4f0e6,
      roughness: 0.55,
    });
    this.disposables.push(signGeo, signMat);
    // Dark hillside backing plate — gives the white letters contrast against
    // the bright haze sky (the landmark reads like white-on-shadowed-terrain).
    const backGeo = new THREE.BoxGeometry(cursor + 6, 7 * CELL + 3, 0.5);
    const backMat = new THREE.MeshStandardMaterial({ color: 0x33302a, roughness: 1 });
    this.disposables.push(backGeo, backMat);
    const signGrp = new THREE.Group();
    const back = new THREE.Mesh(backGeo, backMat);
    back.position.set(cursor / 2, 3.5 * CELL, -1.15);
    signGrp.add(back);
    const sign = new THREE.Mesh(signGeo, signMat);
    signGrp.add(sign);
    // Center the row on the north ridge, leaning back into the slope. The glyph
    // grid faces +z (toward the city) — no yaw flip, or it reads mirrored.
    signGrp.position.set(-cursor / 2, 44, -655);
    signGrp.rotation.x = -0.26; // recline onto the hill
    this.group.add(signGrp);
  }

  // ------------------------------------------------------------------ queries
  isOnRoad(x: number, z: number): boolean {
    if (Math.abs(x) > CITY_HALF + ROAD_W / 2 || Math.abs(z) > CITY_HALF + ROAD_W / 2) return false;
    for (const c of this.roadCoords) {
      if (Math.abs(x - c) <= ROAD_W / 2) return true;
      if (Math.abs(z - c) <= ROAD_W / 2) return true;
    }
    return false;
  }

  sidewalkHeight(x: number, z: number): number {
    if (Math.abs(x) > CITY_HALF || Math.abs(z) > CITY_HALF) return 0;
    const bx = Math.floor(x / BLOCK);
    const bz = Math.floor(z / BLOCK);
    const lx = x - bx * BLOCK;
    const lz = z - bz * BLOCK;
    const inner = BLOCK - ROAD_W; // 24
    if (lx < ROAD_W / 2 || lx > ROAD_W / 2 + inner || lz < ROAD_W / 2 || lz > ROAD_W / 2 + inner) return 0;
    return SIDEWALK_H;
  }

  buildingAt(pos: THREE.Vector3, margin = 0): BuildingRec | null {
    for (const b of this.buildings) {
      if (b.collapsed) continue;
      if (
        pos.x > b.aabb.min.x - margin &&
        pos.x < b.aabb.max.x + margin &&
        pos.z > b.aabb.min.z - margin &&
        pos.z < b.aabb.max.z + margin &&
        pos.y < b.aabb.max.y
      )
        return b;
    }
    return null;
  }

  /** Any building AABB overlapped by a world-space ray (prefilter). */
  rayBuildingCandidates(ray: THREE.Ray, maxDist: number): BuildingRec[] {
    const out: BuildingRec[] = [];
    const end = ray.origin.clone().addScaledVector(ray.direction, maxDist);
    for (const b of this.buildings) {
      if (b.collapsed) continue;
      const box = _tmpBox.copy(b.aabb).expandByScalar(0.4);
      if (ray.intersectsBox(box) || box.containsPoint(end) || box.containsPoint(ray.origin)) out.push(b);
    }
    return out;
  }

  // ------------------------------------------------------------------ night
  /** Adjust window + streetlight emissives for the day/night cycle (night: 0..1). */
  applyNight(night: number): void {
    const emiss = 0.55 + night * 1.05;
    for (const m of this.nightMaterials) m.emissiveIntensity = emiss;
    if (this.headMat) this.headMat.emissiveIntensity = 0.45 + night * 2.8;
  }

  // ------------------------------------------------------------------ rain
  /** Wet the city ground: w = 0 dry → 1 soaked. Drops roughness (mirror sheen),
   *  boosts the IBL reflection and darkens/tints the asphalt slightly blue. */
  setWet(w: number): void {
    const m = this.groundMat;
    if (!m) return;
    const k = w < 0 ? 0 : w > 1 ? 1 : w;
    m.roughness = 0.85 - k * 0.62;
    m.envMapIntensity = 0.3 + k * 2.4;
    m.color.setRGB(1 - k * 0.22, 1 - k * 0.22, 1 - k * 0.19);
  }

  // ------------------------------------------------------------------ collapse
  checkCollapses(): void {
    for (const b of this.buildings) {
      if (b.collapsing || b.collapsed) continue;
      if (this.destruction.aliveRatio(b.entry) < 0.42) this.startCollapse(b);
    }
  }

  private startCollapse(b: BuildingRec): void {
    b.collapsing = true;
    b.collapseT = 0;
    this.destruction.unregister(b.mesh);
    if (b.shellMesh && b.shellEntry) this.destruction.unregister(b.shellMesh);
    this.onCollapseStart?.(b);
  }

  update(dt: number): void {
    for (const b of this.buildings) {
      if (!b.collapsing || b.collapsed) continue;
      b.collapseT += dt;
      const k = Math.min(1, b.collapseT / 1.7);
      b.group.position.y = -b.h * 0.94 * k * k;
      if (Math.random() < dt * 8) {
        const p = new THREE.Vector3(b.cx + (Math.random() - 0.5) * b.w, 0.5, b.cz + (Math.random() - 0.5) * b.d);
        this.onCollapseDust?.(p, b.w * 0.5);
      }
      if (k >= 1) {
        b.collapsed = true;
        b.group.visible = false;
        // Rubble pile
        const rng = mulberry32(Math.floor(b.cx * 31 + b.cz));
        for (let i = 0; i < 9; i++) {
          const r = 0.5 + rng() * 1.3;
          const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), this.rubbleMat);
          m.position.set(b.cx + (rng() - 0.5) * b.w * 0.9, r * 0.4, b.cz + (rng() - 0.5) * b.d * 0.9);
          m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
          m.castShadow = true;
          this.group.add(m);
        }
        this.onCollapsed?.(b);
      }
    }
  }

  createStrataLayer(layerY: number, x: number, z: number): THREE.Mesh {
    const kind =
      layerY > -LAYER_GAP * 1.5
        ? 'dirt'
        : layerY > -LAYER_GAP * 7
          ? 'stone'
          : layerY > -LAYER_GAP * 15
            ? 'deepslate'
            : 'bedrock';
    const tex = makeLayerTexture(kind as 'dirt' | 'stone' | 'deepslate' | 'bedrock', Math.floor(-layerY));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(LAYER_SPAN / 2, LAYER_SPAN / 2);
    const geo = new THREE.PlaneGeometry(LAYER_SPAN, LAYER_SPAN, Math.floor(LAYER_SPAN / 1.05), Math.floor(LAYER_SPAN / 1.05));
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, layerY, z);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const entry = this.destruction.register(mesh, {
      label: 'layer',
      cell: 1.05,
      color: kind === 'dirt' ? 0x6b4a2f : kind === 'stone' ? 0x7d7d7d : 0x3a3f44,
      deform: true,
      grant: kind === 'dirt' ? 'dirt' : 'cobblestone',
      layerY,
      layerSpan: LAYER_SPAN,
    });
    entry.layerCX = x;
    entry.layerCZ = z;
    entry.layerHalf = LAYER_SPAN / 2;
    void entry;
    return mesh;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
  }
}

const _tmpBox = new THREE.Box3();
