import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  BEDROCK_Y,
  CAR_EXPLODE_RADIUS,
  CITY_HALF,
  GRID_HALF,
  BLOCK,
  HAND_COOLDOWN,
  HAND_RADIUS,
  LAYER0_Y,
  LAYER_GAP,
  MAX_STRATA,
  PICK_COOLDOWN,
  REACH,
  ROAD_W,
  TNT_FUSE,
  TNT_RADIUS,
  mulberry32,
} from './constants';
import { DestructionSystem } from './destruction';
import { Input } from './input';
import { City } from './city';
import { Player } from './player';
import { NPCs } from './npcs';
import { Particles } from './particles';
import { Vehicles, Car } from './vehicles';
import { HyperionAudio } from './audio';
import { Missions } from './missions';
import { Weather } from './weather';
import { Helicopter } from './helicopter';
import { SAVE_TYPES, clearSave, hasSave, loadSave, writeSave, loadSettings, writeSettings, type Settings } from './save';
import {
  HUD_EMIT_INTERVAL,
  MINIMAP_SPAN,
  buildSky,
  rayBox,
  updateClouds,
  type SkyUniforms,
} from './game-utils';
import { ITEMS, makeBlockMaterial, makeTNTMaterials } from './items';
import { AimHit, HudState, ItemId, ItemStack, World } from './types';
import { makeCloudTexture, makeSunSprite } from './textures';

export interface GameCallbacks {
  onState: (s: HudState) => void;
  onToast: (msg: string) => void;
  onDeath: () => void;
  /** Engine-initiated pause (Esc without pointer lock) — syncs the React pause menu. */
  onPauseRequest: () => void;
}

const DAY_CYCLE = 300; // seconds of game-time for a full 24h cycle
// Palette anchors for the day/night cycle.
const DUSK_SUN = new THREE.Color(0xff8a3c);
const NIGHT_TOP = new THREE.Color(0x060912);
const NIGHT_MID = new THREE.Color(0x0d1424);
const NIGHT_BOTTOM = new THREE.Color(0x141d33);
const DUSK_ORANGE = new THREE.Color(0xff9a4a);
const NIGHT_FOG = new THREE.Color(0x0a0f1a);
// Overcast/rain palette.
const GRAY_TOP = new THREE.Color(0x4a5258);
const GRAY_MID = new THREE.Color(0x6a7076);
const GRAY_BOT = new THREE.Color(0x838a8e);
const GRAY_FOG = new THREE.Color(0x7d858a);
const WHITE = new THREE.Color(0xffffff);

interface PlacedBlock {
  mesh: THREE.Mesh;
  aabb: THREE.Box3;
  type: ItemId;
}
interface TntEntity {
  mesh: THREE.Mesh;
  fuse: number;
  pos: THREE.Vector3;
}
interface Pearl {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  t: number;
}
interface FirePatch {
  pos: THREE.Vector3;
  ttl: number;
}
interface TankShell {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  t: number;
}
interface ScorchDecal {
  mesh: THREE.Mesh;
  life: number;
  /** Fade ceiling for this decal (scorch 0.52, puddles fainter). */
  base: number;
}
interface Tracer {
  line: THREE.Line;
  life: number;
}

export class HyperionGame implements World {
  private canvas: HTMLCanvasElement;
  private minimap: HTMLCanvasElement | null = null;
  private cb: GameCallbacks;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private destruction = new DestructionSystem();
  /** Public so the React touch-control layer can drive virtual input. */
  input = new Input();
  city: City;
  player: Player;
  vehicles: Vehicles;
  npcs: NPCs;
  particles: Particles;
  audio = new HyperionAudio();
  private detachInput: () => void = () => {};

  private placed = new Map<string, PlacedBlock>();
  private placedOrder: string[] = [];
  private tnts: TntEntity[] = [];
  private pearls: Pearl[] = [];
  private fires: FirePatch[] = [];
  private shells: TankShell[] = [];
  private decals: ScorchDecal[] = [];
  private tracers: Tracer[] = [];

  playing = false;
  paused = false;
  uiOpen = false;
  private deadNotified = false;
  private thirdPerson = false;

  private slot = 0;
  private hotbar: (ItemStack | null)[] = new Array(9).fill(null);
  private inventory: (ItemStack | null)[] = new Array(18).fill(null);

  private heat = 0;
  private stars = 0;
  private digTimer = 0;
  private shakeT = 0;
  private hurtVignette = 0;
  debugVisible = false;

  private clock = new THREE.Clock();
  private raf = 0;
  private stateT = 0;
  private fps = 60;
  private frameAcc = 0;
  private frameN = 0;
  private fpsT = 0;
  private qualityTier = 0;
  private skyUniforms: SkyUniforms | null = null;
  private starsMat: THREE.PointsMaterial | null = null;
  private timeT = 0.72; // 0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset
  private policeTimer = 0;
  private sirenOn = false;
  private policeWarned = false;
  private evadeT = 0; // seconds since any cop last had eyes on the player
  private loseWarned = false;
  /** Occlusion-aware LOS result, recomputed at 4 Hz. */
  private copsSee = false;
  private losT = 0;
  /** Jetpack (contract-chain reward): fuel 0..1 + live thrust flag. */
  jetFuel = 1;
  private jetThrusting = false;
  /** Ground wetness 0..1 — rises in rain, dries slowly after. */
  private wetT = 0;
  private lightningT = 0;
  /** Police air support (5 stars) + door-gun combat state. */
  private heli: Helicopter | null = null;
  private heliGunT = 2;
  private heliBurst = 0;
  private heliBurstT = 0;
  private heliMinAlt = 44;
  private heliScanT = 0;
  /** SPOTTED: the chopper searchlight has the player lit — ground cops converge. */
  private spotT = 0;
  private spotToastT = 0;
  /** Rhino tank gunnery (chain tier-2 reward). */
  private tankAimYaw = 0;
  private tankAimPitch = 0.14;
  private shellCd = 0;
  private shellGeo: THREE.SphereGeometry | null = null;
  private shellMat: THREE.MeshStandardMaterial | null = null;
  private hitMark = 0;
  private clockStr = '17:20';
  private raycaster = new THREE.Raycaster();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private rng = mulberry32(777);
  private minimapBase: HTMLCanvasElement | null = null;
  private minimapT = 0;
  private hintT = 0;
  private currentHint: string | null = null;
  private drivingCar: Car | null = null;
  private disposed = false;
  private weather: Weather;
  private beacon: THREE.Mesh | null = null;
  /** Pay'n'Spray bays (clear heat + repair for a CHAOS fee). */
  private sprays: Array<{ pos: THREE.Vector3; cd: number }> = [];
  private sprayRings: THREE.Mesh[] = [];
  private sprayAssets: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }> = [];
  private nearSpray: number | null = null;
  /** Police roadblocks (4+ stars): cruisers + spike strip across the player's road. */
  private roadblocks: Array<{ group: THREE.Group; pos: THREE.Vector3; spike: THREE.Vector3; cars: Car[]; barrier: THREE.Mesh; flyT: number }> = [];
  private roadblockCd = 8;
  private roadblockToastT = 0;
  private rbAssets: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }> = [];
  private rbGeo: { plane: THREE.PlaneGeometry; strip: THREE.BoxGeometry; tooth: THREE.ConeGeometry; cone: THREE.ConeGeometry; leg: THREE.BoxGeometry; endLight: THREE.BoxGeometry; hazardMat: THREE.MeshStandardMaterial; steelMat: THREE.MeshStandardMaterial; toothMat: THREE.MeshStandardMaterial; coneMat: THREE.MeshStandardMaterial; spikeLightMat: THREE.MeshStandardMaterial } | null = null;
  /** Fire hydrants: instanced street furniture that bursts into water geysers. */
  private hydrants: Array<{ pos: THREE.Vector3; broken: boolean; geyserT: number }> = [];
  private hydBody: THREE.InstancedMesh | null = null;
  private hydCap: THREE.InstancedMesh | null = null;
  private hydAssets: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }> = [];
  private hydToastT = 0;
  /** Gas stations: explosive fuel pumps (GTA classic — shoot one and the block burns). */
  private gasPumps: Array<{ pos: THREE.Vector3; mesh: THREE.Group; blown: boolean }> = [];
  private gasStations: Array<{ pos: THREE.Vector3 }> = [];
  private gasAssets: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }> = [];
  private gasSignMat: THREE.MeshStandardMaterial | null = null;
  /** Stunt ramps: yellow chevron wedges on mid-block roads — hit fast, get AIR TIME. */
  private stuntRamps: Array<{ group: THREE.Group; pos: THREE.Vector3; yaw: number; coolT: number }> = [];
  private rampAssets: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }> = [];
  private rampGeo: { wedge: THREE.BufferGeometry; edge: THREE.BoxGeometry; inclineMat: THREE.MeshStandardMaterial; bodyMat: THREE.MeshStandardMaterial; edgeMat: THREE.MeshStandardMaterial } | null = null;
  /** Airborne cars (launch physics live here; vehicles.ts owns ground physics). */
  private airCars = new Map<Car, { vy: number; t: number; player: boolean; state: Car['state']; last: THREE.Vector3 }>();
  private bestAir = 0;
  private airPop: { sec: number; score: number; record: boolean; key: number } | null = null;
  private airPopKey = 0;
  private airPopT = 0;
  /** User settings (volume / touch) — persisted separately from the world save. */
  private settings: Settings;
  private missions = new Missions({
    toast: (msg) => this.toast(msg),
    complete: (def) => {
      this.addScore(def.rewardScore);
      for (const r of def.rewards) this.addItem(r.id as ItemId, r.count, true);
      this.audio.pickup();
    },
    chainReward: (tier) => {
      if (tier === 1) {
        this.addItem('jetpack', 1, true);
        this.audio.pickup();
        this.addScore(80);
        this.toast('🔥 CHAIN BONUS — Chaos Jetpack! Select it, hold RMB to thrust');
      } else if (tier === 2) {
        this.vehicles.spawnTank(this.playerPos());
        this.audio.pickup();
        this.addScore(150);
        this.toast('🪖 CHAIN BONUS — RHINO TANK delivered nearby! Press F to commandeer · LMB fires the cannon');
      } else {
        this.addItem('tnt', 32, true);
        this.audio.pickup();
        this.addScore(200);
        this.toast('💥 MEGA PACK — TNT ×32 granted!');
      }
    },
    pickBuilding: () => this.pickContractBuilding(),
  });
  private autosaveT = 15;
  private hasSaveFile = false;

  constructor(canvas: HTMLCanvasElement, cb: GameCallbacks) {
    this.canvas = canvas;
    this.cb = cb;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1600);
    this.scene.fog = new THREE.Fog(0xe4c39a, 130, 620);

    // Lighting — golden hour
    this.hemi = new THREE.HemisphereLight(0xcfe0f2, 0x8a7a5a, 0.75);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffd9ae, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -95;
    this.sun.shadow.camera.right = 95;
    this.sun.shadow.camera.top = 95;
    this.sun.shadow.camera.bottom = -95;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();

    const built = buildSky(this.scene, makeSunSprite(), makeCloudTexture());
    this.skyUniforms = built.skyUniforms;
    this.starsMat = built.starsMat;

    this.city = new City(this.scene, this.destruction);
    this.city.onCollapseStart = (b) => {
      this.audio.collapse(this.far(b.group.position));
      this.addScore(40);
      this.missions.onCollapse(this.city.buildings.indexOf(b));
      this.toast('Structural collapse!');
    };
    this.city.onCollapseDust = (p, r) => this.particles.dustPuff(p, 6, r);
    this.city.onCollapsed = (b) => this.particles.dustPuff(new THREE.Vector3(b.cx, 1, b.cz), 40, b.w);

    this.player = new Player(this.scene);
    this.particles = new Particles(this.scene);
    this.vehicles = new Vehicles(this.scene);
    this.npcs = new NPCs(this.scene);
    this.weather = new Weather(this.scene);
    this.weather.onLightning = () => {
      this.lightningT = 0.24;
      this.audio.thunder(0.35 + Math.random() * 0.3);
      this.shake(0.1);
    };

    this.vehicles.onExplosion = (p, r) => this.explode(p, r, true);
    this.vehicles.onRagdollNPCs = (p, r) => {
      if (this.npcs.ragdollNear(p, r)) this.addScore(14);
    };
    // Settings: apply persisted volume/touch BEFORE any audio can start.
    this.settings = loadSettings();
    this.audio.setMasterVolume(this.settings.volume);
    this.buildSprayGarages();
    this.buildHydrants();
    this.buildGasStations();
    this.buildStuntRamps();
    this.vehicles.onSmoke = (car) => {
      const p = car.group.position.clone();
      p.y += 0.9;
      if (car.state === 'burning') this.particles.firePuff(p, 3);
      this.particles.smokePuff(p, car.state === 'burning' ? 2 : 1, 0.5, 2.4);
      this.audio.fireCrackle(this.far(p));
    };
    this.npcs.spawn(26, (bi, bj) => this.city.blockType(bi, bj) === 'built');
    this.vehicles.spawnTraffic(20);
    this.vehicles.spawnParked(this.city.parkingLots, BLOCK);

    this.initInventory();
    this.buildMinimapBase();

    this.detachInput = this.input.attach(canvas, () => {
      if (this.playing && !this.uiOpen) this.cb.onPauseRequest();
    });
    document.addEventListener('pointerlockchange', this.onLockChange);
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.hasSaveFile = hasSave();
  }

  private onLockChange = (): void => {
    this.input.setLocked(!!document.pointerLockElement);
  };

  private onResize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  setMinimap(c: HTMLCanvasElement | null): void {
    this.minimap = c;
  }

  // ------------------------------------------------------------------ inventory
  private initInventory(): void {
    const give = (id: ItemId, count: number) => this.addItem(id, count, true);
    give('pickaxe', 1);
    give('tnt', 32);
    give('dirt', 64);
    give('cobblestone', 64);
    give('planks', 64);
    give('glass', 32);
    give('flint', 1);
    give('pearl', 16);
    give('apple', 8);
    give('sword', 1);
  }

  addItem(id: ItemId, count: number, silent = false): void {
    const def = ITEMS[id];
    let left = count;
    for (const arr of [this.hotbar, this.inventory]) {
      for (const s of arr) {
        if (left <= 0) break;
        if (s && s.id === id && s.count < def.maxStack) {
          const take = Math.min(def.maxStack - s.count, left);
          s.count += take;
          left -= take;
        }
      }
    }
    for (const arr of [this.hotbar, this.inventory]) {
      for (let i = 0; i < arr.length; i++) {
        if (left <= 0) break;
        if (!arr[i]) {
          const take = Math.min(def.maxStack, left);
          arr[i] = { id, count: take };
          left -= take;
        }
      }
    }
    if (left > 0 && !silent) this.toast('Inventory full');
  }

  private selectedItem(): ItemStack | null {
    return this.hotbar[this.slot];
  }

  setSlot(i: number): void {
    this.slot = ((i % 9) + 9) % 9;
    const it = this.selectedItem();
    if (it) {
      this.toast(ITEMS[it.id].name);
      const held = ITEMS[it.id].heldColor;
      this.player.setHeldItem(held);
    } else this.player.setHeldItem(null);
  }

  swapInventorySlot(invIndex: number): void {
    const inv = this.inventory[invIndex];
    this.inventory[invIndex] = this.hotbar[this.slot];
    this.hotbar[this.slot] = inv;
  }

  // ------------------------------------------------------------------ World impl
  floorHeightAt(x: number, z: number, feetY: number): number {
    let best = -Infinity;
    // Strata layers (destruction system knows about all of them)
    for (const e of this.destruction.all()) {
      if (e.label !== 'layer' || e.hidden) continue;
      if (e.layerY > feetY + 0.6) continue;
      if (Math.abs(x - e.layerCX) > e.layerHalf || Math.abs(z - e.layerCZ) > e.layerHalf) continue;
      if (!this.destruction.columnCarved(x, z, e.layerY)) best = Math.max(best, e.layerY);
    }
    if (best === -Infinity) best = BEDROCK_Y; // fell past everything: bedrock catches
    // Ground surface extras
    if (best >= LAYER0_Y - 0.01 && !this.destruction.columnCarved(x, z, LAYER0_Y)) {
      best = Math.max(best, this.city.sidewalkHeight(x, z));
    }
    // Placed blocks
    const x0 = Math.floor(x - 0.4);
    const x1 = Math.floor(x + 0.4);
    const z0 = Math.floor(z - 0.4);
    const z1 = Math.floor(z + 0.4);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        for (let iy = Math.floor(feetY - 1.2); iy <= Math.floor(feetY + 1.2); iy++) {
          const b = this.placed.get(`${ix},${iy},${iz}`);
          if (!b) continue;
          const top = b.aabb.max.y;
          if (top <= feetY + 0.55) best = Math.max(best, top);
        }
      }
    }
    return best;
  }

  resolveCircleXZ(pos: THREE.Vector3, radius: number, feetY: number, height: number): void {
    // Buildings
    const b = this.city.buildingAt(pos, radius);
    if (b && !this.destruction.isCarved(pos.x, feetY + height * 0.5, pos.z)) {
      const a = b.aabb;
      const pushLeft = pos.x + radius - a.min.x;
      const pushRight = a.max.x - (pos.x - radius);
      const pushNear = pos.z + radius - a.min.z;
      const pushFar = a.max.z - (pos.z - radius);
      const minX = Math.min(pushLeft, pushRight);
      const minZ = Math.min(pushNear, pushFar);
      if (minX < minZ) pos.x += pushLeft < pushRight ? -pushLeft : pushRight;
      else pos.z += pushNear < pushFar ? -pushNear : pushFar;
    }
    // Placed blocks
    const x0 = Math.floor(pos.x - radius);
    const x1 = Math.floor(pos.x + radius);
    const z0 = Math.floor(pos.z - radius);
    const z1 = Math.floor(pos.z + radius);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        for (let iy = Math.floor(feetY - 0.5); iy <= Math.floor(feetY + height); iy++) {
          const blk = this.placed.get(`${ix},${iy},${iz}`);
          if (!blk) continue;
          if (blk.aabb.max.y <= feetY + 0.55) continue; // below feet: walkable
          if (blk.aabb.min.y >= feetY + height) continue; // above head
          const pushLeft = pos.x + radius - blk.aabb.min.x;
          const pushRight = blk.aabb.max.x - (pos.x - radius);
          const pushNear = pos.z + radius - blk.aabb.min.z;
          const pushFar = blk.aabb.max.z - (pos.z - radius);
          if (pushLeft <= 0 || pushRight <= 0 || pushNear <= 0 || pushFar <= 0) continue;
          const minX = Math.min(pushLeft, pushRight);
          const minZ = Math.min(pushNear, pushFar);
          if (minX < minZ) pos.x += pushLeft < pushRight ? -pushLeft : pushRight;
          else pos.z += pushNear < pushFar ? -pushNear : pushFar;
        }
      }
    }
  }

  carveSphere(point: THREE.Vector3, radius: number, color?: THREE.Color): number {
    const res = this.destruction.carveAt(point, radius, {
      debris: (p, n, c) => {
        this.particles.spawnDebris(p, Math.min(10, 3 + Math.floor(n / 6)), c, 0.8);
      },
    });
    if (res.removed > 0) {
      void color;
      this.missions.onVoxels(res.removed);
      this.city.checkCollapses();
      this.ensureStrata(this.player.pos.y);
      // Digging through the street shears hydrant risers — water mains burst.
      if (point.y < 2.2) this.maybeBreakHydrants(point, radius + 0.7);
    }
    return res.removed;
  }

  spawnDebris(p: THREE.Vector3, n: number, color: THREE.Color, power = 1): void {
    this.particles.spawnDebris(p, n, color, power);
  }

  aimRaycast(): AimHit | null {
    const origin = this.camera.getWorldPosition(this.tmpV).clone();
    const dir = this.camera.getWorldDirection(this.tmpV2).clone();
    this.raycaster.set(origin, dir);
    this.raycaster.far = REACH;
    let best: AimHit | null = null;

    const consider = (h: AimHit) => {
      if (!best || h.distance < best.distance) best = h;
    };

    // 1) Strata layers (analytic, skips carved cells)
    const layerHit = this.destruction.analyticLayerHit(origin, dir, REACH);
    if (layerHit) {
      const e = layerHit.entry;
      consider({
        point: layerHit.point,
        normal: new THREE.Vector3(0, 1, 0),
        distance: layerHit.distance,
        kind: 'layer',
        grant: e.layerY >= LAYER0_Y - 0.01 && !this.city.isOnRoad(layerHit.point.x, layerHit.point.z) ? 'dirt' : e.grant,
      });
    }

    // 2) Destructible meshes (buildings + shafts) via prefiltered raycast
    const meshes = this.destruction.raycastCandidates(this.raycaster.ray, REACH);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length) {
      const h = hits[0];
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      consider({
        point: h.point.clone(),
        normal: n,
        distance: h.distance,
        kind: h.object.userData.shaft ? 'shaft' : 'building',
        grant: 'cobblestone',
        object: h.object,
      });
    }

    // 3) Placed blocks (ray vs AABB)
    for (const [key, b] of this.placed) {
      const rb = rayBox(origin, dir, b.aabb, REACH);
      if (rb !== null) {
        consider({ point: rb.point, normal: rb.normal, distance: rb.t, kind: 'block', blockKey: key, grant: b.type === 'dirt' ? 'dirt' : b.type === 'glass' ? 'glass' : b.type === 'planks' ? 'planks' : 'cobblestone' });
      }
    }

    // 4) Cars & NPCs & TNT (sphere prefilter then mesh raycast)
    for (const car of this.vehicles.cars) {
      if (car.state === 'falling') continue;
      const c = car.group.position;
      const toC = c.clone().add(new THREE.Vector3(0, 0.7, 0)).sub(origin);
      const t = toC.dot(dir);
      if (t < 0 || t > REACH + 2.5) continue;
      if (toC.lengthSq() - t * t > 6.5) continue;
      const hs = this.raycaster.intersectObject(car.group, true);
      if (hs.length) {
        consider({
          point: hs[0].point.clone(),
          normal: new THREE.Vector3(0, 1, 0),
          distance: hs[0].distance,
          kind: 'car',
          carId: car.id,
        });
      }
    }
    for (const n of this.npcs.list) {
      if (n.state === 'down') continue;
      const c = n.group.position;
      const toC = c.clone().add(new THREE.Vector3(0, 1, 0)).sub(origin);
      const t = toC.dot(dir);
      if (t < 0 || t > REACH) continue;
      if (toC.lengthSq() - t * t > 1.4) continue;
      const hs = this.raycaster.intersectObject(n.group, true);
      if (hs.length) {
        consider({ point: hs[0].point.clone(), normal: new THREE.Vector3(0, 1, 0), distance: hs[0].distance, kind: 'npc' });
      }
    }
    for (const t of this.tnts) {
      const toC = t.pos.clone().add(new THREE.Vector3(0, 0.5, 0)).sub(origin);
      const d = toC.length();
      if (d < REACH) {
        consider({ point: t.pos.clone(), normal: new THREE.Vector3(0, 1, 0), distance: d, kind: 'tnt' });
      }
    }
    return best;
  }

  audioSfx = {
    dig: () => this.audio.dig(),
    breakBlock: () => this.audio.breakBlock(),
    place: () => this.audio.place(),
    boom: (far: number) => this.audio.boom(far),
    horn: (far: number) => this.audio.horn(far),
    ignite: (far: number) => this.audio.ignite(far),
    pearl: () => this.audio.pearl(),
    eat: () => this.audio.eat(),
    hurt: () => this.audio.hurt(),
    thud: (far: number) => this.audio.thud(far),
    enterCar: () => this.audio.enterCar(),
    pickup: () => this.audio.pickup(),
  };

  addScore(n: number): void {
    this.heat = Math.min(760, this.heat + n);
  }

  playerPos(): THREE.Vector3 {
    return this.drivingCar ? this.drivingCar.group.position : this.player.pos;
  }

  playerEyeY(): number {
    return this.player.pos.y + 1.62;
  }

  damagePlayer(n: number): void {
    if (n > 0) this.hitMark++;
    this.player.damage(n);
    this.audio.hurt();
    this.hurtVignette = 1;
    if (this.player.dead && !this.deadNotified) {
      this.deadNotified = true;
      this.cb.onDeath();
    }
  }

  ragdollNPCsNear(pos: THREE.Vector3, r: number): void {
    if (this.npcs.ragdollNear(pos, r)) {
      this.addScore(15);
      this.missions.onPed();
    }
  }

  fleeNPCs(pos: THREE.Vector3, r: number): void {
    this.npcs.fleeFrom(pos, r);
  }

  igniteCarsNear(pos: THREE.Vector3, r: number, excludeId?: number): void {
    for (const car of this.vehicles.cars) {
      if (car.id === excludeId) continue;
      if (car.state === 'burning' || car.state === 'wrecked' || car.state === 'player') continue;
      if (car.group.position.distanceTo(pos) < r) this.vehicles.ignite(car);
    }
  }

  isOnRoad(x: number, z: number): boolean {
    return this.city.isOnRoad(x, z);
  }

  shake(amount: number): void {
    this.shakeT = Math.min(1.2, this.shakeT + amount);
  }

  far(p: THREE.Vector3): number {
    return Math.min(1, p.distanceTo(this.playerPos()) / 95);
  }

  toast(msg: string): void {
    this.cb.onToast(msg);
  }

  // ------------------------------------------------------------------ strata
  private ensureStrata(feetY: number): void {
    let deepest = LAYER0_Y;
    let count = 0;
    const layerEntries: Array<{ y: number; x: number; z: number; entry: unknown }> = [];
    for (const e of this.destruction.all()) {
      if (e.label !== 'layer' || e.hidden) continue;
      count++;
      deepest = Math.min(deepest, e.layerY);
      layerEntries.push({ y: e.layerY, x: e.layerCX, z: e.layerCZ, entry: e });
    }
    // Create new layers below as the player descends
    const p = this.player.pos;
    while (deepest > Math.max(BEDROCK_Y, feetY - 2 * LAYER_GAP) && count < MAX_STRATA && deepest > BEDROCK_Y) {
      const ny = deepest - LAYER_GAP;
      const y = Math.max(ny, BEDROCK_Y);
      const mesh = this.city.createStrataLayer(y, p.x, p.z);
      if (y <= BEDROCK_Y + 0.01) {
        // bedrock is unbreakable
        const entry = this.destruction.getEntry(mesh);
        if (entry) entry.occ.clear();
        this.destruction.unregister(mesh);
      }
      deepest = y;
      count++;
    }
    // Recycle layers far from the player (underground only)
    for (const le of layerEntries) {
      const e = le.entry as { mesh: THREE.Mesh; layerY: number };
      if (le.y >= LAYER0_Y) continue;
      const tooDeepAbove = le.y < feetY - 5 * LAYER_GAP; // far above the player
      const tooFarXZ = Math.abs(le.x - p.x) > MINIMAP_SPAN || Math.abs(le.z - p.z) > MINIMAP_SPAN;
      if (tooDeepAbove || tooFarXZ) {
        this.destruction.unregister(e.mesh);
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        (e.mesh.material as THREE.Material).dispose();
      }
    }
  }

  // ------------------------------------------------------------------ actions
  private tryDig(dt: number): void {
    this.digTimer -= dt;
    const lmb = this.input.leftDown || this.input.virtualDig;
    if (!lmb || this.digTimer > 0) return;
    const it = this.selectedItem();
    const def = it ? ITEMS[it.id] : null;
    const isTool = def && (def.kind === 'tool' || def.kind === 'weapon');
    const radius = isTool ? def!.digRadius : HAND_RADIUS;
    this.digTimer = isTool ? def!.cooldown : HAND_COOLDOWN;
    if (this.drivingCar) return;

    const hit = this.aimRaycast();
    if (!hit) return;

    if (hit.kind === 'block' && hit.blockKey) {
      this.breakPlaced(hit.blockKey);
      return;
    }
    if (hit.kind === 'car' && hit.carId !== undefined) {
      const car = this.vehicles.cars.find((c) => c.id === hit.carId);
      if (car && car.state !== 'wrecked') {
        car.health -= 9;
        this.hitMark++;
        this.audio.thud(0.1);
        this.particles.spawnDebris(hit.point, 3, new THREE.Color(0x999999), 0.6);
        if (car.health <= 0) this.vehicles.ignite(car);
      }
      return;
    }
    if (hit.kind === 'npc') {
      if (this.npcs.hitNear(hit.point, 1.5)) {
        this.hitMark++;
        this.addScore(15);
        this.missions.onPed();
        this.audio.thud(0.1);
        this.toast('Pedestrian down');
        this.fleeNPCs(hit.point, 18);
      }
      return;
    }
    if (hit.kind === 'tnt') return;

    // World carving (micro-voxels)
    const color = hit.grant === 'dirt' ? new THREE.Color(0x6b4a2f) : new THREE.Color(0x55555a);
    const removed = this.carveSphere(hit.point, Math.max(radius, 0.42), color);
    if (removed > 0) {
      this.audio.dig();
      this.addScore(removed * 0.04);
      const grant = hit.grant ?? 'cobblestone';
      if (grant) this.addItem(grant, 1 + Math.floor(removed / 34), true);
      // Bedrock check
      if (hit.point.y <= BEDROCK_Y + 0.4) this.toast('Bedrock is unbreakable');
    }
  }

  private breakPlaced(key: string): void {
    const b = this.placed.get(key);
    if (!b) return;
    this.placed.delete(key);
    const idx = this.placedOrder.indexOf(key);
    if (idx >= 0) this.placedOrder.splice(idx, 1);
    this.scene.remove(b.mesh);
    b.mesh.geometry.dispose();
    this.particles.spawnDebris(b.aabb.getCenter(new THREE.Vector3()), 6, new THREE.Color(ITEMS[b.type].heldColor ?? 0x888888), 0.8);
    this.addItem(b.type, 1, true);
    this.audio.breakBlock();
  }

  private snapPlace(pos: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 | null {
    const p = pos.clone().addScaledVector(normal, 0.5);
    return new THREE.Vector3(Math.floor(p.x) + 0.5, Math.floor(p.y) + 0.5, Math.floor(p.z) + 0.5);
  }

  private canPlaceAt(center: THREE.Vector3): boolean {
    // Overlap with player?
    const pp = this.player.pos;
    if (
      Math.abs(pp.x - center.x) < 0.85 &&
      Math.abs(pp.z - center.z) < 0.85 &&
      center.y + 0.5 > pp.y &&
      center.y - 0.5 < pp.y + 1.9
    )
      return false;
    // Overlap with cars / npcs / tnt
    for (const car of this.vehicles.cars) {
      const c = car.group.position;
      if (c.distanceTo(center) < 2.6) return false;
    }
    for (const n of this.npcs.list) {
      if (n.group.position.distanceTo(center) < 1.1) return false;
    }
    return true;
  }

  private placeBlock(type: ItemId): void {
    const hit = this.aimRaycast();
    if (!hit || hit.kind === 'car' || hit.kind === 'npc' || hit.kind === 'tnt') return;
    const primary = this.snapPlace(hit.point, hit.normal);
    if (!primary) return;
    // Feet-friendly retries: direct cell, then one cell horizontally along the aim
    // direction (in front of the player), then one along the face normal.
    const candidates = [primary];
    const aimFlat = new THREE.Vector3(hit.point.x - this.player.pos.x, 0, hit.point.z - this.player.pos.z);
    if (aimFlat.lengthSq() > 1e-6) {
      aimFlat.normalize();
      const flat = new THREE.Vector3(Math.round(aimFlat.x), 0, Math.round(aimFlat.z));
      if (flat.x === 0 && flat.z === 0) flat.x = 1;
      candidates.push(primary.clone().add(flat));
    }
    candidates.push(primary.clone().add(hit.normal.clone().round()));
    let placedAt: THREE.Vector3 | null = null;
    let key = '';
    for (const cand of candidates) {
      if (cand.y <= BEDROCK_Y - 1) continue;
      const k = `${Math.floor(cand.x)},${Math.floor(cand.y)},${Math.floor(cand.z)}`;
      if (this.placed.has(k)) continue;
      if (!this.canPlaceAt(cand)) continue;
      placedAt = cand;
      key = k;
      break;
    }
    if (!placedAt) return;
    const geo = new RoundedBoxGeometry(0.97, 0.97, 0.97, 2, 0.07);
    const mesh = new THREE.Mesh(geo, makeBlockMaterial(type === 'dirt' ? 'dirt' : type === 'cobblestone' ? 'cobblestone' : type === 'planks' ? 'planks' : 'glass'));
    mesh.position.copy(placedAt);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.placed.set(key, {
      mesh,
      aabb: new THREE.Box3().setFromCenterAndSize(placedAt.clone(), new THREE.Vector3(1, 1, 1)),
      type,
    });
    this.placedOrder.push(key);
    if (this.placedOrder.length > 900) {
      const oldest = this.placedOrder.shift();
      if (oldest) this.breakPlacedSilent(oldest);
    }
    const it = this.selectedItem();
    if (it) {
      it.count--;
      if (it.count <= 0) this.hotbar[this.slot] = null;
    }
    this.audio.place();
  }

  private breakPlacedSilent(key: string): void {
    const b = this.placed.get(key);
    if (!b) return;
    this.placed.delete(key);
    this.scene.remove(b.mesh);
    b.mesh.geometry.dispose();
  }

  private placeTNT(): void {
    const hit = this.aimRaycast();
    if (!hit || hit.kind === 'car' || hit.kind === 'npc') return;
    const center = this.snapPlace(hit.point, hit.normal);
    if (!center) return;
    const key = `${Math.floor(center.x)},${Math.floor(center.y)},${Math.floor(center.z)}`;
    if (this.placed.has(key)) return;
    const mats = makeTNTMaterials();
    const geo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    const mesh = new THREE.Mesh(geo, [mats.side, mats.side, mats.top, mats.bottom, mats.side, mats.side].map((m) => (m as THREE.MeshLambertMaterial).clone()));
    mesh.position.copy(center);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.tnts.push({ mesh, fuse: TNT_FUSE, pos: center.clone() });
    const it = this.selectedItem();
    if (it) {
      it.count--;
      if (it.count <= 0) this.hotbar[this.slot] = null;
    }
    this.audio.place();
    this.toast('TNT armed — 3s fuse');
  }

  private useFlint(): void {
    const hit = this.aimRaycast();
    if (!hit) return;
    if (hit.kind === 'car' && hit.carId !== undefined) {
      const car = this.vehicles.cars.find((c) => c.id === hit.carId);
      if (car) {
        this.vehicles.ignite(car);
        this.audio.ignite(this.far(car.group.position));
        this.particles.firePuff(car.group.position.clone().add(new THREE.Vector3(0, 0.9, 0)), 14);
        this.toast(`${car.name} set on fire!`);
        this.addScore(25);
        this.fleeNPCs(car.group.position, 20);
        return;
      }
    }
    if (hit.kind === 'tnt') {
      for (const t of this.tnts) {
        if (t.pos.distanceTo(hit.point) < 1.2) t.fuse = Math.min(t.fuse, 0.5);
      }
      this.audio.ignite(0.2);
      return;
    }
    // Fire patch on ground
    this.particles.addFireEmitter(
      () => hit.point,
      6,
      1
    );
    this.fires.push({ pos: hit.point.clone(), ttl: 6 });
    this.audio.ignite(this.far(hit.point));
    this.particles.firePuff(hit.point, 10);
  }

  private throwPearl(): void {
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const geo = new THREE.SphereGeometry(0.1, 8, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1f8a7a, emissive: 0x1f8a7a, emissiveIntensity: 0.7 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(origin).addScaledVector(dir, 0.6);
    this.scene.add(mesh);
    this.pearls.push({ mesh, vel: dir.multiplyScalar(24).add(new THREE.Vector3(0, 3, 0)), t: 6 });
    this.audio.pearl();
    const it = this.selectedItem();
    if (it) {
      it.count--;
      if (it.count <= 0) this.hotbar[this.slot] = null;
    }
  }

  private useItem(): void {
    if (this.drivingCar) return;
    const it = this.selectedItem();
    if (!it) return;
    const def = ITEMS[it.id];
    switch (def.kind) {
      case 'placeable':
        if (it.count > 0) this.placeBlock(it.id);
        break;
      case 'tnt':
        if (it.count > 0) this.placeTNT();
        break;
      case 'igniter':
        this.useFlint();
        break;
      case 'throwable':
        if (it.count > 0) this.throwPearl();
        break;
      case 'food':
        if (this.player.health < 20 && it.count > 0) {
          this.player.heal(6);
          this.audio.eat();
          it.count--;
          if (it.count <= 0) this.hotbar[this.slot] = null;
          this.toast('Munch — +3 hearts');
        }
        break;
      default:
        break;
    }
  }

  /** Jetpack: hold RMB with it selected to thrust. Consumes fuel; refills when idle. */
  private updateJetpack(dt: number): void {
    const it = this.selectedItem();
    const armed = !!it && it.id === 'jetpack';
    const rmbHeld = this.input.rightDown || this.input.virtualUseHold;
    const wantThrust = armed && rmbHeld && this.jetFuel > 0 && !this.player.dead;
    this.jetThrusting = wantThrust;
    if (wantThrust) {
      // Rocket burn: strong vertical accel + forward boost, both velocity-capped.
      this.player.vel.y = Math.min(this.player.vel.y + 34 * dt, 13.5);
      const fwd = this.tmpV.set(-Math.sin(this.player.yaw), 0, -Math.cos(this.player.yaw));
      const horiz = Math.hypot(this.player.vel.x, this.player.vel.z);
      if (horiz < 17) {
        this.player.vel.x += fwd.x * 26 * dt;
        this.player.vel.z += fwd.z * 26 * dt;
      }
      this.player.onGround = false;
      this.jetFuel = Math.max(0, this.jetFuel - dt / 6.5); // ~6.5s of continuous burn
      // Exhaust plume at the nozzles (behind/below the player).
      const p = this.playerPos();
      if (Math.random() < dt * 55) {
        this.particles.firePuff(this.tmpV2.set(p.x - fwd.x * 0.35, p.y + 0.25, p.z - fwd.z * 0.35), 1);
      }
      if (Math.random() < dt * 22) {
        this.particles.smokePuff(this.tmpV2.set(p.x - fwd.x * 0.6, p.y + 0.05, p.z - fwd.z * 0.6), 1, 0.45, 1.8);
      }
      // Thrust recoil: tiny camera tremor while the rocket burns
      if (Math.random() < dt * 2.4) this.shake(0.05);
      this.audio.jetThrust(true);
    } else {
      if (this.jetFuel < 1) this.jetFuel = Math.min(1, this.jetFuel + dt / 9); // refill in ~9s
      if (this.jetFuel >= 0.08) {
        this.audio.jetThrust(false);
      }
    }
    if (this.jetFuel <= 0 && armed && rmbHeld && !this.jetDryWarned) {
      this.jetDryWarned = true;
      this.audio.jetThrust(false);
      this.toast('Jetpack fuel depleted — cooling down');
    }
    if (!rmbHeld || this.jetFuel > 0.12) this.jetDryWarned = false;
  }
  private jetDryWarned = false;

  private enterNearestCar(): void {
    if (this.drivingCar) {
      const car = this.drivingCar;
      this.drivingCar = null;
      this.vehicles.exit(car, this.player.pos);
      this.audio.enterCar();
      this.audio.stopEngine();
      this.audio.stopRadio();
      this.player.group.visible = this.thirdPerson;
      return;
    }
    const car = this.vehicles.nearest(this.player.pos, 3.8);
    if (car && car.state !== 'burning') {
      this.drivingCar = car;
      this.vehicles.enter(car);
      this.missions.onCarEnter(car.type);
      this.audio.enterCar();
      this.audio.startEngine();
      this.audio.startRadio(this.audio.radioStation > 0 ? this.audio.radioStation : 1);
      this.player.group.visible = false;
      if (car.type === 'tank') {
        // Seed the gun-cam behind the hull so the first frame already looks right.
        this.tankAimYaw = car.yaw;
        this.tankAimPitch = 0.14;
      }
      this.toast(`Driving ${car.name}`);
    }
  }

  // ------------------------------------------------------------------ explosion
  explode(pos: THREE.Vector3, radius: number, isCar = false): void {
    const r = isCar ? CAR_EXPLODE_RADIUS * 0.9 : radius;
    this.destruction.carveAt(pos, r, {
      debris: (p, n, c) => this.particles.spawnDebris(p, 12, c, 1.6),
      maxDebris: 26,
    });
    this.particles.explosion(pos, r);
    this.audio.boom(this.far(pos));
    this.shake(0.9);
    this.addScore(30);
    if (isCar) this.missions.onCarWreck();
    this.city.checkCollapses();
    this.ensureStrata(this.player.pos.y);
    this.addScorch(pos, r * 0.85);
    this.maybeBreakHydrants(pos, r * 1.1);
    this.maybeBlowPumps(pos, r);

    // Damage & chaos
    this.ragdollNPCsNear(pos, r * 1.35);
    this.fleeNPCs(pos, 55);
    this.igniteCarsNear(pos, r * 1.15);
    const pd = this.playerPos().distanceTo(pos);
    if (pd < r * 1.6) this.damagePlayer(Math.max(0, (1 - pd / (r * 1.6)) * 13));
    // Fire aftermath
    this.particles.addFireEmitter(() => pos.clone(), 3.5, 1.4);
  }

  // ------------------------------------------------------------------ loop
  start(): void {
    this.clock.start();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, this.clock.getDelta());
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private frame(dt: number): void {
    const active = this.playing && !this.paused && !this.uiOpen && !this.player.dead;

    if (active) this.updateGameplay(dt);
    this.city.update(dt);
    this.particles.update(dt);
    updateClouds(this.scene, dt);
    this.updateCamera(dt);
    this.updateHudEmit(dt);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  private updateGameplay(dt: number): void {
    // Mouse look
    const { dx, dy } = this.input.consumeMouse();
    if (!this.drivingCar) {
      this.player.yaw -= dx * 0.0023;
      this.player.pitch = Math.max(-1.55, Math.min(1.55, this.player.pitch - dy * 0.0023));
    } else if (this.drivingCar.type === 'tank') {
      // Tank gunnery: mouse orbits the turret aim (camera follows).
      this.tankAimYaw -= dx * 0.0023;
      this.tankAimPitch = Math.max(-0.55, Math.min(0.38, this.tankAimPitch - dy * 0.0023));
    }

    // Hotbar select
    for (let i = 0; i < 9; i++) {
      if (this.input.justPressed(`Digit${i + 1}`)) this.setSlot(i);
    }
    if (this.input.wheelDelta !== 0) this.setSlot(this.slot + this.input.wheelDelta);
    if (this.input.justPressed('KeyE')) {
      this.cb.onToast('__OPEN_INVENTORY__');
    }
    if (this.input.justPressed('F5')) {
      this.thirdPerson = !this.thirdPerson;
      this.player.thirdPerson = this.thirdPerson;
    }
    if (this.input.justPressed('F3')) this.debugVisible = !this.debugVisible;
    if (this.input.justPressed('KeyF')) this.enterNearestCar();
    if (this.input.justPressed('KeyH') && this.drivingCar) this.audio.horn(0.1);
    if (this.input.justPressed('KeyM')) {
      if (!this.missions.accept()) this.missions.abandon();
    }
    if (this.input.justPressed('KeyR') && this.drivingCar) {
      const st = this.audio.cycleRadio();
      this.toast(`📻 ${st}`);
    }

    // Player or car
    if (this.drivingCar) {
      // Analog touch joystick blends with the keyboard (raw key state avoids
      // double-counting the virtual axis mapping in isDown()).
      const throttle = Math.max(-1, Math.min(1, (this.input.keyDown('KeyW') ? 1 : 0) + (this.input.keyDown('KeyS') ? -1 : 0) + this.input.virtualMove.z));
      const steer = Math.max(-1, Math.min(1, (this.input.keyDown('KeyA') ? 1 : 0) + (this.input.keyDown('KeyD') ? -1 : 0) - this.input.virtualMove.x));
      // Airborne: momentum carries the car — steering/drive forces freeze mid-air.
      if (!this.airCars.has(this.drivingCar)) this.vehicles.drivePlayer(this.drivingCar, dt, throttle, steer, this.input.isDown('Space'), this);
      if (this.input.leftClicked) {
        if (this.drivingCar.type === 'tank') this.fireCannon();
        else this.audio.horn(0.05);
      }
      this.audio.setEngine(Math.min(1, Math.abs(this.drivingCar.speed) / 30));
      // Tank turret follows the aim (world yaw + barrel pitch from the camera ray)
      const tk = this.drivingCar;
      if (tk.type === 'tank' && tk.turret && tk.barrel) {
        tk.turret.rotation.y = this.tankAimYaw - tk.yaw;
        const camDir = this.camera.getWorldDirection(this.tmpV);
        tk.barrel.rotation.x = -Math.asin(THREE.MathUtils.clamp(camDir.y, -1, 1));
      }
    } else {
      this.updateJetpack(dt);
      const res = this.player.update(dt, this.input, this, true);
      if (res.landed && res.fallVel < -18) this.damagePlayer((Math.abs(res.fallVel) - 18) * 0.7);
      this.ensureStrata(this.player.pos.y);
    }

    this.vehicles.setPlayerRef(this.playerPos());
    this.vehicles.update(this.drivingCar, dt, this, this.playerPos());

    // Pay'n'Spray bays (drive-in respray + repair)
    this.updateSprays(dt);
    this.updateRoadblocks(dt);
    this.updateHydrants(dt);
    this.updateGasStations();

    // Stunt ramps + airborne car physics
    this.updateStunts(dt);
    this.updateAirCars(dt);

    // Digging (LMB / touch DIG hold)
    this.tryDig(dt);
    if (this.input.rightClicked) this.useItem();

    // Tank shells, tracer lines, scorch decals
    if (this.shellCd > 0) this.shellCd -= dt;
    this.updateShells(dt);
    this.updateTracers(dt);
    this.updateDecals(dt);

    // TNT fuses
    for (let i = this.tnts.length - 1; i >= 0; i--) {
      const t = this.tnts[i];
      t.fuse -= dt;
      const flash = Math.sin(t.fuse * 18) > 0 ? 2.4 : 0;
      for (const m of t.mesh.material as THREE.MeshLambertMaterial[]) {
        m.emissive = new THREE.Color(0xffffff);
        m.emissiveIntensity = flash;
      }
      if (t.fuse <= 0) {
        this.scene.remove(t.mesh);
        (t.mesh.material as THREE.Material[]).forEach((m) => m.dispose());
        t.mesh.geometry.dispose();
        this.tnts.splice(i, 1);
        this.explode(t.pos, TNT_RADIUS);
      }
    }

    // Pearls
    for (let i = this.pearls.length - 1; i >= 0; i--) {
      const p = this.pearls[i];
      p.t -= dt;
      p.vel.y -= 21 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      const floor = this.floorHeightAt(p.mesh.position.x, p.mesh.position.z, p.mesh.position.y) ;
      const inBuilding = !!this.city.buildingAt(p.mesh.position);
      if (p.t <= 0 || p.mesh.position.y <= floor + 0.05 || inBuilding) {
        this.player.pos.set(p.mesh.position.x, Math.max(floor, BEDROCK_Y) + 0.3, p.mesh.position.z);
        this.player.vel.set(0, 0, 0);
        this.particles.smokePuff(this.player.pos, 8, 0.8, 1.6);
        this.audio.pearl();
        this.scene.remove(p.mesh);
        this.pearls.splice(i, 1);
      }
    }

    // Fire patches ignite cars/NPCs
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.ttl -= dt;
      if (f.ttl <= 0) {
        this.fires.splice(i, 1);
        continue;
      }
      for (const car of this.vehicles.cars) {
        if (car.state === 'traffic' || car.state === 'parked') {
          if (car.group.position.distanceTo(f.pos) < 2.4) {
            this.vehicles.ignite(car);
            this.toast('Car caught fire!');
          }
        }
      }
      this.npcs.fleeFrom(f.pos, 8);
    }

    // NPC update
    this.npcs.update(dt, this);
    // Traffic avoid dug holes handled in vehicles via floorHeightAt

    // Weather machine + consequences
    this.updateWeather(dt);

    // Heat decay + stars (breaking line of sight burns heat 4× faster)
    const heatDecay = this.evadeT > 1.5 ? 10.5 : 2.5;
    this.heat = Math.max(0, this.heat - dt * heatDecay);
    this.stars = this.heat <= 0 ? 0 : Math.min(5, 1 + Math.floor(this.heat / 150));
    if (this.heat <= 0) {
      this.evadeT = 0;
      this.loseWarned = false;
    }

    // Police dispatch + day/night
    this.updatePolice(dt);
    this.timeT = (this.timeT + dt / DAY_CYCLE) % 1;
    this.updateDayNight();

    // Contracts + autosave
    this.updateBeacon(dt);
    this.missions.update(dt);
    this.autosaveT -= dt;
    if (this.autosaveT <= 0) {
      this.autosaveT = 15;
      this.saveNow(false);
    }

    // Hints
    this.hintT -= dt;
    if (this.hintT <= 0) {
      this.hintT = 0.18;
      const geyserNear = this.hydrants.find(
        (h) => h.broken && h.geyserT > 0 && Math.hypot(h.pos.x - this.player.pos.x, h.pos.z - this.player.pos.z) < 26
      );
      if (this.drivingCar) this.currentHint = 'F — exit vehicle   ·   H — horn';
      else if (this.nearGasHint()) this.currentHint = '⛽ Gas station — keep flames away from the pumps!';
      else if (geyserNear) this.currentHint = '💧 Burst hydrant — the geyser douses fires & burning cars';
      else if (this.nearSpray !== null && this.nearSpray < 42) this.currentHint = `🎨 Pay'n'Spray — ${Math.round(this.nearSpray)}m · drive in to clear heat & repair`;
      else {
        const near = this.vehicles.nearest(this.player.pos, 3.8);
        this.currentHint = near && near.state !== 'burning' ? `F — enter ${near.name}` : null;
      }
      // Ramp approach hint (driving fast toward one)
      if (this.drivingCar && Math.abs(this.drivingCar.speed) > 12) {
        const pp3 = this.drivingCar.group.position;
        for (const r of this.stuntRamps) {
          if (Math.hypot(r.pos.x - pp3.x, r.pos.z - pp3.z) < 34) {
            this.currentHint = '🛫 Stunt ramp ahead — hit it at speed for AIR TIME!';
            break;
          }
        }
      }
    }

    this.hurtVignette = Math.max(0, this.hurtVignette - dt * 1.6);
    this.shakeT = Math.max(0, this.shakeT - dt * 2.2);
  }

  // ------------------------------------------------------------------ tank gunnery

  /** Fire the Rhino Tank's main gun toward the camera aim. */
  private fireCannon(): void {
    if (this.shellCd > 0 || !this.drivingCar?.muzzle) return;
    this.shellCd = 2.6;
    if (!this.shellGeo || !this.shellMat) {
      this.shellGeo = new THREE.SphereGeometry(0.17, 10, 8);
      this.shellMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, emissive: 0xff8830, emissiveIntensity: 1.5, roughness: 0.4 });
    }
    const muzzle = this.drivingCar.muzzle.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const mesh = new THREE.Mesh(this.shellGeo, this.shellMat);
    mesh.position.copy(muzzle).addScaledVector(dir, 0.9);
    this.scene.add(mesh);
    this.shells.push({ mesh, vel: dir.clone().multiplyScalar(66).add(new THREE.Vector3(0, 2.4, 0)), t: 4 });
    this.audio.cannon();
    this.particles.firePuff(muzzle, 4);
    this.particles.smokePuff(muzzle, 3, 0.7, 1.5);
    this.shake(0.42);
    this.drivingCar.speed = Math.max(-5, this.drivingCar.speed - 1.3); // recoil
  }

  private updateShells(dt: number): void {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.t -= dt;
      s.vel.y -= 6.5 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      const p = s.mesh.position;
      if (Math.random() < dt * 26) this.particles.smokePuff(p.clone(), 1, 0.16, 0.3);
      let hit = s.t <= 0;
      if (!hit && p.y <= this.floorHeightAt(p.x, p.z, p.y) + 0.12) hit = true;
      if (!hit && !!this.city.buildingAt(p, 0.2)) hit = true;
      if (!hit) {
        for (const car of this.vehicles.cars) {
          if (car === this.drivingCar || car.state === 'wrecked' || car.state === 'falling') continue;
          if (car.group.position.distanceToSquared(p) < 7.4) {
            this.vehicles.ignite(car);
            hit = true;
            break;
          }
        }
      }
      if (!hit) {
        for (const n of this.npcs.list) {
          if (n.state === 'down') continue;
          if (n.group.position.distanceToSquared(p) < 1.9) {
            this.ragdollNPCsNear(p, 2.3);
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        this.explode(p.clone(), 7.4);
        this.addScore(20);
        this.scene.remove(s.mesh);
        this.shells.splice(i, 1);
      }
    }
  }

  /** Dark scorch circle left on the ground under explosions, fading over ~70 s. */
  private addScorch(p: THREE.Vector3, radius: number): void {
    const fy = this.floorHeightAt(p.x, p.z, p.y);
    if (p.y - fy > 7) return; // air burst: nothing to scorch below
    const geo = new THREE.CircleGeometry(radius * (0.8 + Math.random() * 0.35), 14);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0a0a0a,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(p.x, fy + 0.03 + Math.random() * 0.025, p.z);
    m.renderOrder = 3;
    this.pushDecal(m, 70, 0.52);
  }

  /** Wet sheen circle left on the asphalt under an active geyser, fading over ~25 s. */
  private addPuddle(p: THREE.Vector3, radius: number): void {
    const fy = this.floorHeightAt(p.x, p.z, p.y);
    if (p.y - fy > 3) return;
    const geo = new THREE.CircleGeometry(radius * (0.7 + Math.random() * 0.5), 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8fd4ef,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(p.x + (Math.random() - 0.5) * 1.5, fy + 0.045 + Math.random() * 0.02, p.z + (Math.random() - 0.5) * 1.5);
    m.renderOrder = 3;
    this.pushDecal(m, 25, 0.2);
  }

  /** FIFO registry shared by scorch + puddle decals. */
  private pushDecal(mesh: THREE.Mesh, life: number, base: number): void {
    this.scene.add(mesh);
    this.decals.push({ mesh, life, base });
    if (this.decals.length > 26) {
      const old = this.decals.shift();
      if (old) {
        this.scene.remove(old.mesh);
        old.mesh.geometry.dispose();
        (old.mesh.material as THREE.Material).dispose();
      }
    }
  }

  private updateDecals(dt: number): void {
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.life -= dt;
      const mat = d.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = d.life < 18 ? Math.max(0, (d.life / 18) * d.base) : d.base;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        mat.dispose();
        this.decals.splice(i, 1);
      }
    }
  }

  /** Brief additive tracer line for the chopper's door gun. */
  private spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.08 });
  }

  private updateTracers(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= dt;
      const mat = tr.line.material as THREE.LineBasicMaterial;
      mat.opacity = Math.max(0, tr.life / 0.08) * 0.95;
      if (tr.life <= 0) {
        this.scene.remove(tr.line);
        tr.line.geometry.dispose();
        mat.dispose();
        this.tracers.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------------ save / load
  /** Serialize world state to localStorage. manual=true toasts. */
  saveNow(manual: boolean): void {
    const placed: number[][] = [];
    for (const [key, b] of this.placed) {
      const [xs, ys, zs] = key.split(',');
      const ti = SAVE_TYPES.indexOf(b.type as (typeof SAVE_TYPES)[number]);
      if (ti < 0) continue;
      placed.push([Number(xs), Number(ys), Number(zs), ti]);
    }
    const p = this.player;
    const ok = writeSave({
      v: 1,
      t: Date.now(),
      player: { x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, pitch: p.pitch, health: p.health, flying: p.flying },
      timeT: this.timeT,
      heat: this.heat,
      removed: this.destruction.totalRemoved,
      slot: this.slot,
      hotbar: this.hotbar.map((s) => (s ? { ...s } : null)),
      inventory: this.inventory.map((s) => (s ? { ...s } : null)),
      placed,
      radio: this.audio.radioStation,
      jetFuel: this.jetFuel,
      bestAir: this.bestAir,
    });
    this.hasSaveFile = ok;
    if (manual) this.toast(ok ? 'World saved' : 'Save failed (storage blocked?)');
  }

  /** Restore a saved world (placed blocks, player, inventory, clock). */
  applySave(): boolean {
    const d = loadSave();
    if (!d) return false;
    try {
      // Placed blocks — one shared rounded-voxel geometry.
      for (const [ix, iy, iz, ti] of d.placed) {
        const type = SAVE_TYPES[ti];
        if (!type) continue;
        const key = `${ix},${iy},${iz}`;
        if (this.placed.has(key)) continue;
        const center = new THREE.Vector3(ix + 0.5, iy + 0.5, iz + 0.5);
        const mesh = new THREE.Mesh(this.placedGeo(), makeBlockMaterial(type));
        mesh.position.copy(center);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.placed.set(key, {
          mesh,
          aabb: new THREE.Box3().setFromCenterAndSize(center.clone(), new THREE.Vector3(1, 1, 1)),
          type,
        });
        this.placedOrder.push(key);
      }
      // Player
      const p = this.player;
      p.pos.set(d.player.x, d.player.y, d.player.z);
      p.vel.set(0, 0, 0);
      p.yaw = d.player.yaw;
      p.pitch = d.player.pitch;
      p.flying = d.player.flying;
      if (d.player.health < p.health) p.damage(p.health - d.player.health);
      else if (d.player.health > p.health) p.heal(d.player.health - p.health);
      // Stats + clock + inventory
      this.timeT = d.timeT;
      this.updateDayNight();
      this.heat = d.heat;
      this.destruction.totalRemoved = d.removed;
      this.hotbar = d.hotbar.map((s) => (s ? { ...s } : null));
      this.inventory = d.inventory.map((s) => (s ? { ...s } : null));
      this.slot = ((d.slot % 9) + 9) % 9;
      this.setSlot(this.slot);
      if (typeof d.radio === 'number' && d.radio >= 0 && d.radio < HyperionAudio.STATIONS.length) {
        this.audio.radioStation = d.radio;
      }
      if (typeof d.jetFuel === 'number' && d.jetFuel >= 0 && d.jetFuel <= 1) {
        this.jetFuel = d.jetFuel;
      }
      if (typeof d.bestAir === 'number' && d.bestAir >= 0) {
        this.bestAir = d.bestAir;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Fresh game: wipe any previous save. */
  resetNewGame(): void {
    clearSave();
    this.hasSaveFile = false;
  }

  // ------------------------------------------------------------------ contracts
  /** Pick a tall standing building within ~260 m of the player for location contracts. */
  private pickContractBuilding(): { id: number; x: number; z: number } | null {
    const p = this.playerPos();
    const candidates: Array<{ id: number; d: number; x: number; z: number }> = [];
    for (let i = 0; i < this.city.buildings.length; i++) {
      const b = this.city.buildings[i];
      if (b.collapsed || b.collapsing || b.h < 20) continue;
      const d = Math.hypot(b.cx - p.x, b.cz - p.z);
      if (d > 260) continue;
      candidates.push({ id: i, d, x: b.cx, z: b.cz });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.d - b.d);
    return candidates[Math.floor(this.rng() * Math.min(6, candidates.length))];
  }

  /** Marker for a contract (active or offered), or null when it has none. */
  private missionMarker(buildingId?: number): { x: number; z: number } | null {
    if (buildingId === undefined) return null;
    const b = this.city.buildings[buildingId];
    if (!b || b.collapsed) return null;
    return { x: b.cx, z: b.cz };
  }

  /** Pulsing amber beacon pillar over the contract target building. */
  private updateBeacon(dt: number): void {
    const snap = this.missions.snapshot((m, buildingId) => (m.locate === 'building' ? this.missionMarker(buildingId) : null));
    const marker = snap && !snap.offered ? snap.marker : null;
    if (marker) {
      if (!this.beacon) {
        const geo = new THREE.CylinderGeometry(3.2, 4.6, 110, 12, 1, true);
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffb020,
          transparent: true,
          opacity: 0.16,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        this.beacon = new THREE.Mesh(geo, mat);
        this.beacon.renderOrder = 6;
        this.scene.add(this.beacon);
      }
      this.beacon.visible = true;
      this.beacon.position.set(marker.x, 55, marker.z);
      const pulse = 0.1 + 0.09 * (0.5 + 0.5 * Math.sin(performance.now() * 0.004));
      (this.beacon.material as THREE.MeshBasicMaterial).opacity = pulse;
      this.beacon.rotation.y += dt * 0.5;
    } else if (this.beacon) {
      this.beacon.visible = false;
    }
  }

  private placedGeoCache: THREE.BufferGeometry | null = null;
  private placedGeo(): THREE.BufferGeometry {
    if (!this.placedGeoCache) this.placedGeoCache = new RoundedBoxGeometry(0.97, 0.97, 0.97, 2, 0.07);
    return this.placedGeoCache;
  }

  // ------------------------------------------------------------------ pay'n'spray
  /** Neon "PAY'N'SPRAY" sign texture (tiny inline canvas — one per garage). */
  private makeSpraySignTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 72;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#07090c';
    ctx.fillRect(0, 0, 512, 72);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 5;
    ctx.strokeRect(5, 5, 502, 62);
    ctx.font = 'italic 900 44px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#8ff3ff';
    ctx.fillText("PAY'N'SPRAY", 256, 39);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** GTA-style respray bays: neon arch + pad on two parking lots. Drive in to
   *  clear wanted heat + repair the car for a CHAOS fee. */
  private buildSprayGarages(): void {
    const lots = this.city.parkingLots;
    if (!lots.length) return;
    const spots = [lots[0].clone(), lots[Math.floor(lots.length / 2)].clone()];

    const padGeo = new THREE.CircleGeometry(5.4, 26);
    const ringGeo = new THREE.RingGeometry(4.7, 5.4, 26);
    const archGeo = new THREE.TorusGeometry(4.5, 0.3, 10, 28, Math.PI);
    const poleGeo = new THREE.CylinderGeometry(0.2, 0.26, 4.7, 10);
    const signGeo = new THREE.BoxGeometry(6.4, 0.9, 0.4);
    const padMat = new THREE.MeshStandardMaterial({ color: 0x191c21, roughness: 0.82, metalness: 0.15, polygonOffset: true, polygonOffsetFactor: -1 });
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.42, metalness: 0.65 });
    const signTex = this.makeSpraySignTexture();
    const signMat = new THREE.MeshBasicMaterial({ map: signTex });
    for (const g of [padGeo, ringGeo, archGeo, poleGeo, signGeo]) this.sprayAssets.push({ geo: g, mat: padMat });
    this.sprayAssets.push({ geo: padGeo, mat: ringMat }, { geo: signGeo, mat: signMat });

    for (const s of spots) {
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(s.x, 0.07, s.z);
      pad.renderOrder = 2;
      const ring = new THREE.Mesh(ringGeo, ringMat.clone());
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, 0.09, s.z);
      ring.renderOrder = 3;
      const arch = new THREE.Mesh(archGeo, steelMat);
      arch.position.set(s.x, 0.12, s.z);
      const poleL = new THREE.Mesh(poleGeo, steelMat);
      poleL.position.set(s.x - 4.5, 2.35, s.z);
      const poleR = new THREE.Mesh(poleGeo, steelMat);
      poleR.position.set(s.x + 4.5, 2.35, s.z);
      const sign = new THREE.Mesh(signGeo, signMat);
      sign.position.set(s.x, 5.0, s.z);
      const glow = new THREE.PointLight(0x2ee6f5, 2.6, 22, 1.5);
      glow.position.set(s.x, 5.2, s.z);
      this.scene.add(pad, ring, arch, poleL, poleR, sign, glow);
      this.sprayRings.push(ring);
      this.sprays.push({ pos: new THREE.Vector3(s.x, 0, s.z), cd: 0 });
    }
  }

  private updateSprays(dt: number): void {
    const pp = this.playerPos();
    let nearest: number | null = null;
    const now = performance.now();
    for (let i = 0; i < this.sprays.length; i++) {
      const sp = this.sprays[i];
      if (sp.cd > 0) sp.cd -= dt;
      const d = Math.hypot(sp.pos.x - pp.x, sp.pos.z - pp.z);
      if (nearest === null || d < nearest) nearest = d;
      // Pulsing cyan guide ring
      const ring = this.sprayRings[i];
      if (ring) {
        ring.rotation.z += dt * 0.65;
        (ring.material as THREE.MeshBasicMaterial).opacity = (sp.cd > 0 ? 0.16 : 0.42) + 0.2 * Math.sin(now * 0.003 + i * 2.1);
      }
      // Drive-in trigger: slow car on the pad, cooldown ready
      if (this.drivingCar && sp.cd <= 0 && Math.abs(this.drivingCar.speed) < 3.5 && d < 4.6) {
        this.doRespray(this.drivingCar, sp);
      }
    }
    this.nearSpray = nearest !== null && nearest < 90 ? nearest : null;
  }

  /** The Pay'n'Spray service: clears wanted heat, fully repairs, heals a bit. */
  private doRespray(car: Car, sp: { pos: THREE.Vector3; cd: number }): void {
    const maxHealth = car.type === 'tank' ? 400 : 100;
    const wanted = this.heat > 1;
    const damaged = car.health < maxHealth - 1;
    if (!wanted && !damaged) {
      sp.cd = 6; // nothing to service — don't spam
      return;
    }
    const fee = wanted ? Math.min(150, Math.floor(this.heat)) : 60;
    // GTA canon: the spray garage clears your wanted level entirely (the fee is
    // the cost of the service, not a partial bribe) — and fixes shredded tires.
    this.heat = wanted ? 0 : this.heat;
    car.health = maxHealth;
    car.tires = 1;
    car.wobbleT = 0;
    this.player.heal(4);
    this.spotT = 0;
    this.evadeT = 0;
    this.loseWarned = false;
    this.policeWarned = false;
    this.vehicles.despawnExtraPolice(0);
    sp.cd = 20;
    this.audio.spray();
    this.particles.smokePuff(new THREE.Vector3(car.group.position.x, car.group.position.y + 1.1, car.group.position.z), 8, 0.75, 2.1);
    this.toast(wanted ? `🎨 Resprayed — heat cleared (−${fee} CHAOS) · car repaired` : `🎨 Repaired at Pay'n'Spray (−${fee} CHAOS)`);
  }

  // ------------------------------------------------------------------ roadblocks

  /** Red/white hazard stripe texture for barricade boards (one shared canvas). */
  private makeHazardTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 32;
    const ctx = cv.getContext('2d')!;
    for (let i = -1; i < 9; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#e03a2a' : '#f4f0e6';
      ctx.beginPath();
      ctx.moveTo(i * 16, 0);
      ctx.lineTo(i * 16 + 16, 0);
      ctx.lineTo(i * 16 + 8, 32);
      ctx.lineTo(i * 16 - 8, 32);
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Spawn a police roadblock ahead of a fast, wanted driver: two angled
   *  cruisers, a spike strip, hazard barricades and cones. 4+ stars only. */
  private spawnRoadblock(): void {
    const car = this.drivingCar;
    if (!car) return;
    // Dispatch prediction: use the ACTUAL travel direction (velocity sign flips
    // it when reversing) and snap onto the road the car is CURRENTLY driving on
    // (centerline nearest the car, not the projected point — mid-turn the point
    // can snap to a cross street the player isn't on).
    const dirSign = car.speed >= 0 ? 1 : -1;
    const heading = new THREE.Vector3(Math.sin(car.yaw) * dirSign, 0, Math.cos(car.yaw) * dirSign);
    const p = car.group.position;
    const alongX = Math.abs(heading.x) > Math.abs(heading.z); // driving along X
    const roads = this.city.roadCoords;
    let bestRoad = roads[0];
    let bestD = Infinity;
    for (const c of roads) {
      const d = Math.abs(c - (alongX ? p.z : p.x));
      if (d < bestD) { bestD = d; bestRoad = c; }
    }
    if (bestD > 5) return; // off-road / crossing a lot — no sensible lane to block
    const ahead = this.tmpV.set(p.x + heading.x * 105, 0, p.z + heading.z * 105);
    const bx = alongX ? ahead.x : bestRoad;
    const bz = alongX ? bestRoad : ahead.z;
    const pos = new THREE.Vector3(bx, 0, bz);
    // Keep it out of intersections (both axes near a centerline = crossing).
    const cross = roads.reduce((n, c) => n + (Math.abs(c - bx) < 6.5 ? 1 : 0) + (Math.abs(c - bz) < 6.5 ? 1 : 0), 0);
    if (cross > 1) return;

    // Shared roadblock geometry/materials, built once per session.
    if (!this.rbGeo) {
      const hazardMat = new THREE.MeshStandardMaterial({ map: this.makeHazardTexture(), roughness: 0.7, side: THREE.DoubleSide });
      const steelMat = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.5 });
      const toothMat = new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.35, metalness: 0.85 });
      const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1f, roughness: 0.55 });
      this.rbGeo = {
        plane: new THREE.PlaneGeometry(2.6, 0.8),
        strip: new THREE.BoxGeometry(6.6, 0.08, 0.55),
        tooth: new THREE.ConeGeometry(0.07, 0.3, 5),
        cone: new THREE.ConeGeometry(0.28, 0.68, 9),
        leg: new THREE.BoxGeometry(0.08, 0.62, 0.08),
        endLight: new THREE.BoxGeometry(0.34, 0.12, 0.34),
        hazardMat,
        steelMat,
        toothMat,
        coneMat,
        spikeLightMat: new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2418, emissiveIntensity: 2.2, roughness: 0.4 }),
      };
      this.rbAssets.push(
        { geo: this.rbGeo.plane, mat: hazardMat },
        { geo: this.rbGeo.strip, mat: steelMat },
        { geo: this.rbGeo.tooth, mat: toothMat },
        { geo: this.rbGeo.cone, mat: coneMat },
        { geo: this.rbGeo.leg, mat: steelMat },
        { geo: this.rbGeo.endLight, mat: this.rbGeo.spikeLightMat },
      );
    }
    const G = this.rbGeo;
    const group = new THREE.Group();
    const yaw = alongX ? 0 : Math.PI / 2;

    // Spike strip across the road with silver teeth
    const strip = new THREE.Mesh(G.strip, G.steelMat);
    strip.position.y = 0.05;
    strip.rotation.y = yaw;
    group.add(strip);
    for (let i = -5; i <= 5; i++) {
      const tooth = new THREE.Mesh(G.tooth, G.toothMat);
      tooth.position.set(i * 0.58, 0.24, 0);
      group.add(tooth);
    }
    // Hazard barricade boards sealing both road edges
    for (const side of [-1, 1]) {
      const board = new THREE.Mesh(G.plane, G.hazardMat);
      board.position.set(alongX ? side * 3.35 : 0, 0.68, alongX ? 0 : side * 3.35);
      board.rotation.y = yaw + Math.PI / 2;
      group.add(board);
      for (const off of [-1, 1]) {
        const leg = new THREE.Mesh(G.leg, G.steelMat);
        leg.position.set(board.position.x + off * (alongX ? 1 : 0), 0.31, board.position.z + off * (alongX ? 0 : 1));
        group.add(leg);
      }
    }
    // Cones marking the approach
    for (let i = 0; i < 4; i++) {
      const cone = new THREE.Mesh(G.cone, G.coneMat);
      const t = (i / 3 - 0.5) * 7.4;
      cone.position.set(alongX ? t : (this.rng() - 0.5) * 4.5, 0.34, alongX ? (this.rng() - 0.5) * 4.5 : t);
      group.add(cone);
    }
    group.position.copy(pos);
    // Blinking end-cap lights: the strip reads at night from blocks away
    for (const side of [-1, 1]) {
      const light = new THREE.Mesh(G.endLight, G.spikeLightMat);
      light.position.set(side * 3.2, 0.14, 0);
      group.add(light);
    }
    this.scene.add(group);

    // Two angled cruisers sealing the center gap (parked — lightbars flashed manually)
    const cars: Car[] = [];
    for (const side of [-1, 1]) {
      const c = this.vehicles.makeParkedPolice();
      if (!c) continue;
      const cx = alongX ? pos.x + side * 1.55 : pos.x + 1.7;
      const cz = alongX ? pos.z + 1.7 : pos.z + side * 1.55;
      c.group.position.set(cx, 0, cz);
      c.yaw = yaw + Math.PI / 2 + side * 0.5;
      c.group.rotation.y = c.yaw;
      cars.push(c);
    }
    this.roadblocks.push({ group, pos, spike: pos.clone(), cars, barrier: strip, flyT: 0 });
    if (this.roadblockToastT <= 0) {
      this.roadblockToastT = 10;
      this.toast('🚧 POLICE ROADBLOCK AHEAD — dodge it or smash through!');
    }
  }

  /** Per-frame roadblock logic: flashing cruisers, spike hits, barrier smash, cleanup. */
  private updateRoadblocks(dt: number): void {
    // Dispatch: wanted 4+ and driving fast → periodically drop a blockade ahead.
    if (this.stars >= 4 && this.drivingCar && Math.abs(this.drivingCar.speed) > 9) {
      this.roadblockCd -= dt;
      if (this.roadblockCd <= 0) {
        this.roadblockCd = 13 + this.rng() * 6;
        if (this.roadblocks.length < 2) this.spawnRoadblock();
      }
    }
    if (this.roadblockToastT > 0) this.roadblockToastT -= dt;
    const pp = this.playerPos();
    for (let i = this.roadblocks.length - 1; i >= 0; i--) {
      const rb = this.roadblocks[i];
      const d = Math.hypot(rb.pos.x - pp.x, rb.pos.z - pp.z);
      // Flash the parked cruisers' lightbars (they're 'parked', no police AI)
      const phase = Math.floor(performance.now() * 0.007) % 2;
      for (const c of rb.cars) {
        if (c.lightbar.length === 2 && c.state !== 'wrecked' && c.state !== 'burning') {
          (c.lightbar[0].material as THREE.MeshStandardMaterial).emissiveIntensity = phase === 0 ? 3.4 : 0.12;
          (c.lightbar[1].material as THREE.MeshStandardMaterial).emissiveIntensity = phase === 1 ? 3.4 : 0.12;
        }
      }
      // Spike-strip end lights blink in sync (night visibility)
      if (this.rbGeo) this.rbGeo.spikeLightMat.emissiveIntensity = 0.9 + 2.2 * (0.5 + 0.5 * Math.sin(performance.now() * 0.011));
      // Flying barrier animation after a smash-through
      if (rb.flyT > 0) {
        rb.flyT -= dt;
        rb.barrier.position.y += dt * 7.5;
        rb.barrier.rotation.x += dt * 9;
        rb.barrier.rotation.z += dt * 4;
      }
      // Spike strip: non-tank cars at speed shred their tires (grounded only —
      // a car launched off a stunt ramp sails clean over it)
      const car = this.drivingCar;
      if (car && car.type !== 'tank' && car.tires >= 0.5 && Math.abs(car.speed) > 6 && car.group.position.y < 0.5) {
        if (Math.hypot(car.group.position.x - rb.spike.x, car.group.position.z - rb.spike.z) < 2.1) {
          car.tires = 0;
          car.speed *= 0.72;
          this.audio.thud(0.1);
          this.shake(0.32);
          this.particles.spawnDebris(new THREE.Vector3(car.group.position.x, 0.3, car.group.position.z), 7, new THREE.Color(0x181818), 0.9);
          this.toast('🛞 TIRES SHREDDED — handling wrecked! A Pay\'n\'Spray can fit new rubber');
          this.hitMark++;
        }
      }
      // Barrier crash: smash through fast, bounce off slow (tank always smashes)
      if (rb.flyT <= 0 && car && car.group.position.y < 0.6 && Math.hypot(car.group.position.x - rb.pos.x, car.group.position.z - rb.pos.z) < 2.4) {
        const smash = Math.abs(car.speed) > (car.type === 'tank' ? 2 : 9);
        if (smash) {
          rb.flyT = 1.6;
          car.speed *= car.type === 'tank' ? 0.96 : 0.8;
          if (car.type !== 'tank') car.health -= 9;
          this.audio.thud(0.05);
          this.shake(0.3);
          this.particles.spawnDebris(new THREE.Vector3(rb.pos.x, 0.8, rb.pos.z), 6, new THREE.Color(0xe03a2a), 1.2);
          this.addScore(8);
          this.missions.onRoadblockSmash();
        } else if (Math.abs(car.speed) > 1) {
          car.speed *= -0.14;
          this.audio.thud(0.12);
        }
      }
      // Cleanup: cooled down + far, or left far behind
      if ((this.stars < 4 && d > 70) || d > 240) {
        this.clearRoadblock(i);
      }
    }
  }

  private clearRoadblock(i: number): void {
    const rb = this.roadblocks[i];
    for (const c of rb.cars) {
      // A stolen roadblock cruiser the player is driving stays in the world.
      if (c !== this.drivingCar) this.vehicles.removeCar(c);
    }
    this.scene.remove(rb.group);
    this.roadblocks.splice(i, 1);
  }

  // ------------------------------------------------------------------ hydrants

  /** Instanced fire hydrants on sidewalk corners. Carve/explosion near one and
   *  the water main bursts: geyser column, hiss, douses fires and burning cars. */
  private buildHydrants(): void {
    const bodyGeo = new THREE.CylinderGeometry(0.16, 0.2, 0.62, 9);
    const capGeo = new THREE.SphereGeometry(0.15, 9, 7, 0, Math.PI * 2, 0, Math.PI / 2);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xb32014, roughness: 0.5, metalness: 0.35 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.45, metalness: 0.6 });
    this.hydAssets.push({ geo: bodyGeo, mat: bodyMat }, { geo: capGeo, mat: capMat });
    // Candidates: sidewalk corners at alternating intersections (skips blocked corners)
    const roads = this.city.roadCoords;
    const edge = ROAD_W / 2 + 1.3; // mid-sidewalk offset from the road centerline
    const spots: THREE.Vector3[] = [];
    for (let ix = 0; ix < roads.length; ix += 2) {
      for (let iz = (ix / 2) % 2 === 0 ? 1 : 0; iz < roads.length; iz += 2) {
        const x = roads[ix] + edge;
        const z = roads[iz] + edge;
        if (Math.abs(x) > CITY_HALF - 6 || Math.abs(z) > CITY_HALF - 6) continue;
        spots.push(new THREE.Vector3(x, 0, z));
      }
    }
    const max = Math.min(spots.length, 64);
    this.hydBody = new THREE.InstancedMesh(bodyGeo, bodyMat, max);
    this.hydCap = new THREE.InstancedMesh(capGeo, capMat, max);
    this.hydBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hydCap.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hydBody.castShadow = true;
    const d = new THREE.Object3D();
    let n = 0;
    for (let i = 0; i < max; i++) {
      const s = spots[i];
      // Open-corner bias: skip hydrants wedged between buildings (they end up
      // invisible from the street). Require clear sidewalk on at least 3 sides.
      let blocked = 0;
      for (const [ox, oz] of [[3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5]] as const) {
        if (this.city.buildingAt(new THREE.Vector3(s.x + ox, 1, s.z + oz))) blocked++;
      }
      if (this.city.buildingAt(new THREE.Vector3(s.x, 1, s.z)) || blocked > 1) continue;
      d.position.set(s.x, 0.43, s.z);
      d.rotation.set(0, this.rng() * Math.PI, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      this.hydBody.setMatrixAt(n, d.matrix);
      d.position.y = 0.74;
      d.updateMatrix();
      this.hydCap.setMatrixAt(n, d.matrix);
      this.hydrants.push({ pos: s.clone(), broken: false, geyserT: 0 });
      n++;
    }
    this.hydBody.count = n;
    this.hydCap.count = n;
    this.hydBody.instanceMatrix.needsUpdate = true;
    this.hydCap.instanceMatrix.needsUpdate = true;
    this.scene.add(this.hydBody, this.hydCap);
  }

  /** Explosions / deep digs shear hydrants → burst the main. */
  private maybeBreakHydrants(pos: THREE.Vector3, radius: number): void {
    for (const h of this.hydrants) {
      if (h.broken) continue;
      if (Math.hypot(h.pos.x - pos.x, h.pos.z - pos.z) < radius && Math.abs(pos.y - 0.5) < radius + 1.2) {
        this.burstHydrant(h);
      }
    }
  }

  private burstHydrant(h: { pos: THREE.Vector3; broken: boolean; geyserT: number }): void {
    h.broken = true;
    h.geyserT = 15 + this.rng() * 7;
    const idx = this.hydrants.indexOf(h);
    if (this.hydCap && idx >= 0 && idx < this.hydCap.count) {
      const d = new THREE.Object3D();
      d.position.set(0, -100, 0);
      d.updateMatrix();
      this.hydCap.setMatrixAt(idx, d.matrix);
      this.hydCap.instanceMatrix.needsUpdate = true;
    }
    if (this.hydBody && idx >= 0 && idx < this.hydBody.count) {
      const d = new THREE.Object3D();
      d.position.set(h.pos.x, 0.36, h.pos.z);
      d.rotation.set(0.7 * (this.rng() - 0.5), this.rng() * Math.PI, 0.7 * (this.rng() - 0.5));
      d.scale.setScalar(0.9);
      d.updateMatrix();
      this.hydBody.setMatrixAt(idx, d.matrix);
      this.hydBody.instanceMatrix.needsUpdate = true;
    }
    this.particles.spawnDebris(new THREE.Vector3(h.pos.x, 0.7, h.pos.z), 5, new THREE.Color(0xb32014), 1.1);
    this.audio.thud(this.far(h.pos));
    if (this.hydToastT <= 0) {
      this.hydToastT = 8;
      this.toast('💧 Hydrant main burst — the geyser douses fires (and burning cars)');
    }
  }

  private updateHydrants(dt: number): void {
    if (this.hydToastT > 0) this.hydToastT -= dt;
    let loudest = 0;
    const pp = this.playerPos();
    for (const h of this.hydrants) {
      if (!h.broken || h.geyserT <= 0) continue;
      h.geyserT -= dt;
      // Geyser column: droplets per frame scale with remaining pressure
      const pressure = Math.min(1, h.geyserT / 6);
      this.particles.waterJet(h.pos, Math.random() < 0.7 ? 3 : 4, 0.55 + 0.65 * pressure);
      if (Math.random() < dt * 9) this.particles.smokePuff(new THREE.Vector3(h.pos.x, 0.4, h.pos.z), 1, 1.3, 0.7);
      // Wet asphalt sheen pools around the burst (fades like a scorch decal)
      if (Math.random() < dt * 0.8) this.addPuddle(h.pos, 2.4);
      // Douse fires + burning cars nearby
      for (let i = this.fires.length - 1; i >= 0; i--) {
        const f = this.fires[i];
        if (f.pos.distanceTo(h.pos) < 7) {
          this.fires.splice(i, 1);
          this.particles.smokePuff(f.pos.clone().setY(0.6), 4, 1, 1.6);
        }
      }
      for (const c of this.vehicles.cars) {
        if (c.state === 'burning' && c.group.position.distanceTo(h.pos) < 6.5) {
          this.vehicles.extinguish(c);
          this.toast('🚒 Geyser doused a burning car');
        }
      }
      const d = Math.hypot(h.pos.x - pp.x, h.pos.z - pp.z);
      loudest = Math.max(loudest, Math.max(0, 1 - d / 42) * pressure);
    }
    this.audio.setGeyser(loudest);
  }

  // ------------------------------------------------------------------ gas stations

  /** "XY Fuels" gas stations on parking lots: canopy, price sign, two fuel pumps.
   *  Pumps detonate when damaged — explosions, crashes or nearby fire light the
   *  whole block up (GTA classic). Blown pumps char and go inert. */
  private buildGasStations(): void {
    const lots = this.city.parkingLots;
    if (lots.length < 4) return;
    // Different lots than the Pay'n'Spray bays (lots[0] and lots[mid]).
    const mid = Math.floor(lots.length / 2);
    const spots = [lots[1].clone(), lots[Math.min(mid + 1, lots.length - 1)].clone()];

    const canopyGeo = new RoundedBoxGeometry(15, 0.8, 11, 2, 0.25);
    const poleGeo = new THREE.CylinderGeometry(0.24, 0.3, 5.2, 10);
    const pumpBodyGeo = new RoundedBoxGeometry(1.0, 1.7, 0.62, 2, 0.12);
    const screenGeo = new THREE.BoxGeometry(0.62, 0.44, 0.06);
    const hoseGeo = new THREE.TorusGeometry(0.28, 0.045, 7, 16, Math.PI * 1.25);
    const signPoleGeo = new THREE.CylinderGeometry(0.16, 0.2, 8.4, 8);
    const signBoxGeo = new THREE.BoxGeometry(3.4, 2.1, 0.28);
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.5, metalness: 0.3 });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xc2261a, roughness: 0.55, metalness: 0.2 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x34383e, roughness: 0.4, metalness: 0.7 });
    const pumpMat = new THREE.MeshStandardMaterial({ color: 0xd8d3c6, roughness: 0.45, metalness: 0.35 });
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x0d1a12, emissive: 0x2fd97c, emissiveIntensity: 1.1, roughness: 0.3 });
    const hoseMat = new THREE.MeshStandardMaterial({ color: 0x191b1e, roughness: 0.85 });
    this.gasSignMat = new THREE.MeshStandardMaterial({ color: 0xc2261a, emissive: 0xff3b25, emissiveIntensity: 0.55, roughness: 0.5 });
    this.gasAssets.push(
      { geo: canopyGeo, mat: canopyMat },
      { geo: poleGeo, mat: steelMat },
      { geo: pumpBodyGeo, mat: pumpMat },
      { geo: screenGeo, mat: screenMat },
      { geo: hoseGeo, mat: hoseMat },
      { geo: signPoleGeo, mat: steelMat },
      { geo: signBoxGeo, mat: this.gasSignMat },
      { geo: new THREE.BoxGeometry(15, 0.3, 11), mat: bandMat },
    );

    for (const s of spots) {
      // Keep stations clear of other POIs on the same lot
      if (this.sprays.some((sp) => Math.hypot(sp.pos.x - s.x, sp.pos.z - s.z) < 26)) continue;
      this.gasStations.push({ pos: s.clone() });
      const y = s.y;
      // Canopy on 4 poles + red trim band under the slab
      const canopy = new THREE.Mesh(canopyGeo, canopyMat);
      canopy.position.set(s.x, y + 5.6, s.z);
      canopy.castShadow = true;
      const band = new THREE.Mesh(this.gasAssets[this.gasAssets.length - 1].geo as THREE.BoxGeometry, bandMat);
      band.position.set(s.x, y + 5.14, s.z);
      for (const [px, pz] of [[-6, -4], [6, -4], [-6, 4], [6, 4]] as const) {
        const pole = new THREE.Mesh(poleGeo, steelMat);
        pole.position.set(s.x + px, y + 2.6, s.z + pz);
        this.scene.add(pole);
      }
      // Roadside price sign
      const signPole = new THREE.Mesh(signPoleGeo, steelMat);
      signPole.position.set(s.x - 8.5, y + 4.2, s.z + 6.5);
      const sign = new THREE.Mesh(signBoxGeo, this.gasSignMat);
      sign.position.set(s.x - 8.5, y + 9.2, s.z + 6.5);
      this.scene.add(canopy, band, signPole, sign);
      // Two pumps under the canopy (fuel islands) — cloned materials so
      // charring one wrecked pump doesn't blacken its twin.
      for (const off of [-2.6, 2.6]) {
        const pump = new THREE.Group();
        const pm = pumpMat.clone();
        const sm = screenMat.clone();
        const hm = hoseMat.clone();
        const body = new THREE.Mesh(pumpBodyGeo, pm);
        body.position.y = 0.85;
        body.castShadow = true;
        const screen = new THREE.Mesh(screenGeo, sm);
        screen.position.set(0, 1.28, 0.33);
        const hose = new THREE.Mesh(hoseGeo, hm);
        hose.position.set(0.52, 1.05, 0);
        hose.rotation.y = Math.PI / 2;
        pump.add(body, screen, hose);
        pump.position.set(s.x + off, y, s.z + 1.2);
        this.scene.add(pump);
        this.gasPumps.push({ pos: pump.position.clone(), mesh: pump, blown: false });
      }
    }
  }

  /** Explosions near a pump blow it sky-high (chain reaction fuel). */
  private maybeBlowPumps(pos: THREE.Vector3, radius: number): void {
    for (const p of this.gasPumps) {
      if (p.blown) continue;
      if (p.pos.distanceTo(pos) < radius + 1.2) this.blowPump(p);
    }
  }

  private blowPump(p: { pos: THREE.Vector3; mesh: THREE.Group; blown: boolean }): void {
    p.blown = true;
    // Char the pump (keep it as a blackened wreck)
    p.mesh.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.MeshStandardMaterial;
        if (m && m.color) {
          m.color.multiplyScalar(0.14);
          m.roughness = 0.95;
          m.metalness = 0.1;
          if (m.emissive) m.emissive.setHex(0x000000);
        }
      }
    });
    p.mesh.rotation.z = (Math.random() - 0.5) * 0.3;
    // Fuel-air blast: bigger than a car, ignites everything nearby (and can
    // chain-detonate the island's second pump through explode → maybeBlowPumps)
    this.explode(p.pos.clone().setY(0.9), 8.6);
    this.particles.addFireEmitter(() => p.pos.clone().setY(0.7), 9, 1.5);
    this.addScore(45);
    this.missions.onGasBlowup();
    this.toast('⛽ FUEL PUMP EXPLODED — the whole block is burning!');
  }

  private updateGasStations(): void {
    // Sign glow breathes at night; pumps detonate from flame/heat contact.
    const night = Math.max(0, Math.min(1, (this.timeT - 0.78) * 12) + Math.max(0, (0.24 - this.timeT) * 12));
    if (this.gasSignMat) this.gasSignMat.emissiveIntensity = 0.35 + night * 1.5 + 0.25 * Math.sin(performance.now() * 0.0026);
    for (const p of this.gasPumps) {
      if (p.blown) continue;
      // Burning cars parked beside a pump eventually light it.
      for (const c of this.vehicles.cars) {
        if (c.state === 'burning' && c.group.position.distanceTo(p.pos) < 4.2) {
          this.blowPump(p);
          break;
        }
      }
      if (p.blown) continue;
      // Fast crashes into pumps set them off too.
      const car = this.drivingCar;
      if (car && Math.abs(car.speed) > 10 && car.group.position.distanceTo(p.pos) < 2.6) {
        this.blowPump(p);
        this.toast('🚗 You crashed into the pumps!');
      }
    }
  }

  /** True when the player is close enough to a station to warrant the hint. */
  private nearGasHint(): boolean {
    const pp = this.playerPos();
    return this.gasStations.some((s) => Math.hypot(s.pos.x - pp.x, s.pos.z - pp.z) < 38);
  }

  // ------------------------------------------------------------------ stunt ramps

  /** Yellow/black chevron canvas for the ramp incline. */
  private makeChevronTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#e8b018';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#151513';
    for (let band = 0; band < 2; band++) {
      const y0 = band * 64;
      for (const off of [-32, 0, 32, 64, 96, 128]) {
        ctx.beginPath();
        ctx.moveTo(off - 22, y0 + 52);
        ctx.lineTo(off, y0 + 22);
        ctx.lineTo(off + 22, y0 + 52);
        ctx.lineTo(off + 22, y0 + 64);
        ctx.lineTo(off, y0 + 34);
        ctx.lineTo(off - 22, y0 + 64);
        ctx.closePath();
        ctx.fill();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /** Right-triangle prism: incline rises from z=-hl (y=0) to z=+hl (y=h); the
   *  tall end is a vertical back wall. Group 0 = incline face, group 1 = body. */
  private buildWedgeGeometry(w: number, l: number, h: number): THREE.BufferGeometry {
    const hw = w / 2;
    const hl = l / 2;
    const pos: number[] = [];
    const uv: number[] = [];
    const tri = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
      uvs: Array<[number, number]>,
    ) => {
      for (const [v, uvp] of [[a, uvs[0]], [b, uvs[1]], [c, uvs[2]]] as const) {
        pos.push(v[0], v[1], v[2]);
        uv.push(uvp[0], uvp[1]);
      }
    };
    // incline (facing up toward -z): A(-hw,0,-hl) B(hw,0,-hl) C(hw,h,hl) D(-hw,h,hl)
    tri([-hw, 0, -hl], [hw, h, hl], [hw, 0, -hl], [[0, 0], [1, 1], [1, 0]]);
    tri([-hw, 0, -hl], [-hw, h, hl], [hw, h, hl], [[0, 0], [0, 1], [1, 1]]);
    // back wall (facing +z)
    tri([hw, 0, hl], [-hw, h, hl], [-hw, 0, hl], [[1, 0], [0, 1], [0, 0]]);
    tri([hw, 0, hl], [hw, h, hl], [-hw, h, hl], [[1, 0], [1, 1], [0, 1]]);
    // right side (facing +x)
    tri([hw, 0, -hl], [hw, h, hl], [hw, 0, hl], [[0, 0], [1, 1], [1, 0]]);
    // left side (facing -x)
    tri([-hw, 0, -hl], [-hw, 0, hl], [-hw, h, hl], [[0, 0], [1, 0], [1, 1]]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    geo.addGroup(0, 6, 0); // incline → chevron material
    geo.addGroup(6, 12, 1); // walls/sides → steel
    return geo;
  }

  /** Four mid-block launch ramps across the city (kept clear of POI lots). */
  private buildStuntRamps(): void {
    const R = this.city.roadCoords;
    const slots = [
      { road: R[3], mid: R[4] + BLOCK / 2, alongX: true, dir: 1 },
      { road: R[9], mid: R[8] + BLOCK / 2, alongX: true, dir: -1 },
      { road: R[5], mid: R[8] + BLOCK / 2, alongX: false, dir: 1 },
      { road: R[8], mid: R[2] + BLOCK / 2, alongX: false, dir: -1 },
    ];
    const W = 6.6;
    const L = 6.0;
    const H = 2.4;
    if (!this.rampGeo) {
      const inclineMat = new THREE.MeshStandardMaterial({ map: this.makeChevronTexture(), roughness: 0.55, metalness: 0.15 });
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.5, metalness: 0.6 });
      const edgeMat = new THREE.MeshStandardMaterial({ color: 0x3a2c08, emissive: 0xffb020, emissiveIntensity: 1.7, roughness: 0.4 });
      this.rampGeo = {
        wedge: this.buildWedgeGeometry(W, L, H),
        edge: new THREE.BoxGeometry(0.14, 0.07, Math.hypot(L, H)),
        inclineMat,
        bodyMat,
        edgeMat,
      };
      this.rampAssets.push(
        { geo: this.rampGeo.wedge, mat: inclineMat },
        { geo: this.rampGeo.wedge, mat: bodyMat },
        { geo: this.rampGeo.edge, mat: edgeMat },
      );
    }
    const G = this.rampGeo;
    for (const s of slots) {
      let along = s.mid;
      // Nudge off lots occupied by POIs (gas station canopies / spray garages)
      const clash = (x: number, z: number) =>
        this.gasStations.some((g) => Math.hypot(g.pos.x - x, g.pos.z - z) < 26) ||
        this.sprays.some((sp) => Math.hypot(sp.pos.x - x, sp.pos.z - z) < 26);
      let x = s.alongX ? along : s.road;
      let z = s.alongX ? s.road : along;
      if (clash(x, z)) {
        along += 24;
        x = s.alongX ? along : s.road;
        z = s.alongX ? s.road : along;
        if (clash(x, z)) continue;
      }
      if (Math.abs(x) > CITY_HALF - 18 || Math.abs(z) > CITY_HALF - 18) continue;
      const yaw = s.alongX ? (s.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : s.dir > 0 ? 0 : Math.PI;
      const group = new THREE.Group();
      const wedge = new THREE.Mesh(G.wedge, [G.inclineMat, G.bodyMat]);
      wedge.castShadow = true;
      wedge.receiveShadow = true;
      group.add(wedge);
      // Glowing edge strips along both incline sides (night visibility)
      const inclineAng = -Math.atan2(H, L);
      for (const side of [-1, 1]) {
        const edge = new THREE.Mesh(G.edge, G.edgeMat);
        edge.position.set(side * (W / 2 - 0.1), H / 2 + 0.05, 0);
        edge.rotation.x = inclineAng;
        group.add(edge);
      }
      group.position.set(x, 0, z);
      group.rotation.y = yaw;
      this.scene.add(group);
      this.stuntRamps.push({ group, pos: new THREE.Vector3(x, 0, z), yaw, coolT: 0 });
    }
  }

  /** Per-frame ramp logic: launch cars that hit the incline at speed, hard-stop
   *  back-wall hits. Traffic cop cars get launched too (pure spectacle). */
  private updateStunts(dt: number): void {
    for (const r of this.stuntRamps) {
      if (r.coolT > 0) r.coolT -= dt;
    }
    for (const car of this.vehicles.cars) {
      if (car.state === 'wrecked' || car.state === 'burning' || car.state === 'falling') continue;
      if (this.airCars.has(car)) continue;
      const p = car.group.position;
      if (p.y > 0.25) continue;
      const spd = Math.abs(car.speed);
      if (spd < 8) continue;
      const dirSign = car.speed >= 0 ? 1 : -1;
      const vx = Math.sin(car.yaw) * dirSign;
      const vz = Math.cos(car.yaw) * dirSign;
      for (const r of this.stuntRamps) {
        if (r.coolT > 0) continue;
        const dx = p.x - r.pos.x;
        const dz = p.z - r.pos.z;
        const lx = dx * Math.cos(r.yaw) - dz * Math.sin(r.yaw);
        const lz = dx * Math.sin(r.yaw) + dz * Math.cos(r.yaw);
        if (Math.abs(lx) > 3.0) continue;
        const heading = vx * Math.sin(r.yaw) + vz * Math.cos(r.yaw);
        // Back-wall crash: arriving from the tall end against the launch direction
        if (lz > 2.0 && lz < 3.8 && heading < -0.5) {
          car.speed *= -0.22;
          r.coolT = 1.2;
          this.audio.thud(this.far(p));
          this.particles.spawnDebris(new THREE.Vector3(p.x, 0.6, p.z), 4, new THREE.Color(0xe8b018), 0.9);
          if (car === this.drivingCar) {
            this.shake(0.3);
            this.hitMark++;
            this.toast('🧱 Ramp wall! Hit it FROM the incline side at speed');
          }
          break;
        }
        // Launch: crossing the incline face driving up it
        if (lz > -3.2 && lz < 2.4 && heading > 0.55) {
          r.coolT = 1.4;
          this.airCars.set(car, {
            vy: Math.min(19, spd * 0.6),
            t: 0,
            player: car === this.drivingCar,
            state: car.state,
            last: p.clone(),
          });
          car.group.rotation.x = -0.08;
          this.audio.thud(this.far(p));
          if (car === this.drivingCar) this.shake(0.14);
          break;
        }
      }
    }
  }

  /** Airborne integration: gravity, nose pitch, facade splats, landing effects
   *  + AIR TIME scoring for the player's car. */
  private updateAirCars(dt: number): void {
    // Landing pop lifetime is engine-driven (CSS animation fills can stall in
    // throttled/render-blocked tabs — the unmount is the reliable fade-out).
    if (this.airPopT > 0) {
      this.airPopT -= dt;
      if (this.airPopT <= 0) this.airPop = null;
    }
    for (const [car, st] of this.airCars) {
      // vehicles.update re-flags deep-pit floors as 'falling' — reclaim the car.
      if (car.state === 'falling' && car.state !== st.state) {
        car.state = st.state;
        car.fallVel = 0;
      }
      st.vy -= 22 * dt;
      const p = car.group.position;
      p.y += st.vy * dt;
      if (car === this.drivingCar) st.t += dt;
      car.group.rotation.x = THREE.MathUtils.clamp(-st.vy * 0.026, -0.42, 0.4);
      // Facade splat: airborne car flying into a building face stops dead
      if (this.city.buildingAt(p, 0.4) && p.y > 0.5) {
        p.copy(st.last);
        car.speed *= -0.18;
        st.vy = Math.min(st.vy, 0) * 0.35;
        this.audio.thud(this.far(p));
        this.particles.spawnDebris(p.clone().setY(p.y + 0.6), 5, new THREE.Color(0x9a948a), 1.0);
        if (car === this.drivingCar) {
          this.shake(0.3);
          this.hitMark++;
          if (car.type !== 'tank') car.health -= 6;
        }
        continue;
      }
      st.last.copy(p);
      const floor = this.floorHeightAt(p.x, p.z, p.y);
      if (st.vy < 0 && p.y <= floor + 0.04) {
        const impact = -st.vy;
        p.y = floor;
        car.group.rotation.x = 0;
        this.airCars.delete(car);
        this.particles.spawnDebris(new THREE.Vector3(p.x, Math.max(0.25, floor + 0.25), p.z), 8, new THREE.Color(0x6b5b45), 1.4);
        this.audio.thud(this.far(p));
        if (car === this.drivingCar) {
          if (impact > 15 && car.type !== 'tank') car.health = Math.max(1, car.health - Math.round((impact - 14) * 1.5));
          this.shake(Math.min(0.5, 0.16 + impact * 0.02));
          const t = st.t;
          if (t >= 0.55) {
            const score = Math.round(t * 26);
            const record = t > this.bestAir;
            if (record) this.bestAir = t;
            this.addScore(score);
            this.missions.onStuntAir(t);
            this.airPopKey++;
            this.airPop = { sec: t, score, record, key: this.airPopKey };
            this.airPopT = 2.2;
            this.audio.pickup();
            this.toast(record ? `🏆 NEW RECORD AIR TIME — ${t.toFixed(1)}s!` : `🛫 AIR TIME ${t.toFixed(1)}s · +${score} CHAOS`);
          }
        } else if (impact > 16 && car.type !== 'tank') {
          car.health -= 10;
          if (car.health <= 0 && (car.state === 'traffic' || car.state === 'parked')) this.vehicles.ignite(car);
        }
      }
    }
  }

  // ------------------------------------------------------------------ weather
  private updateWeather(dt: number): void {
    this.weather.update(dt, this.playerPos());
    const rainI = this.weather.intensity;

    // Rain audio bed
    this.audio.setRain(this.weather.raining ? rainI : Math.min(rainI, 0.18));

    // Ground wetness: soaks in ~4s of rain, dries out over ~35s after.
    if (rainI > 0.35) this.wetT = Math.min(1, this.wetT + dt * 0.24);
    else this.wetT = Math.max(0, this.wetT - dt * 0.028);
    this.city.setWet(this.wetT);

    // Lightning sky spike (decayed here; updateDayNight adds the boost)
    if (this.lightningT > 0) this.lightningT -= dt;

    // Heavy rain douses fires & burning cars
    if (this.weather.raining) {
      for (let i = this.fires.length - 1; i >= 0; i--) {
        this.fires[i].ttl -= dt * 4.5; // extra decay
        if (Math.random() < dt * 2.2) {
          this.particles.smokePuff(this.fires[i].pos, 2, 0.7, 2.6); // steam
        }
      }
      for (const car of this.vehicles.cars) {
        if (car.state === 'burning' && Math.random() < dt * 1.4) {
          this.vehicles.extinguish(car);
          this.toast(`Rain doused the ${car.name}`);
        }
      }
    }
  }

  // ------------------------------------------------------------------ police
  private updatePolice(dt: number): void {
    const want = this.stars >= 2 ? Math.min(4, this.stars - 1) : 0;
    const units = this.vehicles.cars.filter((c) => c.state === 'police');
    const active = units.length;
    if (active < want) {
      this.policeTimer -= dt;
      if (this.policeTimer <= 0) {
        this.vehicles.spawnPolice(this.playerPos());
        this.policeTimer = 5;
        if (!this.policeWarned) {
          this.policeWarned = true;
          this.evadeT = 0;
          this.loseWarned = false;
          this.toast('WANTED — police units responding!');
        }
      }
    } else if (active > want) {
      this.vehicles.despawnExtraPolice(want);
      this.policeTimer = 4;
    }
    if (want === 0) {
      this.policeWarned = false;
      this.evadeT = 0;
      this.loseWarned = false;
    }

    // --- Air support: one chopper at 5 stars --------------------------------
    if (this.stars >= 5) {
      if (!this.heli) {
        this.heli = new Helicopter(this.scene);
        this.heliGunT = 2.5;
        this.heliBurst = 0;
        this.audio.heliLoop();
        this.toast('🚁 AIR SUPPORT INBOUND — its searchlight sees everything; tunnels are safe!');
      }
    } else if (this.heli) {
      this.heli.dispose(this.scene);
      this.heli = null;
      this.audio.stopHeli();
    }
    let heliSees = false;
    if (this.heli) {
      const hp = this.heli.pos;
      const pp = this.playerPos();
      // Keep clear of rooftops: re-scan nearby building heights every 1.2 s.
      this.heliScanT -= dt;
      if (this.heliScanT <= 0) {
        this.heliScanT = 1.2;
        let maxH = 20;
        for (const b of this.city.buildings) {
          if (b.collapsed || b.collapsing) continue;
          if (Math.abs(b.cx - pp.x) < 110 && Math.abs(b.cz - pp.z) < 110) maxH = Math.max(maxH, b.h);
        }
        this.heliMinAlt = maxH + 9;
      }
      // The chopper watches the surface above the player (underground = blind).
      const surface = this.tmpV.set(pp.x, Math.max(pp.y, 0), pp.z);
      this.heli.update(dt, surface, this.heliMinAlt);
      this.audio.setHeliDist(hp.distanceTo(pp) / 130);
      heliSees = pp.y > -2.5 && Math.hypot(hp.x - pp.x, hp.z - pp.z) < 135;
      // SPOTTED: the searchlight itself is a gameplay tool — when the beam's hot
      // spot lands on you, ground units converge even behind cover (evade resets).
      if (heliSees) {
        const beam = this.heli.beamPoint;
        const bd = Math.hypot(beam.x - pp.x, beam.z - pp.z);
        if (bd < 5.6) {
          if (this.spotT <= 0 && this.spotToastT <= 0) {
            this.toast('🔦 SPOTTED — searchlight lock! Break the beam or tunnel down!');
            this.spotToastT = 7;
          }
          this.spotT = 3.6;
        }
      }
      // Rotor wash when hovering low over the streets
      const below = this.floorHeightAt(hp.x, hp.z, hp.y);
      if (hp.y - below < 17 && Math.random() < dt * 5) {
        this.particles.dustPuff(new THREE.Vector3(hp.x, below + 0.4, hp.z), 3, 4.5);
      }
      // Door-gun bursts — focus the Rhino when the player is tanked up
      const inTank = !!this.drivingCar && this.drivingCar.type === 'tank';
      this.heliGunT -= dt;
      if (heliSees && this.heliGunT <= 0 && !this.player.dead) {
        this.heliGunT = 2.3 + Math.random() * 0.9;
        this.heliBurst = 3;
        this.heliBurstT = 0;
      }
      if (this.heliBurst > 0) {
        this.heliBurstT -= dt;
        if (this.heliBurstT <= 0) {
          this.heliBurstT = 0.11;
          this.heliBurst--;
          const from = this.heli.muzzle.getWorldPosition(new THREE.Vector3());
          const eye = new THREE.Vector3(pp.x, pp.y + 1.2, pp.z);
          const spread = new THREE.Vector3((Math.random() - 0.5) * 2.6, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 2.6);
          const to = eye.clone().add(spread);
          this.spawnTracer(from, to);
          this.audio.gunCrack(0.12);
          if (Math.random() < (inTank ? 0.8 : 0.62)) {
            if (inTank && this.drivingCar) {
              // The chopper's door gun chews tank hull slowly instead of the crew.
              this.drivingCar.health -= 5;
              this.hitMark++;
              this.shake(0.1);
              this.particles.spawnDebris(eye, 2, new THREE.Color(0x992211), 0.5);
            } else {
              this.damagePlayer(3);
              this.particles.spawnDebris(eye, 2, new THREE.Color(0x992211), 0.5);
            }
          } else {
            this.particles.spawnDebris(to, 2, new THREE.Color(0x888888), 0.5);
            this.shake(0.05);
          }
        }
      }
    }
    // SPOTTED timers (run even without the heli so the lock decays naturally)
    if (this.spotT > 0) this.spotT -= dt;
    if (this.spotToastT > 0) this.spotToastT -= dt;

    // --- Line-of-sight / evade logic (occlusion-aware + airborne) -----------
    if (want > 0 && (active > 0 || this.heli)) {
      // Recompute occlusion-aware LOS at 4 Hz: a cop only "sees" the player when
      // nothing blocks the segment cop-eye → player-eye (building AABB test).
      this.losT -= dt;
      if (this.losT <= 0) {
        this.losT = 0.25;
        this.copsSee = this.computeCopLOS(units) || heliSees;
      }
      let seen = this.copsSee;
      // The searchlight lock counts as seen — hiding behind cover doesn't work
      // while the beam is on you.
      if (this.spotT > 0 && this.playerPos().y > -2.5) seen = true;
      // Tunnels are safe: cops can't see you from the surface once underground.
      if (this.playerPos().y < -2.5) seen = false;
      if (seen) {
        this.evadeT = 0;
        this.loseWarned = false;
      } else {
        this.evadeT += dt;
        if (this.evadeT > 5 && !this.loseWarned) {
          this.loseWarned = true;
          this.toast('You are losing them — stay out of sight!');
        }
        if (this.evadeT > 16) {
          this.heat *= 0.4; // big drop; passive decay handles the rest
          this.evadeT = 0;
          this.loseWarned = false;
          this.toast('You lost the cops!');
          this.vehicles.despawnExtraPolice(0);
        }
      }
    }

    const pp = this.playerPos();
    const near = this.vehicles.cars.some((c) => c.state === 'police' && c.group.position.distanceTo(pp) < 95);
    if (near && !this.sirenOn) {
      this.audio.sirenLoop();
      this.sirenOn = true;
    } else if (!near && this.sirenOn) {
      this.audio.stopSiren();
      this.sirenOn = false;
    }
  }

  /** True when any pursuit unit within 68 m has an unblocked line to the player
   *  (segment vs standing-building AABBs — hides behind skyscrapers actually works). */
  private computeCopLOS(units: Car[]): boolean {
    const eye = this.playerEyeY();
    const target = this.tmpV2.set(this.playerPos().x, eye + 1.1, this.playerPos().z);
    for (const c of units) {
      if (c.state !== 'police') continue;
      const origin = this.tmpV.set(c.group.position.x, c.group.position.y + 1.5, c.group.position.z);
      const dist = origin.distanceTo(target);
      if (dist >= 68 || dist < 4) return true; // point-blank always sees
      const dir = target.clone().sub(origin).normalize();
      let blocked = false;
      for (const b of this.city.buildings) {
        if (b.collapsed || b.collapsing) continue;
        // Cheap reject: player outside the AABB expanded to the segment length.
        const reach = Math.max(dist, 0) + 1;
        if (target.x > b.aabb.min.x - reach && target.x < b.aabb.max.x + reach && target.z > b.aabb.min.z - reach && target.z < b.aabb.max.z + reach) {
          if (rayBox(origin, dir, b.aabb, dist - 0.6)) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ day/night
  private updateDayNight(): void {
    const t = this.timeT;
    const ang = (t - 0.25) * Math.PI * 2; // 0.25 => sunrise
    const day = Math.max(0, Math.sin(ang));
    const night = 1 - Math.min(1, day / 0.22);
    const dusk = Math.max(0, 1 - Math.abs(day - 0.1) / 0.12);
    const p = this.playerPos();
    const sx = Math.cos(ang) * 150;
    const sy = Math.sin(ang) * 115;

    this.sun.position.set(p.x + sx, p.y + Math.max(sy, -30), p.z - 60);
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.target.updateMatrixWorld();
    this.sun.intensity = 0.08 + day * 2.7;
    this.sun.color.setHex(0xffd9ae).lerp(DUSK_SUN, Math.min(1, dusk * 1.3));
    this.hemi.intensity = 0.14 + day * 0.62;

    if (this.skyUniforms) {
      this.skyUniforms.top.value.setHex(0x54779e).lerp(NIGHT_TOP, night);
      this.skyUniforms.mid.value.setHex(0xc4a878).lerp(NIGHT_MID, night);
      this.skyUniforms.bottom.value.setHex(0xf0c58c).lerp(NIGHT_BOTTOM, night).lerp(DUSK_ORANGE, Math.min(1, dusk * 0.55));
    }
    if (this.starsMat) this.starsMat.opacity = night * 0.95;

    // Base fog from the day/night cycle.
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.color.setHex(0xe4c39a).lerp(NIGHT_FOG, night);
      fog.near = 130 - night * 45;
      fog.far = 620 - night * 190;
    }
    this.city.applyNight(night);

    // --- Weather dimming (overcast/rain gray-out + lightning spike) ---------
    const rainI = this.weather.intensity;
    if (rainI > 0.01) {
      const w = rainI * 0.78;
      this.sun.intensity *= 1 - 0.82 * rainI;
      this.hemi.intensity = Math.max(0.1, this.hemi.intensity * (1 - 0.25 * rainI) + 0.05 * rainI);
      if (this.skyUniforms) {
        this.skyUniforms.top.value.lerp(GRAY_TOP, w);
        this.skyUniforms.mid.value.lerp(GRAY_MID, w);
        this.skyUniforms.bottom.value.lerp(GRAY_BOT, w);
      }
      if (this.starsMat) this.starsMat.opacity *= 1 - rainI;
      if (fog) {
        fog.color.lerp(GRAY_FOG, w);
        fog.near = Math.min(fog.near, 150 - rainI * 62);
        fog.far = Math.min(fog.far, 620 - rainI * 240);
      }
      this.city.applyNight(Math.max(night, rainI * 0.45));
    }
    if (this.lightningT > 0) {
      const f = Math.min(1, this.lightningT / 0.24);
      this.sun.intensity += 4.5 * f;
      this.hemi.intensity += 1.4 * f;
      if (this.skyUniforms) {
        this.skyUniforms.top.value.lerp(WHITE, f * 0.85);
        this.skyUniforms.mid.value.lerp(WHITE, f * 0.85);
        this.skyUniforms.bottom.value.lerp(WHITE, f * 0.85);
      }
    }

    const mins = Math.floor(t * 24 * 60);
    this.clockStr = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  private updateCamera(dt: number): void {
    const eye = this.player.eyePosition(new THREE.Vector3());
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.player.pitch, this.player.yaw, 0, 'YXZ'));

    if (this.drivingCar) {
      if (this.drivingCar.type === 'tank') {
        // GTA-style gun-cam: orbit the hull with the aim, look at the turret.
        const car = this.drivingCar;
        const fwd = new THREE.Vector3(Math.sin(this.tankAimYaw), 0, Math.cos(this.tankAimYaw));
        const target = car.group.position
          .clone()
          .addScaledVector(fwd, -10.5)
          .add(new THREE.Vector3(0, 4.8 + this.tankAimPitch * 9, 0));
        this.camera.position.lerp(target, 1 - Math.exp(-7 * dt));
        this.camera.lookAt(car.group.position.x, car.group.position.y + 2.1, car.group.position.z);
        this.camera.fov = 70;
      } else {
        const car = this.drivingCar;
        const heading = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
        const target = car.group.position.clone().addScaledVector(heading, -8.2).add(new THREE.Vector3(0, 3.4, 0));
        this.camera.position.lerp(target, 1 - Math.exp(-5.5 * dt));
        this.camera.lookAt(car.group.position.x, car.group.position.y + 1.5, car.group.position.z);
        this.camera.fov = 72;
      }
    } else if (this.thirdPerson) {
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
      const desired = eye.clone().addScaledVector(back, 4.6);
      // Pull camera in if it would clip a building
      const ray = new THREE.Ray(eye, back);
      const b = this.city.rayBuildingCandidates(ray, 4.6);
      let maxD = 4.6;
      if (b.length) {
        this.raycaster.set(eye, back);
        this.raycaster.far = 4.6;
        const hits = this.raycaster.intersectObjects(
          b.map((bb) => bb.mesh),
          false
        );
        if (hits.length) maxD = Math.max(0.5, hits[0].distance - 0.3);
      }
      this.camera.position.copy(eye).addScaledVector(back, maxD);
      this.camera.quaternion.copy(quat);
      this.camera.fov = 75;
    } else {
      this.camera.position.copy(eye);
      this.camera.quaternion.copy(quat);
      const sprinting = this.input.isDown('ShiftLeft') && !this.player.flying;
      const targetFov = sprinting ? 82 : 75;
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 8 * dt);
    }
    if (this.shakeT > 0) {
      const s = this.shakeT * 0.14;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }
    this.camera.updateProjectionMatrix();

    // Sun follows player for tight shadows
    const p = this.playerPos();
    this.sun.position.set(p.x - 120, p.y + 95, p.z - 155);
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.target.updateMatrixWorld();
  }

  private updateHudEmit(dt: number): void {
    // fps
    this.frameAcc += dt;
    this.frameN++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = Math.round(this.frameN / this.frameAcc);
      this.frameAcc = 0;
      this.frameN = 0;
      this.fpsT = 0;
      // auto quality
      if (this.fps < 36 && this.qualityTier < 2) {
        this.qualityTier++;
        this.renderer.setPixelRatio(this.qualityTier === 1 ? 1.1 : 0.8);
        if (this.qualityTier === 2) {
          this.sun.shadow.mapSize.set(1024, 1024);
          if (this.sun.shadow.map) {
            this.sun.shadow.map.dispose();
            this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
          }
        }
      }
    }
    this.stateT += dt;
    if (this.stateT < HUD_EMIT_INTERVAL) return;
    this.stateT = 0;
    const state: HudState = {
      playing: this.playing,
      health: this.player.health,
      flying: this.player.flying,
      thirdPerson: this.thirdPerson,
      driving: this.drivingCar
        ? {
            name: this.drivingCar.name,
            speed: Math.abs(this.drivingCar.speed) * 3.6,
            health: Math.max(0, this.drivingCar.health),
            tank: this.drivingCar.type === 'tank',
            reload: this.drivingCar.type === 'tank' ? 1 - Math.max(0, this.shellCd) / 2.6 : 0,
            tires: this.drivingCar.tires >= 0.5,
          }
        : null,
      slot: this.slot,
      hotbar: this.hotbar.map((s) => (s ? { ...s } : null)),
      inventory: this.inventory.map((s) => (s ? { ...s } : null)),
      stars: this.stars,
      score: Math.floor(this.heat),
      pos: [this.playerPos().x, this.playerPos().y, this.playerPos().z],
      depth: Math.max(0, Math.floor(-this.playerPos().y)),
      removed: this.destruction.totalRemoved,
      fps: this.fps,
      hint: this.currentHint,
      dead: this.player.dead,
      hurt: this.hurtVignette,
      debug: this.debugVisible,
      removedPerSecond: 0,
      clock: this.clockStr,
      hitMark: this.hitMark,
      police: this.vehicles.cars.reduce((n, c) => (c.state === 'police' ? n + 1 : n), 0),
      mission: (() => {
        const s = this.missions.snapshot((m, buildingId) => (m.locate === 'building' ? this.missionMarker(buildingId) : null));
        if (!s) return null;
        const pp2 = this.playerPos();
        const dist = s.marker ? Math.hypot(s.marker.x - pp2.x, s.marker.z - pp2.z) : 0;
        return { ...s, marker: s.marker ? { ...s.marker, dist } : null };
      })(),
      radio: this.drivingCar ? HyperionAudio.STATIONS[this.audio.radioStation].name : null,
      hasSave: this.hasSaveFile,
      weather: { state: this.weather.state, intensity: this.weather.intensity, wet: this.wetT },
      evading: this.stars >= 2 && this.evadeT > 0 ? Math.min(1, this.evadeT / 16) : 0,
      jetFuel: this.jetFuel,
      jetThrusting: this.jetThrusting,
      heli: !!this.heli,
      spotted: this.spotT > 0 ? Math.min(1, this.spotT / 3.6) : 0,
      touch: this.settings.touch,
      spray: this.nearSpray,
      roadblock: (() => {
        const pp2 = this.playerPos();
        let best: number | null = null;
        for (const rb of this.roadblocks) {
          const d = Math.hypot(rb.pos.x - pp2.x, rb.pos.z - pp2.z);
          if (best === null || d < best) best = d;
        }
        return best !== null && best < 150 ? best : null;
      })(),
      air: (() => {
        const dc = this.drivingCar;
        const st = dc ? this.airCars.get(dc) : undefined;
        return st ? st.t : 0;
      })(),
      airBest: this.bestAir,
      airPop: this.airPop,
    };
    this.cb.onState(state);
    this.drawMinimap();
  }

  // ------------------------------------------------------------------ minimap
  private buildMinimapBase(): void {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d')!;
    const k = size / MINIMAP_SPAN;
    const w2m = (m: number) => (m + MINIMAP_SPAN / 2) * k;
    ctx.fillStyle = '#42552f';
    ctx.fillRect(0, 0, size, size);
    // blocks
    for (let bi = -GRID_HALF; bi < GRID_HALF; bi++) {
      for (let bj = -GRID_HALF; bj < GRID_HALF; bj++) {
        const t = this.city.blockType(bi, bj);
        ctx.fillStyle = t === 'park' ? '#4e7a37' : t === 'lot' ? '#3c3c40' : '#6e6e66';
        ctx.fillRect(w2m(bi * BLOCK + 4), w2m(bj * BLOCK + 4), (BLOCK - 8) * k, (BLOCK - 8) * k);
      }
    }
    // roads
    ctx.fillStyle = '#2e2e30';
    for (const c of this.city.roadCoords) {
      ctx.fillRect(w2m(c - 4), 0, 8 * k, size);
      ctx.fillRect(0, w2m(c - 4), size, 8 * k);
    }
    // buildings footprint (lighter = taller)
    for (const b of this.city.buildings) {
      const shade = Math.min(230, 120 + b.h * 2);
      ctx.fillStyle = `rgb(${shade},${shade - 6},${shade - 12})`;
      ctx.fillRect(w2m(b.aabb.min.x), w2m(b.aabb.min.z), (b.aabb.max.x - b.aabb.min.x) * k, (b.aabb.max.z - b.aabb.min.z) * k);
    }
    this.minimapBase = cv;
  }

  private drawMinimap(): void {
    const cv = this.minimap;
    if (!cv || !this.minimapBase) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const w = cv.width;
    const h = cv.height;
    const p = this.playerPos();
    const zoom = 1.5;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 10);
    ctx.clip();
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(this.drivingCar ? this.drivingCar.yaw + Math.PI : this.player.yaw);
    ctx.scale(zoom, zoom);
    ctx.drawImage(this.minimapBase, -(p.x + MINIMAP_SPAN / 2), -(p.z + MINIMAP_SPAN / 2));
    // cars
    for (const car of this.vehicles.cars) {
      const c = car.group.position;
      ctx.fillStyle = car.state === 'wrecked' ? '#555' : car.state === 'burning' ? '#ff5030' : '#e8c34a';
      ctx.fillRect((c.x - p.x) - 1.6, (c.z - p.z) - 1.6, 3.2, 3.2);
    }
    // Stunt ramps — pulsing amber chevrons
    for (const r of this.stuntRamps) {
      const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(performance.now() * 0.005));
      ctx.save();
      ctx.translate(r.pos.x - p.x, r.pos.z - p.z);
      ctx.fillStyle = `rgba(242,183,19,${pulse})`;
      ctx.beginPath();
      ctx.moveTo(0, 3.4);
      ctx.lineTo(-2.4, -2.4);
      ctx.lineTo(2.4, -2.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.restore();
    }
    // Air support: blinking red ring around the chopper
    if (this.heli) {
      const hp = this.heli.pos;
      const blink = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(performance.now() * 0.012));
      ctx.strokeStyle = `rgba(255,70,50,${blink})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(hp.x - p.x, hp.z - p.z, 4.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,120,90,${blink})`;
      ctx.beginPath();
      ctx.arc(hp.x - p.x, hp.z - p.z, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // tnt
    for (const t of this.tnts) {
      if (Math.sin(t.fuse * 14) > 0) {
        ctx.fillStyle = '#ff2020';
        ctx.fillRect((t.pos.x - p.x) - 2.4, (t.pos.z - p.z) - 2.4, 4.8, 4.8);
      }
    }
    // Roadblocks — blinking red ✕
    for (const rb of this.roadblocks) {
      const blink = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(performance.now() * 0.01));
      ctx.strokeStyle = `rgba(255,60,40,${0.45 + 0.5 * blink})`;
      ctx.lineWidth = 1.6;
      const rx = rb.pos.x - p.x;
      const rz = rb.pos.z - p.z;
      ctx.beginPath();
      ctx.moveTo(rx - 3, rz - 3);
      ctx.lineTo(rx + 3, rz + 3);
      ctx.moveTo(rx + 3, rz - 3);
      ctx.lineTo(rx - 3, rz + 3);
      ctx.stroke();
    }
    // Pay'n'Spray bays — pulsing cyan discs with a spray-can glyph
    for (const sp of this.sprays) {
      const gx = sp.pos.x - p.x;
      const gz = sp.pos.z - p.z;
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.004);
      ctx.fillStyle = `rgba(34,211,238,${0.35 + 0.4 * pulse})`;
      ctx.beginPath();
      ctx.arc(gx, gz, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(143,243,255,0.9)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.fillStyle = '#0b1214';
      ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('S', gx, gz + 2.4);
      ctx.textAlign = 'left';
    }
    // Gas stations — amber squares with a pump glyph
    for (const st of this.gasStations) {
      const gx = st.pos.x - p.x;
      const gz = st.pos.z - p.z;
      ctx.fillStyle = 'rgba(255,150,40,0.85)';
      ctx.fillRect(gx - 3, gz - 3, 6, 6);
      ctx.fillStyle = '#1a0e02';
      ctx.font = 'bold 6.5px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('⛽', gx, gz + 2.3);
      ctx.textAlign = 'left';
    }
    // Contract target marker (pulsing amber diamond, clamped to map edges)
    const snap = this.missions.snapshot((m, buildingId) => (m.locate === 'building' ? this.missionMarker(buildingId) : null));
    let markerScreen: { x: number; y: number; dist: number } | null = null;
    if (snap && snap.marker) {
      const mx = snap.marker.x - p.x;
      const mz = snap.marker.z - p.z;
      const md = Math.hypot(mx, mz);
      // Clamp to a rectangle inside the visible map area (world units).
      const clX = 58;
      const clZ = 38;
      const k = Math.max(Math.abs(mx) / clX, Math.abs(mz) / clZ, 1);
      const cx2 = mx / k;
      const cz2 = mz / k;
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.006);
      ctx.save();
      ctx.translate(cx2, cz2);
      ctx.rotate(Math.PI / 4);
      ctx.globalAlpha = 0.45 + 0.55 * pulse;
      ctx.fillStyle = '#ffb020';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      const s = 4.6;
      ctx.beginPath();
      ctx.rect(-s / 2, -s / 2, s, s);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      // Convert to screen space for the upright label (undo map rotation).
      const yaw = this.drivingCar ? this.drivingCar.yaw + Math.PI : this.player.yaw;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      markerScreen = {
        x: w / 2 + zoom * (cx2 * cos - cz2 * sin),
        y: h / 2 + zoom * (cx2 * sin + cz2 * cos),
        dist: md,
      };
    }
    ctx.restore();
    // Contract marker distance label (screen space, upright)
    if (markerScreen) {
      const lx = Math.max(22, Math.min(w - 22, markerScreen.x));
      const ly = Math.max(12, Math.min(h - 10, markerScreen.y - 9));
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      const label = `◆ ${Math.round(markerScreen.dist)}m`;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2.4;
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = '#ffcf6a';
      ctx.fillText(label, lx, ly);
      ctx.restore();
    }
    // Player arrow
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Day/night clock chip
    const nightNow = this.timeT < 0.23 || this.timeT > 0.79;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(w - 74, h - 22, 68, 17);
    ctx.fillStyle = nightNow ? '#bcd0ff' : '#ffe9b0';
    ctx.fillText(`${nightNow ? '☾' : '☀'} ${this.clockStr}`, w - 9, h - 9);
    ctx.textAlign = 'left';
  }

  // ------------------------------------------------------------------ controls from React
  setPlaying(v: boolean): void {
    this.playing = v;
    if (v) this.audio.unlock();
  }

  setPaused(v: boolean): void {
    this.paused = v;
    if (!v) this.audio.unlock();
  }

  setUiOpen(v: boolean): void {
    this.uiOpen = v;
  }

  respawn(): void {
    this.player.respawn(2, 8);
    this.deadNotified = false;
    this.hurtVignette = 0;
  }

  requestLock(): void {
    this.input.requestLock();
  }

  inputExitLock(): void {
    this.input.exitLock();
  }

  get lockFailed(): boolean {
    return this.input.pointerLockFailed;
  }

  // ------------------------------------------------------------------ settings
  /** Master volume 0..1 (persisted to the settings store). */
  setVolume(v: number): void {
    this.settings.volume = Math.min(1, Math.max(0, v));
    this.audio.setMasterVolume(this.settings.volume);
    writeSettings(this.settings);
  }

  get volume(): number {
    return this.settings.volume;
  }

  /** Touch controls on/off (persisted; resets all virtual state when disabled). */
  setTouch(v: boolean): void {
    this.settings.touch = v;
    writeSettings(this.settings);
    if (!v) {
      this.input.virtualMove.x = 0;
      this.input.virtualMove.z = 0;
      this.input.virtualDig = false;
      this.input.virtualUseHold = false;
      this.input.virtualSprint = false;
    }
  }

  /** Car-radio preset from the settings panel (0 = off). Applies live while driving. */
  setRadioStation(i: number): void {
    const st = Math.max(0, Math.min(HyperionAudio.STATIONS.length - 1, Math.round(i)));
    this.audio.radioStation = st;
    if (this.drivingCar) {
      if (st > 0) this.audio.startRadio(st);
      else this.audio.stopRadio();
    }
  }

  get radioStation(): number {
    return this.audio.radioStation;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.detachInput();
    document.removeEventListener('pointerlockchange', this.onLockChange);
    window.removeEventListener('resize', this.onResize);
    if (this.heli) {
      this.heli.dispose(this.scene);
      this.heli = null;
    }
    for (const s of this.shells) {
      this.scene.remove(s.mesh);
    }
    this.shells.length = 0;
    for (const d of this.decals) {
      this.scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      (d.mesh.material as THREE.Material).dispose();
    }
    this.decals.length = 0;
    for (const tr of this.tracers) {
      this.scene.remove(tr.line);
      tr.line.geometry.dispose();
      (tr.line.material as THREE.Material).dispose();
    }
    this.tracers.length = 0;
    this.shellGeo?.dispose();
    this.shellMat?.dispose();
    for (const a of this.sprayAssets) {
      a.geo.dispose();
      a.mat.dispose();
    }
    for (const r of this.sprayRings) (r.material as THREE.Material).dispose();
    while (this.roadblocks.length) this.clearRoadblock(0);
    for (const a of this.rbAssets) {
      a.geo.dispose();
      a.mat.dispose();
    }
    this.rbAssets.length = 0;
    this.rbGeo = null;
    if (this.hydBody) {
      this.scene.remove(this.hydBody);
      this.hydBody.dispose();
      this.hydBody = null;
    }
    if (this.hydCap) {
      this.scene.remove(this.hydCap);
      this.hydCap.dispose();
      this.hydCap = null;
    }
    for (const a of this.hydAssets) {
      a.geo.dispose();
      a.mat.dispose();
    }
    this.hydrants.length = 0;
    for (const p of this.gasPumps) {
      this.scene.remove(p.mesh);
      p.mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
      });
    }
    this.gasPumps.length = 0;
    this.gasStations.length = 0;
    for (const a of this.gasAssets) {
      a.geo.dispose();
      a.mat.dispose();
    }
    this.gasAssets.length = 0;
    this.gasSignMat = null;
    for (const r of this.stuntRamps) this.scene.remove(r.group);
    this.stuntRamps.length = 0;
    this.airCars.clear();
    for (const a of this.rampAssets) {
      a.geo.dispose();
      a.mat.dispose();
    }
    this.rampAssets.length = 0;
    this.rampGeo = null;
    this.weather.dispose();
    this.city.dispose();
    this.vehicles.dispose();
    this.npcs.dispose();
    this.particles.dispose();
    this.destruction.dispose();
    this.audio.dispose();
    this.renderer.dispose();
  }
}
