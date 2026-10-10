/**
 * Project Hyperion — GTA-style street dressing ("Los Santos dusk" art pass).
 *
 * Everything here is decorative-but-living city detail:
 *  - Rooftop + pole billboards with parody brand ads (bloom-glowing at night)
 *  - Working traffic lights (NS/EW phases with red/amber/green)
 *  - Power poles with sagging catenary wires along the avenues
 *  - Neon shop signs (additive planes → bloom halo) on street-facing facades
 *  - Rooftop clutter: water towers, AC units, antennas with blinking beacons
 *
 * All textures are procedurally drawn on canvas — zero network assets.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BLOCK, GRID_HALF, ROAD_W, mulberry32 } from './constants';
import type { City, BuildingRec } from './city';

const SIDEWALK_TOP = 0.12;

// ---------------------------------------------------------------- ad canvases

interface AdBrand {
  name: string;
  tag: string;
  bg: string;
  fg: string;
  accent: string;
}

const BRANDS: AdBrand[] = [
  { name: 'SPRUNK', tag: "IT'S THE BEST!", bg: '#1e7d32', fg: '#ffffff', accent: '#b9f6ca' },
  { name: 'LUXOR', tag: 'HOTEL & CASINO', bg: '#111015', fg: '#f4c95d', accent: '#f4c95d' },
  { name: 'AMMU-NATION', tag: 'GUNS · AMMO · RPG', bg: '#3a3a22', fg: '#f4f1e8', accent: '#e0532a' },
  { name: '24/7', tag: 'SUPERMARKET', bg: '#f4f1ea', fg: '#d62f2f', accent: '#1e7d32' },
  { name: 'ROGUE', tag: 'MAGAZINE', bg: '#f4f1ea', fg: '#141414', accent: '#e0263c' },
  { name: 'FLEECA', tag: 'BANK OF LOS SANTOS', bg: '#123c3c', fg: '#f4c95d', accent: '#e8d9a0' },
  { name: "CLUCKIN' BELL", tag: 'TASTES LIKE CHICKEN', bg: '#f2b705', fg: '#b01f24', accent: '#fff3c4' },
  { name: 'BOBO', tag: 'TELEVISION', bg: '#4a1d6e', fg: '#ff8ad8', accent: '#ffd24a' },
  { name: 'UP-N-ATOM', tag: 'BURGER JOINT', bg: '#e0532a', fg: '#fff3e0', accent: '#2e2a25' },
  { name: 'WIZARD ISLE', tag: 'MINI GOLF', bg: '#0f4d3a', fg: '#ffd24a', accent: '#7bf1a8' },
  { name: 'LOS SANTOS', tag: 'CUSTOMS', bg: '#1c1c1e', fg: '#ff8c1a', accent: '#f4f1ea' },
  { name: 'COFFEE SHARK', tag: 'OPEN LATE', bg: '#0e3a45', fg: '#19e3d1', accent: '#ffffff' },
];

/** Draw one billboard ad face. Returns the canvas (also usable as emissiveMap). */
function drawAd(b: AdBrand, seed: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 256;
  const g = cv.getContext('2d')!;
  // Background: vertical brand gradient + grime streaks
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, shade(b.bg, 1.16));
  grad.addColorStop(1, shade(b.bg, 0.78));
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);
  const rng = mulberry32(seed);
  g.globalAlpha = 0.08;
  for (let i = 0; i < 14; i++) {
    g.fillStyle = i % 2 ? '#000000' : '#ffffff';
    g.fillRect(rng() * 512, 0, 2 + rng() * 7, 256);
  }
  g.globalAlpha = 1;
  // Frame
  g.strokeStyle = shade(b.bg, 0.4);
  g.lineWidth = 10;
  g.strokeRect(5, 5, 502, 246);
  g.strokeStyle = b.accent;
  g.lineWidth = 3;
  g.strokeRect(14, 14, 484, 228);
  // Accent geometry behind the text
  g.save();
  g.globalAlpha = 0.9;
  if (b.name === 'LUXOR' || b.name === 'WIZARD ISLE') {
    g.fillStyle = b.accent;
    g.beginPath();
    g.moveTo(256, 30);
    g.lineTo(330, 226);
    g.lineTo(182, 226);
    g.closePath();
    g.globalAlpha = 0.25;
    g.fill();
    g.globalAlpha = 1;
  } else if (b.name === 'FLEECA') {
    g.fillStyle = b.accent;
    g.globalAlpha = 0.22;
    g.beginPath();
    g.arc(256, 128, 92, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  } else if (b.name === '24/7' || b.name === 'UP-N-ATOM') {
    g.fillStyle = b.accent;
    g.globalAlpha = 0.25;
    g.fillRect(24, 150, 464, 60);
    g.globalAlpha = 1;
  }
  g.restore();
  // Headline
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const fits = b.name.length > 8 ? 58 : 84;
  g.font = `900 ${fits}px "Arial Black", Arial, sans-serif`;
  g.fillStyle = b.fg;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 6;
  g.strokeText(b.name, 256, 116);
  g.fillText(b.name, 256, 116);
  // Tagline bar
  g.font = `bold 26px Arial, sans-serif`;
  g.fillStyle = b.name === '24/7' || b.name === 'ROGUE' ? '#141414' : b.accent;
  g.fillText(b.tag, 256, 196);
  // Corner dots
  g.fillStyle = b.fg;
  for (const [x, y] of [[26, 26], [486, 26], [26, 230], [486, 230]] as const) {
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
  }
  return cv;
}

/** Lighten/darken a hex color by a factor. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const gg = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${gg},${b})`;
}

/** Neon shop-sign canvas: transparent, glowing text + frame. */
function drawNeon(text: string, color: string, seed: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 128;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, 512, 128);
  const rng = mulberry32(seed);
  // Backing board
  g.fillStyle = 'rgba(10,10,14,0.92)';
  g.strokeStyle = color;
  g.lineWidth = 6;
  roundRect(g, 6, 10, 500, 108, 14);
  g.fill();
  g.stroke();
  // Flicker dots like a strip sign
  g.fillStyle = color;
  for (let x = 24; x < 490; x += 26) {
    g.globalAlpha = 0.35 + rng() * 0.5;
    g.beginPath();
    g.arc(x, 24, 3.2, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const size = text.length > 8 ? 52 : 66;
  g.font = `900 ${size}px "Arial Black", Arial, sans-serif`;
  g.shadowColor = color;
  g.shadowBlur = 26;
  g.fillStyle = '#ffffff';
  g.fillText(text, 256, 68);
  g.shadowBlur = 0;
  g.fillStyle = color;
  g.globalAlpha = 0.55;
  g.fillText(text, 256, 68);
  g.globalAlpha = 1;
  return cv;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------- module type

export interface CityProps {
  /** Per-frame updates: traffic-light phases, billboard flicker, beacons. */
  update(time: number, night: number): void;
  dispose(): void;
}

const NEON_WORDS = [
  'BAR', 'DINER', 'NOODLES', 'MOTEL', 'LIQUOR', 'PAWN', 'GYM', 'CASINO',
  'RAMEN', 'SUSHI', 'TATTOO', 'ARCADE', 'BURGER', 'COFFEE', 'PIZZA', 'LAUNDRY',
  'RECORDS', 'PHARMACY', 'COMICS', 'THEATRE',
];
const NEON_COLORS = ['#ff2d95', '#19e3d1', '#ff8c1a', '#a4e21a', '#ff3b30', '#ffd24a', '#7bffb2', '#ff6ad5'];

// ---------------------------------------------------------------- build

export function buildCityProps(scene: THREE.Scene, city: City): CityProps {
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  const group = new THREE.Group();
  const rng = mulberry32(9042);
  const billboardMats: THREE.MeshStandardMaterial[] = [];
  const neonMats: THREE.MeshBasicMaterial[] = [];
  let beaconMat: THREE.MeshStandardMaterial | null = null;
  // Traffic-light lamp materials (shared; phase-driven emissive).
  const tlMats: Record<'r' | 'a' | 'g', THREE.MeshStandardMaterial> = {} as Record<'r' | 'a' | 'g', THREE.MeshStandardMaterial>;
  for (const lamp of ['r', 'a', 'g'] as const) {
    const col = lamp === 'r' ? 0xff2418 : lamp === 'a' ? 0xffb020 : 0x2aff5a;
    const m = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a, emissive: col, emissiveIntensity: 0.05, roughness: 0.4,
      side: THREE.DoubleSide,
    });
    tlMats[lamp] = m;
    disposables.push(m);
  }

  // ---- 1. Rooftop billboards (tallest, well-spaced buildings) -------------
  const tall = city.buildings
    .filter((b) => b.h >= 24 && !b.collapsed)
    .sort((a, b) => b.h - a.h);
  const chosen: BuildingRec[] = [];
  for (const b of tall) {
    if (chosen.every((c) => Math.hypot(c.cx - b.cx, c.cz - b.cz) > 62)) chosen.push(b);
    if (chosen.length >= 11) break;
  }
  const adTexCache: THREE.Texture[] = [];
  BRANDS.forEach((brand, i) => {
    const cv = drawAd(brand, 1000 + i * 37);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    disposables.push(tex);
    adTexCache.push(tex);
  });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.7, metalness: 0.55 });
  disposables.push(legMat);
  chosen.forEach((b, i) => {
    const tex = adTexCache[i % adTexCache.length];
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.2, roughness: 0.8,
    });
    billboardMats.push(mat);
    disposables.push(mat);
    const g = new THREE.Group();
    const alongX = rng() > 0.5;
    const pw = alongX ? 9 : 6.4;
    const pd = alongX ? 6.4 : 9;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(pw, 3.6, 0.28), mat);
    panel.position.y = 2.4;
    g.add(panel);
    // Support legs + skirt truss
    for (const sx of [-pw / 2 + 0.7, pw / 2 - 0.7]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.6, 0.22), legMat);
      leg.position.set(sx, 0.8, 0);
      g.add(leg);
    }
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.96, 0.42, 0.5), legMat);
    skirt.position.y = 0.28;
    g.add(skirt);
    g.position.set(b.cx + (rng() - 0.5) * (b.w - pw) * 0.5, b.h + 0.06, b.cz + (rng() - 0.5) * (b.d - pd) * 0.5);
    g.rotation.y = alongX ? 0 : Math.PI / 2;
    group.add(g);
  });

  // ---- 2. Pole billboards along avenues ----------------------------------
  const poleSpots: Array<{ x: number; z: number; rot: number }> = [];
  const roadA = city.roadCoords[Math.floor(city.roadCoords.length * 0.28)];
  const roadB = city.roadCoords[Math.floor(city.roadCoords.length * 0.72)];
  for (const c of [roadA, roadB]) {
    for (const mid of [-BLOCK / 2, BLOCK / 2, BLOCK * 1.5, -BLOCK * 1.5]) {
      poleSpots.push({ x: c + ROAD_W / 2 + 2.4, z: mid * 2, rot: Math.PI / 2 });
      poleSpots.push({ x: mid * 2, z: c + ROAD_W / 2 + 2.4, rot: 0 });
    }
  }
  poleSpots.forEach((s, i) => {
    if (i % 2) return; // half density
    const tex = adTexCache[(i * 5 + 3) % adTexCache.length];
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.2, roughness: 0.8,
    });
    billboardMats.push(mat);
    disposables.push(mat);
    const g = new THREE.Group();
    for (const px of [-2.4, 2.4]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 9.4, 6), legMat);
      post.position.set(px, 4.7, 0);
      g.add(post);
    }
    const panel = new THREE.Mesh(new THREE.BoxGeometry(6.6, 3.3, 0.24), mat);
    panel.position.y = 9.6;
    g.add(panel);
    g.position.set(s.x, SIDEWALK_TOP, s.z);
    g.rotation.y = s.rot;
    group.add(g);
  });

  // ---- 3. Traffic lights at major intersections --------------------------
  const step = 3;
  const crossings: Array<{ x: number; z: number }> = [];
  for (let ix = -GRID_HALF; ix <= GRID_HALF; ix += step) {
    for (let iz = -GRID_HALF; iz <= GRID_HALF; iz += step) {
      crossings.push({ x: city.roadCoords[ix + GRID_HALF], z: city.roadCoords[iz + GRID_HALF] });
    }
  }
  // Pole + arm + housing, merged into one instanced geometry. The arm reaches
  // out along +x; the instance yaw aims it diagonally over the intersection.
  const tlGeos: THREE.BufferGeometry[] = [];
  const poleG = new THREE.CylinderGeometry(0.09, 0.13, 6.2, 6);
  poleG.translate(0, 3.1, 0);
  tlGeos.push(poleG);
  const armG = new THREE.CylinderGeometry(0.06, 0.06, 3.4, 5);
  armG.rotateZ(Math.PI / 2);
  armG.translate(1.7, 6.0, 0);
  tlGeos.push(armG);
  const houseG = new THREE.BoxGeometry(0.34, 1.06, 0.3);
  houseG.translate(3.2, 5.62, 0);
  tlGeos.push(houseG);
  const tlGeo = mergeGeometries(tlGeos)!;
  tlGeos.forEach((g) => g.dispose());
  const tlPoleMat = new THREE.MeshStandardMaterial({ color: 0x1e2023, roughness: 0.55, metalness: 0.65 });
  disposables.push(tlGeo, tlPoleMat);
  const off = ROAD_W / 2 + 0.9;
  const tlCount = crossings.length * 2;
  const tlPoles = new THREE.InstancedMesh(tlGeo, tlPoleMat, tlCount);
  // One vertical 3-lamp stack per pole, hung at the arm end, DoubleSide so
  // traffic from every approach reads the phase.
  const lampGeo = new THREE.CircleGeometry(0.1, 10);
  lampGeo.translate(0, 0, 0.17); // push in front of the housing face
  disposables.push(lampGeo);
  const lampMats: Record<'r' | 'a' | 'g', THREE.MeshStandardMaterial> = tlMats;
  const lampMeshes = {} as Record<'r' | 'a' | 'g', THREE.InstancedMesh>;
  const lampY = { r: 5.94, a: 5.62, g: 5.3 };
  for (const lamp of ['r', 'a', 'g'] as const) {
    const im = new THREE.InstancedMesh(lampGeo, lampMats[lamp], tlCount);
    im.frustumCulled = false;
    lampMeshes[lamp] = im;
  }
  const dummy = new THREE.Object3D();
  let ti = 0;
  for (const c of crossings) {
    for (const [dx, dz] of [[1, 1], [-1, -1]] as const) {
      const px = c.x + dx * off;
      const pz = c.z + dz * off;
      // Aim the arm at the intersection center.
      const ry = Math.atan2(-dx, -dz);
      dummy.position.set(px, SIDEWALK_TOP, pz);
      dummy.rotation.set(0, ry, 0);
      dummy.updateMatrix();
      tlPoles.setMatrixAt(ti, dummy.matrix);
      // Arm-end world offset: rotate (3.2, 0, 0) by ry → (3.2 cos ry, 0, -3.2 sin ry).
      const ex = px + 3.2 * Math.cos(ry);
      const ez = pz - 3.2 * Math.sin(ry);
      for (const lamp of ['r', 'a', 'g'] as const) {
        dummy.position.set(ex, lampY[lamp], ez);
        dummy.rotation.set(0, ry, 0);
        dummy.updateMatrix();
        lampMeshes[lamp].setMatrixAt(ti, dummy.matrix);
      }
      ti++;
    }
  }
  for (let k = ti; k < tlCount; k++) {
    dummy.position.set(0, -999, 0);
    dummy.updateMatrix();
    tlPoles.setMatrixAt(k, dummy.matrix);
    for (const lamp of ['r', 'a', 'g'] as const) lampMeshes[lamp].setMatrixAt(k, dummy.matrix);
  }
  tlPoles.castShadow = true;
  group.add(tlPoles);
  for (const lamp of ['r', 'a', 'g'] as const) group.add(lampMeshes[lamp]);

  // ---- 4. Power poles + sagging wires on two avenues ---------------------
  const wireMat = new THREE.LineBasicMaterial({ color: 0x15171a });
  disposables.push(wireMat);
  const ppGeos: THREE.BufferGeometry[] = [];
  const ppPole = new THREE.CylinderGeometry(0.11, 0.16, 8.8, 6);
  ppPole.translate(0, 4.4, 0);
  ppGeos.push(ppPole);
  const ppArm = new THREE.BoxGeometry(2.2, 0.12, 0.12);
  ppArm.translate(0, 8.1, 0);
  ppGeos.push(ppArm);
  const ppGeo = mergeGeometries(ppGeos)!;
  ppGeos.forEach((g) => g.dispose());
  const ppMat = new THREE.MeshStandardMaterial({ color: 0x3a3230, roughness: 0.9 });
  disposables.push(ppGeo, ppMat);
  const wireSpots: Array<{ x: number; z: number }> = [];
  for (const rx of [roadA, roadB]) {
    let prev: { x: number; z: number } | null = null;
    for (let z = -CITY_EDGE; z <= CITY_EDGE; z += 34) {
      if (city.roadCoords.some((c) => Math.abs(z - c) < 6)) continue; // skip intersections
      const spot = { x: rx + ROAD_W / 2 + 1.1, z };
      wireSpots.push(spot);
      if (prev) {
        // 3 sagging wires between consecutive poles
        for (const [oy, ox] of [[8.1, -0.9], [7.85, 0], [8.1, 0.9]] as const) {
          const pts: THREE.Vector3[] = [];
          for (let s = 0; s <= 8; s++) {
            const t = s / 8;
            const x = prev.x + (spot.x - prev.x) * t;
            const zz = prev.z + (spot.z - prev.z) * t;
            const y = SIDEWALK_TOP + oy - Math.sin(t * Math.PI) * 1.05;
            pts.push(new THREE.Vector3(x + ox, y, zz));
          }
          const geo = new THREE.BufferGeometry().setFromPoints(pts);
          disposables.push(geo);
          group.add(new THREE.Line(geo, wireMat));
        }
      }
      prev = spot;
    }
  }
  const ppPoles = new THREE.InstancedMesh(ppGeo, ppMat, wireSpots.length);
  wireSpots.forEach((s, i) => {
    dummy.position.set(s.x, SIDEWALK_TOP, s.z);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    ppPoles.setMatrixAt(i, dummy.matrix);
  });
  group.add(ppPoles);

  // ---- 5. Neon shop signs on street-facing facades ------------------------
  const roadList = city.roadCoords;
  const candidates: Array<{ b: BuildingRec; side: 0 | 1 | 2 | 3 }> = [];
  for (const b of city.buildings) {
    if (b.h < 7 || b.collapsed) continue;
    // A face is street-facing when its plane sits within 2.4 m of a road edge.
    const faces: Array<[number, 0 | 1 | 2 | 3]> = [
      [faceRoadDist(b.aabb.min.x, roadList), 0],
      [faceRoadDist(b.aabb.max.x, roadList), 1],
      [faceRoadDist(b.aabb.min.z, roadList), 2],
      [faceRoadDist(b.aabb.max.z, roadList), 3],
    ];
    faces.sort((a, c) => a[0] - c[0]);
    if (faces[0][0] < 2.4) candidates.push({ b, side: faces[0][1] });
  }
  const signSpots = candidates.filter((_, i) => i % 5 === 0).slice(0, 24);
  signSpots.forEach((s, i) => {
    const word = NEON_WORDS[i % NEON_WORDS.length];
    const color = NEON_COLORS[(i * 3 + 1) % NEON_COLORS.length];
    const cv = drawNeon(word, color, 200 + i * 13);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    disposables.push(tex);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.6, depthWrite: false,
      side: THREE.DoubleSide,
    });
    neonMats.push(mat);
    disposables.push(mat);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), mat);
    const y = 3.1 + rng() * 1.4;
    if (s.side === 0) {
      plane.position.set(s.b.aabb.min.x - 0.1, y, s.b.cz);
      plane.rotation.y = -Math.PI / 2;
    } else if (s.side === 1) {
      plane.position.set(s.b.aabb.max.x + 0.1, y, s.b.cz);
      plane.rotation.y = Math.PI / 2;
    } else if (s.side === 2) {
      plane.position.set(s.b.cx, y, s.b.aabb.min.z - 0.1);
      plane.rotation.y = Math.PI;
    } else {
      plane.position.set(s.b.cx, y, s.b.aabb.max.z + 0.1);
    }
    group.add(plane);
  });

  // ---- 6. Rooftop clutter: water towers, AC units, antenna beacons -------
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x6e5b46, roughness: 0.85 });
  const acMat = new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.6, metalness: 0.4 });
  beaconMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2015, emissiveIntensity: 1.2 });
  disposables.push(tankMat, acMat, beaconMat);
  const clutterRoofs = chosen.length ? chosen : tall.slice(0, 8);
  clutterRoofs.forEach((b, i) => {
    if (i % 2 === 0) {
      // Water tower
      const g = new THREE.Group();
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 2.6, 10), tankMat);
      tank.position.y = 3.4;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.85, 1.1, 10), tankMat);
      cone.position.y = 5.2;
      g.add(tank, cone);
      for (let l = 0; l < 4; l++) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.2, 0.16), legMat);
        const a = (l / 4) * Math.PI * 2 + 0.6;
        leg.position.set(Math.cos(a) * 1.15, 1.1, Math.sin(a) * 1.15);
        g.add(leg);
      }
      g.position.set(b.cx + (rng() - 0.5) * b.w * 0.4, b.h, b.cz + (rng() - 0.5) * b.d * 0.4);
      group.add(g);
    } else {
      // Antenna + blinking beacon
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 5.5, 5), legMat);
      mast.position.set(b.cx, b.h + 2.75, b.cz);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), beaconMat);
      tip.position.set(b.cx, b.h + 5.6, b.cz);
      group.add(mast, tip);
    }
    // AC boxes
    const ac = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.05, 1.4), acMat);
    ac.position.set(b.cx + (rng() - 0.5) * b.w * 0.5, b.h + 0.55, b.cz + (rng() - 0.5) * b.d * 0.5);
    ac.rotation.y = rng() * Math.PI;
    ac.castShadow = true;
    group.add(ac);
  });

  scene.add(group);

  // ---------------------------------------------------------------- update
  const update = (time: number, night: number): void => {
    // Traffic-light phase: green 8s → amber 2s → red 10s, citywide synced.
    const cyc = time % 20;
    const state: 'g' | 'a' | 'r' = cyc < 8 ? 'g' : cyc < 10 ? 'a' : 'r';
    for (const lamp of ['r', 'a', 'g'] as const) {
      lampMats[lamp].emissiveIntensity = lamp === state ? 2.1 + night * 1.6 : 0.05;
    }
    // Billboards: brighten at night; one board flickers like a dying tube.
    for (let i = 0; i < billboardMats.length; i++) {
      const flick = i % 5 === 3 ? (Math.sin(time * 11 + i) > -0.4 ? 1 : 0.25) : 1;
      billboardMats[i].emissiveIntensity = (0.16 + night * 1.75) * flick;
    }
    // Neon signs: breathe; rare stutter.
    for (let i = 0; i < neonMats.length; i++) {
      const sput = Math.sin(time * (2.2 + i * 0.37) + i * 5) > -0.92 ? 1 : 0.35;
      neonMats[i].opacity = (0.5 + night * 0.5) * sput;
    }
    // Aviation beacons blink.
    if (beaconMat) beaconMat.emissiveIntensity = 0.4 + 1.8 * (0.5 + 0.5 * Math.sin(time * 3.2));
  };

  const dispose = (): void => {
    scene.remove(group);
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const d of disposables) d.dispose();
  };

  return { update, dispose };
}

// ---------------------------------------------------------------- helpers

/** Distance from a face-plane coordinate to the nearest road EDGE (center ± ROAD_W/2). */
function faceRoadDist(v: number, roadCoords: number[]): number {
  let best = 1e9;
  for (const c of roadCoords) {
    const d = Math.abs(v - (c - ROAD_W / 2));
    if (d < best) best = d;
    const d2 = Math.abs(v - (c + ROAD_W / 2));
    if (d2 < best) best = d2;
  }
  return best;
}

/** City edge for props (roads span ±GRID_HALF*BLOCK). */
const CITY_EDGE = GRID_HALF * BLOCK;
