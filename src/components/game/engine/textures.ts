/**
 * Project Hyperion — procedural texture factory (Task 2-a).
 * Every texture is generated at runtime on a <canvas>: no external assets, no
 * network requests, no top-level DOM access (canvases are created per call).
 * Facade tile = 3m x 3m with RepeatWrapping on both axes; all colors are sRGB;
 * pixel-art tiles use NearestFilter; randomness comes from mulberry32 (seeded).
 */
import * as THREE from 'three';

type RNG = () => number;

/** Deterministic seeded RNG (mulberry32). */
function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d');
  if (!g) throw new Error('Hyperion textures: 2D context unavailable');
  return g;
}

/** Solid pixel rect. */
function px(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  g.fillStyle = color; g.fillRect(x, y, w, h);
}

/** Wrap a canvas into an sRGB texture (repeat wrapping on both axes by default). */
function toTexture(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  return t;
}

/** Scatter `count` random 1..max-px speckles from a color pool. */
function speckle(g: CanvasRenderingContext2D, rnd: RNG, w: number, h: number, count: number, colors: string[], max = 2): void {
  for (let i = 0; i < count; i++) {
    px(g, (rnd() * w) | 0, (rnd() * h) | 0, 1 + ((rnd() * max) | 0), 1 + ((rnd() * max) | 0), colors[(rnd() * colors.length) | 0]);
  }
}

/** Vertical gradient rect. */
function vGrad(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, top: string, bottom: string): void {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, top);
  gr.addColorStop(1, bottom);
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}

/** Warm lit-window pane (#ffd27f family) painted onto an emissive map. */
function litPane(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number): void {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, `rgba(255,210,127,${alpha})`);
  gr.addColorStop(1, `rgba(255,178,90,${alpha * 0.7})`);
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}

/** Ellipse blob drawn with wrapped copies so tiles stay seamless. */
function wrapBlob(g: CanvasRenderingContext2D, size: number, x: number, y: number, r: number, color: string): void {
  g.fillStyle = color;
  for (let ox = -size; ox <= size; ox += size)
    for (let oy = -size; oy <= size; oy += size) {
      if (x + ox + r < 0 || x + ox - r > size || y + oy + r < 0 || y + oy - r > size) continue;
      g.beginPath(); g.ellipse(x + ox, y + oy, r, r * 0.65, 0, 0, Math.PI * 2); g.fill();
    }
}

/** Stroke a precomputed polyline with wrapped copies (seamless cracks/roots). */
function wrapStroke(g: CanvasRenderingContext2D, size: number, pts: Array<[number, number]>, color: string, width: number): void {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  for (let ox = -size; ox <= size; ox += size)
    for (let oy = -size; oy <= size; oy += size) {
      g.beginPath(); g.moveTo(pts[0][0] + ox, pts[0][1] + oy);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] + ox, pts[i][1] + oy);
      g.stroke();
    }
}

/** Filled pixel disc (for 32px pixel-art tiles). */
function disc(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy)); px(g, cx - w, cy + dy, w * 2 + 1, 1, color);
  }
}

/** Nearest-filtered sRGB texture for 32px pixel-art tiles. */
function pixelTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = toTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}

/** Facade material pair: color map + emissive map of the lit windows. */
export interface FacadeStyle {
  map: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
}

/**
 * Procedural 3m x 3m facade tile (color map + emissive map).
 * The tile repeats over a whole building; `seed` varies the look per building.
 */
export function makeFacadeTexture(style: 'concrete' | 'glass' | 'brick' | 'white', seed: number): FacadeStyle {
  const S = 128;
  const rnd = mulberry32(seed);
  const c = makeCanvas(S, S), ec = makeCanvas(S, S);
  const g = ctx2d(c), eg = ctx2d(ec);
  px(eg, 0, 0, S, S, '#000000');
  const lit = (x: number, y: number, w: number, h: number, p: number): void => {
    if (rnd() < p) litPane(eg, x, y, w, h, 0.4 + rnd() * 0.55);
  };

  if (style === 'concrete') {
    vGrad(g, 0, 0, S, S, '#b9b1a3', '#a29a8c');
    speckle(g, rnd, S, S, 520, ['#c4bcae', '#aaa294', '#948c7e', '#beb6a8', '#a8a091']);
    px(g, 0, 0, S, 5, '#c9c2b4'); px(g, 0, 5, S, 2, '#8d8577'); // floor ledges (slab lines)
    px(g, 0, 121, S, 3, '#b5ada0'); px(g, 0, 124, S, 4, '#877f72');
    const wx = 36, wy = 26, ww = 56, wh = 74; // punched window
    px(g, wx - 3, wy - 3, ww + 6, wh + 6, '#7e776b');
    vGrad(g, wx, wy, ww, wh, '#7e8b98', '#242b32'); // glass with sky reflection
    g.globalAlpha = 0.09; px(g, wx + 6, wy + 4, 14, wh - 10, '#ffffff'); g.globalAlpha = 1;
    px(g, wx + ww / 2 - 1, wy, 2, wh, '#4d5a66'); // center mullion
    px(g, wx - 5, wy + wh, ww + 10, 4, '#cfc8ba'); px(g, wx - 5, wy + wh + 4, ww + 10, 2, '#877f72'); // sill
    lit(wx, wy, ww, wh, 0.35);
  } else if (style === 'glass') {
    px(g, 0, 0, S, S, '#20242a'); // charcoal mullion base
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        const x = 4 + i * 62, y = 4 + j * 62, w = 58, h = 58;
        vGrad(g, x, y, w, h, '#48596b', '#161a20'); // glossy pane
        g.globalAlpha = 0.14; px(g, x, y, w, 10, '#9fb4c8'); g.globalAlpha = 1; // sky sheen
        px(g, x, y, w, 1, '#0c0e11'); px(g, x, y, 1, h, '#5c7086');
        lit(x + 2, y + 2, w - 4, h - 4, 0.22);
      }
  } else if (style === 'brick') {
    px(g, 0, 0, S, S, '#6a564a'); // mortar
    const pal = ['#9a4a31', '#8b4229', '#a4523a', '#7f3c27', '#96503a', '#8f4630'];
    for (let row = 0; row < 16; row++) {
      const y = row * 8, off = (row % 2) * 8;
      for (let x = -16; x < S; x += 16)
        px(g, x + off + 1, y + 1, 14, 6, pal[(rnd() * pal.length) | 0]);
    }
    speckle(g, rnd, S, S, 260, ['#83402c', '#a5573e', '#6e564a']);
    const wx = 42, wy = 34, ww = 44, wh = 60; // smaller window, light frame
    px(g, wx - 3, wy - 3, ww + 6, wh + 6, '#d9d2c2');
    vGrad(g, wx, wy, ww, wh, '#6f7d8a', '#262f38');
    px(g, wx + ww / 2 - 1, wy, 2, wh, '#c9c2b2');
    px(g, wx - 5, wy + wh + 3, ww + 10, 4, '#d9d2c2'); // sill
    lit(wx, wy, ww, wh, 0.4);
  } else { // white
    vGrad(g, 0, 0, S, S, '#eeeee9', '#dededa');
    for (let x = 0; x < S; x += 32) px(g, x, 0, 1, S, '#cfcfca'); // panel seams
    px(g, 0, 118, S, 2, '#c6c6c1'); px(g, 0, 120, S, 8, '#d6d6d1');
    const bx = 8, by = 44, bw = 112, bh = 48; // wide window band
    px(g, bx - 2, by - 2, bw + 4, bh + 4, '#c9c9c4');
    vGrad(g, bx, by, bw, bh, '#57646e', '#20262c');
    g.globalAlpha = 0.12; px(g, bx, by, bw, 10, '#ffffff'); g.globalAlpha = 1;
    for (let x = bx + 16; x < bx + bw; x += 16) px(g, x - 1, by, 2, bh, '#b0b0ab');
    for (let x = bx; x < bx + bw; x += 16) lit(x + 2, by + 2, 12, bh - 4, 0.3);
  }
  return { map: toTexture(c), emissiveMap: toTexture(ec) };
}

/** Gravel/tar roof tile: dark gray noise, lighter worn patches, occasional vent. */
export function makeRoofTexture(): THREE.CanvasTexture {
  const S = 128;
  const rnd = mulberry32(0x5eed);
  const c = makeCanvas(S, S), g = ctx2d(c);
  px(g, 0, 0, S, S, '#3a3a3d');
  speckle(g, rnd, S, S, 2400, ['#434345', '#313134', '#2b2b2e', '#4a4a4c', '#37373a']);
  for (let i = 0; i < 7; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 8 + rnd() * 16, 'rgba(78,78,80,0.35)');
  for (let i = 0; i < 5; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 6 + rnd() * 12, 'rgba(32,32,34,0.4)');
  if (rnd() < 0.75) { // metal vent, kept away from tile edges
    const vx = 20 + ((rnd() * (S - 48)) | 0), vy = 20 + ((rnd() * (S - 48)) | 0);
    px(g, vx, vy, 12, 12, '#565659');
    px(g, vx + 1, vy + 1, 10, 5, '#6a6a6e'); px(g, vx, vy + 12, 12, 2, '#262628');
  }
  return toTexture(c);
}

/** Seamless dark asphalt tile (raw canvas; the city compositor drawImages it). */
export function makeAsphaltTile(): HTMLCanvasElement {
  const S = 256;
  const rnd = mulberry32(0xa5fa);
  const c = makeCanvas(S, S), g = ctx2d(c);
  px(g, 0, 0, S, S, '#3d3d40');
  speckle(g, rnd, S, S, 5200, ['#464649', '#37373a', '#4d4d50', '#404043', '#333336']);
  for (let i = 0; i < 6; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 14 + rnd() * 26, 'rgba(66,66,69,0.30)');
  for (let i = 0; i < 4; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 10 + rnd() * 18, 'rgba(40,40,43,0.35)');
  return c;
}

/** Light-gray concrete sidewalk slabs, darker seams every 64px (raw canvas). */
export function makeSidewalkTile(): HTMLCanvasElement {
  const S = 256;
  const rnd = mulberry32(0x5ab1);
  const c = makeCanvas(S, S), g = ctx2d(c);
  px(g, 0, 0, S, S, '#b7b5ae');
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      g.globalAlpha = 0.05 + rnd() * 0.05;
      px(g, i * 64, j * 64, 64, 64, rnd() < 0.5 ? '#ffffff' : '#6f6d66');
      g.globalAlpha = 1;
    }
  speckle(g, rnd, S, S, 2600, ['#c4c2bb', '#a9a7a0', '#bdbbb4', '#a19f98']);
  for (let k = 0; k < S; k += 64) { // seams at 0 cover both tiled edges
    px(g, k, 0, 2, S, '#8b897f'); px(g, 0, k, S, 2, '#8b897f');
  }
  return c;
}

/** Mid-green grass noise with darker/lighter patches (raw canvas). */
export function makeGrassTile(): HTMLCanvasElement {
  const S = 256;
  const rnd = mulberry32(0x6ea5);
  const c = makeCanvas(S, S), g = ctx2d(c);
  px(g, 0, 0, S, S, '#4e7a34');
  speckle(g, rnd, S, S, 5000, ['#578a3a', '#466e2e', '#619448', '#3f6329', '#528036', '#5d9a3f']);
  for (let i = 0; i < 8; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 16 + rnd() * 30, 'rgba(38,66,24,0.30)');
  for (let i = 0; i < 8; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 14 + rnd() * 26, 'rgba(96,142,58,0.28)');
  for (let i = 0; i < 500; i++) px(g, (rnd() * S) | 0, (rnd() * S) | 0, 1, 2, '#6ea84a'); // blades
  return c;
}

/** 256px seamless underground strata texture (dirt/stone/deepslate/bedrock). */
export function makeLayerTexture(kind: 'dirt' | 'stone' | 'deepslate' | 'bedrock', seed: number): THREE.CanvasTexture {
  const S = 256;
  const rnd = mulberry32(seed);
  const c = makeCanvas(S, S), g = ctx2d(c);
  const walk = (steps: number, span: number): Array<[number, number]> => { // random walk
    const pts: Array<[number, number]> = [[rnd() * S, rnd() * S]];
    for (let i = 0; i < steps; i++) {
      const [lx, ly] = pts[pts.length - 1];
      pts.push([lx + (rnd() - 0.5) * span, ly + (rnd() - 0.5) * span]);
    }
    return pts;
  };
  if (kind === 'dirt') {
    px(g, 0, 0, S, S, '#7b5b3b');
    speckle(g, rnd, S, S, 3200, ['#6b4c30', '#8a6a46', '#5e412a', '#84643f', '#77583a']);
    for (let i = 0; i < 34; i++) { // scattered small stones
      const x = rnd() * S, y = rnd() * S, r = 1.5 + rnd() * 2.5;
      wrapBlob(g, S, x, y, r + 1, 'rgba(40,28,16,0.5)');
      wrapBlob(g, S, x, y, r, rnd() < 0.5 ? '#8b8b82' : '#6f6f66');
    }
    for (let i = 0; i < 4; i++) // rare root lines
      wrapStroke(g, S, walk(6, 26), 'rgba(76,52,31,0.75)', 1.5);
  } else if (kind === 'stone') {
    px(g, 0, 0, S, S, '#7e7e80');
    speckle(g, rnd, S, S, 2600, ['#737375', '#89898b', '#68686a', '#939395']);
    for (let i = 0; i < 7; i++) // cracks
      wrapStroke(g, S, walk(7, 46), 'rgba(60,60,64,0.85)', 1 + rnd());
  } else if (kind === 'deepslate') {
    px(g, 0, 0, S, S, '#3b3e45');
    speckle(g, rnd, S, S, 3600, ['#34373d', '#43464e', '#2e3136', '#4b4f58']);
    for (let y = (rnd() * 12) | 0; y < S; y += 10 + ((rnd() * 12) | 0)) // strata
      for (let x = 0; x < S; x += 24 + ((rnd() * 20) | 0)) {
        px(g, x, y, 20 + ((rnd() * 16) | 0), 1, '#2b2e34');
        px(g, x + 2, y + 1, 16 + ((rnd() * 12) | 0), 1, '#4a4e57');
      }
  } else { // bedrock
    px(g, 0, 0, S, S, '#0c0c0e');
    const shades = ['#1a1a1d', '#111114', '#202024', '#0a0a0c', '#16161a'];
    for (let i = 0; i < 46; i++) { // chaotic near-black blocks, sharp gray edges
      const w = 14 + ((rnd() * 22) | 0), h = 12 + ((rnd() * 20) | 0);
      const x = (rnd() * (S - w)) | 0, y = (rnd() * (S - h)) | 0;
      px(g, x, y, w, h, shades[(rnd() * shades.length) | 0]);
      px(g, x, y, w, 1, '#4e4e54'); px(g, x, y, 1, h, '#4e4e54'); // sharp gray edges
      px(g, x, y + h - 1, w, 1, '#26262b'); px(g, x + w - 1, y, 1, h, '#26262b');
    }
    speckle(g, rnd, S, S, 700, ['#1c1c20', '#000000', '#2a2a30', '#050506']);
  }
  return toTexture(c);
}

/** 32px Minecraft-inspired pixel block tile, Nearest-filtered for crispness. */
export type BlockTextureKind =
  | 'dirt'
  | 'cobblestone'
  | 'planks'
  | 'grass-top'
  | 'grass-side'
  | 'stone'
  | 'log-side'
  | 'log-top'
  | 'leaves'
  | 'sand'
  | 'bricks';

/** Distinct seed per block kind (legacy kinds keep their original `0xb10c + len` seeds). */
const BLOCK_SEEDS: Record<BlockTextureKind, number> = {
  dirt: 0xb10c + 4,
  cobblestone: 0xb10c + 11,
  planks: 0xb10c + 6,
  'grass-top': 0xb10c + 10,
  'grass-side': 0x6ea5,
  stone: 0x57e5,
  'log-side': 0x1063,
  'log-top': 0x7a12,
  leaves: 0x1eaf,
  sand: 0x5abd,
  bricks: 0x8b21,
};

export function makeBlockTexture(kind: BlockTextureKind): THREE.CanvasTexture {
  const S = 32;
  const rnd = mulberry32(BLOCK_SEEDS[kind]);
  const c = makeCanvas(S, S), g = ctx2d(c);
  const pixelNoise = (colors: string[]): void => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(g, x, y, 1, 1, colors[(rnd() * colors.length) | 0]);
  };
  if (kind === 'dirt') {
    pixelNoise(['#79553a', '#6b4a32', '#8a6244', '#5f4128', '#7d5b3e', '#734f35']);
  } else if (kind === 'cobblestone') {
    px(g, 0, 0, S, S, '#3f3f3f'); // mortar
    const stones = ['#9a9a9a', '#8a8a8a', '#a4a4a4', '#7d7d7d', '#909090'];
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const x = i * 8, y = j * 8;
        px(g, x, y, 7, 7, stones[(rnd() * stones.length) | 0]);
        px(g, x, y, 7, 1, '#b0b0b0'); // top highlight
        px(g, x, y + 5, 7, 2, '#5c5c5c'); px(g, x + 5, y, 2, 7, '#666666'); // shadows
      }
    for (let i = 0; i < 8; i++) px(g, (rnd() * 31) | 0, (rnd() * 31) | 0, 2, 2, '#7a7a7a');
  } else if (kind === 'planks') {
    const bases = ['#a9844f', '#9e7a48', '#b08b55', '#9a7645'];
    for (let j = 0; j < 4; j++) {
      px(g, 0, j * 8, S, 8, bases[j]);
      for (let i = 0; i < 6; i++) // grain streaks
        px(g, (rnd() * 26) | 0, j * 8 + ((rnd() * 7) | 0), 3 + ((rnd() * 5) | 0), 1, '#8a6a3c');
      const joint = 4 + ((rnd() * 24) | 0);
      px(g, joint, j * 8, 1, 7, '#5c4526'); // vertical joint
      px(g, joint - 2, j * 8 + 2, 1, 1, '#4a3316'); px(g, joint + 2, j * 8 + 4, 1, 1, '#4a3316'); // nails
      px(g, 0, j * 8 + 7, S, 1, '#5c4526'); // horizontal seam
    }
  } else if (kind === 'grass-top') {
    pixelNoise(['#5d9c3f', '#548f38', '#67a847', '#4c8531', '#5f9c41', '#4a7f30']);
  } else if (kind === 'grass-side') {
    pixelNoise(['#79553a', '#6b4a32', '#8a6244', '#5f4128', '#7d5b3e', '#734f35']); // dirt base
    const greens = ['#5d9c3f', '#548f38', '#67a847', '#4c8531', '#5f9c41', '#4a7f30'];
    for (let x = 0; x < S; x++) { // grass strip, jagged bottom edge dipping 2-4px
      const depth = 8 + ((rnd() * 4) | 0);
      for (let y = 0; y < depth; y++) px(g, x, y, 1, 1, greens[(rnd() * greens.length) | 0]);
      px(g, x, depth, 1, 1, '#3f6e28'); // dark fringe under the strip
    }
  } else if (kind === 'stone') {
    pixelNoise(['#7e7e7e', '#828282', '#747474', '#8a8a8a', '#767676']);
  } else if (kind === 'log-side') {
    const bark = ['#6b5233', '#5a4429', '#74593a', '#4e3a20'];
    for (let x = 0; x < S; x++) { // per-column bark base with vertical streak breaks
      const col = bark[(rnd() * bark.length) | 0];
      for (let y = 0; y < S; y++) px(g, x, y, 1, 1, rnd() < 0.82 ? col : bark[(rnd() * bark.length) | 0]);
    }
  } else if (kind === 'log-top') {
    px(g, 0, 0, S, S, '#6b5233'); // outer bark ring
    speckle(g, rnd, S, S, 90, ['#5a4429', '#74593a', '#4e3a20']); // bark grain
    disc(g, 16, 16, 13, '#a8834f'); // inner wood with darker concentric rings
    disc(g, 16, 16, 10, '#8a6a3c');
    disc(g, 16, 16, 8, '#a8834f');
    disc(g, 16, 16, 5, '#8a6a3c');
    disc(g, 16, 16, 3, '#a8834f');
    disc(g, 16, 16, 1, '#6b5233'); // center knot
  } else if (kind === 'leaves') {
    pixelNoise(['#2e6b1e', '#3f7d2c', '#356e26', '#4c9138', '#2a5e1c']);
    for (let i = 0; i < 14; i++) px(g, (rnd() * S) | 0, (rnd() * S) | 0, 1, 1, '#1e4a12'); // deep shadow holes
  } else if (kind === 'sand') {
    pixelNoise(['#dbd3a0', '#e6dfae', '#d1c78f', '#e0d8a6']);
  } else { // bricks — 4 rows of 8px, mortar lines, half-brick (8px) row offset
    px(g, 0, 0, S, S, '#a8a8a8'); // mortar
    const brick = ['#96513d', '#8e4a37', '#a05a44'];
    for (let row = 0; row < 4; row++) {
      const y = row * 8, off = (row % 2) * 8;
      for (let x = -16 + off; x < S; x += 16)
        px(g, x, y, 15, 7, brick[(rnd() * brick.length) | 0]);
    }
    speckle(g, rnd, S, S, 110, ['#8e4a37', '#a05a44', '#7e4231']);
  }
  return pixelTexture(c);
}

/** Classic Minecraft TNT: side (banded + TNT letters), top, bottom. */
export function makeTNTTextures(): { side: THREE.CanvasTexture; top: THREE.CanvasTexture; bottom: THREE.CanvasTexture } {
  const S = 32;
  const RED = '#c93b2c', RED_D = '#a92e22', BAND = '#e6e0d2';
  const mk = (draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture => {
    const c = makeCanvas(S, S);
    draw(ctx2d(c));
    return pixelTexture(c);
  };
  const side = mk((g) => {
    px(g, 0, 0, S, S, RED);
    speckle(g, mulberry32(0x77), S, S, 40, [RED_D]);
    px(g, 0, 10, S, 12, BAND);
    const glyphs = [
      ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'], // T
      ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'], // N
      ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'], // T
    ];
    for (let li = 0; li < 3; li++)
      for (let ry = 0; ry < 7; ry++)
        for (let rx = 0; rx < 5; rx++)
          if (glyphs[li][ry][rx] === '#') px(g, 6 + li * 7 + rx, 12 + ry, 1, 1, RED);
  });
  const top = mk((g) => { // red border, gray-white concentric circle pattern
    px(g, 0, 0, S, S, RED);
    disc(g, 16, 16, 10, '#d8d5cb'); disc(g, 16, 16, 7, '#8f8c84');
    disc(g, 16, 16, 4, '#d8d5cb'); disc(g, 16, 16, 2, '#6e6b64');
  });
  const bottom = mk((g) => { // red with dark center
    px(g, 0, 0, S, S, RED);
    disc(g, 16, 16, 9, '#541711'); disc(g, 16, 16, 5, '#3a0f0b');
  });
  return { side, top, bottom };
}

/** 128x64 palm frond on transparency: stem + angled leaflets (alpha-tested planes). */
export function makeFrondTexture(): THREE.CanvasTexture {
  const rnd = mulberry32(0xf20d);
  const c = makeCanvas(128, 64), g = ctx2d(c);
  const greens = ['#2e7d32', '#3d8b3d', '#4c9a44', '#66bb6a', '#35843a'];
  g.strokeStyle = '#3e6b2f';
  g.lineWidth = 3; g.lineCap = 'round';
  g.beginPath(); // central stem, slight arc
  g.moveTo(3, 33);
  g.quadraticCurveTo(64, 27, 125, 31);
  g.stroke();
  const stemY = (t: number): number => (1 - t) * (1 - t) * 33 + 2 * (1 - t) * t * 27 + t * t * 31;
  for (let i = 0; i < 15; i++) { // leaflet pairs, shrinking toward the tip
    const t = 0.05 + (i / 14) * 0.9;
    const x = 3 + t * 122, y = stemY(t), len = 26 * (1 - t * 0.8) + 4;
    for (const dir of [-1, 1]) {
      g.strokeStyle = greens[(rnd() * greens.length) | 0];
      g.lineWidth = 2.4;
      g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo(x + len * 0.18, y + dir * len * 0.55, x + len * 0.62, y + dir * len * 0.92);
      g.stroke();
    }
  }
  g.beginPath(); g.moveTo(124, 31); g.quadraticCurveTo(128, 32, 126, 36); g.stroke(); // tip leaflet
  return toTexture(c, false);
}

/** 64x128 palm trunk: brown bark, horizontal ring segments, fiber noise. */
export function makeTrunkTexture(): THREE.CanvasTexture {
  const W = 64, H = 128;
  const rnd = mulberry32(0x7babe);
  const c = makeCanvas(W, H), g = ctx2d(c);
  px(g, 0, 0, W, H, '#8a6a4a');
  for (let y = 4; y < H - 4; y += 9 + ((rnd() * 8) | 0)) {
    const h = 2 + ((rnd() * 2) | 0);
    for (let x = 0; x < W; x += 8) // wavy ring segments
      px(g, x, y + ((rnd() * 2) | 0), 8, h, '#5f4630');
    px(g, 0, y + h, W, 1, 'rgba(255,232,196,0.16)');
  }
  for (let i = 0; i < 110; i++) { // vertical fiber streaks
    g.fillStyle = rnd() < 0.5 ? 'rgba(58,42,26,0.22)' : 'rgba(214,182,140,0.18)';
    g.fillRect((rnd() * W) | 0, (rnd() * H) | 0, 1, 3 + ((rnd() * 16) | 0));
  }
  speckle(g, rnd, W, H, 500, ['#7d5d3f', '#94744f', '#6e5236']);
  return toTexture(c);
}

/** 256x256 soft white cloud blob on transparency (for cloud sprites). */
export function makeCloudTexture(): THREE.CanvasTexture {
  const rnd = mulberry32(0xc10d);
  const c = makeCanvas(256, 256), g = ctx2d(c);
  const puff = (x: number, y: number, r: number, a: number): void => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`);
    gr.addColorStop(0.65, `rgba(255,255,255,${a * 0.5})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  puff(128, 132, 86, 0.9);
  for (let i = 0; i < 7; i++) puff(60 + rnd() * 136, 90 + rnd() * 70, 30 + rnd() * 42, 0.55 + rnd() * 0.3);
  return toTexture(c, false);
}

/** 128x128 warm sun glow: white core into orange halo on transparency. */
export function makeSunSprite(): THREE.CanvasTexture {
  const c = makeCanvas(128, 128), g = ctx2d(c);
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,250,1)');
  gr.addColorStop(0.18, 'rgba(255,243,196,0.95)');
  gr.addColorStop(0.45, 'rgba(255,198,102,0.55)');
  gr.addColorStop(0.75, 'rgba(255,152,56,0.18)');
  gr.addColorStop(1, 'rgba(255,140,48,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return toTexture(c, false);
}

/** Classic "Steve" skin palette. */
const STEVE = {
  skin: '#b5876c', skinD: '#9c6e54', hair: '#3b2a1c', hairL: '#4d3826',
  eyeW: '#ffffff', eyeP: '#523d89', nose: '#8f6448', mouth: '#6b4226',
  shirt: '#00a8a8', shirtD: '#008f8f', denim: '#3f4aa4', denimD: '#353f8c', shoe: '#6b6b6b',
};

/** Classic "Steve" pixel-skin canvases at native resolution (materials made elsewhere). */
export function makeSteveTextures(): {
  headFront: HTMLCanvasElement; headSide: HTMLCanvasElement; headTop: HTMLCanvasElement;
  body: HTMLCanvasElement; arm: HTMLCanvasElement; leg: HTMLCanvasElement;
} {
  const { skin, skinD, hair, hairL, eyeW, eyeP, nose, mouth, shirt, shirtD, denim, denimD, shoe } = STEVE;
  // head front 8x8: hair fringe + sideburns, eyes, nose, 3px mouth
  const headFront = makeCanvas(8, 8), gf = ctx2d(headFront);
  px(gf, 0, 0, 8, 8, skin);
  px(gf, 0, 0, 8, 2, hair); px(gf, 2, 1, 3, 1, hairL); // hair top 2 rows + fringe
  px(gf, 0, 2, 1, 3, hair); px(gf, 7, 2, 1, 3, hair);  // sideburns
  px(gf, 1, 4, 1, 1, eyeW); px(gf, 2, 4, 1, 1, eyeP);  // eyes: white outer, violet pupil inner
  px(gf, 5, 4, 1, 1, eyeP); px(gf, 6, 4, 1, 1, eyeW);
  px(gf, 3, 5, 2, 1, nose);
  px(gf, 2, 6, 3, 1, mouth);
  // head side 8x8: skin with hair top rows
  const headSide = makeCanvas(8, 8), gs = ctx2d(headSide);
  px(gs, 0, 0, 8, 8, skin);
  px(gs, 0, 0, 8, 2, hair); px(gs, 0, 2, 2, 1, hair); px(gs, 0, 3, 1, 2, hair);
  px(gs, 7, 2, 1, 6, skinD); // back-of-head shading
  // head top 8x8: all hair
  const headTop = makeCanvas(8, 8), gt = ctx2d(headTop);
  px(gt, 0, 0, 8, 8, hair);
  const rnd = mulberry32(0x57ea);
  for (let i = 0; i < 7; i++) px(gt, (rnd() * 8) | 0, (rnd() * 8) | 0, 1, 1, hairL);
  // body 8x12: teal shirt with subtle shading
  const body = makeCanvas(8, 12), gb = ctx2d(body);
  px(gb, 0, 0, 8, 12, shirt);
  px(gb, 7, 0, 1, 12, shirtD); px(gb, 0, 11, 8, 1, shirtD);
  px(gb, 2, 1, 1, 1, shirtD); px(gb, 5, 4, 1, 1, shirtD); px(gb, 3, 8, 1, 1, shirtD);
  // arm 4x12: plain skin with 1px darker shading column
  const arm = makeCanvas(4, 12), ga = ctx2d(arm);
  px(ga, 0, 0, 4, 12, skin);
  px(ga, 3, 0, 1, 12, skinD);
  // leg 4x12: indigo denim with gray shoe
  const leg = makeCanvas(4, 12), gl = ctx2d(leg);
  px(gl, 0, 0, 4, 12, denim);
  px(gl, 3, 0, 1, 10, denimD); px(gl, 0, 10, 4, 2, shoe); // gray shoe bottom 2 rows
  return { headFront, headSide, headTop, body, arm, leg };
}
