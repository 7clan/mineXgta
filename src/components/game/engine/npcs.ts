import * as THREE from 'three';
import { BLOCK, ROAD_W, SIDEWALK_H, mulberry32 } from './constants';
import { World } from './types';

/**
 * GTA 5-style pedestrians: fully articulated low-poly humans with jointed
 * elbows/knees, canvas-painted faces, hair styles, hats and a wardrobe of
 * outfit archetypes (tee, tank, suit, hoodie, safety vest, shirtless...).
 * Walk cycle with knee flex + elbow bend + torso bob; idle phone / look
 * around behaviours; panic sprint; ragdoll sprawl.
 */

export interface NPC {
  group: THREE.Group;
  limbs: { lArm: THREE.Object3D; rArm: THREE.Object3D; lLeg: THREE.Object3D; rLeg: THREE.Object3D };
  fore: { l: THREE.Object3D; r: THREE.Object3D };
  shins: { l: THREE.Object3D; r: THREE.Object3D };
  headGrp: THREE.Group;
  torso: THREE.Mesh;
  state: 'walk' | 'flee' | 'down';
  behavior: 'walk' | 'phone' | 'stand';
  behaviorT: number;
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

// ---------------------------------------------------------------- shared pools
const SKIN_TONES = [0xe8b48c, 0xc68b59, 0x9c6644, 0x6f4a2a, 0xd9a06b, 0x8d5a3a];
const SHIRT_COLORS = [
  0xb34a3a, 0x3a6b58, 0xc9b458, 0x74589a, 0x53687a, 0x8a5a3a, 0x2f4858, 0x9a3a52,
  0xd9d3c8, 0x4a4a52, 0x6b8e4e, 0xc96a2a,
];
const PANTS_COLORS = [0x3a4a66, 0x2e3848, 0x8a7a5a, 0x24242a, 0x4a4a48, 0x5a4632, 0x3d5245];
const SHOE_COLORS = [0xe8e8e8, 0x1a1a1a, 0x5a3a22];
const HAIR_COLORS = [0x241a12, 0x3a2a1a, 0x5a3a20, 0x9a9a9a, 0xc9a45a];
const JACKET_COLORS = [0x2a2e38, 0x4a3626, 0x1e3a2a, 0x5a2a2a];

type OutfitKind = 'tee' | 'tank' | 'shirtless' | 'suit' | 'hoodie' | 'vest' | 'jacket';
const OUTFIT_POOL: OutfitKind[] = [
  'tee', 'tee', 'tee', 'tee', 'tank', 'tank', 'shirtless', 'suit', 'suit',
  'hoodie', 'hoodie', 'vest', 'jacket', 'jacket',
];

/**
 * 128x128 TRANSPARENT face-decal texture painted per skin-tone variant:
 * heavy brows, large eyes with iris+pupil, nose shading, defined mouth,
 * optional stubble. Applied to a small plane floating just in front of the
 * head sphere (-z = model forward) — deterministic, always readable, no
 * sphere-UV guesswork.
 */
function makeFaceTexture(stubble: boolean, darkHair: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  // cheek shading
  g.fillStyle = 'rgba(60,30,15,0.16)';
  g.fillRect(18, 82, 22, 16);
  g.fillRect(88, 82, 22, 16);
  // stubble / beard shadow
  if (stubble) {
    g.fillStyle = 'rgba(30,20,12,0.34)';
    for (let i = 0; i < 380; i++) {
      const x = 26 + Math.random() * 76;
      const y = 84 + Math.random() * 34;
      g.fillRect(x, y, 2.2, 2.2);
    }
  }
  // brows
  g.fillStyle = darkHair ? '#241a12' : '#4a3620';
  g.fillRect(30, 44, 24, 5.5);
  g.fillRect(74, 44, 24, 5.5);
  // eyes: white + iris + pupil + dark outline
  g.fillStyle = 'rgba(20,14,10,0.55)';
  g.fillRect(29, 53, 27, 13);
  g.fillRect(72, 53, 27, 13);
  g.fillStyle = '#f6f6f6';
  g.fillRect(31, 55, 23, 9);
  g.fillRect(74, 55, 23, 9);
  g.fillStyle = '#3a2a1a';
  g.fillRect(40, 55, 7, 9);
  g.fillRect(81, 55, 7, 9);
  g.fillStyle = '#141414';
  g.fillRect(42, 56.5, 3.4, 6);
  g.fillRect(83, 56.5, 3.4, 6);
  // nose shading
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(61, 60, 6, 16);
  g.fillStyle = 'rgba(0,0,0,0.10)';
  g.fillRect(58, 74, 12, 3);
  // mouth
  g.fillStyle = '#6e3a2c';
  g.fillRect(52, 96, 24, 5);
  g.fillStyle = 'rgba(0,0,0,0.30)';
  g.fillRect(52, 96, 24, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class NPCs {
  list: NPC[] = [];
  private scene: THREE.Scene;
  private rng = mulberry32(2024);
  private geoCache: THREE.BufferGeometry[] = [];
  private pools: {
    skin: THREE.MeshStandardMaterial[];
    faceDecal: THREE.MeshStandardMaterial[];
    shirt: THREE.MeshStandardMaterial[];
    pants: THREE.MeshStandardMaterial[];
    shoe: THREE.MeshStandardMaterial[];
    hair: THREE.MeshStandardMaterial[];
    jacket: THREE.MeshStandardMaterial[];
    white: THREE.MeshStandardMaterial;
    tie: THREE.MeshStandardMaterial;
    vest: THREE.MeshStandardMaterial;
    stripe: THREE.MeshStandardMaterial;
    phone: THREE.MeshStandardMaterial;
  };
  private G: {
    torso: THREE.BoxGeometry;
    pelvis: THREE.BoxGeometry;
    head: THREE.SphereGeometry;
    neck: THREE.CylinderGeometry;
    upperArm: THREE.CapsuleGeometry;
    foreArm: THREE.CapsuleGeometry;
    hand: THREE.SphereGeometry;
    thigh: THREE.CapsuleGeometry;
    shin: THREE.CapsuleGeometry;
    shoe: THREE.BoxGeometry;
    hairBuzz: THREE.SphereGeometry;
    hairAfro: THREE.SphereGeometry;
    hairBack: THREE.BoxGeometry;
    cap: THREE.SphereGeometry;
    brim: THREE.BoxGeometry;
    hood: THREE.SphereGeometry;
    chestV: THREE.BoxGeometry;
    tie: THREE.BoxGeometry;
    stripe: THREE.BoxGeometry;
    phone: THREE.BoxGeometry;
    faceDecal: THREE.PlaneGeometry;
  };

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const std = (color: number, roughness = 0.82): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color, roughness });
    this.pools = {
      skin: SKIN_TONES.map((c) => std(c, 0.72)),
      faceDecal: [0, 1, 2, 3, 4, 5].map(
        (i) =>
          new THREE.MeshStandardMaterial({
            map: makeFaceTexture(i % 3 === 1, i % 2 === 0),
            transparent: true,
            roughness: 0.72,
            depthWrite: false,
          }),
      ),
      shirt: SHIRT_COLORS.map((c) => std(c, 0.88)),
      pants: PANTS_COLORS.map((c) => std(c, 0.9)),
      shoe: SHOE_COLORS.map((c) => std(c, 0.6)),
      hair: HAIR_COLORS.map((c) => std(c, 0.95)),
      jacket: JACKET_COLORS.map((c) => std(c, 0.85)),
      white: std(0xe8e6e0, 0.85),
      tie: std(0x7a2020, 0.7),
      vest: std(0xe8701a, 0.85),
      stripe: std(0xd8d8d8, 0.4),
      phone: std(0x14141a, 0.4),
    };
    this.G = {
      torso: new THREE.BoxGeometry(0.34, 0.44, 0.21),
      pelvis: new THREE.BoxGeometry(0.31, 0.16, 0.2),
      head: new THREE.SphereGeometry(0.115, 12, 10),
      neck: new THREE.CylinderGeometry(0.05, 0.055, 0.08, 8),
      upperArm: new THREE.CapsuleGeometry(0.052, 0.22, 3, 6),
      foreArm: new THREE.CapsuleGeometry(0.046, 0.2, 3, 6),
      hand: new THREE.SphereGeometry(0.05, 6, 5),
      thigh: new THREE.CapsuleGeometry(0.075, 0.3, 3, 6),
      shin: new THREE.CapsuleGeometry(0.06, 0.3, 3, 6),
      shoe: new THREE.BoxGeometry(0.11, 0.075, 0.24),
      hairBuzz: new THREE.SphereGeometry(0.121, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.3),
      hairAfro: new THREE.SphereGeometry(0.152, 10, 8),
      hairBack: new THREE.BoxGeometry(0.2, 0.24, 0.06),
      cap: new THREE.SphereGeometry(0.123, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.1),
      brim: new THREE.BoxGeometry(0.16, 0.02, 0.11),
      hood: new THREE.SphereGeometry(0.13, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      chestV: new THREE.BoxGeometry(0.12, 0.16, 0.02),
      tie: new THREE.BoxGeometry(0.05, 0.2, 0.015),
      stripe: new THREE.BoxGeometry(0.345, 0.07, 0.215),
      phone: new THREE.BoxGeometry(0.05, 0.09, 0.012),
      faceDecal: new THREE.PlaneGeometry(0.155, 0.19),
    };
    for (const g of Object.values(this.G)) this.geoCache.push(g);
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

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)];
  }

  private make(bi: number, bj: number): NPC {
    const G = this.G;
    const skinIdx = Math.floor(this.rng() * this.pools.skin.length);
    const plainSkin = this.pools.skin[skinIdx];
    const decalMat = this.pools.faceDecal[skinIdx];
    const pantsMat = this.pick(this.pools.pants);
    const shoeMat = this.pick(this.pools.shoe);
    const hairMat = this.pick(this.pools.hair);
    const shirtMat = this.pick(this.pools.shirt);

    // ---- outfit archetype
    const kind = this.pick(OUTFIT_POOL);
    let torsoMat = shirtMat;
    let upperMat = shirtMat; // sleeve material
    let foreMat = plainSkin; // forearm skin unless long sleeve
    let sleeve: 'long' | 'short' | 'none' = 'short';
    const addHood = kind === 'hoodie';
    const addSuit = kind === 'suit';
    const addVest = kind === 'vest';
    if (kind === 'tank' || kind === 'shirtless') sleeve = 'none';
    if (kind === 'tank') upperMat = plainSkin;
    if (kind === 'shirtless') {
      torsoMat = plainSkin;
      upperMat = plainSkin;
    }
    if (kind === 'suit' || kind === 'jacket') {
      torsoMat = this.pick(this.pools.jacket);
      upperMat = torsoMat;
      foreMat = torsoMat;
      sleeve = 'long';
    }
    if (kind === 'hoodie') {
      upperMat = shirtMat;
      foreMat = shirtMat;
      sleeve = 'long';
    }
    if (kind === 'vest') {
      torsoMat = this.pools.vest;
      upperMat = this.pick(this.pools.pants); // dark undershirt sleeve
      foreMat = upperMat;
      sleeve = 'long';
    }

    const group = new THREE.Group();

    // ---- core body
    const torso = new THREE.Mesh(G.torso, torsoMat);
    torso.position.y = 1.2;
    torso.castShadow = true;
    const pelvis = new THREE.Mesh(G.pelvis, pantsMat);
    pelvis.position.y = 0.9;
    const neck = new THREE.Mesh(G.neck, plainSkin);
    neck.position.y = 1.46;

    // ---- head: plain skin sphere + face decal plane on the forward side (-z)
    const headGrp = new THREE.Group();
    headGrp.position.y = 1.575;
    const head = new THREE.Mesh(G.head, plainSkin);
    head.castShadow = true;
    headGrp.add(head);
    const face = new THREE.Mesh(G.faceDecal, decalMat);
    face.position.set(0, -0.012, -0.104); // just off the sphere surface
    face.rotation.y = Math.PI; // plane normal faces -z
    face.renderOrder = 2;
    headGrp.add(face);

    const hairRoll = this.rng();
    const hairStyle: 'bald' | 'buzz' | 'afro' | 'long' | 'cap' =
      hairRoll < 0.08 ? 'bald' : hairRoll < 0.42 ? 'buzz' : hairRoll < 0.6 ? 'afro' : hairRoll < 0.82 ? 'long' : 'cap';
    if (hairStyle === 'buzz') {
      const h = new THREE.Mesh(G.hairBuzz, hairMat);
      h.position.y = 0.012;
      headGrp.add(h);
    } else if (hairStyle === 'afro') {
      const h = new THREE.Mesh(G.hairAfro, hairMat);
      // shifted up & back so the face decal stays exposed
      h.position.set(0, 0.048, 0.026);
      h.scale.set(0.96, 0.82, 0.88);
      headGrp.add(h);
    } else if (hairStyle === 'long') {
      const h = new THREE.Mesh(G.hairBuzz, hairMat);
      h.position.y = 0.012;
      headGrp.add(h);
      const back = new THREE.Mesh(G.hairBack, hairMat);
      back.position.set(0, -0.06, 0.1); // back of the head (model forward is -z)
      headGrp.add(back);
    } else if (hairStyle === 'cap') {
      const capMat = this.pick(this.pools.shirt);
      const h = new THREE.Mesh(G.cap, capMat);
      h.position.y = 0.02;
      headGrp.add(h);
      const brim = new THREE.Mesh(G.brim, capMat);
      brim.position.set(0, 0.012, -0.13); // brim points forward (-z)
      headGrp.add(brim);
    }

    // ---- arms (shoulder pivot -> upper arm -> elbow pivot -> forearm+hand)
    const mkArm = (side: -1 | 1): { shoulder: THREE.Group; elbow: THREE.Group } => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.222, 1.385, 0);
      const upper = new THREE.Mesh(G.upperArm, sleeve === 'none' ? plainSkin : upperMat);
      upper.position.y = -0.15;
      if (sleeve !== 'none') upper.castShadow = true;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -0.3;
      const fore = new THREE.Mesh(G.foreArm, sleeve === 'long' ? foreMat : plainSkin);
      fore.position.y = -0.13;
      elbow.add(fore);
      const hand = new THREE.Mesh(G.hand, plainSkin);
      hand.position.y = -0.29;
      hand.scale.set(0.85, 1.15, 0.6);
      elbow.add(hand);
      shoulder.add(elbow);
      return { shoulder, elbow };
    };
    const lArm = mkArm(-1);
    const rArm = mkArm(1);

    // ---- legs (hip pivot -> thigh -> knee pivot -> shin+shoe)
    const mkLeg = (side: -1 | 1): { hip: THREE.Group; knee: THREE.Group } => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.095, 0.86, 0);
      const thigh = new THREE.Mesh(G.thigh, pantsMat);
      thigh.position.y = -0.2;
      thigh.castShadow = true;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.y = -0.4;
      const shin = new THREE.Mesh(G.shin, pantsMat);
      shin.position.y = -0.19;
      knee.add(shin);
      const shoe = new THREE.Mesh(G.shoe, shoeMat);
      shoe.position.set(0, -0.4, -0.035); // toe points forward (-z)
      knee.add(shoe);
      hip.add(knee);
      return { hip, knee };
    };
    const lLeg = mkLeg(-1);
    const rLeg = mkLeg(1);

    // ---- outfit extras + carried phone (parented to the right elbow)
    let hasPhone = false;
    if (addSuit) {
      const v = new THREE.Mesh(G.chestV, this.pools.white);
      v.position.set(0, 1.28, -0.108);
      group.add(v);
      const tie = new THREE.Mesh(G.tie, this.pools.tie);
      tie.position.set(0, 1.22, -0.115);
      group.add(tie);
    }
    if (addVest) {
      const stripe = new THREE.Mesh(G.stripe, this.pools.stripe);
      stripe.position.y = 1.16;
      group.add(stripe);
    }
    if (addHood) {
      const hood = new THREE.Mesh(G.hood, torsoMat);
      hood.position.set(0, 1.5, 0.075); // drapes behind the head
      hood.rotation.x = Math.PI * 0.92;
      group.add(hood);
    }
    if (this.rng() < 0.3) {
      hasPhone = true;
      const phone = new THREE.Mesh(G.phone, this.pools.phone);
      phone.position.set(0, -0.33, -0.045); // in the right hand, screen forward
      rArm.elbow.add(phone);
    }
    group.userData.hasPhone = hasPhone;

    group.add(torso, pelvis, neck, headGrp, lArm.shoulder, rArm.shoulder, lLeg.hip, rLeg.hip);
    group.scale.setScalar(0.92 + this.rng() * 0.16);

    const npc: NPC = {
      group,
      limbs: { lArm: lArm.shoulder, rArm: rArm.shoulder, lLeg: lLeg.hip, rLeg: rLeg.hip },
      fore: { l: lArm.elbow, r: rArm.elbow },
      shins: { l: lLeg.knee, r: rLeg.knee },
      headGrp,
      torso,
      state: 'walk',
      behavior: 'walk',
      behaviorT: 0,
      blockBI: bi,
      blockBJ: bj,
      perim: this.rng() * 94,
      dir: this.rng() < 0.5 ? 1 : -1,
      speed: 0,
      phase: this.rng() * 6,
      fleeT: 0,
      downT: 0,
      walkSpeed: 1.05 + this.rng() * 0.85,
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
    npc.group.position.x = x;
    npc.group.position.z = z;
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
    // sprawled limbs
    n.limbs.lArm.rotation.set(-0.6, 0, 1.15);
    n.limbs.rArm.rotation.set(-1.4, 0, -0.9);
    n.limbs.lLeg.rotation.set(-0.25, 0, 0.35);
    n.limbs.rLeg.rotation.set(-0.5, 0, -0.5);
    n.fore.l.rotation.x = -0.5;
    n.fore.r.rotation.x = -0.9;
    n.shins.l.rotation.x = 0.7;
    n.shins.r.rotation.x = 0.25;
    n.headGrp.rotation.set(0, 0.4, 0);
  }

  fleeFrom(pos: THREE.Vector3, r: number): void {
    for (const n of this.list) {
      if (n.state !== 'walk') continue;
      if (n.group.position.distanceTo(pos) < r) {
        n.state = 'flee';
        n.fleeT = 4 + this.rng() * 3;
        n.behavior = 'walk';
        n.behaviorT = 0;
        this.resetPose(n);
        n.dir = this.rng() < 0.5 ? 1 : -1;
      }
    }
  }

  private resetPose(n: NPC): void {
    for (const p of [n.limbs.lArm, n.limbs.rArm, n.limbs.lLeg, n.limbs.rLeg, n.fore.l, n.fore.r, n.shins.l, n.shins.r])
      p.rotation.set(0, 0, 0);
    n.headGrp.rotation.set(0, 0, 0);
    n.torso.rotation.set(0, 0, 0);
    n.group.userData.swayT = undefined;
  }

  private poseStand(n: NPC, dt: number): void {
    // relaxed standing with a gentle sway; phone pose lifts right arm to ear
    const prev = n.group.userData.swayT as number | undefined;
    const sway = (prev ?? 0) + dt;
    n.group.userData.swayT = sway;
    const s = Math.sin(sway * 1.4) * 0.05;
    n.limbs.lArm.rotation.x = s;
    n.limbs.lArm.rotation.z = 0.06;
    n.limbs.rArm.rotation.z = -0.06;
    n.fore.l.rotation.x = -0.14;
    n.shins.l.rotation.x = 0.04;
    n.shins.r.rotation.x = 0.04;
    n.limbs.lLeg.rotation.x = 0;
    n.limbs.rLeg.rotation.x = 0;
    if (n.behavior === 'phone') {
      n.limbs.rArm.rotation.x = -2.32;
      n.limbs.rArm.rotation.z = -0.22;
      n.fore.r.rotation.x = -1.05;
      n.headGrp.rotation.x = -0.07;
      n.headGrp.rotation.y = 0;
    } else {
      n.limbs.rArm.rotation.x = -s;
      n.fore.r.rotation.x = -0.14;
      n.headGrp.rotation.x = 0;
      n.headGrp.rotation.y = Math.sin(sway * 0.7) * 0.55; // look around slowly
    }
  }

  update(dt: number, world: World): void {
    for (const n of this.list) {
      if (n.state === 'down') {
        n.downT += dt;
        // Fall over backward with a slight roll
        n.group.rotation.x = Math.min(Math.PI / 2, n.downT * 5);
        n.group.rotation.z = Math.min(0.22, n.downT * 1.1);
        n.group.position.y = Math.max(0.05, SIDEWALK_H - n.downT * 0.08);
        if (n.downT > 10) {
          // get up & respawn elsewhere
          n.group.rotation.x = 0;
          n.group.rotation.z = 0;
          n.state = 'walk';
          n.behavior = 'walk';
          n.behaviorT = 0;
          this.resetPose(n);
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
      } else if (n.behavior !== 'walk') {
        // idle behaviours (phone call / looking around)
        n.behaviorT -= dt;
        if (n.behaviorT <= 0) {
          n.behavior = 'walk';
          n.behaviorT = 0;
          this.resetPose(n);
        } else {
          this.placeAt(n, n.perim);
          this.faceRing(n);
          this.poseStand(n, dt);
          continue;
        }
      } else if (this.rng() < dt * 0.03) {
        // occasionally stop for a phone call / to look around
        n.behavior = n.group.userData.hasPhone && this.rng() < 0.65 ? 'phone' : 'stand';
        n.behaviorT = 4 + this.rng() * 6;
        n.group.userData.swayT = 0;
        continue;
      }

      const speed = fleeing ? 4.6 : n.walkSpeed;
      n.speed = speed;
      n.perim += n.dir * speed * dt;
      if (this.rng() < dt * 0.05) n.dir = (n.dir * -1) as 1 | -1;
      this.placeAt(n, n.perim);
      this.faceRing(n);

      // ---- GTA-style walk cycle: knee flex + elbow bend + torso bob
      n.phase += speed * dt * 3.6;
      const amp = fleeing ? 1.0 : 0.62;
      const sw = Math.sin(n.phase);
      const cw = Math.cos(n.phase);
      n.limbs.lLeg.rotation.x = sw * amp * 0.66;
      n.limbs.rLeg.rotation.x = -sw * amp * 0.66;
      // knees only flex backward (heel kick), peak as the leg swings forward
      n.shins.l.rotation.x = (1 - cw) * 0.5 * amp * 1.05;
      n.shins.r.rotation.x = (1 + cw) * 0.5 * amp * 1.05;
      n.limbs.lArm.rotation.x = -sw * amp * 0.52;
      n.limbs.rArm.rotation.x = sw * amp * 0.52;
      n.limbs.lArm.rotation.z = 0.05;
      n.limbs.rArm.rotation.z = -0.05;
      n.fore.l.rotation.x = -(0.22 + Math.max(0, cw) * 0.4) * amp;
      n.fore.r.rotation.x = -(0.22 + Math.max(0, -cw) * 0.4) * amp;
      n.headGrp.rotation.y = Math.sin(n.phase * 0.4) * 0.1;
      n.torso.rotation.x = fleeing ? -0.13 : -0.035; // lean into travel (-z forward)
      n.group.position.y = SIDEWALK_H + Math.abs(Math.sin(n.phase)) * (fleeing ? 0.045 : 0.024);
    }
    void world;
  }

  private faceRing(n: NPC): void {
    const side = n.group.userData.ringSide as number;
    // model forward is -z: yaw for sides [+x, +z, -x, -z]
    const yawMap = [-Math.PI / 2, Math.PI, Math.PI / 2, 0];
    n.group.rotation.y = yawMap[side] + (n.dir === 1 ? 0 : Math.PI);
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
    for (const p of Object.values(this.pools)) {
      if (Array.isArray(p)) for (const m of p) m.dispose();
      else p.dispose();
    }
  }
}
