import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BLOCK, GRID_HALF, LANE_OFF, ROAD_W, mulberry32 } from './constants';
import { World } from './types';

/**
 * Smooth GTA-style vehicles: rounded hulls, glass canopies, real wheels.
 * Traffic AI follows right-hand lanes on the road grid, brakes for cars/players,
 * turns at intersections. Cars are enterable, ignitable (flint & steel) and explode.
 */
export type CarType = 'sedan' | 'sports' | 'suv' | 'taxi' | 'police' | 'tank';
export type CarState = 'traffic' | 'parked' | 'player' | 'burning' | 'wrecked' | 'falling' | 'police';

export interface Car {
  id: number;
  type: CarType;
  group: THREE.Group;
  wheels: THREE.Mesh[];
  state: CarState;
  speed: number;
  targetSpeed: number;
  dir: 0 | 1 | 2 | 3; // 0:+z 1:+x 2:-z 3:-x
  road: number; // coordinate of the road centerline it drives on
  lane: number; // coordinate of the perpendicular lane position
  yaw: number;
  yawVis: number;
  health: number;
  burnT: number;
  honkT: number;
  blockedT: number;
  fallVel: number;
  color: number;
  name: string;
  smokeAcc: number;
  lightbar: THREE.Mesh[];
  flashT: number;
  stuckT: number;
  reverseT: number;
  /** Tire health 1 = fine, 0 = shredded by spike strips (tank tracks immune). */
  tires: number;
  /** Wobble phase accumulator while driving on shredded tires. */
  wobbleT: number;
  /** Tank-only: rotating turret group (child of group). */
  turret?: THREE.Group;
  /** Tank-only: barrel pitch pivot (child of turret). */
  barrel?: THREE.Group;
  /** Tank-only: muzzle anchor at the barrel tip (child of barrel). */
  muzzle?: THREE.Object3D;
}

const DIR_VEC: Array<[number, number]> = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

export class Vehicles {
  cars: Car[] = [];
  private scene: THREE.Scene;
  private nextId = 1;
  private rng = mulberry32(555);
  private bodyGeoCache = new Map<string, RoundedBoxGeometry>();
  private geometries: THREE.BufferGeometry[] = [];
  onExplosion?: (pos: THREE.Vector3, radius: number) => void;
  onRagdollNPCs?: (pos: THREE.Vector3, r: number) => void;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  private bodyGeo(w: number, h: number, d: number, r: number): RoundedBoxGeometry {
    const key = `${w}|${h}|${d}|${r}`;
    let g = this.bodyGeoCache.get(key);
    if (!g) {
      g = new RoundedBoxGeometry(w, h, d, 3, r);
      this.bodyGeoCache.set(key, g);
      this.geometries.push(g);
    }
    return g;
  }

  private buildMesh(type: CarType, color: number): { group: THREE.Group; wheels: THREE.Mesh[]; lightbar: THREE.Mesh[]; turret?: THREE.Group; barrel?: THREE.Group; muzzle?: THREE.Object3D } {
    if (type === 'tank') return this.buildTank();
    const group = new THREE.Group();
    const paint = new THREE.MeshPhysicalMaterial({
      color, roughness: 0.3, metalness: 0.72,
      clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.35,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.55, metalness: 0.3 });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x10161c, roughness: 0.06, metalness: 0.9,
      clearcoat: 0.6, clearcoatRoughness: 0.04, envMapIntensity: 1.5,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.95 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.85 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 1.4 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2a1a, emissiveIntensity: 1.25 });

    const dims =
      type === 'sports'
        ? { w: 1.92, h: 0.5, len: 4.4, cabinH: 0.42, cabinLen: 1.9, ride: 0.42, wheel: 0.33 }
        : type === 'suv'
          ? { w: 2.02, h: 0.85, len: 4.9, cabinH: 0.72, cabinLen: 2.6, ride: 0.6, wheel: 0.4 }
          : { w: 1.88, h: 0.62, len: 4.6, cabinH: 0.55, cabinLen: 2.3, ride: 0.52, wheel: 0.35 };

    const hull = new THREE.Mesh(this.bodyGeo(dims.w, dims.h, dims.len, 0.22), paint);
    hull.position.y = dims.ride;
    hull.castShadow = true;
    group.add(hull);

    const cabin = new THREE.Mesh(this.bodyGeo(dims.w * 0.88, dims.cabinH, dims.cabinLen, 0.16), glass);
    cabin.position.set(0, dims.ride + dims.h / 2 + dims.cabinH / 2 - 0.06, -0.25);
    cabin.castShadow = true;
    group.add(cabin);

    const roof = new THREE.Mesh(this.bodyGeo(dims.w * 0.8, 0.06, dims.cabinLen * 0.72, 0.02), paint);
    roof.position.set(0, dims.ride + dims.h / 2 + dims.cabinH - 0.05, -0.25);
    group.add(roof);

    // bumpers + grille
    const bumperF = new THREE.Mesh(this.bodyGeo(dims.w * 0.96, 0.18, 0.22, 0.06), dark);
    bumperF.position.set(0, dims.ride - dims.h * 0.18, dims.len / 2 - 0.02);
    const bumperR = new THREE.Mesh(this.bodyGeo(dims.w * 0.96, 0.18, 0.22, 0.06), dark);
    bumperR.position.set(0, dims.ride - dims.h * 0.18, -dims.len / 2 + 0.02);
    group.add(bumperF, bumperR);

    // lights
    for (const s of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.06), headMat);
      hl.position.set(s * dims.w * 0.3, dims.ride + dims.h * 0.18, dims.len / 2 + 0.02);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), tailMat);
      tl.position.set(s * dims.w * 0.3, dims.ride + dims.h * 0.2, -dims.len / 2 - 0.02);
      group.add(hl, tl);
    }

    if (type === 'taxi') {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.3), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffd23f, emissiveIntensity: 0.7 }));
      sign.position.set(0, dims.ride + dims.h / 2 + dims.cabinH + 0.02, -0.2);
      group.add(sign);
    }

    const lightbar: THREE.Mesh[] = [];
    if (type === 'police') {
      // Black door panels + trunk stripe over white paint
      const stripeMat = new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.4, metalness: 0.5 });
      const hood = new THREE.Mesh(this.bodyGeo(dims.w * 0.9, 0.04, 1.1, 0.02), stripeMat);
      hood.position.set(0, dims.ride + dims.h / 2 + 0.03, 1.45);
      const trunk = new THREE.Mesh(this.bodyGeo(dims.w * 0.9, 0.04, 0.9, 0.02), stripeMat);
      trunk.position.set(0, dims.ride + dims.h / 2 + 0.03, -1.7);
      group.add(hood, trunk);
      // Lightbar: red + blue flashing modules
      const red = new THREE.MeshStandardMaterial({ color: 0x5a0806, emissive: 0xff2418, emissiveIntensity: 2 });
      const blue = new THREE.MeshStandardMaterial({ color: 0x061a5a, emissive: 0x2a5aff, emissiveIntensity: 0.2 });
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.28), red);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.28), blue);
      const barY = dims.ride + dims.h / 2 + dims.cabinH + 0.04;
      r.position.set(-0.3, barY, -0.2);
      b.position.set(0.3, barY, -0.2);
      group.add(r, b);
      lightbar.push(r, b);
    }

    const wheels: THREE.Mesh[] = [];
    const tireGeo = new THREE.CylinderGeometry(dims.wheel, dims.wheel, 0.26, 14);
    tireGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(dims.wheel * 0.55, dims.wheel * 0.55, 0.27, 10);
    hubGeo.rotateZ(Math.PI / 2);
    this.geometries.push(tireGeo, hubGeo);
    for (const [sx, sz] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const wm = new THREE.Mesh(tireGeo, tireMat);
      const hub = new THREE.Mesh(hubGeo, hubMat);
      wm.add(hub);
      wm.position.set(sx * (dims.w / 2 - 0.02), dims.wheel, sz * (dims.len / 2 - 0.85));
      wm.castShadow = true;
      group.add(wm);
      wheels.push(wm);
    }
    return { group, wheels, lightbar };
  }

  /** Rhino Tank: smooth olive hull, rotating turret + barrel, treads, road wheels. */
  private buildTank(): { group: THREE.Group; wheels: THREE.Mesh[]; lightbar: THREE.Mesh[]; turret: THREE.Group; barrel: THREE.Group; muzzle: THREE.Object3D } {
    const group = new THREE.Group();
    const olive = new THREE.MeshStandardMaterial({ color: 0x4d5a33, roughness: 0.62, metalness: 0.38 });
    const oliveDark = new THREE.MeshStandardMaterial({ color: 0x39441f, roughness: 0.7, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6, metalness: 0.35 });
    const gun = new THREE.MeshStandardMaterial({ color: 0x2a2d26, roughness: 0.45, metalness: 0.7 });

    // Hull — low, wide, rounded
    const hullGeo = this.bodyGeo(2.5, 0.82, 5.5, 0.14);
    const hull = new THREE.Mesh(hullGeo, olive);
    hull.position.y = 0.72;
    hull.castShadow = true;
    group.add(hull);
    // Glacis (sloped front plate)
    const glacisGeo = this.bodyGeo(2.3, 0.5, 1.5, 0.1);
    const glacis = new THREE.Mesh(glacisGeo, oliveDark);
    glacis.position.set(0, 0.95, 2.15);
    glacis.rotation.x = -0.42;
    group.add(glacis);
    // Engine deck grating
    const deckGeo = this.bodyGeo(2.2, 0.08, 1.4, 0.03);
    const deck = new THREE.Mesh(deckGeo, dark);
    deck.position.set(0, 1.15, -1.9);
    group.add(deck);

    // Treads: two dark boxes hugging the hull sides
    const treadGeo = this.bodyGeo(0.58, 0.62, 5.3, 0.08);
    for (const sx of [-1.16, 1.16]) {
      const tread = new THREE.Mesh(treadGeo, dark);
      tread.position.set(sx, 0.42, 0);
      tread.castShadow = true;
      group.add(tread);
    }
    // Road wheels (spinning, partially visible outside the treads)
    const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.22, 8);
    hubGeo.rotateZ(Math.PI / 2);
    this.geometries.push(wheelGeo, hubGeo);
    const wheels: THREE.Mesh[] = [];
    for (const sx of [-1.47, 1.47]) {
      for (const wz of [1.75, 0.55, -0.65, -1.85]) {
        const wm = new THREE.Mesh(wheelGeo, oliveDark);
        const hub = new THREE.Mesh(hubGeo, dark);
        wm.add(hub);
        wm.position.set(sx, 0.36, wz);
        group.add(wm);
        wheels.push(wm);
      }
    }

    // Turret (rotates with aim) + barrel pivot + muzzle anchor
    const turret = new THREE.Group();
    turret.position.set(0, 1.18, -0.25);
    const turGeo = new THREE.CylinderGeometry(0.92, 1.12, 0.52, 18);
    const tur = new THREE.Mesh(turGeo, olive);
    tur.castShadow = true;
    const hatchGeo = new THREE.SphereGeometry(0.3, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const hatch = new THREE.Mesh(hatchGeo, oliveDark);
    hatch.position.set(-0.25, 0.24, -0.3);
    const mantletGeo = this.bodyGeo(0.72, 0.42, 0.5, 0.08);
    const mantlet = new THREE.Mesh(mantletGeo, oliveDark);
    mantlet.position.set(0, -0.02, 1.0);
    turret.add(tur, hatch, mantlet);
    this.geometries.push(turGeo, hatchGeo);

    const barrel = new THREE.Group();
    const barrelGeo = new THREE.CylinderGeometry(0.085, 0.105, 3.7, 12);
    barrelGeo.rotateX(Math.PI / 2);
    const barrelMesh = new THREE.Mesh(barrelGeo, gun);
    barrelMesh.position.z = 1.95;
    barrelMesh.castShadow = true;
    const brakeGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.42, 12);
    brakeGeo.rotateX(Math.PI / 2);
    const brake = new THREE.Mesh(brakeGeo, gun);
    brake.position.z = 3.55;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0, 3.85);
    barrel.add(barrelMesh, brake, muzzle);
    barrel.position.set(0, 0, 0.9);
    turret.add(barrel);
    this.geometries.push(barrelGeo, brakeGeo);
    group.add(turret);

    return { group, wheels, lightbar: [], turret, barrel, muzzle };
  }

  spawnTraffic(n: number): void {
    for (let i = 0; i < n; i++) this.spawnCar('traffic');
  }

  spawnParked(lots: THREE.Vector3[], roadsideZ: number): void {
    let placed = 0;
    for (const lot of lots) {
      const n = 3 + Math.floor(this.rng() * 3);
      for (let i = 0; i < n && placed < 10; i++) {
        const type = this.pickType();
        const car = this.makeCar(type, 'parked');
        const stall = (i - n / 2) * 5.4;
        car.group.position.set(lot.x + stall, 0, lot.z + (this.rng() - 0.5) * 8);
        car.yaw = this.rng() < 0.5 ? 0 : Math.PI;
        car.yawVis = car.yaw;
        car.group.rotation.y = car.yaw;
        placed++;
      }
    }
    // A couple of cars parallel-parked along roadsides.
    for (let i = 0; i < 4; i++) {
      const road = (Math.floor(this.rng() * (GRID_HALF * 2 + 1)) - GRID_HALF) * BLOCK;
      const car = this.makeCar(this.pickType(), 'parked');
      car.group.position.set(road + ROAD_W / 2 - 1.4, 0, roadsideZ * (i + 1) * 0.35 % 300 - 150);
      car.yaw = 0;
      car.yawVis = 0;
      car.group.rotation.y = 0;
    }
  }

  private pickType(): CarType {
    const r = this.rng();
    return r < 0.42 ? 'sedan' : r < 0.62 ? 'sports' : r < 0.82 ? 'suv' : 'taxi';
  }

  private makeCar(type: CarType, state: CarState): Car {
    // GTA-flavored paint palette: candy metallics + pearls + deep black.
    const palette = [
      0xb0192a, // crimson
      0x0c0d10, // deep black
      0xf2f0e9, // pearl white
      0x1f8a7d, // teal
      0xe0653a, // sunset orange
      0x9dc209, // lime
      0xb4296e, // magenta
      0x5b2a86, // royal purple
      0x9aa0a6, // silver
      0xd9b23a, // champagne gold
      0x3d6b35, // british racing green
      0x7a2f26, // burnt sienna
    ];
    const taxiColor = 0xf7c531;
    const policeColor = 0xe8e8ec;
    const color = type === 'taxi' ? taxiColor : type === 'police' ? policeColor : type === 'tank' ? 0x4d5a33 : palette[Math.floor(this.rng() * palette.length)];
    const { group, wheels, lightbar, turret, barrel, muzzle } = this.buildMesh(type, color);
    this.scene.add(group);
    const car: Car = {
      id: this.nextId++,
      type,
      group,
      wheels,
      state,
      speed: 0,
      targetSpeed: 9 + this.rng() * 5,
      dir: 0,
      road: 0,
      lane: 0,
      yaw: 0,
      yawVis: 0,
      health: type === 'tank' ? 400 : 100,
      burnT: 0,
      honkT: 0,
      blockedT: 0,
      fallVel: 0,
      color,
      name:
        type === 'taxi'
          ? 'Taxi'
          : type === 'police'
            ? 'Police Cruiser'
            : type === 'sports'
              ? 'Comet Sports'
              : type === 'suv'
                ? 'Cavalcade SUV'
                : type === 'tank'
                  ? 'Rhino Tank'
                  : 'Washington Sedan',
      smokeAcc: 0,
      lightbar,
      flashT: 0,
      stuckT: 0,
      reverseT: 0,
      tires: 1,
      wobbleT: 0,
      turret,
      barrel,
      muzzle,
    };
    this.cars.push(car);
    return car;
  }

  private spawnCar(_mode: 'traffic'): void {
    const car = this.makeCar(this.pickType(), 'traffic');
    // Random road + lane + direction (right-hand traffic)
    const vertical = this.rng() < 0.5;
    const road = (Math.floor(this.rng() * (GRID_HALF * 2 + 1)) - GRID_HALF) * BLOCK;
    const dirRoll = Math.floor(this.rng() * 4) as 0 | 1 | 2 | 3;
    car.dir = dirRoll;
    if (vertical) {
      car.road = road;
      car.lane = road + (dirRoll === 0 ? -LANE_OFF : LANE_OFF);
      car.group.position.set(car.lane, 0, (this.rng() - 0.5) * 360);
      car.yaw = dirRoll === 0 ? 0 : Math.PI;
    } else {
      car.road = road;
      car.lane = road + (dirRoll === 1 ? LANE_OFF : -LANE_OFF);
      car.group.position.set((this.rng() - 0.5) * 360, 0, car.lane);
      car.yaw = dirRoll === 1 ? Math.PI / 2 : -Math.PI / 2;
    }
    car.yawVis = car.yaw;
    car.group.rotation.y = car.yaw;
  }

  /** Spawn a police cruiser on a road ~90-150m from the player (pursuit AI). */
  spawnPolice(playerPos: THREE.Vector3): Car | null {
    for (let tries = 0; tries < 14; tries++) {
      const vertical = this.rng() < 0.5;
      const road = (Math.floor(this.rng() * (GRID_HALF * 2 + 1)) - GRID_HALF) * BLOCK;
      const dirSign = this.rng() < 0.5 ? 1 : -1;
      let x: number;
      let z: number;
      if (vertical) {
        x = road + (this.rng() < 0.5 ? LANE_OFF : -LANE_OFF);
        z = playerPos.z + dirSign * (90 + this.rng() * 60);
      } else {
        z = road + (this.rng() < 0.5 ? LANE_OFF : -LANE_OFF);
        x = playerPos.x + dirSign * (90 + this.rng() * 60);
      }
      if (Math.abs(x) > GRID_HALF * BLOCK - 8 || Math.abs(z) > GRID_HALF * BLOCK - 8) continue;
      const car = this.makeCar('police', 'police');
      car.group.position.set(x, 0, z);
      const toP = playerPos.clone().sub(car.group.position);
      car.yaw = Math.atan2(toP.x, toP.z);
      car.yawVis = car.yaw;
      car.group.rotation.y = car.yaw;
      car.targetSpeed = 27;
      return car;
    }
    return null;
  }

  /** Parked (non-AI) police cruiser for roadblocks — lightbars flashed by the game. */
  makeParkedPolice(): Car {
    return this.makeCar('police', 'parked');
  }

  /** Hard-despawn a car (roadblock cleanup): removes mesh + registry entry. */
  removeCar(car: Car): void {
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
    this.scene.remove(car.group);
  }

  /** Deliver the Rhino Tank on a road point near the player (chain tier-2 reward). */
  spawnTank(playerPos: THREE.Vector3): Car {
    const car = this.makeCar('tank', 'parked');
    // Prefer the nearest road centerline point; fall back beside the player.
    const roadX = Math.round(playerPos.x / BLOCK) * BLOCK;
    const roadZ = Math.round(playerPos.z / BLOCK) * BLOCK;
    const cands: THREE.Vector3[] = [
      new THREE.Vector3(roadX + 2.4, 0, playerPos.z),
      new THREE.Vector3(roadX - 2.4, 0, playerPos.z),
      new THREE.Vector3(playerPos.x, 0, roadZ + 2.4),
      new THREE.Vector3(playerPos.x, 0, roadZ - 2.4),
      new THREE.Vector3(playerPos.x + 5, 0, playerPos.z + 3),
    ];
    let best = cands[cands.length - 1];
    let bd = Infinity;
    for (const c of cands) {
      if (Math.abs(c.x) > GRID_HALF * BLOCK - 4 || Math.abs(c.z) > GRID_HALF * BLOCK - 4) continue;
      const d = c.distanceTo(playerPos);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    car.group.position.copy(best);
    const toP = playerPos.clone().sub(best);
    car.yaw = Math.atan2(toP.x, toP.z);
    car.yawVis = car.yaw;
    car.group.rotation.y = car.yaw;
    return car;
  }

  /** Remove the farthest pursuit units beyond `keep`. */
  despawnExtraPolice(keep: number): void {
    const units = this.cars.filter((c) => c.state === 'police');
    if (units.length <= keep) return;
    units.sort((a, b) => b.group.position.distanceTo(this.playerRef) - a.group.position.distanceTo(this.playerRef));
    for (let i = 0; i < units.length - keep; i++) {
      const c = units[i];
      this.scene.remove(c.group);
      const idx = this.cars.indexOf(c);
      if (idx >= 0) this.cars.splice(idx, 1);
    }
  }

  /** Police pursuit: seek the player, shove traffic aside, ram, unstick by reversing.
   *  `playerCar` lets the AI trade paint with the Rhino instead of hurting the player directly. */
  private drivePolice(car: Car, dt: number, world: World, target: THREE.Vector3, playerCar: Car | null): void {
    const p = car.group.position;
    // Flash the lightbar
    car.flashT += dt;
    const phase = Math.floor(car.flashT * 7) % 2;
    if (car.lightbar.length === 2) {
      (car.lightbar[0].material as THREE.MeshStandardMaterial).emissiveIntensity = phase === 0 ? 3.4 : 0.12;
      (car.lightbar[1].material as THREE.MeshStandardMaterial).emissiveIntensity = phase === 1 ? 3.4 : 0.12;
    }

    const toT = target.clone().sub(p);
    toT.y = 0;
    const dist = toT.length();

    if (car.reverseT > 0) {
      car.reverseT -= dt;
      car.speed = Math.max(car.speed - 18 * dt, -7);
      car.yaw -= 1.25 * dt;
      const heading = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
      p.addScaledVector(heading, car.speed * dt);
      car.group.rotation.y = car.yaw;
      this.spinWheels(car, dt, car.speed);
      return;
    }

    // Steer toward the player
    const desiredYaw = Math.atan2(toT.x, toT.z);
    let dy = desiredYaw - car.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    car.yaw += dy * Math.min(1, (3.4 + Math.abs(car.speed) * 0.05) * dt);

    const wantSpeed = dist > 14 ? 30 : Math.max(5, dist * 2.1);
    car.speed += (wantSpeed - car.speed) * Math.min(1, 1.7 * dt);

    // Move with building collision probe
    const heading = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    const next = p.clone().addScaledVector(heading, car.speed * dt);
    const probe = next.clone();
    probe.y = 1;
    const before = probe.clone();
    world.resolveCircleXZ(probe, 1.35, 0.2, 1.6);
    if (probe.distanceToSquared(before) > 1e-6) {
      p.x += (probe.x - before.x) * 0.55;
      p.z += (probe.z - before.z) * 0.55;
      car.stuckT += dt;
      if (car.stuckT > 1.1) {
        car.stuckT = 0;
        car.reverseT = 0.75;
      }
      car.speed *= 0.85;
    } else {
      car.stuckT = Math.max(0, car.stuckT - dt);
      p.copy(next);
    }

    // Shove civilian traffic aside (GTA-style PIT maneuver energy)
    for (const o of this.cars) {
      if (o === car || o.state === 'wrecked' || o.state === 'falling' || o.state === 'police') continue;
      const d = o.group.position.distanceTo(p);
      if (d < 3.2 && d > 0.01) {
        const push = o.group.position.clone().sub(p).setY(0).normalize().multiplyScalar((3.2 - d) * 0.55);
        o.group.position.add(push);
        if (o.state === 'traffic') o.state = 'parked';
        car.speed *= 0.94;
      }
    }

    // Ram the player on foot — or bounce off the Rhino's armor (GTA tank energy)
    if (dist < 2.7 && Math.abs(car.speed) > 5) {
      if (playerCar && playerCar.type === 'tank') {
        // Cops break themselves against 30 tons of steel: they take the damage,
        // the tank barely shudders.
        car.health -= 24;
        world.audio.thud(0.05);
        world.shake(0.14);
        car.reverseT = 0.85; // bounce off and regroup
        car.speed *= -0.38;
        if (car.health <= 0 && car.state !== 'burning' && car.state !== 'wrecked') this.ignite(car);
      } else {
        world.damagePlayer(7);
        world.shake(0.4);
        world.audio.thud(0.05);
        car.speed *= 0.45;
      }
    }

    car.group.rotation.y = car.yaw;
    this.spinWheels(car, dt, car.speed);
  }

  nearest(pos: THREE.Vector3, maxDist: number): Car | null {
    let best: Car | null = null;
    let bd = maxDist * maxDist;
    for (const c of this.cars) {
      if (c.state === 'wrecked' || c.state === 'falling') continue;
      const d = c.group.position.distanceToSquared(pos);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  ignite(car: Car): void {
    if (car.state === 'burning' || car.state === 'wrecked') return;
    if (car.state === 'player') return;
    car.state = 'burning';
    car.burnT = 3.4 + this.rng() * 1.8;
  }

  /** Rain dousing: a burning car caught in heavy rain goes out (still damaged). */
  extinguish(car: Car): void {
    if (car.state !== 'burning') return;
    car.state = car.type === 'police' ? 'police' : 'parked';
    car.burnT = 0;
    car.health = Math.max(14, car.health);
    car.targetSpeed = car.type === 'police' ? 27 : car.targetSpeed;
    // Steam puff (state is no longer 'burning', so game renders smoke only)
    this.onSmoke?.(car);
  }

  explode(car: Car): void {
    car.state = 'wrecked';
    car.speed = 0;
    const p = car.group.position;
    this.charCar(car);
    this.onExplosion?.(new THREE.Vector3(p.x, p.y + 0.8, p.z), 5.0);
    // Tilt the wreck
    car.group.rotation.z = (this.rng() - 0.5) * 0.25;
    car.group.rotation.x = (this.rng() - 0.5) * 0.18;
  }

  private charCar(car: Car): void {
    car.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.MeshStandardMaterial;
        if (m && m.color) {
          m.color.multiplyScalar(0.18);
          m.roughness = 0.95;
          m.metalness = 0.1;
          if (m.emissive) m.emissive.setHex(0x000000);
        }
      }
    });
  }

  enter(car: Car): void {
    car.state = 'player';
  }

  exit(car: Car, playerPos: THREE.Vector3): void {
    car.state = 'parked';
    car.speed = 0;
    const side = new THREE.Vector3(Math.cos(car.yaw), 0, -Math.sin(car.yaw));
    playerPos.copy(car.group.position).addScaledVector(side, 2.1);
    playerPos.y = 0.2;
  }

  /** Drive as player: throttle/brake/steer arcade physics. */
  drivePlayer(car: Car, dt: number, throttle: number, steer: number, handbrake: boolean, world: World): void {
    const tank = car.type === 'tank';
    const shredded = !tank && car.tires < 0.5;
    if (shredded) car.wobbleT += dt;
    const accel = tank ? 5.5 : car.type === 'sports' ? 11 : car.type === 'suv' ? 7.5 : 8.5;
    const maxSpeed = (tank ? 16 : car.type === 'sports' ? 34 : car.type === 'suv' ? 24 : 27) * (shredded ? 0.52 : 1);
    const maxRev = tank ? -5 : -9;
    if (throttle > 0) car.speed += accel * throttle * (shredded ? 0.65 : 1) * dt;
    else if (throttle < 0) car.speed -= (car.speed > 0 ? 26 : 10) * dt;
    car.speed = Math.max(maxRev, Math.min(maxSpeed, car.speed));
    const drag = handbrake ? 3.4 : tank ? 0.9 : 0.55;
    car.speed -= car.speed * drag * dt * Math.abs(car.speed) * 0.012;
    if (Math.abs(throttle) < 0.05) car.speed -= Math.sign(car.speed) * (tank ? 5.5 : 4.2) * dt;

    const speedFactor = Math.min(1, Math.abs(car.speed) / (tank ? 11 : 14));
    car.yaw += steer * (tank ? 1.05 : 1.9) * speedFactor * dt * Math.sign(car.speed || 1) * (handbrake ? 1.5 : 1);
    // Shredded tires pull hard to one side (flapping rubber on the rim)
    if (shredded && Math.abs(car.speed) > 3) {
      car.yaw += Math.sin(car.wobbleT * 8.5) * 0.62 * speedFactor * dt;
      if (Math.random() < dt * 6) world.spawnDebris(car.group.position.clone().setY(0.25), 1, new THREE.Color(0x1a1a1a), 0.5);
    }
    const heading = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    const next = car.group.position.clone().addScaledVector(heading, car.speed * dt);

    // Collisions with buildings (circle vs AABB).
    const r = tank ? 1.95 : 1.35;
    const probe = next.clone();
    probe.y = 1;
    const before = probe.clone();
    world.resolveCircleXZ(probe, r, 0.2, tank ? 1.8 : 1.6);
    if (probe.distanceToSquared(before) > 1e-6) {
      // Hit something solid
      if (Math.abs(car.speed) > 9) {
        car.health -= Math.abs(car.speed) * (tank ? 0.35 : 1.1);
        world.audio.thud(0.1);
        world.spawnDebris(probe, tank ? 2 : 4, new THREE.Color(0x888888), 0.7);
        world.shake(Math.min(0.5, Math.abs(car.speed) * (tank ? 0.012 : 0.02)));
      }
      car.speed *= tank ? -0.08 : -0.18;
    } else {
      car.group.position.copy(next);
    }

    // Car-vs-car (the Rhino crushes traffic instead of bouncing)
    for (const o of this.cars) {
      if (o === car) continue;
      const d = o.group.position.distanceTo(car.group.position);
      const hitR = tank ? 3.9 : 3.4;
      if (d < hitR && d > 0.01) {
        const push = car.group.position.clone().sub(o.group.position).normalize().multiplyScalar((hitR - d) * (tank ? 0.78 : 0.5));
        car.group.position.add(push);
        o.group.position.sub(push);
        if (tank) {
          if (Math.abs(car.speed) > 4 && o.state !== 'wrecked' && o.state !== 'falling') {
            o.health = 0;
            o.burnT = Math.min(o.burnT > 0 ? o.burnT : 99, 1.1);
            this.ignite(o);
            world.audio.thud(0.15);
            world.shake(0.22);
            car.speed *= 0.93;
          }
        } else if (Math.abs(car.speed) > 10) {
          o.health -= 24;
          car.health -= 12;
          world.audio.thud(0.2);
          if (o.state === 'traffic') o.state = 'parked';
          if (o.health <= 0 && o.state !== 'burning' && o.state !== 'wrecked') this.ignite(o);
        }
        if (!tank) car.speed *= 0.72;
      }
    }

    // Run over NPCs
    if (Math.abs(car.speed) > 5) {
      this.onRagdollNPCs?.(car.group.position, tank ? 2.4 : 1.9);
    }

    car.group.rotation.y = car.yaw;
    this.spinWheels(car, dt, car.speed);
  }

  update(car0: Car | null, dt: number, world: World, playerPos: THREE.Vector3): void {
    const burning: Car[] = [];
    for (const car of this.cars) {
      const p = car.group.position;

      // Falling into dug road holes
      if (car.state !== 'falling' && car.state !== 'wrecked' && world.floorHeightAt(p.x, p.z, p.y + 0.4) < -1.5) {
        if (car.state === 'player') continue;
        car.state = 'falling';
        car.fallVel = 0;
      }
      if (car.state === 'falling') {
        car.fallVel -= 22 * dt;
        p.y += car.fallVel * dt;
        if (p.y < -2.4) {
          this.explode(car);
        }
        continue;
      }

      if (car.state === 'burning') {
        burning.push(car);
        car.burnT -= dt;
        car.smokeAcc += dt;
        if (car.health > 25) car.health = 25;
        if (car.burnT <= 0) this.explode(car);
      }
      if (car.health < 30 && car.state !== 'wrecked' && car.state !== 'burning') {
        car.smokeAcc += dt;
      }

      if (car.state === 'traffic' && car !== car0) {
        this.driveTraffic(car, dt, world, playerPos);
      }
      if (car.state === 'police' && car !== car0) {
        this.drivePolice(car, dt, world, playerPos, car0);
      }
      if (car.state !== 'wrecked') {
        p.y = Math.max(p.y, 0);
      }
      // wheel spin for parked/burning (traffic handled in driveTraffic)
      if (car.state === 'parked' || car.state === 'burning') this.spinWheels(car, dt, 0);
    }

    // Smoke for damaged/burning cars handled by game via callback below.
    for (const car of this.cars) {
      if (car.smokeAcc > 0.09 && (car.state === 'burning' || car.health < 30) && car.state !== 'wrecked') {
        car.smokeAcc = 0;
        this.onSmoke?.(car);
      }
    }
    void burning;
  }

  onSmoke?: (car: Car) => void;

  private driveTraffic(car: Car, dt: number, world: World, playerPos: THREE.Vector3): void {
    const [dx, dz] = DIR_VEC[car.dir];
    const p = car.group.position;

    // Ahead checks: other cars + player
    let brake = false;
    const ahead = new THREE.Vector3(p.x + dx * 7, 0, p.z + dz * 7);
    for (const o of this.cars) {
      if (o === car) continue;
      const rel = o.group.position.clone().sub(p);
      const along = rel.x * dx + rel.z * dz;
      const lateral = Math.abs(rel.x * dz - rel.z * dx);
      if (along > 0 && along < 8.5 && lateral < 1.6 && o.state !== 'wrecked') {
        brake = true;
        break;
      }
    }
    const prel = playerPos.clone().sub(p);
    const pAlong = prel.x * dx + prel.z * dz;
    const pLat = Math.abs(prel.x * dz - prel.z * dx);
    if (pAlong > 0 && pAlong < 6.5 && pLat < 1.8 && !brake) brake = true;

    if (brake) {
      car.blockedT += dt;
      car.speed = Math.max(0, car.speed - 16 * dt);
      if (car.blockedT > 2.2 && car.honkT <= 0) {
        world.audio.horn(this.far(p));
        car.honkT = 3.5 + this.rng() * 3;
      }
    } else {
      car.blockedT = 0;
      car.speed += (car.targetSpeed - car.speed) * Math.min(1, 1.4 * dt);
    }
    car.honkT -= dt;

    p.x += dx * car.speed * dt;
    p.z += dz * car.speed * dt;

    // Lane keeping
    if (car.dir === 0 || car.dir === 2) p.x += (car.lane - p.x) * Math.min(1, 3 * dt);
    else p.z += (car.lane - p.z) * Math.min(1, 3 * dt);

    // Intersections: random turns
    const nearestCross = Math.round(p.x / BLOCK) * BLOCK;
    const nearestCrossZ = Math.round(p.z / BLOCK) * BLOCK;
    const onVertical = car.dir === 0 || car.dir === 2;
    const crossCoord = onVertical ? nearestCrossZ : nearestCross;
    const alongPos = onVertical ? p.z : p.x;
    const passed = Math.abs(alongPos - crossCoord) < 0.5 + car.speed * dt;
    if (passed && Math.abs(crossCoord) <= GRID_HALF * BLOCK) {
      const turnKey = `${car.id}:${Math.round(crossCoord)}`;
      if (car.honkT !== -999 && (car as unknown as { lastTurn?: string }).lastTurn !== turnKey) {
        (car as unknown as { lastTurn?: string }).lastTurn = turnKey;
        const roll = this.rng();
        if (roll < 0.45) {
          // turn
          const left = this.rng() < 0.5;
          if (onVertical) {
            car.dir = left ? 1 : 3;
            car.road = crossCoord;
            car.lane = crossCoord + (car.dir === 1 ? LANE_OFF : -LANE_OFF);
            p.z = crossCoord + dz * 0.4;
          } else {
            car.dir = left ? 2 : 0;
            car.road = crossCoord;
            car.lane = crossCoord + (car.dir === 0 ? -LANE_OFF : LANE_OFF);
            p.x = crossCoord + dx * 0.4;
          }
        }
      }
    }

    // Out of city bounds: turn around
    if (Math.abs(p.x) > GRID_HALF * BLOCK + 6 || Math.abs(p.z) > GRID_HALF * BLOCK + 6) {
      car.dir = ((car.dir + 2) % 4) as 0 | 1 | 2 | 3;
      this.relane(car);
    }

    const targetYaw = Math.atan2(dx, dz);
    let dy = targetYaw - car.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    car.yaw += dy * Math.min(1, 8 * dt);
    car.yawVis = car.yaw;
    car.group.rotation.y = car.yaw;
    this.spinWheels(car, dt, car.speed);
  }

  private relane(car: Car): void {
    const [dx, dz] = DIR_VEC[car.dir];
    if (dz !== 0) car.lane = car.road + (dz > 0 ? -LANE_OFF : LANE_OFF);
    else car.lane = car.road + (dx > 0 ? LANE_OFF : -LANE_OFF);
  }

  private spinWheels(car: Car, dt: number, speed: number): void {
    for (const w of car.wheels) {
      w.rotation.x -= (speed * dt) / 0.35;
    }
  }

  private far(p: THREE.Vector3): number {
    return Math.min(1, p.distanceTo(this.playerRef) / 90);
  }

  private playerRef = new THREE.Vector3();

  setPlayerRef(p: THREE.Vector3): void {
    this.playerRef.copy(p);
  }

  dispose(): void {
    for (const c of this.cars) this.scene.remove(c.group);
    this.cars.length = 0;
    for (const g of this.geometries) g.dispose();
  }
}
