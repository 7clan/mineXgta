import * as THREE from 'three';

/**
 * GPU-friendly particle system:
 * - Debris: one InstancedMesh of small icosahedra (rubble chips, never blocky cubes).
 * - Fire/Smoke: two THREE.Points systems driven by a tiny custom shader.
 * - Explosion flash: pooled PointLight + expanding shockwave ring.
 */

const MAX_DEBRIS = 700;
const MAX_FIRE = 900;
const MAX_SMOKE = 700;
const MAX_WATER = 520;

interface DebrisP {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  rotVel: THREE.Vector3;
  life: number;
  maxLife: number;
  scale: number;
  active: boolean;
}

interface SparkP {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  active: boolean;
}

interface FireEmitter {
  getPos: () => THREE.Vector3;
  ttl: number;
  rate: number;
  acc: number;
  power: number;
}

const FIRE_VERT = /* glsl */ `
  attribute float aLife;
  attribute float aSize;
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Clip out particles at/behind the camera (prevents giant screen-filling quads).
    if (mv.z > -0.35) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    gl_PointSize = aSize * (140.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FIRE_FRAG = /* glsl */ `
  varying float vLife;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.05, d) * vLife;
    vec3 col = mix(vec3(1.0, 0.32, 0.05), vec3(1.0, 0.85, 0.3), vLife * vLife);
    gl_FragColor = vec4(col, a);
  }
`;

const SMOKE_FRAG = /* glsl */ `
  varying float vLife;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.1, d) * vLife * 0.38;
    gl_FragColor = vec4(vec3(0.16, 0.15, 0.14), a);
  }
`;

// Water spray: bright cyan-white droplets that thin out as they fly.
const WATER_FRAG = /* glsl */ `
  varying float vLife;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.08, d) * vLife * 0.72;
    vec3 col = mix(vec3(0.62, 0.86, 0.98), vec3(0.92, 0.99, 1.0), vLife);
    gl_FragColor = vec4(col, a);
  }
`;

export class Particles {
  private scene: THREE.Scene;
  private debrisMesh: THREE.InstancedMesh;
  private debris: DebrisP[] = [];
  private fire: SparkP[] = [];
  private smoke: SparkP[] = [];
  private water: SparkP[] = [];
  private firePoints: THREE.Points;
  private smokePoints: THREE.Points;
  private waterPoints: THREE.Points;
  private firePos: Float32Array;
  private fireLife: Float32Array;
  private fireSize: Float32Array;
  private smokePos: Float32Array;
  private smokeLife: Float32Array;
  private smokeSize: Float32Array;
  private waterPos: Float32Array;
  private waterLife: Float32Array;
  private waterSize: Float32Array;
  private emitters: FireEmitter[] = [];
  private flashLight: THREE.PointLight;
  private flashT = 0;
  private ring: THREE.Mesh;
  private ringT = 0;
  private dummy = new THREE.Object3D();
  private colorTmp = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // ---- Debris ----
    const dGeo = new THREE.IcosahedronGeometry(0.09, 0);
    const dMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.05 });
    this.debrisMesh = new THREE.InstancedMesh(dGeo, dMat, MAX_DEBRIS);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.count = MAX_DEBRIS;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.castShadow = false;
    const colors = new Float32Array(MAX_DEBRIS * 3).fill(0.6);
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.debris.push({
        pos: new THREE.Vector3(0, -100, 0),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        rotVel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        scale: 1,
        active: false,
      });
      this.dummy.position.set(0, -100, 0);
      this.dummy.scale.setScalar(0.001);
      this.dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(i, this.dummy.matrix);
    }
    scene.add(this.debrisMesh);

    // ---- Fire points ----
    const mkPoints = (max: number, frag: string) => {
      const g = new THREE.BufferGeometry();
      const p = new Float32Array(max * 3).fill(-9999);
      const l = new Float32Array(max);
      const s = new Float32Array(max).fill(1);
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setAttribute('aLife', new THREE.BufferAttribute(l, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(s, 1));
      const m = new THREE.ShaderMaterial({
        vertexShader: FIRE_VERT,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending: frag === SMOKE_FRAG ? THREE.NormalBlending : THREE.AdditiveBlending,
      });
      const pts = new THREE.Points(g, m);
      pts.frustumCulled = false;
      scene.add(pts);
      return { pts, p, l, s };
    };
    const f = mkPoints(MAX_FIRE, FIRE_FRAG);
    this.firePoints = f.pts;
    this.firePos = f.p;
    this.fireLife = f.l;
    this.fireSize = f.s;
    const s = mkPoints(MAX_SMOKE, SMOKE_FRAG);
    this.smokePoints = s.pts;
    this.smokePos = s.p;
    this.smokeLife = s.l;
    this.smokeSize = s.s;
    for (let i = 0; i < MAX_FIRE; i++)
      this.fire.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 1, active: false });
    for (let i = 0; i < MAX_SMOKE; i++)
      this.smoke.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 1, active: false });
    const w = mkPoints(MAX_WATER, WATER_FRAG);
    this.waterPoints = w.pts;
    this.waterPos = w.p;
    this.waterLife = w.l;
    this.waterSize = w.s;
    for (let i = 0; i < MAX_WATER; i++)
      this.water.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 1, active: false });

    // ---- Explosion flash light + shockwave ring ----
    this.flashLight = new THREE.PointLight(0xffb060, 0, 40, 1.8);
    scene.add(this.flashLight);
    const ringGeo = new THREE.RingGeometry(0.9, 1.0, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  spawnDebris(pos: THREE.Vector3, count: number, color: THREE.Color, power = 1): void {
    let spawned = 0;
    for (const d of this.debris) {
      if (spawned >= count) break;
      if (d.active) continue;
      d.active = true;
      d.pos.copy(pos);
      d.pos.x += (Math.random() - 0.5) * 0.4;
      d.pos.y += (Math.random() - 0.5) * 0.4;
      d.pos.z += (Math.random() - 0.5) * 0.4;
      const a = Math.random() * Math.PI * 2;
      const up = 2.5 + Math.random() * 4.5 * power;
      const sp = (1.5 + Math.random() * 4) * power;
      d.vel.set(Math.cos(a) * sp, up, Math.sin(a) * sp);
      d.rot.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      d.rotVel.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12);
      d.maxLife = 1.4 + Math.random() * 1.4;
      d.life = d.maxLife;
      d.scale = 0.6 + Math.random() * 1.1;
      const ci = this.debris.indexOf(d);
      const c = this.colorTmp.copy(color).multiplyScalar(0.75 + Math.random() * 0.4);
      this.debrisMesh.instanceColor!.setXYZ(ci, c.r, c.g, c.b);
      spawned++;
    }
    this.debrisMesh.instanceColor!.needsUpdate = true;
  }

  private spawnSpark(list: SparkP[], pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number): void {
    for (const p of list) {
      if (p.active) continue;
      p.active = true;
      p.pos.copy(pos);
      p.vel.copy(vel);
      p.life = life;
      p.maxLife = life;
      p.size = size;
      return;
    }
  }

  addFireEmitter(getPos: () => THREE.Vector3, ttl: number, power = 1): void {
    this.emitters.push({ getPos, ttl, rate: 26 * power, acc: 0, power });
  }

  /** Quick visual helpers ---------------------------------------------------- */
  firePuff(pos: THREE.Vector3, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawnSpark(this.fire, pos, new THREE.Vector3(Math.cos(a) * 1.6, 1.6 + Math.random() * 2.4, Math.sin(a) * 1.6), 0.5 + Math.random() * 0.4, 1.2 + Math.random());
    }
  }

  smokePuff(pos: THREE.Vector3, n: number, spread = 1.4, rise = 2.2): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      this.spawnSpark(
        this.smoke,
        new THREE.Vector3(pos.x + Math.cos(a) * r, pos.y + Math.random() * 0.4, pos.z + Math.sin(a) * r),
        new THREE.Vector3((Math.random() - 0.5) * 0.7, rise + Math.random() * 1.4, (Math.random() - 0.5) * 0.7),
        1.6 + Math.random() * 1.8,
        2.2 + Math.random() * 2.4
      );
    }
  }

  dustPuff(pos: THREE.Vector3, n: number, radius: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * radius;
      this.spawnSpark(
        this.smoke,
        new THREE.Vector3(pos.x + Math.cos(a) * rr, pos.y + Math.random() * 1.5, pos.z + Math.sin(a) * rr),
        new THREE.Vector3(Math.cos(a) * 2.4, 1 + Math.random() * 2, Math.sin(a) * 2.4),
        2 + Math.random() * 1.6,
        3 + Math.random() * 3
      );
    }
  }

  /** Hydrant water jet: a column of bright droplets launched upward, spraying
   *  outwards as they rise. Called every frame while a main is burst. */
  waterJet(pos: THREE.Vector3, n: number, power = 1): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = (7.5 + Math.random() * 6.5) * power;
      const out = (0.55 + Math.random() * 1.5) * power;
      this.spawnSpark(
        this.water,
        new THREE.Vector3(pos.x + Math.cos(a) * 0.14, pos.y + 0.15, pos.z + Math.sin(a) * 0.14),
        new THREE.Vector3(Math.cos(a) * out, up, Math.sin(a) * out),
        0.75 + Math.random() * 0.75,
        0.55 + Math.random() * 0.8
      );
    }
  }

  explosion(pos: THREE.Vector3, radius: number): void {
    this.flashLight.position.copy(pos);
    this.flashLight.position.y += 1.2;
    this.flashLight.intensity = 320;
    this.flashT = 0.5;
    this.firePuff(pos, Math.min(90, Math.floor(radius * 14)));
    this.smokePuff(pos, Math.min(60, Math.floor(radius * 9)), radius * 0.7, 3.4);
    this.ring.position.copy(pos);
    this.ring.position.y += 0.25;
    this.ring.scale.setScalar(0.6);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.85;
    this.ring.visible = true;
    this.ringT = 0.62;
  }

  update(dt: number): void {
    // ---- Debris ----
    let i = 0;
    for (const d of this.debris) {
      if (d.active) {
        d.life -= dt;
        if (d.life <= 0) {
          d.active = false;
          d.pos.y = -100;
        } else {
          d.vel.y -= 16 * dt;
          d.pos.addScaledVector(d.vel, dt);
          if (d.pos.y < 0.06) {
            d.pos.y = 0.06;
            d.vel.y = Math.abs(d.vel.y) * 0.34;
            d.vel.x *= 0.72;
            d.vel.z *= 0.72;
          }
          d.rot.x += d.rotVel.x * dt;
          d.rot.y += d.rotVel.y * dt;
          d.rot.z += d.rotVel.z * dt;
        }
      }
      this.dummy.position.copy(d.pos);
      this.dummy.rotation.copy(d.rot);
      this.dummy.scale.setScalar(d.active ? d.scale * Math.min(1, d.life * 2.4) : 0.001);
      this.dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(i++, this.dummy.matrix);
    }
    this.debrisMesh.instanceMatrix.needsUpdate = true;

    // ---- Emitters ----
    for (let e = this.emitters.length - 1; e >= 0; e--) {
      const em = this.emitters[e];
      em.ttl -= dt;
      if (em.ttl <= 0) {
        this.emitters.splice(e, 1);
        continue;
      }
      em.acc += em.rate * dt;
      const p = em.getPos();
      while (em.acc >= 1) {
        em.acc -= 1;
        const a = Math.random() * Math.PI * 2;
        this.spawnSpark(
          this.fire,
          new THREE.Vector3(p.x + Math.cos(a) * 0.4 * em.power, p.y + Math.random() * 0.3, p.z + Math.sin(a) * 0.4 * em.power),
          new THREE.Vector3((Math.random() - 0.5) * 0.5, 2.2 + Math.random() * 2, (Math.random() - 0.5) * 0.5),
          0.4 + Math.random() * 0.35,
          (1.1 + Math.random()) * em.power
        );
        if (Math.random() < 0.4) {
          this.spawnSpark(
            this.smoke,
            new THREE.Vector3(p.x, p.y + 0.5, p.z),
            new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.8 + Math.random() * 1.6, (Math.random() - 0.5) * 0.6),
            1.6 + Math.random() * 1.5,
            1.8 + Math.random() * 2
          );
        }
      }
    }

    // ---- Fire points ----
    this.writePoints(this.fire, this.firePos, this.fireLife, this.fireSize, this.firePoints, dt, -3.4);
    this.writePoints(this.smoke, this.smokePos, this.smokeLife, this.smokeSize, this.smokePoints, dt, -1.1);
    // Water: strong gravity so jets arc over and rain back down.
    this.writePoints(this.water, this.waterPos, this.waterLife, this.waterSize, this.waterPoints, dt, -16.5);

    // ---- Flash + ring ----
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flashLight.intensity *= Math.pow(0.0016, dt);
      if (this.flashT <= 0) this.flashLight.intensity = 0;
    }
    if (this.ringT > 0) {
      this.ringT -= dt;
      const k = 1 - this.ringT / 0.62;
      this.ring.scale.setScalar(0.6 + k * 9);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
      if (this.ringT <= 0) this.ring.visible = false;
    }
  }

  private writePoints(list: SparkP[], pos: Float32Array, life: Float32Array, size: Float32Array, pts: THREE.Points, dt: number, gravity: number): void {
    let n = 0;
    for (const p of list) {
      if (p.active) {
        p.life -= dt;
        if (p.life <= 0) {
          p.active = false;
        } else {
          p.vel.y += gravity * dt * 0.4;
          p.pos.addScaledVector(p.vel, dt);
        }
      }
      if (p.active) {
        pos[n * 3] = p.pos.x;
        pos[n * 3 + 1] = p.pos.y;
        pos[n * 3 + 2] = p.pos.z;
        life[n] = p.life / p.maxLife;
        size[n] = p.size;
        n++;
      }
    }
    const g = pts.geometry;
    (g.attributes.position as THREE.BufferAttribute).updateRanges = [{ start: 0, count: n * 3 }];
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aLife as THREE.BufferAttribute).updateRanges = [{ start: 0, count: n }];
    (g.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aSize as THREE.BufferAttribute).updateRanges = [{ start: 0, count: n }];
    (g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    g.setDrawRange(0, n);
  }

  get activeFireCount(): number {
    return this.emitters.length;
  }

  dispose(): void {
    this.scene.remove(this.debrisMesh, this.firePoints, this.smokePoints, this.waterPoints, this.flashLight, this.ring);
  }
}
