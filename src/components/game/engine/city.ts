import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  BLOCK,
  CITY_HALF,
  GROUND_CORE,
  GROUND_SPAN,
  GRID_HALF,
  LAYER_GAP,
  LAYER_SPAN,
  ROAD_W,
  SIDEWALK_H,
  SIDEWALK_W,
  mulberry32,
} from './constants';
import { DestructionSystem, DestructionEntry } from './destruction';
import {
  makeAsphaltTile,
  makeFacadeTexture,
  makeFrondTexture,
  makeGrassTile,
  makeLayerTexture,
  makeRoofTexture,
  makeSidewalkTile,
  makeTrunkTexture,
} from './textures';

export type BlockType = 'built' | 'park' | 'lot';

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
}

/** Procedural Los Santos-style city: road grid, destructible buildings, props, strata. */
export class City {
  group = new THREE.Group();
  buildings: BuildingRec[] = [];
  parkingLots: THREE.Vector3[] = [];
  parkCenters: THREE.Vector3[] = [];
  roadCoords: number[] = [];
  blockTypes = new Map<string, BlockType>();
  groundEntry: DestructionEntry | null = null;
  private scene: THREE.Scene;
  private destruction: DestructionSystem;
  private facadeCache = new Map<string, { map: THREE.Texture; emissiveMap: THREE.Texture }>();
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
    scene.add(this.group);
  }

  // ------------------------------------------------------------------ ground
  private buildGround(): void {
    const tex = new THREE.CanvasTexture(this.compositeGroundCanvas(2048));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.disposables.push(tex);
    const segs = Math.floor(GROUND_CORE / 1.05);
    const geo = new THREE.PlaneGeometry(GROUND_SPAN, GROUND_SPAN, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.94, metalness: 0.02 });
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
    // Outer skirt beyond the destructible ground.
    const skirtGeo = new THREE.PlaneGeometry(3200, 3200);
    skirtGeo.rotateX(-Math.PI / 2);
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0x54703c, roughness: 1 });
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

    // Lane markings: double yellow center + white edges
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
      dash(v - 0.28, 0, v - 0.28, size, 0.14, '#c9a227');
      dash(v + 0.28, 0, v + 0.28, size, 0.14, '#c9a227');
      ctx.fillStyle = 'rgba(220,220,220,0.8)';
      ctx.fillRect(w2p(c - ROAD_W / 2 + 0.35), 0, 0.14 * S, size);
      ctx.fillRect(w2p(c + ROAD_W / 2 - 0.49), 0, 0.14 * S, size);
      // horizontal road (along x)
      dash(0, v - 0.28, size, v - 0.28, 0.14, '#c9a227');
      dash(0, v + 0.28, size, v + 0.28, 0.14, '#c9a227');
      ctx.fillRect(0, w2p(c - ROAD_W / 2 + 0.35), size, 0.14 * S);
      ctx.fillRect(0, w2p(c + ROAD_W / 2 - 0.49), size, 0.14 * S);
    }

    // Crosswalks at intersections
    ctx.fillStyle = 'rgba(235,235,235,0.85)';
    for (const cx of this.roadCoords) {
      for (const cz of this.roadCoords) {
        for (let i = 0; i < 6; i++) {
          const off = -3.4 + i * 1.36;
          ctx.fillRect(w2p(cx + off), w2p(cz + ROAD_W / 2 + 0.5), 0.8 * S, 1.6 * S);
          ctx.fillRect(w2p(cx + off), w2p(cz - ROAD_W / 2 - 2.1), 0.8 * S, 1.6 * S);
          ctx.fillRect(w2p(cx + ROAD_W / 2 + 0.5), w2p(cz + off), 1.6 * S, 0.8 * S);
          ctx.fillRect(w2p(cx - ROAD_W / 2 - 2.1), w2p(cz + off), 1.6 * S, 0.8 * S);
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
    const slabMat = new THREE.MeshStandardMaterial({ map: swTex, roughness: 0.95 });
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
      const made = makeFacadeTexture(style as 'concrete' | 'glass' | 'brick' | 'white', 100 + style.length * 17);
      f = { map: made.map, emissiveMap: made.emissiveMap };
      this.facadeCache.set(style, f);
      this.disposables.push(made.map, made.emissiveMap);
    }
    return f;
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
      const base = 8 + (1 - dc) * 40;
      const h = Math.max(7, base * (0.65 + r() * 0.75));
      let style: 'concrete' | 'glass' | 'brick' | 'white';
      const sr = r();
      if (dc < 0.4) style = sr < 0.5 ? 'glass' : sr < 0.8 ? 'white' : 'concrete';
      else style = sr < 0.4 ? 'concrete' : sr < 0.65 ? 'brick' : sr < 0.85 ? 'white' : 'glass';
      this.makeBuilding(p.x, p.z, p.w, p.d, h, style);
    }
  }

  private makeBuilding(cx: number, cz: number, w: number, d: number, h: number, style: string): void {
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
      emissiveMap: f.emissiveMap,
      emissive: new THREE.Color(0xffd9a0),
      emissiveIntensity: 0.9,
      roughness: glassy ? 0.18 : 0.85,
      metalness: glassy ? 0.55 : 0.04,
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
    for (const bi of this.blockRange()) {
      for (const bj of this.blockRange()) {
        if (rng() < 0.3) {
          positions.push(
            new THREE.Vector3(bi * BLOCK + BLOCK / 2 + (rng() - 0.5) * 18, SIDEWALK_H, bj * BLOCK + ROAD_W / 2 + 1.3)
          );
        }
      }
    }
    if (!positions.length) return;

    // Frond template: drooped blade, 8 copies merged around Y.
    const frondGeos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.PlaneGeometry(3.0, 0.85, 8, 1);
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < p.count; v++) {
        const x = p.getX(v) + 1.55;
        const t = x / 3.1;
        p.setX(v, x);
        p.setY(v, p.getY(v) - t * t * 1.5);
      }
      g.computeVertexNormals();
      g.rotateY((i / 8) * Math.PI * 2 + rng() * 0.3);
      g.rotateZ(-0.25 - rng() * 0.35);
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
    const mat = new THREE.MeshStandardMaterial({ color: 0x4c5a3a, roughness: 1 });
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
    m.roughness = 0.94 - k * 0.62;
    m.envMapIntensity = 1 + k * 2.4;
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
