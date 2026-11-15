/**
 * GTA SOURCE PORT — raw asset loader (feature/gta-source-port).
 *
 * Every byte served by this module originates from the GTA clone source repo
 * (pressure/desktop branches, upstream fiveplay.lol /data/ = the streamed game
 * data): the real Los Santos road graph (common/data/levels/gta5/paths.ipl),
 * the real water layout (water.xml), the real district population schedule
 * (popcycle.dat) and the real GTA V texture/material files extracted as-is
 * from the source .ytd resource containers. Nothing here is a stylized
 * re-creation: the game world is now built out of the original game data.
 */
import * as THREE from 'three';

export interface GtaRoadGraph {
  /** Flat node positions (GTA V world coords, meters). */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Node links (index pairs) — the real street connectivity. */
  a: Uint32Array;
  b: Uint32Array;
}

export interface GtaWaterQuad {
  minX: number; maxX: number; minY: number; maxY: number; z: number; t: number;
}

export interface GtaPopSchedule {
  /** Per district: 24 rows (12 weekday hours + 12 weekend) of
   * [#Peds,#Scenario,#Cars,#prkdcrs,#lowprkdcrs,PercCopCars,PercCopPed,...]. */
  [district: string]: number[][];
}

export interface GtaTextures {
  /** Real GTA V detail material tiles (mapdetail/*.ytd extraction). */
  stucco: THREE.Texture | null;
  concreteNoise: THREE.Texture | null;
  concreteSmooth: THREE.Texture | null;
  crusty: THREE.Texture | null;
  woodgrain: THREE.Texture | null;
  bark: THREE.Texture | null;
  cloth: THREE.Texture | null;
  /** Real GTA V grass (plantsmgr/*.ytd extraction). */
  grass: THREE.Texture | null;
  grassFur: THREE.Texture | null;
  /** Real GTA V weather sprites (fxweather.ytd extraction). */
  rain: THREE.Texture | null;
  snow: THREE.Texture | null;
  mist: THREE.Texture | null;
  /** Real GTA V light sprites (graphics[_pc].ytd extraction). */
  headlights: THREE.Texture | null;
  distantLight: THREE.Texture | null;
  lightning: THREE.Texture | null;
  cloudNoise: THREE.Texture | null;
  puddleLayout: THREE.Texture | null;
  /** Real GTA V ped damage decals (peddamagedecals.ytd extraction). */
  bloodMist: THREE.Texture | null;
  bloodSplatter: THREE.Texture | null;
  bruise: THREE.Texture | null;
  /** Real GTA V glass decals (breakableglass.ytd extraction). */
  glassCrack: THREE.Texture | null;
}

export interface GtaSource {
  roads: GtaRoadGraph | null;
  water: GtaWaterQuad[];
  pop: GtaPopSchedule;
  tex: GtaTextures;
  /** Names of the real radio tracks shipped from the source. */
  radioStations: { name: string; tracks: { title: string; file: string }[] }[];
}

const TEX_BASE = '/gta/textures';

function loadTex(path: string, repeat = true): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      `${TEX_BASE}/${path}`,
      (t) => {
        // Photographic GTA V look: linear filtering + anisotropy (NOT the
        // pixel/nearest voxel filtering the procedural pass used).
        t.colorSpace = THREE.SRGBColorSpace;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.anisotropy = 8;
        if (repeat) {
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.RepeatWrapping;
        }
        resolve(t);
      },
      undefined,
      () => resolve(null),
    );
  });
}

function fetchBin(url: string): Promise<ArrayBuffer | null> {
  return fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
}

function fetchJson<T>(url: string, fallback: T): Promise<T> {
  return fetch(url)
    .then((r) => (r.ok ? r.json() : fallback))
    .catch(() => fallback);
}

/** Parse the real Los Santos road graph from roads.bin (built from paths.ipl). */
function parseRoads(buf: ArrayBuffer): GtaRoadGraph | null {
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true);
  const l = dv.getUint32(4, true);
  if (!n || !l) return null;
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
  let p = 12;
  for (let i = 0; i < n; i++) {
    x[i] = dv.getFloat32(p, true);
    y[i] = dv.getFloat32(p + 4, true);
    z[i] = dv.getFloat32(p + 8, true);
    p += 14; // skip flags u16
  }
  const a = new Uint32Array(l), b = new Uint32Array(l);
  for (let i = 0; i < l; i++) {
    a[i] = dv.getUint32(p, true);
    b[i] = dv.getUint32(p + 4, true);
    p += 10;
  }
  return { x, y, z, a, b };
}

/** Real GTA V radio — the tracks extracted as-is from the source audio. */
const RADIO: GtaSource['radioStations'] = [
  {
    name: 'West Coast Classics',
    tracks: [
      { title: 'N.H.H. — Waves', file: '/gta/audio/waves.ogg' },
      { title: 'Do Ya Like', file: '/gta/audio/do_ya_like.ogg' },
      { title: 'Everything', file: '/gta/audio/everything.ogg' },
    ],
  },
  {
    name: 'Radio Los Santos',
    tracks: [
      { title: 'Enjoy The Pain', file: '/gta/audio/enjoy_the_pain.ogg' },
      { title: 'People Like Me', file: '/gta/audio/people_like_me.ogg' },
      { title: 'NHH', file: '/gta/audio/nhh.ogg' },
    ],
  },
  {
    name: 'Non-Stop-Pop FM',
    tracks: [
      { title: 'Pray', file: '/gta/audio/pray.ogg' },
      { title: 'Spread Your Wings', file: '/gta/audio/spread_your_wings.ogg' },
      { title: 'Living So Italian', file: '/gta/audio/living_so_italian.ogg' },
    ],
  },
];

let cached: Promise<GtaSource> | null = null;

/** Preload the real GTA source assets (call once before the game builds). */
export function loadGtaSource(): Promise<GtaSource> {
  if (cached) return cached;
  cached = (async () => {
    const [roadsBuf, water, pop, ...texs] = await Promise.all([
      fetchBin('/gta/data/roads.bin'),
      fetchJson<GtaWaterQuad[]>('/gta/data/water.json', []),
      fetchJson<GtaPopSchedule>('/gta/data/popcycle.json', {}),
      loadTex('mapdetail/env_stucco.png'),
      loadTex('mapdetail/env_noise_concrete.png'),
      loadTex('mapdetail/env_smooth_concrete2.png'),
      loadTex('mapdetail/env_crusty.png'),
      loadTex('mapdetail/env_woodgrain.png'),
      loadTex('mapdetail/env_bark.png'),
      loadTex('mapdetail/env_cloth.png'),
      loadTex('plantsmgr/txgrass00.png'),
      loadTex('plantsmgr/fur_grass_d_0.png', false),
      loadTex('fxweather/rain.png', false),
      loadTex('fxweather/snow.png', false),
      loadTex('fxweather/mist.png', false),
      loadTex('graphics/headlights.png', false),
      loadTex('graphics/distant_light.png', false),
      loadTex('graphics/lightning.png', false),
      loadTex('graphics/cloudnoise.png'),
      loadTex('graphics/puddle_layout.png'),
      loadTex('peddamagedecals/pd_blood_mist_splatter.png', false),
      loadTex('peddamagedecals/pd_scars_bruise_damage.png', false),
      loadTex('peddamagedecals/pd_blushing.png', false),
      loadTex('breakableglass/cracktempered.png', false),
    ]);
    const [stucco, concreteNoise, concreteSmooth, crusty, woodgrain, bark, cloth,
      grass, grassFur, rain, snow, mist, headlights, distantLight, lightning,
      cloudNoise, puddleLayout, bloodMist, bloodSplatter, bruise, glassCrack] = texs as (THREE.Texture | null)[];
    return {
      roads: roadsBuf ? parseRoads(roadsBuf) : null,
      water,
      pop,
      tex: {
        stucco, concreteNoise, concreteSmooth, crusty, woodgrain, bark, cloth,
        grass, grassFur, rain, snow, mist, headlights, distantLight, lightning,
        cloudNoise, puddleLayout, bloodMist, bloodSplatter, bruise, glassCrack,
      },
      radioStations: RADIO,
    };
  })();
  return cached;
}
