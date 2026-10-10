import * as THREE from 'three';
import { BLOCK, NPC_COUNT, ROAD_W, SIDEWALK_H, mulberry32 } from './constants';
import { World } from './types';

/** Smooth low-poly pedestrians that walk sidewalk loops, flee chaos and ragdoll. */
export interface NPC {
  group: THREE.Group;
  limbs: { lArm: THREE.Object3D; rArm: THREE.Object3D; lLeg: THREE.Object3D; rLeg: THREE.Object3D };
  state: 'walk' | 'flee' | 'down';
  blockBI: number;
  blockBJ: number;
  perim: number; // param along sidewalk ring (m)
  dir: 1 | -1;
  speed: number;
  phase: number;
  fleeT: number;
  downT: number;
  walkSpeed: number;
}

const SHIRTS = [0xb34a3a, 0x3a6b58, 0xc9b458, 0x74589a, 0x53687a, 0x8a5a3a, 0x2f4858, 0x9a3a52];
const PANTS = [0x37414f, 0x4a4038, 0x2e3440, 0x5a5248, 0x31465a];
const SKINS = [0xc68b59, 0x8d5a3a, 0xe0ac69, 0x6b4429, 0xd9a06b];

export class NPCs {
  list: NPC[] = [];
  private scene: THREE.Scene;
  private rng = mulberry32(2024);
  private geoCache: THREE.BufferGeometry[] = [];
  private matCache: THREE.Material[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  spawn(n: number, isBuiltBlock: (bi: number, bj: number) => boolean): void {
    for (let i = 0; i < n; i++) {
      let bi = 0;
      let bj = 0;
      for (let tries = 0; tries < 20; tries++) {
        bi = Math.floor(this.rng() * 12) - 6;
        bj = Math.floor(this.rng() * 12) - 6;
        if (isBuiltBlock(bi, bj)) break;
      }
      const npc = this.make(bi, bj);
      this.list.push(npc);
      this.scene.add(npc.group);
    }
  }

  private make(bi: number, bj: number): NPC {
    const skin = SKINS[Math.floor(this.rng() * SKINS.length)];
    const shirt = SHIRTS[Math.floor(this.rng() * SHIRTS.length)];
    const pants = PANTS[Math.floor(this.rng() * PANTS.length)];
    const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.85 });
    const shirtMat = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.9 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.9 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 1 });
    this.matCache.push(skinMat, shirtMat, pantsMat, hairMat);

    const torsoGeo = new THREE.CapsuleGeometry(0.17, 0.42, 4, 8);
    const headGeo = new THREE.SphereGeometry(0.135, 10, 8);
    const hairGeo = new THREE.SphereGeometry(0.14, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.2);
    const limbGeo = new THREE.CapsuleGeometry(0.055, 0.52, 3, 6);
    const legGeo = new THREE.CapsuleGeometry(0.07, 0.58, 3, 6);
    this.geoCache.push(torsoGeo, headGeo, hairGeo, limbGeo, legGeo);

    const group = new THREE.Group();
    const torso = new THREE.Mesh(torsoGeo, shirtMat);
    torso.position.y = 1.06;
    torso.castShadow = true;
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 1.52;
    head.castShadow = true;
    const hair = new THREE.Mesh(hairGeo, hairMat);
    hair.position.y = 1.55;

    const mkLimb = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, hang: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.y = -hang;
      mesh.castShadow = true;
      pivot.add(mesh);
      return pivot;
    };
    const lArm = mkLimb(limbGeo, shirtMat, -0.24, 1.28, 0.37);
    const rArm = mkLimb(limbGeo, shirtMat, 0.24, 1.28, 0.37);
    const lLeg = mkLimb(legGeo, pantsMat, -0.1, 0.72, 0.41);
    const rLeg = mkLimb(legGeo, pantsMat, 0.1, 0.72, 0.41);
    group.add(torso, head, hair, lArm, rArm, lLeg, rLeg);
    group.scale.setScalar(0.93 + this.rng() * 0.16);

    const npc: NPC = {
      group,
      limbs: { lArm, rArm, lLeg, rLeg },
      state: 'walk',
      blockBI: bi,
      blockBJ: bj,
      perim: this.rng() * 94,
      dir: this.rng() < 0.5 ? 1 : -1,
      speed: 0,
      phase: this.rng() * 6,
      fleeT: 0,
      downT: 0,
      walkSpeed: 1.1 + this.rng() * 0.9,
    };
    this.placeAt(npc, npc.perim);
    return npc;
  }

  /** Sidewalk ring walk: maps perim param -> world pos on the block ring. */
  private placeAt(npc: NPC, perim: number): void {
    const inner = BLOCK - ROAD_W; // 24
    const margin = 1.3;
    const x0 = npc.blockBI * BLOCK + ROAD_W / 2 + margin;
    const z0 = npc.blockBJ * BLOCK + ROAD_W / 2 + margin;
    const side = inner - margin * 2;
    const per = side * 4;
    let p = ((perim % per) + per) % per;
    let x: number;
    let z: number;
    if (p < side) {
      x = x0 + p;
      z = z0;
    } else if (p < side * 2) {
      x = x0 + side;
      z = z0 + (p - side);
    } else if (p < side * 3) {
      x = x0 + side - (p - side * 2);
      z = z0 + side;
    } else {
      x = x0;
      z = z0 + side - (p - side * 3);
    }
    npc.perim = p;
    npc.group.position.set(x, SIDEWALK_H, z);
    npc.group.userData.ringSide = p < side ? 0 : p < side * 2 ? 1 : p < side * 3 ? 2 : 3;
  }

  ragdollNear(pos: THREE.Vector3, r: number): boolean {
    let hitAny = false;
    for (const n of this.list) {
      if (n.state === 'down') continue;
      if (n.group.position.distanceTo(pos) < r) {
        this.knockDown(n);
        hitAny = true;
      }
    }
    return hitAny;
  }

  knockDown(n: NPC): void {
    n.state = 'down';
    n.downT = 0;
  }

  fleeFrom(pos: THREE.Vector3, r: number): void {
    for (const n of this.list) {
      if (n.state !== 'walk') continue;
      if (n.group.position.distanceTo(pos) < r) {
        n.state = 'flee';
        n.fleeT = 4 + this.rng() * 3;
        n.dir = this.rng() < 0.5 ? 1 : -1;
      }
    }
  }

  update(dt: number, world: World): void {
    for (const n of this.list) {
      if (n.state === 'down') {
        n.downT += dt;
        // Fall over
        n.group.rotation.x = Math.min(Math.PI / 2, n.downT * 5);
        n.group.position.y = Math.max(0.14, SIDEWALK_H - n.downT * 0.1);
        if (n.downT > 10) {
          // fade & respawn elsewhere
          n.group.rotation.x = 0;
          n.state = 'walk';
          n.blockBI = Math.floor(this.rng() * 12) - 6;
          n.blockBJ = Math.floor(this.rng() * 12) - 6;
          this.placeAt(n, this.rng() * 94);
        }
        continue;
      }

      const fleeing = n.state === 'flee';
      if (fleeing) {
        n.fleeT -= dt;
        if (n.fleeT <= 0) n.state = 'walk';
      }
      const speed = fleeing ? 4.4 : n.walkSpeed;
      n.speed = speed;
      n.perim += n.dir * speed * dt;
      const inner = BLOCK - ROAD_W;
      const per = (inner - 2.6) * 4;
      if (this.rng() < dt * 0.06) n.dir = (n.dir * -1) as 1 | -1;
      this.placeAt(n, n.perim);
      n.group.userData.per = per;
      void per;

      // Face movement direction (rough, based on ring tangent)
      const side = n.group.userData.ringSide as number;
      const tangent = side === 0 ? 1 : side === 1 ? 2 : side === 2 ? 3 : 0; // ring heading bucket
      const yawMap = [Math.PI / 2, Math.PI, -Math.PI / 2, 0];
      n.group.rotation.y = yawMap[tangent] + (n.dir === 1 ? 0 : Math.PI);

      n.phase += speed * dt * 4.2;
      const amp = fleeing ? 0.95 : 0.55;
      const s = Math.sin(n.phase) * amp;
      n.limbs.lArm.rotation.x = s;
      n.limbs.rArm.rotation.x = -s;
      n.limbs.lLeg.rotation.x = -s * 0.9;
      n.limbs.rLeg.rotation.x = s * 0.9;
      n.group.position.y = SIDEWALK_H + (fleeing ? Math.abs(Math.sin(n.phase)) * 0.04 : 0);
    }
    void world;
  }

  /** Ragdoll an NPC directly hit (melee / car). */
  hitNear(pos: THREE.Vector3, r: number): boolean {
    for (const n of this.list) {
      if (n.state === 'down') continue;
      if (n.group.position.distanceTo(pos) < r) {
        this.knockDown(n);
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    for (const n of this.list) this.scene.remove(n.group);
    this.list.length = 0;
    for (const g of this.geoCache) g.dispose();
    for (const m of this.matCache) m.dispose();
  }
}
