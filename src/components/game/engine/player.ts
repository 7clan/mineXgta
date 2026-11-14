import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  EYE_HEIGHT,
  FLY_SPEED,
  FLY_SPRINT_SPEED,
  GRAVITY,
  JUMP_SPEED,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPRINT_SPEED,
  WALK_SPEED,
} from './constants';
import { Input } from './input';
import { World } from './types';
import { LoadedSkin, PartFaces, loadSkin, makeDefaultSkinCanvas } from './skin';
import { makeBackpackTextures } from './textures';

/**
 * The player is the ONLY blocky thing in the world — a classic Minecraft
 * character driven by the full skin format (engine/skin.ts): per-face
 * materials from a 64×64 skin PNG, overlay layers (hat/jacket/sleeves/
 * pants), classic 4px and slim 3px arms, legacy 64×32 skins auto-converted.
 * Skins can be swapped at runtime with applySkin() — e.g. with the user's
 * own TLauncher skin fetched through /api/skin.
 *
 * Walk / sprint / jump + creative flight (double-tap Space), first & third
 * person. Model scale: 1px = 1/16 world unit (Steve is ~2 blocks tall).
 */
export class Player {
  pos = new THREE.Vector3(6, 0.2, 14);
  vel = new THREE.Vector3();
  yaw = Math.PI * 0.75;
  pitch = -0.05;
  flying = false;
  onGround = false;
  health = 20;
  /** Level-ups raise the cap (2 HP per level; survival HUD reads this). */
  maxHealth = 20;
  dead = false;
  /** Creative mode: no damage of any kind (falls, cops, bosses, fire). */
  creative = false;
  group = new THREE.Group();
  thirdPerson = false;
  private limbs: { lArm: THREE.Object3D; rArm: THREE.Object3D; lLeg: THREE.Object3D; rLeg: THREE.Object3D };
  private phase = 0;
  private lastSpaceTap = -1;
  private regenT = 0;
  private hurtT = 0;
  private heldMesh: THREE.Mesh | null = null;
  private headGroup = new THREE.Group();
  /** Current skin materials (base + overlays) — creative glow iterates these. */
  private bodyMats: THREE.MeshStandardMaterial[] = [];
  private bobT = 0;

  // rig pieces that survive skin swaps
  private headHolder = new THREE.Group(); // head + hat meshes (centered at head)
  private bodyHolder = new THREE.Group(); // body + jacket meshes
  private armHolders: Record<'l' | 'r', THREE.Group> = { l: new THREE.Group(), r: new THREE.Group() };
  private legHolders: Record<'l' | 'r', THREE.Group> = { l: new THREE.Group(), r: new THREE.Group() };
  /** All currently-installed skin meshes (removed + disposed on each applySkin). */
  private skinMeshes: THREE.Mesh[] = [];
  private textures: THREE.CanvasTexture[] = [];
  private currentSkin: LoadedSkin | null = null;

  constructor(scene: THREE.Scene) {
    const P = 1 / 16;

    // Head pivot at the neck so pitch rotation swings around the right axis.
    this.headGroup.position.set(0, 24 * P, 0);
    this.headHolder.position.set(0, 4 * P, 0); // head center = 28px
    this.headGroup.add(this.headHolder);
    this.group.add(this.headGroup);

    // Body center at 18px.
    this.bodyHolder.position.set(0, 18 * P, 0);
    this.group.add(this.bodyHolder);

    // Limb pivots: shoulders at y=24px, hips at y=12px; mesh centers hang 6px below.
    this.armHolders.l.position.set(0, -6 * P, 0);
    this.armHolders.r.position.set(0, -6 * P, 0);
    this.legHolders.l.position.set(0, -6 * P, 0);
    this.legHolders.r.position.set(0, -6 * P, 0);

    const mkPivot = (holder: THREE.Group, x: number, y: number): THREE.Group => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.add(holder);
      this.group.add(pivot);
      return pivot;
    };
    this.limbs = {
      lArm: mkPivot(this.armHolders.l, -6 * P, 24 * P),
      rArm: mkPivot(this.armHolders.r, 6 * P, 24 * P),
      lLeg: mkPivot(this.legHolders.l, -2 * P, 12 * P),
      rLeg: mkPivot(this.legHolders.r, 2 * P, 12 * P),
    };

    this.applySkin(loadSkin(makeDefaultSkinCanvas(), 'classic')!);
    this.buildBackpack();
    this.group.visible = false; // hidden in first person
    scene.add(this.group);
  }

  /** PBR backpack (procedural woven-canvas maps + normal/roughness), strapped
   *  to the back: main pack + flap + side pockets + shoulder straps with steel
   *  buckles + bedroll cinched across the top. -Z is the model's back. */
  private buildBackpack(): void {
    const texs = makeBackpackTextures();
    const fabric = new THREE.MeshStandardMaterial({
      map: texs.map,
      normalMap: texs.normalMap,
      roughnessMap: texs.roughnessMap,
      metalness: 0,
      envMapIntensity: 0.55,
    });
    fabric.normalScale.set(0.9, 0.9);
    const nylon = new THREE.MeshStandardMaterial({ color: 0x241f1d, roughness: 0.58, metalness: 0.05, envMapIntensity: 0.6 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.3, metalness: 0.95, envMapIntensity: 1.2 });
    const roll = new THREE.MeshStandardMaterial({ color: 0x8f7c5c, roughness: 0.94, metalness: 0, envMapIntensity: 0.3 });
    const add = (mesh: THREE.Mesh): THREE.Mesh => {
      mesh.castShadow = true;
      this.group.add(mesh);
      return mesh;
    };

    // Main pack panel against the back.
    const pack = add(new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.44, 0.16, 3, 0.035), fabric));
    pack.position.set(0, 1.16, -0.21);
    // Flap wrapping the top rear.
    const flap = add(new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.14, 0.06, 2, 0.025), fabric));
    flap.position.set(0, 1.35, -0.18);
    flap.rotation.x = -0.45;
    // Side pockets.
    for (const sx of [-1, 1]) {
      const pocket = add(new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.17, 0.1, 2, 0.015), fabric));
      pocket.position.set(sx * 0.22, 1.1, -0.21);
    }
    // Shoulder straps on the chest (+Z), shoulder pads, steel buckles.
    for (const sx of [-1, 1]) {
      const strap = add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.46, 0.028), nylon));
      strap.position.set(sx * 0.11, 1.12, 0.15);
      const pad = add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 0.06), nylon));
      pad.position.set(sx * 0.11, 1.42, 0.03);
      pad.rotation.x = 0.35;
      const buckle = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.024), steel));
      buckle.position.set(sx * 0.11, 0.96, 0.165);
    }
    // Bedroll cinched across the top with two nylon wraps.
    const bed = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 12), roll));
    bed.rotation.z = Math.PI / 2;
    bed.position.set(0, 1.43, -0.16);
    for (const sx of [-1, 1]) {
      const ring = add(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.115, 0.115), nylon));
      ring.position.set(sx * 0.09, 1.43, -0.16);
    }
    // Grab handle.
    const handle = add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.022, 0.03), nylon));
    handle.position.set(0, 1.39, -0.12);
  }

  /**
   * Install a loaded skin onto the rig: per-face materials (the standard
   * Minecraft box face order [+X,-X,+Y,-Y,+Z,-Z] = left/right/top/bottom/
   * front/back of the character), overlay layers slightly inflated, slim
   * arms narrow the shoulder pivots. Old materials + textures are disposed.
   */
  applySkin(skin: LoadedSkin): void {
    const P = 1 / 16;
    for (const m of this.skinMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }
    this.skinMeshes = [];
    for (const t of this.textures) t.dispose();
    for (const m of this.bodyMats) m.dispose();
    this.textures = [];
    this.bodyMats = [];
    this.currentSkin = skin;

    const mkMat = (face: HTMLCanvasElement, overlay: boolean): THREE.MeshStandardMaterial => {
      const t = new THREE.CanvasTexture(face);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      t.generateMipmaps = false;
      const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.72, metalness: 0, envMapIntensity: 0.45 });
      if (overlay) m.alphaTest = 0.5; // crisp cutout overlay pixels
      this.textures.push(t);
      this.bodyMats.push(m);
      return m;
    };
    /** BoxGeometry material order [+X,-X,+Y,-Y,+Z,-Z] maps to the character's left/right/top/bottom/front/back. */
    const mats6 = (p: PartFaces, overlay = false): THREE.Material[] => [
      mkMat(p.left, overlay),
      mkMat(p.right, overlay),
      mkMat(p.top, overlay),
      mkMat(p.bottom, overlay),
      mkMat(p.front, overlay),
      mkMat(p.back, overlay),
    ];
    const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w * P, h * P, d * P);
    const addMesh = (parent: THREE.Object3D, geo: THREE.BoxGeometry, mats: THREE.Material[]): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mats);
      mesh.castShadow = true;
      parent.add(mesh);
      this.skinMeshes.push(mesh);
      return mesh;
    };

    const f = skin.parts;
    // Head + hat (hat inflated 0.5px per side).
    addMesh(this.headHolder, box(8, 8, 8), mats6(f.head));
    if (f.hat) addMesh(this.headHolder, box(9, 9, 9), mats6(f.hat, true));
    // Body + jacket (0.25px per side).
    addMesh(this.bodyHolder, box(8, 12, 4), mats6(f.body));
    if (f.jacket) addMesh(this.bodyHolder, box(8.5, 12.5, 4.5), mats6(f.jacket, true));
    // Arms + sleeves. Slim arms are 3px wide and sit 0.5px closer in.
    const aw = skin.armW;
    const ax = 4 + aw / 2; // arm inner edge hugs the body half-width (4px)
    this.limbs.lArm.position.x = -ax * P;
    this.limbs.rArm.position.x = ax * P;
    addMesh(this.armHolders.r, box(aw, 12, 4), mats6(f.armR));
    if (f.sleeveR) addMesh(this.armHolders.r, box(aw + 0.5, 12.5, 4.5), mats6(f.sleeveR, true));
    addMesh(this.armHolders.l, box(aw, 12, 4), mats6(f.armL));
    if (f.sleeveL) addMesh(this.armHolders.l, box(aw + 0.5, 12.5, 4.5), mats6(f.sleeveL, true));
    // Legs + pants.
    addMesh(this.legHolders.r, box(4, 12, 4), mats6(f.legR));
    if (f.pantsR) addMesh(this.legHolders.r, box(4.5, 12.5, 4.5), mats6(f.pantsR, true));
    addMesh(this.legHolders.l, box(4, 12, 4), mats6(f.legL));
    if (f.pantsL) addMesh(this.legHolders.l, box(4.5, 12.5, 4.5), mats6(f.pantsL, true));
  }

  /** The currently-installed skin (used by the HUD preview + status line). */
  get skin(): LoadedSkin | null {
    return this.currentSkin;
  }

  setHeldItem(color: number | null): void {
    if (this.heldMesh) {
      this.limbs.rArm.remove(this.heldMesh);
      this.heldMesh.geometry.dispose();
      (this.heldMesh.material as THREE.Material).dispose();
      this.heldMesh = null;
    }
    if (color === null) return;
    const geo = new THREE.BoxGeometry(0.22, 0.22, 0.34);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.7 });
    this.heldMesh = new THREE.Mesh(geo, mat);
    this.heldMesh.position.set(0, -0.62, 0.1);
    this.heldMesh.rotation.x = 0.5;
    this.limbs.rArm.add(this.heldMesh);
  }

  /** Creative-mode visual: warm golden emissive glow on the whole body (base + overlays). */
  setCreativeGlow(on: boolean): void {
    for (const m of this.bodyMats) {
      if (on) {
        m.emissive.setHex(0x8a6a1a);
        m.emissiveIntensity = 0.85;
      } else {
        m.emissive.setHex(0x000000);
        m.emissiveIntensity = 1;
      }
    }
  }

  toggleFly(): void {
    this.flying = !this.flying;
    if (this.flying) this.vel.y = Math.max(this.vel.y, 0);
  }

  damage(n: number): void {
    if (this.dead || this.creative) return;
    this.health = Math.max(0, this.health - n);
    this.hurtT = 0.45;
    if (this.health <= 0) this.dead = true;
  }

  heal(n: number): void {
    this.health = Math.min(this.maxHealth, this.health + n);
  }

  levelUp(): void {
    this.maxHealth = Math.min(40, this.maxHealth + 2);
    this.health = this.maxHealth;
  }

  respawn(x: number, z: number): void {
    this.pos.set(x, 2, z);
    this.vel.set(0, 0, 0);
    this.health = this.maxHealth;
    this.dead = false;
    this.flying = false;
  }

  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + EYE_HEIGHT + Math.sin(this.bobT) * 0.035, this.pos.z);
  }

  update(
    dt: number,
    input: Input,
    world: World,
    active: boolean
  ): { landed: boolean; fallVel: number } {
    let landed = false;
    let fallVel = 0;
    this.hurtT = Math.max(0, this.hurtT - dt);

    if (active) {
      // Double-tap space toggles creative flight.
      if (input.justPressed('Space')) {
        const now = performance.now();
        if (now - this.lastSpaceTap < 280) {
          this.toggleFly();
          this.lastSpaceTap = -1;
        } else this.lastSpaceTap = now;
      }
    }

    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const wish = new THREE.Vector3();
    if (active) {
      if (input.isDown('KeyW')) wish.add(f);
      if (input.isDown('KeyS')) wish.sub(f);
      if (input.isDown('KeyD')) wish.add(r);
      if (input.isDown('KeyA')) wish.sub(r);
    }
    if (wish.lengthSq() > 0) wish.normalize();
    const sprint = input.isDown('ShiftLeft') && !this.flying;

    if (this.flying) {
      const speed = sprint ? FLY_SPRINT_SPEED : FLY_SPEED;
      const target = wish.multiplyScalar(speed);
      if (active) {
        if (input.isDown('Space')) target.y += speed * 0.9;
        if (input.isDown('KeyC')) target.y -= speed * 0.9;
      }
      const k = 1 - Math.exp(-9 * dt);
      this.vel.lerp(target, k);
      this.pos.addScaledVector(this.vel, dt);
      this.onGround = false;
    } else {
      const speed = sprint ? SPRINT_SPEED : WALK_SPEED;
      const accel = this.onGround ? 42 : 12;
      const target = wish.multiplyScalar(speed);
      this.vel.x += (target.x - this.vel.x) * Math.min(1, accel * dt);
      this.vel.z += (target.z - this.vel.z) * Math.min(1, accel * dt);
      this.vel.y -= GRAVITY * dt;
      if (active && input.isDown('Space') && this.onGround) {
        this.vel.y = JUMP_SPEED;
        this.onGround = false;
      }
      this.pos.addScaledVector(this.vel, dt);
    }

    // Floor collision (works in every mode). The probe height includes the
    // distance fallen THIS frame so fast drops can't tunnel through rooftops.
    const drop = !this.flying && this.vel.y < 0 ? Math.min(1.6, -this.vel.y * dt) : 0;
    const floor = world.floorHeightAt(this.pos.x, this.pos.z, this.pos.y + drop);
    if (this.pos.y <= floor + 0.001) {
      if (!this.onGround && !this.flying) {
        landed = true;
        fallVel = this.vel.y;
        if (fallVel < -18) this.damage((Math.abs(fallVel) - 18) * 0.9);
      }
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
      this.onGround = true;
      // Auto step-up small ledges (sidewalks).
      if (!this.flying) {
        const ahead = world.floorHeightAt(this.pos.x + this.vel.x * 0.1, this.pos.z + this.vel.z * 0.1, this.pos.y + 0.3);
        if (ahead - this.pos.y > 0.02 && ahead - this.pos.y < 0.4 && this.onGround) this.pos.y = ahead;
      }
    } else if (this.pos.y > floor + 0.05) {
      this.onGround = false;
    }
    // Bedrock safety
    if (this.pos.y < -70) this.pos.y = -64;

    // Walls: buildings + placed blocks.
    world.resolveCircleXZ(this.pos, PLAYER_RADIUS, this.pos.y, PLAYER_HEIGHT);

    // Regen
    this.regenT += dt;
    if (this.regenT > 4.5 && this.health < this.maxHealth && this.hurtT <= 0) {
      this.health = Math.min(this.maxHealth, this.health + 1);
      this.regenT = 0;
    }

    // Animation
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.phase += hSpeed * dt * 2.6;
    this.bobT += dt * hSpeed * 1.9;
    const swing = this.flying ? 0 : Math.sin(this.phase * 2.2) * Math.min(0.75, hSpeed * 0.16);
    this.limbs.lArm.rotation.x = swing;
    this.limbs.rArm.rotation.x = -swing;
    this.limbs.lLeg.rotation.x = -swing;
    this.limbs.lLeg.rotation.x = swing * 0.9;
    this.limbs.rLeg.rotation.x = -swing * 0.9;
    if (this.flying) {
      this.limbs.lLeg.rotation.x = 0.25;
      this.limbs.rLeg.rotation.x = -0.2;
    }
    this.headGroup.rotation.x = -this.pitch * 0.6;

    // Sync mesh (third person)
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw + Math.PI; // model faces -Z natively
    this.group.visible = this.thirdPerson;
    return { landed, fallVel };
  }

  hurtFlash(): number {
    return this.hurtT / 0.45;
  }
}
