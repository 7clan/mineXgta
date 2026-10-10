import * as THREE from 'three';
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
import { makeSteveTextures } from './textures';

/**
 * The player is the ONLY blocky thing in the world — a classic Minecraft Steve.
 * Walk / sprint / jump + creative flight (double-tap Space), first & third person.
 */
export class Player {
  pos = new THREE.Vector3(6, 0.2, 14);
  vel = new THREE.Vector3();
  yaw = Math.PI * 0.75;
  pitch = -0.05;
  flying = false;
  onGround = false;
  health = 20;
  dead = false;
  group = new THREE.Group();
  thirdPerson = false;
  private limbs: { lArm: THREE.Object3D; rArm: THREE.Object3D; lLeg: THREE.Object3D; rLeg: THREE.Object3D };
  private phase = 0;
  private lastSpaceTap = -1;
  private regenT = 0;
  private hurtT = 0;
  private heldMesh: THREE.Mesh | null = null;
  private headGroup: THREE.Group;
  private bodyMats: THREE.MeshLambertMaterial[] = [];
  private bobT = 0;

  constructor(scene: THREE.Scene) {
    const tex = makeSteveTextures();
    const mkMat = (c: HTMLCanvasElement) => {
      const t = new THREE.CanvasTexture(c);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.MeshLambertMaterial({ map: t });
      this.bodyMats.push(m);
      return m;
    };
    const headSide = mkMat(tex.headSide);
    const headTop = mkMat(tex.headTop);
    const headFront = mkMat(tex.headFront);
    const bodyMat = mkMat(tex.body);
    const armMat = mkMat(tex.arm);
    const legMat = mkMat(tex.leg);

    const P = 1 / 16; // pixel scale: Steve is ~2 blocks tall => 32px
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w * P, h * P, d * P);

    // Head (8x8x8 px) with face on -Z? We'll orient forward = +Z like vehicles... Steve faces where camera looks; use +Z forward.
    const headMats = [headSide, headSide, headTop, headTop, headFront, headSide];
    const head = new THREE.Mesh(box(8, 8, 8), headMats);
    head.position.y = 28 * P;
    head.castShadow = true;
    this.headGroup = new THREE.Group();
    this.headGroup.add(head);

    // Body (8x12x4)
    const body = new THREE.Mesh(box(8, 12, 4), bodyMat);
    body.position.y = 18 * P;
    body.castShadow = true;

    // Arms (4x12x4) pivot at shoulder
    const mkLimb = (m: THREE.Material, px: number, py: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(px, py, 0);
      const mesh = new THREE.Mesh(box(4, 12, 4), m);
      mesh.position.y = -6 * P;
      mesh.castShadow = true;
      pivot.add(mesh);
      return pivot;
    };
    const lArm = mkLimb(armMat, -6 * P, 24 * P);
    const rArm = mkLimb(armMat, 6 * P, 24 * P);
    const lLeg = mkLimb(legMat, -2 * P, 12 * P);
    const rLeg = mkLimb(legMat, 2 * P, 12 * P);

    this.group.add(this.headGroup, body, lArm, rArm, lLeg, rLeg);
    this.limbs = { lArm, rArm, lLeg, rLeg };
    this.group.visible = false; // hidden in first person
    scene.add(this.group);
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
    const mat = new THREE.MeshLambertMaterial({ color });
    this.heldMesh = new THREE.Mesh(geo, mat);
    this.heldMesh.position.set(0, -0.62, 0.1);
    this.heldMesh.rotation.x = 0.5;
    this.limbs.rArm.add(this.heldMesh);
  }

  toggleFly(): void {
    this.flying = !this.flying;
    if (this.flying) this.vel.y = Math.max(this.vel.y, 0);
  }

  damage(n: number): void {
    if (this.dead) return;
    this.health = Math.max(0, this.health - n);
    this.hurtT = 0.45;
    if (this.health <= 0) this.dead = true;
  }

  heal(n: number): void {
    this.health = Math.min(20, this.health + n);
  }

  respawn(x: number, z: number): void {
    this.pos.set(x, 2, z);
    this.vel.set(0, 0, 0);
    this.health = 20;
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
        if (input.isDown('KeyC') || input.isDown('ShiftLeft')) target.y -= speed * 0.9;
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

    // Floor collision (works in every mode).
    const floor = world.floorHeightAt(this.pos.x, this.pos.z, this.pos.y);
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
    if (this.regenT > 4.5 && this.health < 20 && this.hurtT <= 0) {
      this.health = Math.min(20, this.health + 1);
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
