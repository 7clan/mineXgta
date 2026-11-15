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
import { GtaSource } from './gtaSource';
import { buildRealLattice, RealBlock, RealLattice } from './gtaMap';

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

/**
 * Los Santos built from the REAL GTA V source data (feature/gta-source-port):
 * the street lattice, block extents, park gap and water come from the actual
 * game's paths.ipl / water.xml as downloaded from the GTA clone source; the
 * material set is the real GTA V texture dictionary extraction. Buildings,
 * props and destruction remain the engine's own (fully preserved gameplay).
 */
export class City {
  group = new THREE.Group();
  buildings: BuildingRec[] = [];
  parkingLots: THREE.Vector3[] = [];
  parkCenters: THREE.Vector3[] = [];
  /** Real N-S street centerlines (x axis, game coords). */
  roadCoords: number[] = [];
  /** Real E-W street centerlines (z axis, game coords). */
  roadCoordsZ: number[] = [];
  /** Real water quads in the window (ocean/river planes). */
  waterQuads: { x0: number; x1: number; z0: number; z1: number; y: number }[] = [];
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

  private lattice: RealLattice;
  private realBlocks: RealBlock[];
  /** GTA V real textures (null-safe — procedural fallback when offline). */
  private gta: GtaSource;
  private cityHalf: number;

  constructor(scene: THREE.Scene, destruction: DestructionSystem, gta: GtaSource) {
    this.scene = scene;
    this.destruction = destruction;
    this.gta = gta;
    this.lattice = buildRealLattice(gta.roads, gta.water);
    this.realBlocks = this.lattice.blocks;
    this.roadCoords = this.lattice.streetsX.slice();
    this.roadCoordsZ = this.lattice.streetsY.slice();
    this.waterQuads = this.lattice.water;
    this.cityHalf = Math.max(CITY_HALF, this.lattice.half);
    for (const b of this.realBlocks) {
      // register real block kinds into the legacy query interface
      this.blockTypes.set(`${b.bi},${b.bj}`, b.kind);
      if (b.kind === 'park') {
        this.parkCenters.push(new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2));
      }
      if (b.kind === 'lot') {
        this.parkingLots.push(new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2));
      }
    }
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
    const cv = this.compositeGroundCanvas(2048);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.disposables.push(tex);
    const segs = Math.floor(GROUND_CORE / 1.05);
    const geo = new THREE.PlaneGeometry(GROUND_SPAN, GROUND_SPAN, segs, segs);
    geo.rotateX(-Math.PI / 2);
    // Real GTA V detail maps multiply over the painted base when present.
    const detail = this.gta.tex.concreteNoise ?? this.gta.tex.concreteSmooth ?? null;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.78, metalness: 0.06, envMapIntensity: 0.55,
      ...(detail
        ? { roughnessMap: (() => {
            const d = detail.clone();
            d.wrapS = d.wrapT = THREE.RepeatWrapping;
            d.repeat.set(GROUND_SPAN / 8, GROUND_SPAN / 8);
            return d;
          })() }
        : {}),
    });
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
    // Real GTA V water quads — actual ocean/river planes from water.xml.
    for (const w of this.waterQuads) {
      const ww = w.x1 - w.x0, wd = w.z1 - w.z0;
      const wGeo = new THREE.PlaneGeometry(ww, wd);
      wGeo.rotateX(-Math.PI / 2);
      const wMat = new THREE.MeshStandardMaterial({
        color: 0x1e4d66, roughness: 0.12, metalness: 0.4,
        transparent: true, opacity: 0.88,
      });
      this.disposables.push(wGeo, wMat);
      const wMesh = new THREE.Mesh(wGeo, wMat);
      wMesh.position.set((w.x0 + w.x1) / 2, w.y + 0.06, (w.z0 + w.z1) / 2);
      this.group.add(wMesh);
    }
    // Outer skirt beyond the destructible ground.
    const skirtGeo = new THREE.PlaneGeometry(3200, 3200);
    skirtGeo.rotateX(-Math.PI / 2);
    const skirtTexImg = this.gta.tex.grass;
    const skirtMat = new THREE.MeshStandardMaterial(
      skirtTexImg
        ? { map: skirtTexImg, roughness: 1 }
        : { color: 0x54703c, roughness: 1 }
    );
    if (skirtTexImg) skirtTexImg.repeat.set(90, 90);
    this.disposables.push(skirtGeo, skirtMat);
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.position.y = -0.35;
    this.group.add(skirt);
  }

  /** Compose the city ground over the REAL street lattice + real water. */
  private compositeGroundCanvas(size: number): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d')!;
    const S = size / GROUND_SPAN; // px per meter
    const w2p = (m: number) => (m + GROUND_SPAN / 2) * S; // world -> px
    const RX = this.roadCoords; // real N-S streets
    const RZ = this.roadCoordsZ; // real E-W streets

    // Grass base — real GTA V grass texture tiled when available.
    const realGrass = this.gta.tex.grass;
    if (realGrass && (realGrass.image as HTMLImageElement | undefined)?.width) {
      const pat = ctx.createPattern(realGrass.image as CanvasImageSource, 'repeat')!;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, size, size);
    } else {
      ctx.fillStyle = ctx.createPattern(makeGrassTile(), 'repeat')!;
      ctx.fillRect(0, 0, size, size);
    }
    // subtle grass variation
    const rng = mulberry32(7);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rng() < 0.5 ? 'rgba(60,90,40,0.12)' : 'rgba(120,150,80,0.08)';
      const r = 8 + rng() * 40;
      ctx.beginPath();
      ctx.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Real water quads — painted before roads so streets overlay banks.
    for (const w of this.waterQuads) {
      const gr = ctx.createLinearGradient(0, w2p(w.z0), 0, w2p(w.z1));
      gr.addColorStop(0, '#1b455c');
      gr.addColorStop(0.5, '#215873');
      gr.addColorStop(1, '#1b455c');
      ctx.fillStyle = gr;
      ctx.fillRect(w2p(w.x0), w2p(w.z0), (w.x1 - w.x0) * S, (w.z1 - w.z0) * S);
    }

    // Sidewalk bands inside every real block
    const sw = ctx.createPattern(makeSidewalkTile(), 'repeat')!;
    ctx.fillStyle = sw;
    for (const b of this.realBlocks) {
      const x0 = w2p(b.x0 + ROAD_W / 2);
      const z0 = w2p(b.z0 + ROAD_W / 2);
      const s = (b.x1 - b.x0 - ROAD_W) * S;
      const d = (b.z1 - b.z0 - ROAD_W) * S;
      ctx.fillRect(x0, z0, s, d);
    }

    // Parking lots on real lot blocks
    ctx.fillStyle = ctx.createPattern(makeAsphaltTile(), 'repeat')!;
    for (const b of this.realBlocks) {
      if (b.kind !== 'lot') continue;
      const x0 = w2p(b.x0 + ROAD_W / 2 + SIDEWALK_W);
      const z0 = w2p(b.z0 + ROAD_W / 2 + SIDEWALK_W);
      const s = b.x1 - b.x0 - ROAD_W - SIDEWALK_W * 2;
      const d = b.z1 - b.z0 - ROAD_W - SIDEWALK_W * 2;
      ctx.fillRect(x0, z0, s * S, d * S);
      ctx.strokeStyle = 'rgba(230,230,230,0.75)';
      ctx.lineWidth = Math.max(1, 0.12 * S);
      const stalls = Math.max(3, Math.min(9, Math.floor(s / 4.5)));
      for (let m = 1; m < stalls; m++) {
        ctx.beginPath();
        ctx.moveTo(x0 + (s * m / stalls) * S, z0 + 2 * S);
        ctx.lineTo(x0 + (s * m / stalls) * S, z0 + d * S - 2 * S);
        ctx.stroke();
      }
    }

    // Real park blocks — the actual Legion Square gap gets grass + paths.
    for (const b of this.realBlocks) {
      if (b.kind !== 'park') continue;
      const x0 = w2p(b.x0 + ROAD_W / 2 + SIDEWALK_W);
      const z0 = w2p(b.z0 + ROAD_W / 2 + SIDEWALK_W);
      const s = b.x1 - b.x0 - ROAD_W - SIDEWALK_W * 2;
      const d = b.z1 - b.z0 - ROAD_W - SIDEWALK_W * 2;
      const parkGrass = this.gta.tex.grass;
      if (parkGrass && (parkGrass.image as HTMLImageElement | undefined)?.width) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, z0, s * S, d * S);
        ctx.clip();
        ctx.fillStyle = ctx.createPattern(parkGrass.image as CanvasImageSource, 'repeat')!;
        ctx.fillRect(x0, z0, s * S, d * S);
        ctx.restore();
      } else {
        ctx.fillStyle = ctx.createPattern(makeGrassTile(), 'repeat')!;
        ctx.fillRect(x0, z0, s * S, d * S);
      }
      // plaza paths
      ctx.fillStyle = 'rgba(196,186,168,0.85)';
      const cx = x0 + (s * S) / 2, cz = z0 + (d * S) / 2;
      ctx.fillRect(cx - 0.9 * S, z0, 1.8 * S, d * S);
      ctx.fillRect(x0, cz - 0.9 * S, s * S, 1.8 * S);
    }

    // Roads — painted along the REAL street centerlines.
    ctx.fillStyle = ctx.createPattern(makeAsphaltTile(), 'repeat')!;
    for (const c of RX) ctx.fillRect(w2p(c - ROAD_W / 2), 0, ROAD_W * S, size);
    for (const c of RZ) ctx.fillRect(0, w2p(c - ROAD_W / 2), size, ROAD_W * S);
    // Road wear streaks
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (const c of RX) ctx.fillRect(w2p(c - 1.6), 0, 3.2 * S, size);
    for (const c of RZ) ctx.fillRect(0, w2p(c - 1.6), size, 3.2 * S);

    // Lane markings: double yellow center + white edges along real streets
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
    for (const c of RX) {
      const v = w2p(c);
      dash(v - 0.28, 0, v - 0.28, size, 0.14, '#c9a227');
      dash(v + 0.28, 0, v + 0.28, size, 0.14, '#c9a227');
      ctx.fillStyle = 'rgba(220,220,220,0.8)';
      ctx.fillRect(w2p(c - ROAD_W / 2 + 0.35), 0, 0.14 * S, size);
      ctx.fillRect(w2p(c + ROAD_W / 2 - 0.49), 0, 0.14 * S, size);
    }
    for (const c of RZ) {
      const v = w2p(c);
      dash(0, v - 0.28, size, v - 0.28, 0.14, '#c9a227');
      dash(0, v + 0.28, size, v + 0.28, 0.14, '#c9a227');
      ctx.fillStyle = 'rgba(220,220,220,0.8)';
      ctx.fillRect(0, w2p(c - ROAD_W / 2 + 0.35), size, 0.14 * S);
      ctx.fillRect(0, w2p(c + ROAD_W / 2 - 0.49), size, 0.14 * S);
    }

    // Crosswalks at REAL street intersections
    ctx.fillStyle = 'rgba(235,235,235,0.85)';
    for (const cx of RX) {
      for (const cz of RZ) {
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

  /** Real block kind (bi/bj index the real street-gap lattice). */
  blockType(bi: number, bj: number): BlockType {
    const t = this.blockTypes.get(`${bi},${bj}`);
    if (t) return t;
    return 'built';
  }

  /** Real-block lookup for a world position (used by NPC/traffic queries). */
  realBlockAt(x: number, z: number): RealBlock | null {
    for (const b of this.realBlocks) {
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return b;
    }
    return null;
  }

  /** Public read access to the real block lattice (minimap, spawners). */
  realBlocksPublic(): RealBlock[] {
    return this.realBlocks;
  }

  // ------------------------------------------------------------------ blocks
  private buildBlocks(): void {
    // Sidewalk slabs with real GTA V concrete detail when available.
    const swMatTexBase = this.gta.tex.concreteNoise ?? this.gta.tex.concreteSmooth ?? null;
    const slabMats: THREE.MeshStandardMaterial[] = [];
    const mkSlabMat = () => {
      const m = new THREE.MeshStandardMaterial({ roughness: 0.95 });
      if (swMatTexBase) {
        const t = swMatTexBase.clone();
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(6, 6);
        m.map = t;
      } else {
        const t = new THREE.CanvasTexture(makeSidewalkTile());
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(6, 6);
        m.map = t;
      }
      slabMats.push(m);
      this.disposables.push(m);
      return m;
    };
    const defaultSlabMat = mkSlabMat();
    const geos: THREE.BufferGeometry[] = [];
    const mats: THREE.MeshStandardMaterial[] = [];
    for (const b of this.realBlocks) {
      const w = b.x1 - b.x0 - ROAD_W;
      const d = b.z1 - b.z0 - ROAD_W;
      if (w < 6 || d < 6) continue;
      const geo = new THREE.BoxGeometry(w, SIDEWALK_H, d);
      geos.push(geo);
      this.disposables.push(geo);
      mats.push(defaultSlabMat);
      const mesh = new THREE.Mesh(geo, defaultSlabMat);
      mesh.position.set((b.x0 + b.x1) / 2, SIDEWALK_H / 2, (b.z0 + b.z1) / 2);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      if (b.kind === 'built') this.placeBuildings(b);
    }
    void geos; void mats; void mkSlabMat;
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

  /** Real GTA V facade detail overlay: LA stucco / crusty concrete tiles
   *  multiply over the procedural window architecture (photographic look). */
  private facadeDetail(style: string): THREE.Texture | null {
    const t =
      style === 'white' || style === 'concrete'
        ? this.gta.tex.stucco ?? this.gta.tex.concreteSmooth
        : style === 'brick'
          ? this.gta.tex.crusty ?? this.gta.tex.concreteNoise
          : null;
    if (!t) return null;
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(3, 3);
    return c;
  }

  private placeBuildings(b: RealBlock): void {
    const r = this.rng;
    // Small real blocks (alley-fronted) get a slimmer sidewalk carve so the
    // dense downtown fabric still fills in.
    const inset = Math.min(SIDEWALK_W, Math.max(0.7, (Math.min(b.x1 - b.x0, b.z1 - b.z0) - ROAD_W) * 0.08));
    const x0 = b.x0 + ROAD_W / 2 + inset + 0.35;
    const z0 = b.z0 + ROAD_W / 2 + inset + 0.35;
    const spanX = b.x1 - b.x0 - ROAD_W - inset * 2 - 0.7;
    const spanZ = b.z1 - b.z0 - ROAD_W - inset * 2 - 0.7;
    const span = Math.min(spanX, spanZ);
    if (span < 3.5) return; // true alleys stay open
    const dc = Math.max(Math.abs(x0), Math.abs(z0)) / this.cityHalf;
    const two = r() < 0.45 && span > 14;
    const plots: Array<{ x: number; z: number; w: number; d: number }> = [];
    if (two) {
      const vertical = r() < 0.5;
      const w = vertical ? spanX * 0.46 : spanX * (0.75 + r() * 0.2);
      const d = vertical ? spanZ * (0.75 + r() * 0.2) : spanZ * 0.46;
      if (vertical) {
        plots.push({ x: x0 + w / 2, z: z0 + spanZ / 2, w, d });
        plots.push({ x: x0 + w * 1.5 + (spanX - w * 2), z: z0 + spanZ / 2, w, d });
      } else {
        plots.push({ x: x0 + spanX / 2, z: z0 + d / 2, w, d });
        plots.push({ x: x0 + spanX / 2, z: z0 + d * 1.5 + (spanZ - d * 2), w, d });
      }
    } else {
      const w = spanX * (0.62 + r() * 0.38);
      const d = spanZ * (0.62 + r() * 0.38);
      plots.push({ x: x0 + spanX / 2, z: z0 + spanZ / 2, w, d });
    }
    for (const p of plots) {
      if (Math.min(p.w, p.d) < 2.6) continue;
      // Real downtown zoning: big plots → towers, alley fronts → low shops.
      const area = p.w * p.d;
      const base = area > 2200 ? 30 + (1 - Math.min(1, dc)) * 30 : area > 700 ? 14 + (1 - Math.min(1, dc)) * 22 : 7 + r() * 8;
      const h = Math.max(6, base * (0.7 + r() * 0.6));
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
    const detailMap = this.facadeDetail(style);
    const mat = new THREE.MeshStandardMaterial({
      map: f.map,
      emissiveMap: f.emissiveMap,
      emissive: new THREE.Color(0xffd9a0),
      emissiveIntensity: 0.9,
      roughness: glassy ? 0.18 : 0.85,
      metalness: glassy ? 0.55 : 0.04,
      side: THREE.DoubleSide,
      ...(detailMap ? { roughnessMap: detailMap } : {}),
    });
    if (detailMap) this.disposables.push(detailMap);
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
    // Palms in the real parks (Legion Square) + lining real streets.
    for (const c of this.parkCenters) {
      const n = 5 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        positions.push(
          new THREE.Vector3(c.x + (rng() - 0.5) * 16, SIDEWALK_H, c.z + (rng() - 0.5) * 16)
        );
      }
    }
    for (const b of this.realBlocks) {
      if (b.kind !== 'built' || rng() >= 0.34) continue;
      const mid = (b.x0 + b.x1) / 2;
      if (rng() < 0.5) {
        positions.push(new THREE.Vector3(mid, SIDEWALK_H, b.z0 + ROAD_W / 2 + 1.3));
      } else {
        positions.push(new THREE.Vector3(b.x0 + ROAD_W / 2 + 1.3, SIDEWALK_H, (b.z0 + b.z1) / 2));
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
    // Streetlights along the REAL streets, alternating sides.
    for (const c of this.roadCoords) {
      for (const zc of this.roadCoordsZ) {
        const mid = zc + (this.lattice.half / Math.max(1, this.roadCoordsZ.length)) * 0.9;
        spots.push({ x: c + ROAD_W / 2 + 0.55, z: mid, flip: false });
        spots.push({ x: c - ROAD_W / 2 - 0.55, z: mid + 40, flip: true });
      }
    }
    for (const c of this.roadCoordsZ) {
      for (const xc of this.roadCoords) {
        const mid = xc + 22;
        spots.push({ x: mid, z: c + ROAD_W / 2 + 0.55, flip: false });
        spots.push({ x: mid + 36, z: c - ROAD_W / 2 - 0.55, flip: true });
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
  /** On a real street? (distance to the nearest N-S or E-W centerline). */
  isOnRoad(x: number, z: number): boolean {
    if (Math.abs(x) > this.cityHalf + ROAD_W / 2 || Math.abs(z) > this.cityHalf + ROAD_W / 2) return false;
    for (const c of this.roadCoords) if (Math.abs(x - c) <= ROAD_W / 2) return true;
    for (const c of this.roadCoordsZ) if (Math.abs(z - c) <= ROAD_W / 2) return true;
    return false;
  }

  sidewalkHeight(x: number, z: number): number {
    const b = this.realBlockAt(x, z);
    if (!b) return 0;
    // Raised sidewalk band rings the block interior (inside the road edge).
    const lx = Math.min(x - b.x0, b.x1 - x);
    const lz = Math.min(z - b.z0, b.z1 - z);
    if (lx < ROAD_W / 2 || lz < ROAD_W / 2) return 0;
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
    m.roughness = 0.78 - k * 0.55;
    m.envMapIntensity = 0.55 + k * 2.6;
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
