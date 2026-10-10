import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BLOCK, GRID_HALF, LANE_OFF, ROAD_W, mulberry32 } from './constants';
import { World } from './types';

/**
 * Smooth GTA-style vehicles: rounded hulls, glass canopies, real wheels.
 * Traffic AI follows right-hand lanes on the road grid, brakes for cars/players,
 * turns at intersections. Cars are enterable, ignitable (flint & steel) and explode.
 */
export type CarType = 'sedan' | 'sports' | 'suv' | 'taxi' | 'police';
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

  private buildMesh(type: CarType, color: number): { group: THREE.Group; wheels: THREE.Mesh[]; lightbar: THREE.Mesh[] } {
    const group = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.65 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.55, metalness: 0.3 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0e1418, roughness: 0.08, metalness: 0.9 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.95 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.85 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 1.4 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2a1a, emissiveIntensity: 1.1 });

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
    const palette = [0xc23b22, 0x22262b, 0xd8d8dc, 0x8f9aa4, 0xb7791f, 0x37545c, 0x6b2f26, 0xe0dcd2, 0x4a5d23];
    const taxiColor = 0xf7c531;
    const policeColor = 0xe8e8ec;
    const color = type === 'taxi' ? taxiColor : type === 'police' ? policeColor : palette[Math.floor(this.rng() * palette.length)];
    const { group, wheels, lightbar } = this.buildMesh(type, color);
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
      health: 100,
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
                : 'Washington Sedan',
      smokeAcc: 0,
      lightbar,
      flashT: 0,
      stuckT: 0,
      reverseT: 0,
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

  /** Police pursuit: seek the player, shove traffic aside, ram, unstick by reversing. */
  private drivePolice(car: Car, dt: number, world: World, target: THREE.Vector3): void {
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

    // Ram the player on foot
    if (dist < 2.7 && Math.abs(car.speed) > 5) {
      world.damagePlayer(7);
      world.shake(0.4);
      world.audio.thud(0.05);
      car.speed *= 0.45;
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
    const accel = car.type === 'sports' ? 11 : car.type === 'suv' ? 7.5 : 8.5;
    const maxSpeed = car.type === 'sports' ? 34 : car.type === 'suv' ? 24 : 27;
    if (throttle > 0) car.speed += accel * throttle * dt;
    else if (throttle < 0) car.speed -= (car.speed > 0 ? 26 : 10) * dt;
    car.speed = Math.max(-9, Math.min(maxSpeed, car.speed));
    const drag = handbrake ? 3.4 : 0.55;
    car.speed -= car.speed * drag * dt * Math.abs(car.speed) * 0.012;
    if (Math.abs(throttle) < 0.05) car.speed -= Math.sign(car.speed) * 4.2 * dt;

    const speedFactor = Math.min(1, Math.abs(car.speed) / 14);
    car.yaw += steer * 1.9 * speedFactor * dt * Math.sign(car.speed || 1) * (handbrake ? 1.5 : 1);
    const heading = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    const next = car.group.position.clone().addScaledVector(heading, car.speed * dt);

    // Collisions with buildings (circle vs AABB).
    const r = 1.35;
    const probe = next.clone();
    probe.y = 1;
    const before = probe.clone();
    world.resolveCircleXZ(probe, r, 0.2, 1.6);
    if (probe.distanceToSquared(before) > 1e-6) {
      // Hit something solid
      if (Math.abs(car.speed) > 9) {
        car.health -= Math.abs(car.speed) * 1.1;
        world.audio.thud(0.1);
        world.spawnDebris(probe, 4, new THREE.Color(0x888888), 0.7);
        world.shake(Math.min(0.5, Math.abs(car.speed) * 0.02));
      }
      car.speed *= -0.18;
    } else {
      car.group.position.copy(next);
    }

    // Car-vs-car
    for (const o of this.cars) {
      if (o === car) continue;
      const d = o.group.position.distanceTo(car.group.position);
      if (d < 3.4 && d > 0.01) {
        const push = car.group.position.clone().sub(o.group.position).normalize().multiplyScalar((3.4 - d) * 0.5);
        car.group.position.add(push);
        o.group.position.sub(push);
        if (Math.abs(car.speed) > 10) {
          o.health -= 24;
          car.health -= 12;
          world.audio.thud(0.2);
          if (o.state === 'traffic') o.state = 'parked';
          if (o.health <= 0 && o.state !== 'burning' && o.state !== 'wrecked') this.ignite(o);
        }
        car.speed *= 0.72;
      }
    }

    // Run over NPCs
    if (Math.abs(car.speed) > 5) {
      this.onRagdollNPCs?.(car.group.position, 1.9);
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
        this.drivePolice(car, dt, world, playerPos);
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
