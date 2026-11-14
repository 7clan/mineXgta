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

/** Warm lit-window pane (#ffd27f family, or an override color) painted onto an emissive map. */
function litPane(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number, color?: [string, string]): void {
  const [top, bottom] = color ?? ['255,210,127', '255,178,90'];
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, `rgba(${top},${alpha})`);
  gr.addColorStop(1, `rgba(${bottom},${alpha * 0.7})`);
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}

/** Convert a grayscale height canvas into a tangent-space normal map texture.
 *  Wraps at the edges so tiles stay seamless. `strength` scales the bump slope. */
function heightToNormal(c: HTMLCanvasElement, strength: number): THREE.CanvasTexture {
  const w = c.width, h = c.height;
  const src = ctx2d(c).getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h);
  const og = ctx2d(out);
  const img = og.createImageData(w, h);
  const lum = (i: number) => (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xl = lum(y * w + ((x - 1 + w) % w));
      const xr = lum(y * w + ((x + 1) % w));
      const yu = lum(((y - 1 + h) % h) * w + x);
      const yd = lum(((y + 1) % h) * w + x);
      const dx = (xl - xr) * strength;
      const dy = (yu - yd) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      img.data[i * 4] = (dx * inv * 0.5 + 0.5) * 255;
      img.data[i * 4 + 1] = (dy * inv * 0.5 + 0.5) * 255;
      img.data[i * 4 + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[i * 4 + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Noise-speckle a grayscale height canvas around a base level. */
function heightNoise(g: CanvasRenderingContext2D, rnd: RNG, w: number, h: number, count: number, levels: string[]): void {
  speckle(g, rnd, w, h, count, levels, 2);
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

/** Facade material set: color map (AO baked in), normal map, emissive map of lit windows. */
export interface FacadeStyle {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
}

/** Height levels used by the facade normal maps (grayscale strings). */
const H_WALL = '#808080', H_RAISE = '#a6a6a6', H_RECESS = '#4a4a4a', H_GLASS = '#303030', H_DEEP = '#242424';

/** Baked AO: soft dark gradient inside a window reveal / under a slab. */
function aoShadow(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number): void {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, `rgba(0,0,0,${alpha})`);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}

/**
 * Procedural 3m x 3m facade tile (256px): color map with baked AO, normal map
 * from a height canvas (recessed windows, proud slabs/sills — pops under raking
 * golden-hour light), and an emissive map of lit windows. The tile repeats over
 * a whole building; `seed` varies the look per building. The five styles are the
 * Los Santos material set: beige downtown concrete, teal LA glass, muted brown
 * brick, warm-white modern panels and tan low-rise stucco.
 */
export function makeFacadeTexture(style: 'concrete' | 'glass' | 'brick' | 'white' | 'stucco', seed: number): FacadeStyle {
  const S = 256;
  const rnd = mulberry32(seed);
  const c = makeCanvas(S, S), ec = makeCanvas(S, S), hc = makeCanvas(S, S);
  const g = ctx2d(c), eg = ctx2d(ec), hg = ctx2d(hc);
  px(eg, 0, 0, S, S, '#000000');
  px(hg, 0, 0, S, S, H_WALL);
  const lit = (x: number, y: number, w: number, h: number, p: number): void => {
    if (rnd() < p) {
      if (rnd() < 0.18) litPane(eg, x, y, w, h, 0.3 + rnd() * 0.3, ['207,226,255', '170,196,236']); // cool office light
      else litPane(eg, x, y, w, h, 0.4 + rnd() * 0.55);
    }
  };
  // Sky-reflection glass with a diagonal sheen streak.
  const glassPane = (x: number, y: number, w: number, h: number, tint: string): void => {
    vGrad(g, x, y, w, h, tint, '#1a2026');
    g.globalAlpha = 0.10;
    g.fillStyle = '#bcd3e8';
    g.beginPath();
    g.moveTo(x + w * 0.12, y); g.lineTo(x + w * 0.38, y); g.lineTo(x + w * 0.62, y + h); g.lineTo(x + w * 0.36, y + h);
    g.closePath(); g.fill();
    g.globalAlpha = 1;
    px(hg, x, y, w, h, H_GLASS);
  };

  if (style === 'concrete') {
    vGrad(g, 0, 0, S, S, '#b8ac96', '#a89c86'); // sun-baked beige concrete
    speckle(g, rnd, S, S, 1500, ['#c2b6a0', '#9e927c', '#928672', '#bab19b', '#a4988f']);
    // Floor slab band (proud) + shadow gap (recessed) at the tile top.
    px(g, 0, 0, S, 8, '#cbc4b6'); px(g, 0, 8, S, 6, '#8b8375');
    px(hg, 0, 0, S, 8, H_RAISE); px(hg, 0, 8, S, 6, H_RECESS);
    aoShadow(g, 0, 8, S, 26, 0.16);
    const wx = 72, wy = 56, ww = 112, wh = 132; // punched window with deep reveal
    px(g, wx - 10, wy - 10, ww + 20, wh + 20, '#787165'); // reveal wall
    px(hg, wx - 10, wy - 10, ww + 20, wh + 20, H_RECESS);
    glassPane(wx, wy, ww, wh, '#5e6d7d');
    // Baked AO inside the reveal + glass edge shading.
    aoShadow(g, wx, wy, ww, 22, 0.30); aoShadow(g, wx, wy + wh - 14, ww, 14, 0.18);
    g.globalAlpha = 0.08; px(g, wx - 4, wy + 4, 10, wh - 8, '#ffffff'); g.globalAlpha = 1;
    px(g, wx + ww / 2 - 2, wy, 4, wh, '#46525e'); // center mullion
    px(g, wx, wy + wh / 2 - 2, ww, 4, '#46525e');
    px(hg, wx + ww / 2 - 2, wy, 4, wh, '#606060');
    // Sill (proud) with its own cast shadow + LA water-stain streaks below.
    px(g, wx - 14, wy + wh + 10, ww + 28, 10, '#cfc4a8');
    px(g, wx - 14, wy + wh + 20, ww + 28, 5, '#877c68');
    px(hg, wx - 14, wy + wh + 10, ww + 28, 10, H_RAISE);
    aoShadow(g, wx - 10, wy + wh + 20, ww + 20, 16, 0.22);
    g.globalAlpha = 0.16;
    for (let sx = wx - 8; sx < wx + ww; sx += 34) px(g, sx, wy + wh + 35, 5, 42, '#6a5f4d');
    g.globalAlpha = 1;
    lit(wx + 4, wy + 4, ww / 2 - 8, wh / 2 - 8, 0.4);
    lit(wx + ww / 2 + 4, wy + 4, ww / 2 - 8, wh / 2 - 8, 0.3);
    lit(wx + 4, wy + wh / 2 + 4, ww / 2 - 8, wh / 2 - 8, 0.35);
    lit(wx + ww / 2 + 4, wy + wh / 2 + 4, ww / 2 - 8, wh / 2 - 8, 0.4);
  } else if (style === 'glass') {
    px(g, 0, 0, S, S, '#232830'); // anodized mullion base
    px(hg, 0, 0, S, S, H_RAISE);
    const panes: Array<[number, number]> = [[8, 8], [136, 8], [8, 136], [136, 136]];
    // LA glass: teal-green reflective tints under the smog sky.
    const tints = ['#3f5a62', '#47626a', '#527079', '#3c565e'];
    panes.forEach(([x, y], i) => {
      const w = 112, h = 112;
      glassPane(x, y, w, h, tints[(rnd() * tints.length) | 0] ?? tints[i % tints.length]);
      // warm smog-sky sheen band across the top of each pane (LA haze reflection)
      g.globalAlpha = 0.16; px(g, x, y, w, 26, '#d8b088'); g.globalAlpha = 1;
      // thin transom line
      px(g, x, y + h * 0.42, w, 3, '#2c3238');
      px(hg, x, y + h * 0.42, w, 3, '#6a6a6a');
      // per-pane edge highlight (left/top lighter, right/bottom darker)
      px(g, x, y, w, 2, '#0c0e11'); px(g, x, y, 2, h, '#5c7886');
      lit(x + 5, y + 5, w - 10, h * 0.42 - 10, 0.2);
      lit(x + 5, y + h * 0.42 + 6, w - 10, h * 0.58 - 12, 0.24);
    });
    // corner bolt dots on mullion crossings
    for (const [mx, my] of [[0, 0], [128, 0], [0, 128], [128, 128]] as Array<[number, number]>) {
      px(g, mx + 2, my + 2, 3, 3, '#3a4148');
    }
  } else if (style === 'brick') {
    px(g, 0, 0, S, S, '#6e5a4c'); // mortar
    px(hg, 0, 0, S, S, H_RECESS);
    const pal = ['#8a4a36', '#7a422e', '#94543c', '#6e3a2a', '#8f503a', '#834630'];
    for (let row = 0; row < 16; row++) {
      const y = row * 16, off = (row % 2) * 16;
      for (let x = -32; x < S; x += 32) {
        const col = pal[(rnd() * pal.length) | 0];
        px(g, x + off + 2, y + 2, 28, 12, col);
        px(g, x + off + 2, y + 2, 28, 2, 'rgba(255,255,255,0.07)'); // top-of-brick light
        px(g, x + off + 2, y + 11, 28, 3, 'rgba(0,0,0,0.18)'); // bottom shadow
        px(hg, x + off + 2, y + 2, 28, 12, rnd() < 0.5 ? '#8c8c8c' : '#828282');
      }
    }
    speckle(g, rnd, S, S, 700, ['#83402c', '#a5573e', '#6e564a']);
    const wx = 84, wy = 68, ww = 88, wh = 120; // smaller window, light stone frame
    px(g, wx - 8, wy - 8, ww + 16, wh + 16, '#d5cebe'); // stone surround
    px(hg, wx - 8, wy - 8, ww + 16, wh + 16, H_RAISE);
    // lintel keystones
    px(g, wx - 12, wy - 16, ww + 24, 10, '#c7c0b0');
    px(hg, wx - 12, wy - 16, ww + 24, 10, H_RAISE);
    glassPane(wx, wy, ww, wh, '#5d6c78');
    aoShadow(g, wx, wy, ww, 18, 0.28);
    px(g, wx + ww / 2 - 2, wy, 4, wh, '#b8b1a1');
    px(hg, wx + ww / 2 - 2, wy, 4, wh, '#606060');
    px(g, wx - 12, wy + wh + 8, ww + 24, 9, '#d5cebe'); // stone sill
    px(hg, wx - 12, wy + wh + 8, ww + 24, 9, H_RAISE);
    aoShadow(g, wx - 8, wy + wh + 17, ww + 16, 14, 0.2);
    lit(wx + 4, wy + 4, ww / 2 - 8, wh - 8, 0.42);
    lit(wx + ww / 2 + 4, wy + 4, ww / 2 - 8, wh - 8, 0.38);
  } else if (style === 'white') { // warm stucco modern panel with a shaded window band + louver row
    vGrad(g, 0, 0, S, S, '#ece5d2', '#dcd4c0');
    for (let x = 0; x < S; x += 64) px(g, x, 0, 2, S, '#cfc7b2'); // panel seams
    for (let y = 0; y < S; y += 128) px(g, 0, y, S, 2, '#d4ccb8');
    px(hg, 0, 0, S, S, H_WALL);
    for (let x = 0; x < S; x += 64) px(hg, x, 0, 2, S, H_RECESS);
    // Louver row (sun shades) above the window band
    for (let x = 12; x < S - 12; x += 22) {
      px(g, x, 66, 18, 7, '#dcdcd7'); px(g, x, 73, 18, 3, '#9d9d98');
      px(hg, x, 66, 18, 7, H_RAISE); px(hg, x, 73, 18, 3, H_RECESS);
    }
    aoShadow(g, 12, 80, S - 24, 14, 0.22);
    // Window band, recessed behind the frame
    const bx = 16, by = 92, bw = S - 32, bh = 96;
    px(g, bx - 6, by - 6, bw + 12, bh + 12, '#c6c6c1');
    px(hg, bx - 6, by - 6, bw + 12, bh + 12, H_RECESS);
    glassPane(bx, by, bw, bh, '#4a5862');
    aoShadow(g, bx, by, bw, 16, 0.26);
    for (let x = bx + 22; x < bx + bw; x += 22) {
      px(g, x - 1, by, 3, bh, '#b0b0ab');
      px(hg, x - 1, by, 3, bh, '#686868');
    }
    for (let x = bx; x < bx + bw; x += 22) lit(x + 3, by + 3, 15, bh - 6, 0.3);
    // Base shadow gradient for depth
    aoShadow(g, 0, S - 20, S, 20, 0.1);
  } else { // stucco — tan LA strip-mall wall: parapet cap, AC + downspout,
    // punched windows with pop-out frames, a painted sign band remnant.
    vGrad(g, 0, 0, S, S, '#c2a078', '#b89768');
    speckle(g, rnd, S, S, 1800, ['#ccab82', '#b5926a', '#d4b48c', '#ad8c66', '#c4a274']);
    // Parapet cap (proud) + gravel-stop edge + grime shadow
    px(g, 0, 0, S, 10, '#d4ba90'); px(g, 0, 10, S, 5, '#9c8054');
    px(hg, 0, 0, S, 10, H_RAISE); px(hg, 0, 10, S, 5, H_RECESS);
    aoShadow(g, 0, 15, S, 18, 0.14);
    // Faded painted sign band remnant (ghost sign)
    g.globalAlpha = 0.20; px(g, 12, 26, S - 24, 20, '#e8d9b4'); g.globalAlpha = 1;
    for (let i = 0; i < 4; i++) px(g, 22 + i * 52, 32, 12 + ((rnd() * 26) | 0), 9, 'rgba(120,96,60,0.5)');
    // Two punched windows with pop-out stucco frames
    for (const wx0 of [36, 148] as Array<number>) {
      const wy0 = 78, ww0 = 72, wh0 = 118;
      px(g, wx0 - 9, wy0 - 9, ww0 + 18, wh0 + 18, '#d4b48c'); // pop-out surround
      px(hg, wx0 - 9, wy0 - 9, ww0 + 18, wh0 + 18, H_RAISE);
      glassPane(wx0, wy0, ww0, wh0, '#5d6c78');
      aoShadow(g, wx0, wy0, ww0, 16, 0.26);
      px(g, wx0 + ww0 / 2 - 2, wy0, 4, wh0, '#46525e'); // mullion
      px(hg, wx0 + ww0 / 2 - 2, wy0, 4, wh0, '#606060');
      px(g, wx0 - 12, wy0 + wh0 + 10, ww0 + 24, 8, '#d4b48c'); // stucco sill
      px(hg, wx0 - 12, wy0 + wh0 + 10, ww0 + 24, 8, H_RAISE);
      aoShadow(g, wx0 - 9, wy0 + wh0 + 18, ww0 + 18, 12, 0.16);
      lit(wx0 + 4, wy0 + 4, ww0 / 2 - 8, wh0 / 2 - 8, 0.3);
      lit(wx0 + ww0 / 2 + 4, wy0 + wh0 / 2 + 4, ww0 / 2 - 8, wh0 / 2 - 8, 0.25);
    }
    // Wall-mounted AC unit + downspout (street furniture shadows)
    if (rnd() < 0.6) {
      const ax = 20 + ((rnd() * 30) | 0), ay = 116 + ((rnd() * 60) | 0);
      px(g, ax, ay, 26, 18, '#9a948a'); px(g, ax + 2, ay + 2, 22, 8, '#b0aaa0');
      px(hg, ax, ay, 26, 18, H_RAISE); aoShadow(g, ax, ay + 18, 26, 10, 0.22);
    }
    const dx = rnd() < 0.5 ? 4 : S - 9;
    px(g, dx, 15, 5, S - 20, '#a08858'); px(hg, dx, 15, 5, S - 20, H_RECESS);
    // Ground grime line
    aoShadow(g, 0, S - 26, S, 26, 0.2);
  }
  heightNoise(hg, rnd, S, S, 260, ['#767676', '#8a8a8a']);
  return { map: toTexture(c), normalMap: heightToNormal(hc, 2.1), emissiveMap: toTexture(ec) };
}

/** Gravel/tar roof tile: warm sun-bleached gray noise, worn patches, vents. */
export function makeRoofTexture(): THREE.CanvasTexture {
  const S = 128;
  const rnd = mulberry32(0x5eed);
  const c = makeCanvas(S, S), g = ctx2d(c);
  px(g, 0, 0, S, S, '#443f39');
  speckle(g, rnd, S, S, 2400, ['#4d4841', '#3a352f', '#332f29', '#524c45', '#3f3a34']);
  for (let i = 0; i < 7; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 8 + rnd() * 16, 'rgba(92,86,76,0.35)'); // sun-bleached
  for (let i = 0; i < 5; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 6 + rnd() * 12, 'rgba(38,34,29,0.4)'); // tar patches
  if (rnd() < 0.75) { // metal vent, kept away from tile edges
    const vx = 20 + ((rnd() * (S - 48)) | 0), vy = 20 + ((rnd() * (S - 48)) | 0);
    px(g, vx, vy, 12, 12, '#5c5750');
    px(g, vx + 1, vy + 1, 10, 5, '#6e6860'); px(g, vx, vy + 12, 12, 2, '#2b2824');
  }
  return toTexture(c);
}

/** Seamless LA asphalt tile: warm sun-bleached gray-brown base, aggregate
 *  speckle, faded worn wheel paths, dark tar-patch seams and oil stains —
 *  the patched, sun-baked LA street look (raw canvas; the city compositor
 *  drawImages it). */
export function makeAsphaltTile(): HTMLCanvasElement {
  const S = 256;
  const rnd = mulberry32(0xa5fa);
  const c = makeCanvas(S, S), g = ctx2d(c);
  px(g, 0, 0, S, S, '#565049');
  speckle(g, rnd, S, S, 5200, ['#5f5851', '#4d473f', '#665e54', '#514b44', '#464039']);
  for (let i = 0; i < 6; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 14 + rnd() * 26, 'rgba(112,104,92,0.26)'); // sun-faded
  for (let i = 0; i < 4; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 10 + rnd() * 18, 'rgba(43,38,33,0.32)');
  // Tar-patch repair seams (LA street patchwork) + oil stains.
  for (let i = 0; i < 4; i++) {
    const x0 = rnd() * S, y0 = rnd() * S;
    const pts: Array<[number, number]> = [];
    for (let k = 0; k < 5; k++) pts.push([x0 + (rnd() - 0.5) * 100, y0 + (rnd() - 0.5) * 100]);
    wrapStroke(g, S, pts, 'rgba(33,29,25,0.42)', 6 + rnd() * 8);
  }
  for (let i = 0; i < 3; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 6 + rnd() * 10, 'rgba(24,22,20,0.30)');
  return c;
}

/** Sun-bleached warm concrete sidewalk slabs: expansion joints every 64px,
 *  curb-grime edges, hairline cracks, gum specks (raw canvas). */
export function makeSidewalkTile(): HTMLCanvasElement {
  const S = 256;
  const rnd = mulberry32(0x5ab1);
  const c = makeCanvas(S, S), g = ctx2d(c);
  px(g, 0, 0, S, S, '#c5beb0');
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      g.globalAlpha = 0.05 + rnd() * 0.05;
      px(g, i * 64, j * 64, 64, 64, rnd() < 0.5 ? '#fdfaf0' : '#6f6a5e');
      g.globalAlpha = 1;
    }
  speckle(g, rnd, S, S, 2600, ['#cfc8ba', '#b3ac9e', '#c6bfb1', '#a9a294']);
  // Gum specks + hairline cracks
  for (let i = 0; i < 26; i++) px(g, (rnd() * S) | 0, (rnd() * S) | 0, 2, 2, rnd() < 0.5 ? '#8a8274' : '#736c5e');
  for (let i = 0; i < 3; i++) {
    const x0 = rnd() * S, y0 = rnd() * S;
    wrapStroke(g, S, [[x0, y0], [x0 + (rnd() - 0.5) * 70, y0 + (rnd() - 0.5) * 70], [x0 + (rnd() - 0.5) * 110, y0 + (rnd() - 0.5) * 110]], 'rgba(107,100,88,0.5)', 1.2);
  }
  for (let k = 0; k < S; k += 64) { // expansion joints at 0 cover both tiled edges
    px(g, k, 0, 2, S, '#8f887a'); px(g, 0, k, S, 2, '#8f887a');
  }
  return c;
}

/** Dry LA turf: olive-khaki base with dry yellow blades, sparse green
 *  patches and bald dirt spots — the sun-baked Los Angeles ground (raw canvas). */
export function makeGrassTile(): HTMLCanvasElement {
  const S = 256;
  const rnd = mulberry32(0x6ea5);
  const c = makeCanvas(S, S), g = ctx2d(c);
  px(g, 0, 0, S, S, '#7a7444');
  speckle(g, rnd, S, S, 5000, ['#847c4a', '#6e6838', '#8f8150', '#5f6634', '#7c7040', '#93864a']);
  for (let i = 0; i < 8; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 16 + rnd() * 30, 'rgba(96,88,44,0.30)'); // dry patches
  for (let i = 0; i < 5; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 14 + rnd() * 22, 'rgba(90,96,44,0.24)'); // greener spots
  for (let i = 0; i < 5; i++) wrapBlob(g, S, rnd() * S, rnd() * S, 10 + rnd() * 18, 'rgba(122,100,58,0.30)'); // bald dirt
  for (let i = 0; i < 420; i++) px(g, (rnd() * S) | 0, (rnd() * S) | 0, 1, 2, rnd() < 0.7 ? '#a89254' : '#6f7a3c'); // blades
  return c;
}

/** Storefront band module (3m wide x 4.2m tall): pilaster frame, fascia sign,
 *  striped awning, big display glass with warm interior, kick base, side door.
 *  Variant picks the paint + neon sign color. Returns map/normalMap/emissiveMap.
 */
export function makeStorefrontTexture(variant: 0 | 1 | 2): FacadeStyle {
  const W = 256, H = 384;
  const rnd = mulberry32(0x57ab + variant * 131);
  const c = makeCanvas(W, H), ec = makeCanvas(W, H), hc = makeCanvas(W, H);
  const g = ctx2d(c), eg = ctx2d(ec), hg = ctx2d(hc);
  px(eg, 0, 0, W, H, '#000000');
  px(hg, 0, 0, W, H, H_WALL);
  const THEMES = [
    // LA strip-mall retail: tan stucco + forest-green canvas awning, green neon.
    { paint: '#b89a76', trim: '#8a7355', neon: '190,255,110', awnA: '#4a5a40', awnB: '#e8e0cc' },
    // Terracotta stucco + charcoal canvas awning, pink neon.
    { paint: '#a35d44', trim: '#7a4a34', neon: '255,120,200', awnA: '#3a3430', awnB: '#e8e0cc' },
    // Gray stucco + oxide-red canvas awning, cyan neon.
    { paint: '#8f8a7a', trim: '#6a655a', neon: '72,229,255', awnA: '#7a2020', awnB: '#e8e0cc' },
  ][variant];
  const L = 26, R = W - 26; // pilaster inner edges

  // Pilasters (proud) with subtle vertical shading
  for (const x of [0, W - 26]) {
    vGrad(g, x, 0, 26, H, THEMES.paint, '#1c1a17');
    px(g, x + 2, 0, 4, H, 'rgba(255,255,255,0.10)');
    px(g, x + 20, 0, 6, H, 'rgba(0,0,0,0.25)');
    px(hg, x, 0, 26, H, H_RAISE);
  }
  // Fascia sign band (proud) with neon strip
  px(g, L, 8, R - L, 52, THEMES.paint);
  px(g, L, 8, R - L, 4, THEMES.trim);
  px(g, L, 52, R - L, 6, 'rgba(0,0,0,0.35)');
  px(hg, L, 8, R - L, 52, H_RAISE);
  // fake sign glyphs: light box + letter dashes
  px(eg, L + 14, 22, R - L - 28, 22, `rgba(${THEMES.neon},0.85)`);
  px(g, L + 14, 22, R - L - 28, 22, `rgba(${THEMES.neon},0.16)`);
  g.fillStyle = `rgba(${THEMES.neon},0.55)`;
  for (let i = 0; i < 5; i++) {
    const gw = 12 + ((rnd() * 20) | 0);
    g.fillRect(L + 24 + i * 38, 28, gw, 10);
  }
  // Canvas awning (solid colour + subtle weave stripe, scalloped valance).
  const awY = 62, awH = 34;
  for (let x = L; x < R; x += 24) {
    px(g, x, awY, 19, awH, THEMES.awnA);
    px(g, x + 19, awY, 5, awH, THEMES.awnB);
  }
  for (let x = L; x < R; x += 16) { // scallops
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.beginPath(); g.arc(x + 8, awY + awH, 8, 0, Math.PI); g.fill();
  }
  px(hg, L, awY, R - L, awH, '#c8c8c8');
  // AO under the awning onto the glass
  aoShadow(g, L, awY + awH, R - L, 30, 0.38);

  // Display glass (recessed) with warm interior + shelf hints
  const gy = awY + awH + 2, gh = 208;
  px(g, L + 2, gy, R - L - 4, gh, '#181d22');
  px(hg, L + 2, gy, R - L - 4, gh, H_GLASS);
  const inter = g.createLinearGradient(0, gy, 0, gy + gh);
  inter.addColorStop(0, '#3a3226');
  inter.addColorStop(0.5, '#574a33');
  inter.addColorStop(1, '#2c2619');
  g.globalAlpha = 0.75; g.fillStyle = inter; g.fillRect(L + 6, gy + 4, R - L - 12, gh - 8); g.globalAlpha = 1;
  for (let i = 1; i < 3; i++) px(g, L + 6, gy + (gh / 3) * i, R - L - 12, 3, 'rgba(0,0,0,0.4)'); // shelves
  // silhouettes in windows (mannequin blobs)
  for (let i = 0; i < 3; i++) {
    const mx = L + 24 + rnd() * (R - L - 60);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath(); g.arc(mx, gy + gh - 46, 7, 0, Math.PI * 2); g.fill();
    g.fillRect(mx - 9, gy + gh - 40, 18, 38);
  }
  // window frame + center divider
  px(g, L + 2, gy, R - L - 4, 5, '#3c3c40'); px(g, L + 2, gy + gh - 5, R - L - 4, 5, '#3c3c40');
  px(g, (L + R) / 2 - 2, gy, 4, gh, '#3c3c40');
  px(hg, (L + R) / 2 - 2, gy, 4, gh, '#5a5a5a');
  // warm interior glow on the emissive map
  litPane(eg, L + 8, gy + 8, (R - L) / 2 - 14, gh - 16, 0.5);
  litPane(eg, (L + R) / 2 + 6, gy + 8, (R - L) / 2 - 14, gh - 16, 0.42);

  // Door (right side, recessed w/ transom)
  const dx = R - 54, dy = gy + 14, dw = 44, dh = gh - 20;
  px(g, dx - 4, dy - 4, dw + 8, dh + 8, THEMES.trim);
  px(hg, dx - 4, dy - 4, dw + 8, dh + 8, H_RECESS);
  px(g, dx, dy, dw, 30, '#2c343c'); // transom glass
  px(hg, dx, dy, dw, 30, H_GLASS);
  px(g, dx, dy + 34, dw, dh - 34, '#4a5560'); // door leaf
  px(g, dx + 4, dy + 40, dw - 8, dh - 52, '#39434c');
  px(g, dx + dw - 10, dy + 90, 5, 12, THEMES.trim); // handle
  aoShadow(g, dx, dy + 30, dw, 12, 0.25);
  litPane(eg, dx + 3, dy + 3, dw - 6, 24, 0.35, ['255,224,160', '255,200,120']);

  // Kick base (proud, robust)
  px(g, L, gy + gh + 4, R - L, H - (gy + gh + 4), '#3a3630');
  px(g, L, gy + gh + 4, R - L, 6, '#4c463c');
  px(hg, L, gy + gh + 4, R - L, H - (gy + gh + 4), H_RAISE);
  heightNoise(hg, rnd, W, H, 220, ['#767676', '#8a8a8a']);
  return { map: toTexture(c), normalMap: heightToNormal(hc, 2.3), emissiveMap: toTexture(ec) };
}

/** Subtle seamless asphalt micro-bump normal map (wheel wear, patches). */
export function makeAsphaltNormal(): THREE.CanvasTexture {
  const S = 256;
  const rnd = mulberry32(0x3a57);
  const hc = makeCanvas(S, S), hg = ctx2d(hc);
  px(hg, 0, 0, S, S, '#808080');
  heightNoise(hg, rnd, S, S, 2600, ['#787878', '#888888', '#707070', '#909090'], );
  for (let i = 0; i < 5; i++) wrapBlob(hg, S, rnd() * S, rnd() * S, 18 + rnd() * 30, rnd() < 0.5 ? '#747474' : '#8a8a8a');
  return heightToNormal(hc, 1.15);
}

/** Sidewalk slab-seam normal map (matches the 256px 4x4 slab tile). */
export function makeSidewalkNormal(): THREE.CanvasTexture {
  const S = 256;
  const rnd = mulberry32(0x5ab2);
  const hc = makeCanvas(S, S), hg = ctx2d(hc);
  px(hg, 0, 0, S, S, '#828282');
  heightNoise(hg, rnd, S, S, 1600, ['#7c7c7c', '#888888']);
  for (let k = 0; k < S; k += 64) {
    px(hg, k, 0, 3, S, '#484848'); // recessed seams
    px(hg, 0, k, S, 3, '#484848');
    px(hg, k + 3, 0, 1, S, '#9a9a9a'); // seam lip highlight
    px(hg, 0, k + 3, S, 1, '#9a9a9a');
  }
  return heightToNormal(hc, 1.7);
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
