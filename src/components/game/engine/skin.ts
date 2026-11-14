/**
 * Project Hyperion — Minecraft-format character skin engine.
 *
 * Reverse-engineered from the public Minecraft skin layout (the universal
 * 64×64 / legacy 64×32 PNG format used by every launcher — including
 * TLauncher, whose skin service we proxy through /api/skin):
 *
 *   GET https://auth.tlauncher.org/skin/profile/texture/login/<NAME>
 *     -> { "SKIN": { "url": ".../skin_<NAME>.png", "metadata": { "model": "slim" } } }
 *
 * The PNG follows the standard layout below. "R" = the character's RIGHT side,
 * "L" = LEFT; each region is painted as seen from OUTSIDE that face.
 *
 * This module: layout tables (classic 4px arms + slim 3px arms), a loader that
 * rasterizes any 64×64 or legacy 64×32 skin into per-face canvases, an
 * ORIGINAL procedurally-painted default skin (no third-party pixels), the
 * TLauncher client fetch, and localStorage persistence of the user's choice.
 */

// ---------------------------------------------------------------- utilities

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d', { willReadFrequently: true })!;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tiny pixel helper: fill a rect on a 2d context. */
function px(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

// ---------------------------------------------------------------- layout

export interface FaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PartLayout {
  top: FaceRect;
  bottom: FaceRect;
  right: FaceRect; // character's right side of this part
  front: FaceRect;
  left: FaceRect;
  back: FaceRect;
}

export interface SkinLayout {
  head: PartLayout;
  hat: PartLayout;
  body: PartLayout;
  jacket: PartLayout;
  armR: PartLayout;
  sleeveR: PartLayout;
  armL: PartLayout;
  sleeveL: PartLayout;
  legR: PartLayout;
  pantsR: PartLayout;
  legL: PartLayout;
  pantsL: PartLayout;
}

/**
 * The standard 64×64 layout. classic = 4px-wide arms; slim ("Alex") = 3px
 * arms (the arm front/back faces shrink by 1px and everything after them on
 * the row shifts left 1px).
 */
export function skinLayout(model: 'classic' | 'slim'): SkinLayout {
  const aw = model === 'slim' ? 3 : 4; // arm width in px
  const part = (top: FaceRect, bottom: FaceRect, right: FaceRect, front: FaceRect, left: FaceRect, back: FaceRect): PartLayout => ({ top, bottom, right, front, left, back });

  const head = part({ x: 8, y: 0, w: 8, h: 8 }, { x: 16, y: 0, w: 8, h: 8 }, { x: 0, y: 8, w: 8, h: 8 }, { x: 8, y: 8, w: 8, h: 8 }, { x: 16, y: 8, w: 8, h: 8 }, { x: 24, y: 8, w: 8, h: 8 });
  const hat = part({ x: 40, y: 0, w: 8, h: 8 }, { x: 48, y: 0, w: 8, h: 8 }, { x: 32, y: 8, w: 8, h: 8 }, { x: 40, y: 8, w: 8, h: 8 }, { x: 48, y: 8, w: 8, h: 8 }, { x: 56, y: 8, w: 8, h: 8 });
  const body = part({ x: 20, y: 16, w: 8, h: 4 }, { x: 28, y: 16, w: 8, h: 4 }, { x: 16, y: 20, w: 4, h: 12 }, { x: 20, y: 20, w: 8, h: 12 }, { x: 28, y: 20, w: 4, h: 12 }, { x: 32, y: 20, w: 8, h: 12 });
  const jacket = part({ x: 20, y: 32, w: 8, h: 4 }, { x: 28, y: 32, w: 8, h: 4 }, { x: 16, y: 36, w: 4, h: 12 }, { x: 20, y: 36, w: 8, h: 12 }, { x: 28, y: 36, w: 4, h: 12 }, { x: 32, y: 36, w: 8, h: 12 });

  const armR = part({ x: 44, y: 16, w: aw, h: 4 }, { x: 44 + aw, y: 16, w: aw, h: 4 }, { x: 40, y: 20, w: 4, h: 12 }, { x: 44, y: 20, w: aw, h: 12 }, { x: 44 + aw, y: 20, w: 4, h: 12 }, { x: 44 + aw + 4, y: 20, w: aw, h: 12 });
  const sleeveR = part({ x: 44, y: 32, w: aw, h: 4 }, { x: 44 + aw, y: 32, w: aw, h: 4 }, { x: 40, y: 36, w: 4, h: 12 }, { x: 44, y: 36, w: aw, h: 12 }, { x: 44 + aw, y: 36, w: 4, h: 12 }, { x: 44 + aw + 4, y: 36, w: aw, h: 12 });
  const armL = part({ x: 36, y: 48, w: aw, h: 4 }, { x: 36 + aw, y: 48, w: aw, h: 4 }, { x: 32, y: 52, w: 4, h: 12 }, { x: 36, y: 52, w: aw, h: 12 }, { x: 36 + aw, y: 52, w: 4, h: 12 }, { x: 36 + aw + 4, y: 52, w: aw, h: 12 });
  const sleeveL = part({ x: 52, y: 48, w: aw, h: 4 }, { x: 52 + aw, y: 48, w: aw, h: 4 }, { x: 48, y: 52, w: 4, h: 12 }, { x: 52, y: 52, w: aw, h: 12 }, { x: 52 + aw, y: 52, w: 4, h: 12 }, { x: 52 + aw + 4, y: 52, w: aw, h: 12 });

  const legR = part({ x: 4, y: 16, w: 4, h: 4 }, { x: 8, y: 16, w: 4, h: 4 }, { x: 0, y: 20, w: 4, h: 12 }, { x: 4, y: 20, w: 4, h: 12 }, { x: 8, y: 20, w: 4, h: 12 }, { x: 12, y: 20, w: 4, h: 12 });
  const pantsR = part({ x: 4, y: 32, w: 4, h: 4 }, { x: 8, y: 32, w: 4, h: 4 }, { x: 0, y: 36, w: 4, h: 12 }, { x: 4, y: 36, w: 4, h: 12 }, { x: 8, y: 36, w: 4, h: 12 }, { x: 12, y: 36, w: 4, h: 12 });
  const legL = part({ x: 20, y: 48, w: 4, h: 4 }, { x: 24, y: 48, w: 4, h: 4 }, { x: 16, y: 52, w: 4, h: 12 }, { x: 20, y: 52, w: 4, h: 12 }, { x: 24, y: 52, w: 4, h: 12 }, { x: 28, y: 52, w: 4, h: 12 });
  const pantsL = part({ x: 4, y: 48, w: 4, h: 4 }, { x: 8, y: 48, w: 4, h: 4 }, { x: 0, y: 52, w: 4, h: 12 }, { x: 4, y: 52, w: 4, h: 12 }, { x: 8, y: 52, w: 4, h: 12 }, { x: 12, y: 52, w: 4, h: 12 });

  return { head, hat, body, jacket, armR, sleeveR, armL, sleeveL, legR, pantsR, legL, pantsL };
}

// ---------------------------------------------------------------- loader

export interface PartFaces {
  front: HTMLCanvasElement;
  back: HTMLCanvasElement;
  left: HTMLCanvasElement;
  right: HTMLCanvasElement;
  top: HTMLCanvasElement;
  bottom: HTMLCanvasElement;
}

export interface SkinParts {
  head: PartFaces;
  hat: PartFaces | null; // null when the overlay layer is fully transparent
  body: PartFaces;
  jacket: PartFaces | null;
  armR: PartFaces;
  sleeveR: PartFaces | null;
  armL: PartFaces;
  sleeveL: PartFaces | null;
  legR: PartFaces;
  pantsR: PartFaces | null;
  legL: PartFaces;
  pantsL: PartFaces | null;
}

export interface LoadedSkin {
  model: 'classic' | 'slim';
  armW: 4 | 3;
  parts: SkinParts;
}

export type SkinModelHint = 'classic' | 'slim' | 'auto';

/** Extract one region into its own canvas. */
function extractFace(src: HTMLCanvasElement, r: FaceRect): HTMLCanvasElement {
  const c = makeCanvas(r.w, r.h);
  ctx2d(c).drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c;
}

/** True when the region has at least one opaque pixel (used to skip empty overlays). */
function regionHasPixels(g: CanvasRenderingContext2D, r: FaceRect): boolean {
  const data = g.getImageData(r.x, r.y, r.w, r.h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) return true;
  return false;
}

/** Draw a source region into the dest canvas, mirrored horizontally. */
function drawRegionMirrored(dst: HTMLCanvasElement, src: HTMLCanvasElement, r: FaceRect, dx: number, dy: number): void {
  const g = ctx2d(dst);
  g.save();
  g.translate(dx + r.w, dy);
  g.scale(-1, 1);
  g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  g.restore();
}

/** Copy a source region into dest (unmirrored). */
function drawRegion(dst: HTMLCanvasElement, src: HTMLCanvasElement, r: FaceRect, dx: number, dy: number): void {
  ctx2d(dst).drawImage(src, r.x, r.y, r.w, r.h, dx, dy, r.w, r.h);
}

/** Expand a legacy 64×32 skin into the modern 64×64 layout in place. */
function legacyTo64(c64: HTMLCanvasElement): void {
  const classic = skinLayout('classic');
  // Left arm = mirrored right arm; left leg = mirrored right leg.
  drawRegionMirrored(c64, c64, classic.armR.front, classic.armL.front.x, classic.armL.front.y);
  drawRegionMirrored(c64, c64, classic.armR.back, classic.armL.back.x, classic.armL.back.y);
  drawRegionMirrored(c64, c64, classic.armR.right, classic.armL.left.x, classic.armL.left.y); // outer face -> outer face
  drawRegionMirrored(c64, c64, classic.armR.left, classic.armL.right.x, classic.armL.right.y); // inner face -> inner face
  drawRegion(c64, c64, classic.armR.top, classic.armL.top.x, classic.armL.top.y);
  drawRegion(c64, c64, classic.armR.bottom, classic.armL.bottom.x, classic.armL.bottom.y);
  drawRegionMirrored(c64, c64, classic.legR.front, classic.legL.front.x, classic.legL.front.y);
  drawRegionMirrored(c64, c64, classic.legR.back, classic.legL.back.x, classic.legL.back.y);
  drawRegionMirrored(c64, c64, classic.legR.right, classic.legL.left.x, classic.legL.left.y);
  drawRegionMirrored(c64, c64, classic.legR.left, classic.legL.right.x, classic.legL.right.y);
  drawRegion(c64, c64, classic.legR.top, classic.legL.top.x, classic.legL.top.y);
  drawRegion(c64, c64, classic.legR.bottom, classic.legL.bottom.x, classic.legL.bottom.y);
}

/**
 * Detect classic vs slim by pixel-dropping: the columns only a classic skin
 * paints (4th column of the right-arm back face, etc.) are transparent on
 * slim skins. Only consulted when the caller has no authoritative model info.
 */
function detectModel(g: CanvasRenderingContext2D): 'classic' | 'slim' {
  const probes: Array<[number, number, number, number]> = [
    [54, 20, 2, 12], // right arm back face, classic-only columns
    [54, 36, 2, 12], // right sleeve back, classic-only columns
    [46, 52, 2, 12], // left arm back, classic-only columns
    [62, 52, 2, 12], // left sleeve back, classic-only columns
  ];
  for (const [x, y, w, h] of probes) {
    const data = g.getImageData(x, y, w, h).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) return 'classic';
  }
  return 'slim';
}

/**
 * Load a Minecraft-format skin from an image or canvas.
 * Accepts 64×64 (modern) or 64×32 (legacy, auto-converted). Returns null when
 * the image is not a skin-shaped PNG.
 */
export function loadSkin(src: HTMLImageElement | HTMLCanvasElement, modelHint: SkinModelHint = 'auto'): LoadedSkin | null {
  const isImg = typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement;
  const w = isImg ? (src as HTMLImageElement).naturalWidth : (src as HTMLCanvasElement).width;
  const h = isImg ? (src as HTMLImageElement).naturalHeight : (src as HTMLCanvasElement).height;
  if (w !== 64 || (h !== 64 && h !== 32)) return null;

  const c64 = makeCanvas(64, 64);
  const g = ctx2d(c64);
  g.drawImage(src as CanvasImageSource, 0, 0);
  if (h === 32) legacyTo64(c64);

  const model = modelHint === 'auto' ? detectModel(g) : modelHint;
  const L = skinLayout(model);

  const facesOf = (p: PartLayout): PartFaces => ({
    front: extractFace(c64, p.front),
    back: extractFace(c64, p.back),
    left: extractFace(c64, p.left),
    right: extractFace(c64, p.right),
    top: extractFace(c64, p.top),
    bottom: extractFace(c64, p.bottom),
  });
  const overlay = (p: PartLayout): PartFaces | null => (regionHasPixels(g, p.front) || regionHasPixels(g, p.back) || regionHasPixels(g, p.right) || regionHasPixels(g, p.left) || regionHasPixels(g, p.top) || regionHasPixels(g, p.bottom) ? facesOf(p) : null);

  return {
    model,
    armW: model === 'slim' ? 3 : 4,
    parts: {
      head: facesOf(L.head),
      hat: overlay(L.hat),
      body: facesOf(L.body),
      jacket: overlay(L.jacket),
      armR: facesOf(L.armR),
      sleeveR: overlay(L.sleeveR),
      armL: facesOf(L.armL),
      sleeveL: overlay(L.sleeveL),
      legR: facesOf(L.legR),
      pantsR: overlay(L.pantsR),
      legL: facesOf(L.legL),
      pantsL: overlay(L.pantsL),
    },
  };
}

// ---------------------------------------------------------------- default skin

/**
 * The ORIGINAL Hyperion default skin — a golden-hour street runner:
 * dark hair + stubble, charcoal bomber over a teal tee with a gold chain,
 * indigo jeans, white sneakers. 100% procedurally painted here (no
 * third-party pixels), laid out in the standard 64×64 format so it round-
 * trips through the exact same loader as a real TLauncher skin.
 */
export function makeDefaultSkinCanvas(): HTMLCanvasElement {
  const c = makeCanvas(64, 64);
  const g = ctx2d(c);
  const rnd = mulberry32(0x4217);

  const skin = '#b5876c', skinD = '#9c6e54', skinL = '#c99b7e';
  const hair = '#2a1f16', hairL = '#43301f';
  const brow = '#3a2a1c', eyeW = '#f2f2f2', eyeP = '#4a3d8f', eyeD = '#20182c';
  const nose = '#8f6448', mouth = '#5c3722', stubble = '#a5825f';
  const jacket = '#3a3f4a', jacketD = '#2e323b', jacketL = '#475064';
  const tee = '#00a8a8', teeD = '#008f8f', teeL = '#33cccc';
  const gold = '#d9a521', goldD = '#a67a12';
  const jeans = '#2c3350', jeansD = '#232941', jeansL = '#3a4266';
  const shoe = '#e6e6e6', sole = '#141414';
  const belt = '#1c1f26';

  // helper working in REGION-local coordinates
  const fill = (r: FaceRect, color: string): void => px(g, r.x, r.y, r.w, r.h, color);

  const L = skinLayout('classic');

  // ---- head front: hair fringe, brows, eyes, nose, mouth, stubble
  {
    const r = L.head.front;
    fill(r, skin);
    px(g, r.x, r.y, 8, 2, hair); // hair band
    px(g, r.x + 2, r.y + 1, 3, 1, hairL); // fringe highlight
    px(g, r.x, r.y + 2, 1, 3, hair); // right sideburn
    px(g, r.x + 7, r.y + 2, 1, 3, hair); // left sideburn
    px(g, r.x + 3, r.y + 2, 2, 1, hairL); // fringe dip (asymmetric QA cue)
    px(g, r.x + 1, r.y + 3, 2, 1, brow); px(g, r.x + 5, r.y + 3, 2, 1, brow); // brows
    px(g, r.x + 1, r.y + 4, 1, 1, eyeW); px(g, r.x + 2, r.y + 4, 1, 1, eyeP); // eyes
    px(g, r.x + 5, r.y + 4, 1, 1, eyeP); px(g, r.x + 6, r.y + 4, 1, 1, eyeW);
    px(g, r.x + 2, r.y + 4, 1, 1, eyeD); px(g, r.x + 5, r.y + 4, 1, 1, eyeD); // dark inner corners
    px(g, r.x + 3, r.y + 5, 2, 1, nose);
    px(g, r.x + 2, r.y + 6, 3, 1, mouth);
    px(g, r.x + 1, r.y + 7, 2, 1, stubble); px(g, r.x + 5, r.y + 7, 2, 1, stubble); // jaw stubble
    px(g, r.x + 3, r.y + 7, 2, 1, skinD); // chin shading
  }
  // ---- head right side (front edge at the region's RIGHT columns)
  {
    const r = L.head.right;
    fill(r, skin);
    px(g, r.x, r.y, 8, 2, hair);
    px(g, r.x, r.y + 2, 3, 1, hair); // hairline toward the back
    px(g, r.x + 6, r.y + 2, 2, 2, hair); // sideburn toward the face
    px(g, r.x + 3, r.y + 3, 2, 3, skinL); // ear
    px(g, r.x + 3, r.y + 5, 2, 1, skinD); // ear base
    px(g, r.x, r.y + 3, 1, 5, skinD); // back-of-head shading
  }
  // ---- head left side (front edge at the region's LEFT columns)
  {
    const r = L.head.left;
    fill(r, skin);
    px(g, r.x, r.y, 8, 2, hair);
    px(g, r.x + 5, r.y + 2, 3, 1, hair); // hairline toward the back
    px(g, r.x, r.y + 2, 2, 2, hair); // sideburn toward the face
    px(g, r.x + 3, r.y + 3, 2, 3, skinL); // ear
    px(g, r.x + 3, r.y + 5, 2, 1, skinD);
    px(g, r.x + 7, r.y + 3, 1, 5, skinD);
  }
  // ---- head top (row 0 of the region = BACK edge, bottom row = forehead)
  {
    const r = L.head.top;
    fill(r, hair);
    for (let i = 0; i < 10; i++) px(g, r.x + ((rnd() * 8) | 0), r.y + ((rnd() * 8) | 0), 1, 1, hairL);
    px(g, r.x + 2, r.y + 2, 2, 2, hairL); // cowlick (orientation QA cue)
  }
  // ---- head back
  {
    const r = L.head.back;
    fill(r, skinD);
    px(g, r.x, r.y, 8, 5, hair);
    px(g, r.x + 3, r.y + 1, 1, 4, hairL); // hair part
    px(g, r.x, r.y + 5, 8, 1, hair);
    px(g, r.x + 2, r.y + 6, 4, 1, skinD);
    for (let i = 0; i < 6; i++) px(g, r.x + ((rnd() * 8) | 0), r.y + ((rnd() * 5) | 0), 1, 1, hairL);
  }
  // ---- head bottom (neck side)
  {
    const r = L.head.bottom;
    fill(r, skinD);
    px(g, r.x + 2, r.y + 2, 4, 4, '#8a5f47');
  }

  // ---- body front: bomber over teal tee, gold chain, belt hem
  {
    const r = L.body.front;
    fill(r, tee);
    px(g, r.x, r.y, 8, 1, skinL); // neck
    px(g, r.x, r.y + 1, 2, 1, jacket); px(g, r.x + 6, r.y + 1, 2, 1, jacket);
    px(g, r.x + 1, r.y + 1, 6, 1, teeL); // collar highlight
    px(g, r.x, r.y + 2, 2, 9, jacket); px(g, r.x + 6, r.y + 2, 2, 9, jacket); // jacket edges
    px(g, r.x + 1, r.y + 1, 1, 10, jacketL); px(g, r.x + 7, r.y + 1, 1, 10, jacketD); // shading
    px(g, r.x + 5, r.y + 2, 1, 8, teeD);
    px(g, r.x + 3, r.y + 2, 2, 1, gold); px(g, r.x + 3, r.y + 3, 1, 1, goldD); // gold chain
    px(g, r.x, r.y + 11, 8, 1, belt); // belt peek
    px(g, r.x + 3, r.y + 11, 2, 1, goldD); // buckle
  }
  // ---- body back
  {
    const r = L.body.back;
    fill(r, jacket);
    px(g, r.x, r.y, 8, 1, jacketL); // collar
    px(g, r.x, r.y + 3, 8, 1, jacketL); // yoke
    px(g, r.x + 3, r.y + 4, 2, 8, jacketD); // center seam
    px(g, r.x, r.y + 11, 8, 1, jacketD); // hem
  }
  // ---- body sides + top + bottom
  for (const r of [L.body.right, L.body.left]) {
    fill(r, jacket);
    px(g, r.x, r.y + 2, r.w, 1, jacketL);
    px(g, r.x, r.y + 11, r.w, 1, jacketD);
  }
  {
    const r = L.body.top;
    fill(r, jacket);
    px(g, r.x + 3, r.y, 2, 4, skin); // neck
  }
  fill(L.body.bottom, jacketD);

  // ---- arms: bomber sleeve to the cuff, bare hands
  const armFaces = (p: PartLayout, shadeCol: 0 | 1): void => {
    for (const key of ['front', 'back', 'left', 'right'] as const) {
      const r = p[key];
      fill(r, jacket);
      px(g, r.x, r.y, r.w, 9, jacket);
      if (shadeCol === 1) px(g, r.x + r.w - 1, r.y, 1, 9, jacketD);
      else px(g, r.x, r.y, 1, 9, jacketD);
      px(g, r.x, r.y + 9, r.w, 1, jacketL); // cuff highlight
      px(g, r.x, r.y + 10, r.w, 2, skin); // hand
      px(g, r.x, r.y + 11, r.w, 1, skinD);
    }
    fill(p.top, jacket);
    px(g, p.top.x, p.top.y, p.top.w, 1, jacketL);
    fill(p.bottom, skinD);
  };
  armFaces(L.armR, 1);
  armFaces(L.armL, 0);

  // ---- legs: indigo jeans + white sneakers
  const legFaces = (p: PartLayout, shadeCol: 0 | 1): void => {
    for (const key of ['front', 'back', 'left', 'right'] as const) {
      const r = p[key];
      fill(r, jeans);
      if (shadeCol === 1) px(g, r.x + r.w - 1, r.y, 1, 10, jeansD);
      else px(g, r.x, r.y, 1, 10, jeansD);
      px(g, r.x, r.y + 5, r.w, 1, jeansL); // knee seam
      px(g, r.x, r.y + 10, r.w, 1, shoe); // sneaker
      px(g, r.x, r.y + 11, r.w, 1, sole); // sole
    }
    fill(p.top, jeans);
    fill(p.bottom, sole);
  };
  legFaces(L.legR, 1);
  legFaces(L.legL, 0);

  return c;
}

/** Convenience: the default skin as a data URL (for persistence + previews). */
export function defaultSkinDataUrl(): string {
  return makeDefaultSkinCanvas().toDataURL('image/png');
}

// ---------------------------------------------------------------- TLauncher fetch

export interface TlauncherSkin {
  model: 'classic' | 'slim';
  png: string; // data URL
}

/**
 * Fetch a TLauncher user's skin through our server-side proxy
 * (auth.tlauncher.org sends no CORS headers and the skin file itself is
 * plain HTTP — both are solved by routing through /api/skin).
 */
export async function fetchTlauncherSkin(name: string): Promise<TlauncherSkin> {
  const res = await fetch(`/api/skin?name=${encodeURIComponent(name.trim())}`);
  const j = (await res.json().catch(() => null)) as { model?: string; png?: string; error?: string } | null;
  if (!res.ok || !j?.png) throw new Error(j?.error ?? `Skin service error (HTTP ${res.status})`);
  return { model: j.model === 'slim' ? 'slim' : 'classic', png: j.png };
}

/** Decode a data URL into an <img> for the loader. */
export function imageFromDataUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Not a readable PNG image'));
    img.src = url;
  });
}

// ---------------------------------------------------------------- persistence

export type SkinSource = 'default' | 'tlauncher' | 'file';

export interface SkinChoice {
  source: SkinSource;
  name: string | null;
  model: 'classic' | 'slim';
  png: string; // data URL — restored offline on next boot
}

const SKIN_KEY = 'hyperion.skin.v1';

export function saveSkinChoice(c: SkinChoice): void {
  try {
    window.localStorage.setItem(SKIN_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable (private mode) — skin stays session-only */
  }
}

export function loadSkinChoice(): SkinChoice | null {
  try {
    const raw = window.localStorage.getItem(SKIN_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as SkinChoice;
    if (!c || typeof c.png !== 'string' || !c.png.startsWith('data:image/png')) return null;
    return { source: c.source ?? 'file', name: c.name ?? null, model: c.model === 'slim' ? 'slim' : 'classic', png: c.png };
  } catch {
    return null;
  }
}

export function clearSkinChoice(): void {
  try {
    window.localStorage.removeItem(SKIN_KEY);
  } catch {
    /* ignore */
  }
}
