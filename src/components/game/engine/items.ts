import * as THREE from 'three';
import { ItemId, PlaceableId } from './types';
import { makeBlockTexture, makeTNTTextures } from './textures';

/**
 * The universal Minecraft item -> world-action map.
 * Tools carve micro-voxels, TNT triggers real explosions, blocks place smooth
 * voxel slabs (rounded bevel boxes, never pixel-cube visuals), flint & steel
 * ignites realistic car engine fires, etc.
 */

export interface ItemDef {
  id: ItemId;
  name: string;
  kind: 'tool' | 'weapon' | 'placeable' | 'tnt' | 'igniter' | 'throwable' | 'food' | 'jetpack';
  maxStack: number;
  digRadius: number;
  cooldown: number;
  /** Icon painting: 16x16 pixel-art string rows + palette. */
  icon: string[];
  palette: Record<string, string>;
  /** Color chip for the third-person held item. */
  heldColor: number | null;
}

const P = (rows: string[]) => rows;

export const ITEMS: Record<ItemId, ItemDef> = {
  pickaxe: {
    id: 'pickaxe',
    name: 'Diamond Pickaxe',
    kind: 'tool',
    maxStack: 1,
    digRadius: 1.35,
    cooldown: 0.16,
    heldColor: 0x4aedd9,
    icon: P([
      '..........aa.....',
      '.........aaaa....',
      '........aaaaaa...',
      '.......aa..aaa...',
      '......bb...aaa...',
      '.....bb....aaa...',
      '....bb.....aaa...',
      '...bb......aaa...',
      '..bb.......aaa...',
      '.bb........aaa...',
      'bb.........aaa...',
      'b..........aaa...',
      '..........aaaaaa.',
      '..........aaaaaa.',
      '................',
      '................',
    ]),
    palette: { a: '#4aedd9', b: '#8b5a2b' },
  },
  sword: {
    id: 'sword',
    name: 'Diamond Sword',
    kind: 'weapon',
    maxStack: 1,
    digRadius: 0.45,
    cooldown: 0.3,
    heldColor: 0x4aedd9,
    icon: P([
      '..........aa....',
      '.........aaaa...',
      '........aaaaa...',
      '.......aaaaa....',
      '......aaaaa.....',
      '.....aaaaa......',
      '....aaaaa.......',
      '...aaaaa........',
      'bbaaaa..........',
      '.bbaa...........',
      '..bbb...........',
      '.bbbbb..........',
      'bb..bbb.........',
      'b....bb.........',
      '................',
      '................',
    ]),
    palette: { a: '#4aedd9', b: '#6b4423' },
  },
  tnt: {
    id: 'tnt',
    name: 'TNT',
    kind: 'tnt',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.45,
    heldColor: 0xc23b22,
    icon: P([
      '................',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.abbbbbbbbbbbba.',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.aa.bbb..bbb.aa.',
      '.aaabbbaabbaaa..',
      '.aa..bbb..bb.aa.',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#c23b22', b: '#e8e4da' },
  },
  dirt: {
    id: 'dirt',
    name: 'Dirt Block',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0x79553a,
    icon: P([
      '................',
      '.aaaaaaaaaaaaaa.',
      '.aabbaaaaaaabaa.',
      '.aaaaaabbaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.abaaaccaaaaaab.',
      '.aaaaccccaaaaaa.',
      '.aaccaacccaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.aabbaaaaccaaaa.',
      '.aaaaaabbaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#79553a', b: '#5d3f2a', c: '#8a6a48' },
  },
  cobblestone: {
    id: 'cobblestone',
    name: 'Cobblestone',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0x7a7a7a,
    icon: P([
      '................',
      '.aacaaabbaaccaa.',
      '.accaaaabaaacaa.',
      '.caaaaaccaaabaa.',
      '.aacbaaaaaaacaa.',
      '.aaaaaacbaaaaaa.',
      '.bbaaacaaaacbaa.',
      '.abaaacaaaabbaa.',
      '.acaaabaacaaaca.',
      '.aaaacaaaaaacaa.',
      '.abbaacaaabbaaa.',
      '.acaabaaacaaaba.',
      '.aaaaaaaaaaaaaa.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#7a7a7a', b: '#565656', c: '#9a9a9a' },
  },
  planks: {
    id: 'planks',
    name: 'Oak Planks',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0x9c7f4e,
    icon: P([
      '................',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.bbbbbbbbbbbbbb.',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.bbbbbbbbbbbbbb.',
      '.aaaaaaaaaaaaaa.',
      '.aaaaacaaaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.bbbbbbbbbbbbbb.',
      '.aaaaaaaaaaaaaa.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#9c7f4e', b: '#7a5f36', c: '#6b5230' },
  },
  glass: {
    id: 'glass',
    name: 'Glass Block',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0xd4ecef,
    icon: P([
      '.cccccccccccccc.',
      '.cddddddddddddc.',
      '.cdeeeeeeeeeggc.',
      '.cdeeeeeeeegggc.',
      '.cdeeeeeeeegggc.',
      '.cdeeeeeeeggggc.',
      '.cdeeeeeegggggc.',
      '.cdeeeeeggggggc.',
      '.cdeeeegggggggc.',
      '.cdeeeegggggggc.',
      '.cdeeeeggggggbc.',
      '.cdeeeggggggbbc.',
      '.cddddddddddddc.',
      '.cccccccccccccc.',
      '................',
      '................',
    ]),
    palette: { c: '#dceff2', d: '#eef8fa', e: '#f8feff', g: '#b8dfe6', b: '#a8d4dc' },
  },
  grass: {
    id: 'grass',
    name: 'Grass Block',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0x5d9c3f,
    icon: P([
      '................',
      '.gggggggggggggg.',
      '.gihgggggghiggg.',
      '.gaggggaaggggag.',
      '.aaggaabbaaagaa.',
      '.aaaaccccaaaaaa.',
      '.abaaaccaaaaaab.',
      '.aaccaacccaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '.aabbaaaaccaaaa.',
      '.aaaaaabbaaaaaa.',
      '.aacaaabbaaaaaa.',
      '.aaaaaaaaaaaaaa.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#79553a', b: '#5d3f2a', c: '#8a6a48', g: '#5d9c3f', h: '#4c8531', i: '#67a847' },
  },
  stone: {
    id: 'stone',
    name: 'Stone',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0x8a8a8a,
    icon: P([
      '................',
      '.aaaaaaaaaaaaaa.',
      '.aabbaaaaaacbaa.',
      '.aaaaacbaaaaaaa.',
      '.aacaaaaaaaaaaa.',
      '.aaaacaaaacbaaa.',
      '.abaaaaaaaaaaaa.',
      '.aaaaaaacaaaaaa.',
      '.aacaaabaacaaaa.',
      '.aaaacaaaaaacaa.',
      '.aabbaaacaaaaaa.',
      '.aaaaaaaaacaaaa.',
      '.acaaabcaaaaaaa.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#828282', b: '#6e6e6e', c: '#8f8f8f' },
  },
  log: {
    id: 'log',
    name: 'Oak Log',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0x6b5233,
    icon: P([
      '................',
      '.baabacaabaabac.',
      '.baabacaabaabac.',
      '.baabacaabaabac.',
      '.baadacaabaabac.',
      '.baaddcaabaabac.',
      '.baaddcaabaabac.',
      '.baadacaabaabac.',
      '.baabacaabaabac.',
      '.baabacaabaddac.',
      '.baabacaabaddac.',
      '.baabacaabaabac.',
      '.baabacaabaabac.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#6b5233', b: '#5a4429', c: '#74593a', d: '#4e3a20' },
  },
  leaves: {
    id: 'leaves',
    name: 'Oak Leaves',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0x3f7d2c,
    icon: P([
      '................',
      '.aabadaabcaabda.',
      '.abdaacaabdacaa.',
      '.acaabdcabaadaa.',
      '.abacabadacabab.',
      '.cabadacabadeaa.',
      '.abdacabadacaba.',
      '.acabadacabadab.',
      '.badacabadaceba.',
      '.dacabadacabadc.',
      '.abadacabadacab.',
      '.bdacabadacabea.',
      '.adacabadacabda.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#3f7d2c', b: '#2e6b1e', c: '#4c9138', d: '#356e26', e: '#2a5e1c' },
  },
  sand: {
    id: 'sand',
    name: 'Sand',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0xd8cf9e,
    icon: P([
      '................',
      '.aaaaaaaaaaaaaa.',
      '.aacaaacaaacaaa.',
      '.adaaabcaadaaba.',
      '.acaaadaaacbaaa.',
      '.aaacaaabaaacaa.',
      '.abaaacaaadaaba.',
      '.acaadaaacaaaad.',
      '.aaacaaabaaacaa.',
      '.adaaacbaadaaaa.',
      '.acaaadaaacbaaa.',
      '.aabaaacaaadaba.',
      '.aaaaaaaaaaaaaa.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#dbd3a0', b: '#d1c78f', c: '#e6dfae', d: '#e0d8a6' },
  },
  bricks: {
    id: 'bricks',
    name: 'Bricks',
    kind: 'placeable',
    maxStack: 64,
    digRadius: 0,
    cooldown: 0.2,
    heldColor: 0x96513d,
    icon: P([
      '................',
      '.mmmmmmmmmmmmmm.',
      '.aaamaaamaaamaa.',
      '.abcmbacmcabmab.',
      '.aaamaaamaaamaa.',
      '.mmmmmmmmmmmmmm.',
      '.maaamaaamaaama.',
      '.caabmabambaama.',
      '.maaamaaamaaama.',
      '.mmmmmmmmmmmmmm.',
      '.aaamaaamaaamaa.',
      '.cbmacamabcmaba.',
      '.aaamaaamaaamaa.',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#96513d', b: '#8e4a37', c: '#a05a44', m: '#a8a8a8' },
  },
  flint: {
    id: 'flint',
    name: 'Flint & Steel',
    kind: 'igniter',
    maxStack: 1,
    digRadius: 0,
    cooldown: 0.4,
    heldColor: 0x9a9a9a,
    icon: P([
      '................',
      '.....bb.........',
      '....bbbb........',
      '...bbbb.........',
      '...bbb..........',
      '..bbbb..........',
      '..bb.......aa...',
      '.bb.......aaaa..',
      '.bb......aataa..',
      '.........aataa..',
      '..........aaaa..',
      '...........aa...',
      '................',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#9a9a9a', b: '#3d3d3d', t: '#ffb020' },
  },
  pearl: {
    id: 'pearl',
    name: 'Ender Pearl',
    kind: 'throwable',
    maxStack: 16,
    digRadius: 0,
    cooldown: 0.6,
    heldColor: 0x1f8a7a,
    icon: P([
      '................',
      '.....aaaaa......',
      '....aaaaaaa.....',
      '...aadaaaaaa....',
      '..aaddaaaaaaa...',
      '..aadaaaaaaaa...',
      '..aaaaaaaaaaa...',
      '..aaaaaaaaaaa...',
      '..aaaaaaaaaac...',
      '...aaaaaaaaac...',
      '...aaaaaaaaac...',
      '....aaaaaaa.....',
      '.....aaaaa......',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#1f8a7a', d: '#7ce8d8', c: '#0e5f54' },
  },
  apple: {
    id: 'apple',
    name: 'Golden Apple',
    kind: 'food',
    maxStack: 8,
    digRadius: 0,
    cooldown: 0.5,
    heldColor: 0xe8b923,
    icon: P([
      '.......bb.......',
      '......bb........',
      '....aaaaaaa.....',
      '...aaaaaaaaaa...',
      '..aaaaaaaaaaaa..',
      '..aaaacaaaaaaa..',
      '..aaaacaaaaaaa..',
      '..aaaacaaaaaaa..',
      '..aaaaaaaaaaaa..',
      '..aaaaaaaaaaaa..',
      '...aaaaaaaaaa...',
      '....aaaaaaaa....',
      '.....aaaaaa.....',
      '................',
      '................',
      '................',
    ]),
    palette: { a: '#e8b923', b: '#3f7a2a', c: '#fff0a0' },
  },
  jetpack: {
    id: 'jetpack',
    name: 'Chaos Jetpack',
    kind: 'jetpack',
    maxStack: 1,
    digRadius: 0,
    cooldown: 0,
    heldColor: 0xb8bcc4,
    icon: P([
      '..aaa......aaa..',
      '..aba......aba..',
      '..aba......aba..',
      '.aaba......abaa.',
      '.aaba.dddd.abaa.',
      '.abba.dffd.abba.',
      '.abbb.dffd.abbb.',
      '.abbb.dffd.abbb.',
      '.abba.dffd.abba.',
      '..aba.dddd.aba..',
      '..aba..dd..aba..',
      '...a...ff...a...',
      '.......ff.......',
      '.......ee.......',
      '......gggg......',
      '.....gggggg.....',
    ]),
    palette: {
      a: '#9aa2ac',
      b: '#6b7178',
      d: '#ffd24a',
      e: '#ff8c1a',
      f: '#ff5722',
      g: '#ffb74d',
    },
  },
};

/** Generate a pixel-art icon data URL (crisp, scaled x4). */
export function itemIconURL(def: ItemDef): string {
  const size = 16;
  const scale = 4;
  const cv = document.createElement('canvas');
  cv.width = size * scale;
  cv.height = size * scale;
  const ctx = cv.getContext('2d')!;
  for (let y = 0; y < size; y++) {
    const row = def.icon[y] ?? '';
    for (let x = 0; x < size; x++) {
      const ch = row[x];
      if (!ch || ch === '.') continue;
      const color = def.palette[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return cv.toDataURL();
}

export const ICON_URLS: Partial<Record<ItemId, string>> = {};

export function initIcons(): void {
  for (const key of Object.keys(ITEMS) as ItemId[]) {
    ICON_URLS[key] = itemIconURL(ITEMS[key]);
  }
}

/** Shared UI pixel icons (hearts / stars) generated once. */
export const UI_ICONS: { heartFull: string; heartEmpty: string; starFull: string; starEmpty: string } = {
  heartFull: '',
  heartEmpty: '',
  starFull: '',
  starEmpty: '',
};

export function initUIIcons(): void {
  const heart = (full: boolean) => {
    const cv = document.createElement('canvas');
    cv.width = 36;
    cv.height = 36;
    const ctx = cv.getContext('2d')!;
    const rows = [
      '..xx...xx..',
      '.xxxx.xxxx.',
      'xxxxxxxxxxx',
      'xxxxxxxxxxx',
      'xxxxxxxxxxx',
      '.xxxxxxxxx.',
      '..xxxxxxx..',
      '...xxxxx...',
      '....xxx....',
      '.....x.....',
    ];
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        if (rows[y][x] !== 'x') continue;
        ctx.fillStyle = full ? (x > 2 && x < 5 && y > 1 && y < 4 ? '#ff8a8a' : '#e02222') : '#3a3a3a';
        ctx.fillRect(x * 3, y * 3, 3, 3);
      }
    }
    return cv.toDataURL();
  };
  const star = (full: boolean) => {
    const cv = document.createElement('canvas');
    cv.width = 40;
    cv.height = 40;
    const ctx = cv.getContext('2d')!;
    ctx.beginPath();
    const cx = 20;
    const cy = 21;
    for (let i = 0; i < 10; i++) {
      const ang = (Math.PI / 5) * i - Math.PI / 2;
      const r = i % 2 === 0 ? 17 : 7.5;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#111';
    ctx.stroke();
    ctx.fillStyle = full ? '#ffffff' : 'rgba(40,40,40,0.75)';
    ctx.fill();
    return cv.toDataURL();
  };
  UI_ICONS.heartFull = heart(true);
  UI_ICONS.heartEmpty = heart(false);
  UI_ICONS.starFull = star(true);
  UI_ICONS.starEmpty = star(false);
}

/**
 * Materials for placeable "smooth voxel" blocks (rounded bevel cubes).
 * Materials are cached per kind and SHARED across every placed block of that
 * kind (blocks never dispose their material on break — geometry only), so
 * repeated place/load calls reuse one GPU texture + program per block type.
 */
const blockMatCache = new Map<PlaceableId, THREE.MeshStandardMaterial>();

export function makeBlockMaterial(kind: PlaceableId): THREE.MeshStandardMaterial {
  const hit = blockMatCache.get(kind);
  if (hit) return hit;
  let mat: THREE.MeshStandardMaterial;
  if (kind === 'glass') {
    mat = new THREE.MeshStandardMaterial({
      color: 0xcfe8ec,
      transparent: true,
      opacity: 0.34,
      roughness: 0.05,
      metalness: 0.1,
    });
  } else {
    // grass uses the side texture (dirt + green fringe), log uses bark; the rest map 1:1.
    const texKind = kind === 'grass' ? 'grass-side' : kind === 'log' ? 'log-side' : kind;
    const tex = makeBlockTexture(texKind);
    const roughness = kind === 'planks' ? 0.7 : kind === 'sand' ? 0.9 : kind === 'leaves' ? 0.85 : 0.95;
    mat = new THREE.MeshStandardMaterial({ map: tex, roughness });
  }
  blockMatCache.set(kind, mat);
  return mat;
}

let tntMats: { side: THREE.Material; top: THREE.Material; bottom: THREE.Material } | null = null;
export function makeTNTMaterials(): { side: THREE.Material; top: THREE.Material; bottom: THREE.Material } {
  if (tntMats) return tntMats;
  const t = makeTNTTextures();
  const mk = (tex: THREE.Texture) => {
    const m = new THREE.MeshLambertMaterial({ map: tex });
    return m;
  };
  tntMats = { side: mk(t.side), top: mk(t.top), bottom: mk(t.bottom) };
  return tntMats;
}
