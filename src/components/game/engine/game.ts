import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  BEDROCK_Y,
  CAR_EXPLODE_RADIUS,
  GRID_HALF,
  BLOCK,
  HAND_COOLDOWN,
  HAND_RADIUS,
  LAYER0_Y,
  LAYER_GAP,
  MAX_STRATA,
  PICK_COOLDOWN,
  REACH,
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
import { Missions, CHAIN_GOAL } from './missions';
import { Weather } from './weather';
import { SAVE_TYPES, clearSave, hasSave, loadSave, writeSave } from './save';
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
  private input = new Input();
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
  private missions = new Missions({
    toast: (msg) => this.toast(msg),
    complete: (def) => {
      this.addScore(def.rewardScore);
      for (const r of def.rewards) this.addItem(r.id as ItemId, r.count, true);
      this.audio.pickup();
    },
    chainReward: () => {
      this.addItem('jetpack', 1, true);
      this.audio.pickup();
      this.addScore(80);
      this.toast('🔥 CHAIN BONUS — Chaos Jetpack! Select it, hold RMB to thrust');
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
    if (!this.input.leftDown || this.digTimer > 0) return;
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
    const wantThrust = armed && this.input.rightDown && this.jetFuel > 0 && !this.player.dead;
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
      this.audio.jetThrust(true);
    } else {
      if (this.jetFuel < 1) this.jetFuel = Math.min(1, this.jetFuel + dt / 9); // refill in ~9s
      if (this.jetFuel >= 0.08) {
        this.audio.jetThrust(false);
      }
    }
    if (this.jetFuel <= 0 && armed && this.input.rightDown && !this.jetDryWarned) {
      this.jetDryWarned = true;
      this.audio.jetThrust(false);
      this.toast('Jetpack fuel depleted — cooling down');
    }
    if (!this.input.rightDown || this.jetFuel > 0.12) this.jetDryWarned = false;
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
      const throttle = (this.input.isDown('KeyW') ? 1 : 0) + (this.input.isDown('KeyS') ? -1 : 0);
      const steer = (this.input.isDown('KeyA') ? 1 : 0) + (this.input.isDown('KeyD') ? -1 : 0);
      this.vehicles.drivePlayer(this.drivingCar, dt, throttle, steer, this.input.isDown('Space'), this);
      if (this.input.leftClicked) this.audio.horn(0.05);
      this.audio.setEngine(Math.min(1, Math.abs(this.drivingCar.speed) / 30));
    } else {
      this.updateJetpack(dt);
      const res = this.player.update(dt, this.input, this, true);
      if (res.landed && res.fallVel < -18) this.damagePlayer((Math.abs(res.fallVel) - 18) * 0.7);
      this.ensureStrata(this.player.pos.y);
    }

    this.vehicles.setPlayerRef(this.playerPos());
    this.vehicles.update(this.drivingCar, dt, this, this.playerPos());

    // Digging (LMB)
    this.tryDig(dt);
    if (this.input.rightClicked) this.useItem();

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
      if (this.drivingCar) this.currentHint = 'F — exit vehicle   ·   H — horn';
      else {
        const near = this.vehicles.nearest(this.player.pos, 3.8);
        this.currentHint = near && near.state !== 'burning' ? `F — enter ${near.name}` : null;
      }
    }

    this.hurtVignette = Math.max(0, this.hurtVignette - dt * 1.6);
    this.shakeT = Math.max(0, this.shakeT - dt * 2.2);
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

    // --- Line-of-sight / evade logic (occlusion-aware, fixes corner-camping) ---
    if (want > 0 && active > 0) {
      // Recompute occlusion-aware LOS at 4 Hz: a cop only "sees" the player when
      // nothing blocks the segment cop-eye → player-eye (building AABB test).
      this.losT -= dt;
      if (this.losT <= 0) {
        this.losT = 0.25;
        this.copsSee = this.computeCopLOS(units);
      }
      let seen = this.copsSee;
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
      const car = this.drivingCar;
      const heading = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
      const target = car.group.position.clone().addScaledVector(heading, -8.2).add(new THREE.Vector3(0, 3.4, 0));
      this.camera.position.lerp(target, 1 - Math.exp(-5.5 * dt));
      this.camera.lookAt(car.group.position.x, car.group.position.y + 1.5, car.group.position.z);
      this.camera.fov = 72;
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
      driving: this.drivingCar ? { name: this.drivingCar.name, speed: Math.abs(this.drivingCar.speed) * 3.6 } : null,
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
    // tnt
    for (const t of this.tnts) {
      if (Math.sin(t.fuse * 14) > 0) {
        ctx.fillStyle = '#ff2020';
        ctx.fillRect((t.pos.x - p.x) - 2.4, (t.pos.z - p.z) - 2.4, 4.8, 4.8);
      }
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

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.detachInput();
    document.removeEventListener('pointerlockchange', this.onLockChange);
    window.removeEventListener('resize', this.onResize);
    this.weather.dispose();
    this.city.dispose();
    this.vehicles.dispose();
    this.npcs.dispose();
    this.particles.dispose();
    this.destruction.dispose();
    this.renderer.dispose();
  }
}
