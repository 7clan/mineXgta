import * as THREE from 'three';

/** Shared helpers for the game orchestrator. */

export const HUD_EMIT_INTERVAL = 0.125;
export const MINIMAP_SPAN = 480; // world meters covered by the minimap base image
export const SHAFT_LIFE = 1; // reserved for future shaft recycling tuning
export const AIM_EPS = 0.01;

/** Analytic ray vs AABB. Returns entry point, distance and face normal, or null. */
export function rayBox(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  box: THREE.Box3,
  maxDist: number
): { point: THREE.Vector3; t: number; normal: THREE.Vector3 } | null {
  let tmin = 0;
  let tmax = maxDist;
  let axis = 0;
  let sign = 1;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const mn = [box.min.x, box.min.y, box.min.z];
  const mx = [box.max.x, box.max.y, box.max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (mn[i] - o[i]) * inv;
    let t2 = (mx[i] - o[i]) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  const point = origin.clone().addScaledVector(dir, tmin);
  const normal = new THREE.Vector3();
  if (axis === 0) normal.set(sign, 0, 0);
  else if (axis === 1) normal.set(0, sign, 0);
  else normal.set(0, 0, sign);
  return { point, t: tmin, normal };
}

/** Golden-hour sky dome, sun sprite and drifting clouds. */
export function buildSky(scene: THREE.Scene, sunTex: THREE.Texture, cloudTex: THREE.Texture): void {
  const skyGeo = new THREE.SphereGeometry(1100, 24, 14);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x54779e) },
      mid: { value: new THREE.Color(0xc4a878) },
      bottom: { value: new THREE.Color(0xf0c58c) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        vec3 col = mix(bottom, mid, smoothstep(-0.02, 0.18, h));
        col = mix(col, top, smoothstep(0.12, 0.6, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  // Sun sprite near the horizon
  const sunMat = new THREE.SpriteMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false });
  const sun = new THREE.Sprite(sunMat);
  sun.scale.setScalar(160);
  sun.position.set(-460, 240, -640);
  scene.add(sun);

  // Clouds
  const cloudMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.5, depthWrite: false, fog: false });
  const rng = (seed: number) => {
    let a = seed;
    return () => {
      a = (a * 16807) % 2147483647;
      return a / 2147483647;
    };
  };
  const r = rng(12345);
  for (let i = 0; i < 14; i++) {
    const c = new THREE.Sprite(cloudMat);
    c.scale.set(120 + r() * 160, 40 + r() * 50, 1);
    c.position.set((r() - 0.5) * 1500, 150 + r() * 130, (r() - 0.5) * 1500);
    c.userData.drift = 1.2 + r() * 2;
    scene.add(c);
    if (!scene.userData.clouds) scene.userData.clouds = [] as THREE.Sprite[];
    (scene.userData.clouds as THREE.Sprite[]).push(c);
  }
}

/** Drift clouds; call once per frame. */
export function updateClouds(scene: THREE.Scene, dt: number): void {
  const clouds = scene.userData.clouds as THREE.Sprite[] | undefined;
  if (!clouds) return;
  for (const c of clouds) {
    c.position.x += c.userData.drift * dt;
    if (c.position.x > 900) c.position.x = -900;
  }
}
