# Project Hyperion — Worklog

## Project
**Project Hyperion** — a standalone 3D sandbox engine: GTA-style realistic city (smooth meshes, roads, traffic, NPCs) that the player interacts with using Minecraft mechanics (blocky Steve player, creative flight, universal item inventory, micro-voxel destruction).

Rendered in the web preview panel, so the engine is WebGL/three.js (same architecture the user specified: smooth realistic meshes outside, dense micro-voxel carving under the hood). References used as architectural inspiration: calamity-inc/GTA-V-Decompiled-Scripts (city/vehicle feel), ikkentim/opengta2 (top-down lane traffic AI), fogleman/craft + python-minecraft-clone (movement/inventory/flight mechanics).

## Architecture Plan (Task Map)
- Task 1: env setup — install three.js, verify dev server (main agent) ✅ dev server confirmed running
- Task 2-a: `src/components/game/engine/textures.ts` — all procedural textures (facades, ground tiles, strata, TNT, blocks, Steve skin, fronds, clouds) [subagent]
- Task 2-b: `src/components/game/engine/audio.ts` — procedural WebAudio SFX engine [subagent]
- Task 3: core engine — `input.ts`, `destruction.ts` (micro-voxel carve system: spatial-hash tri removal + crater deformation + occupancy grid), `particles.ts` (debris/fire/smoke/shockwave)
- Task 4: `city.ts` — procedural Los-Santos-style city: road grid, destructible buildings (high-subdivision boxes + facade textures), sidewalk slabs, palms, streetlights, parks, parking lots, deep strata layers for infinite digging, bedrock
- Task 5: `player.ts` (blocky Steve, walk/fly/creative, first/third person), `vehicles.ts` (smooth rounded cars, lane traffic AI, driveable, fire/explosion chain), `npcs.ts` (pedestrians, flee, ragdoll)
- Task 6: `items.ts` — universal Minecraft item map: pickaxe/sword/TNT/dirt/cobble/planks/glass/flint&steel/ender pearl/golden apple + pixel-art icons
- Task 7: `game.ts` orchestrator + `hud.tsx` + `HyperionClient.tsx` + `page.tsx` + splash art (AI-generated)
- Task 8: integrate subagent outputs + lint
- Task 9: agent-browser QA golden path
- Task 10: final worklog + 15-minute webDevReview cron

## Micro-voxel destruction design (core constraint #2)
- Every destructible model (buildings, ground, strata, tunnel shafts) is stored as an indexed high-density mesh (tri edge ≈ 0.85–1.0 m, i.e. "micro-voxel" sampling grid).
- A uniform spatial hash (cell ≈ tri size) maps cells → triangle indices for O(local) carving.
- On tool/explosion: world point → local space, gather candidate tris from overlapped cells, kill tris whose centroid is inside the sphere, radially displace surviving shell vertices (crater lip), compact index buffer, recompute normals (buildings), spawn debris at removed centroids.
- A world-space 1 m occupancy grid records carved cells → used by the hybrid collision engine (player/cars can pass through carved cells = tunneling) and by traffic AI (cars fall into dug road holes).
- Ground dig-down: ground slab → rim shaft walls → infinite strata layers (dirt → stone → deepslate) spawned on demand → bedrock at −64.

---
Task ID: 2-b
Agent: audio-subagent
Task: Create procedural WebAudio SFX module for Project Hyperion

Work Log:
- Read worklog.md + tsconfig.json (strict mode, DOM libs) to align with project conventions; created src/components/game/engine/ directory.
- Designed SSR-safe lazy architecture: no window/AudioContext touch at import; AudioContext + master GainNode + cached 1s white-noise AudioBuffer created exactly once inside unlock() (idempotent, also resumes suspended contexts, supports webkitAudioContext fallback).
- Implemented full public API: boom (lowpass sweep 900->60Hz ~1.1s + 42Hz sub sine + tanh WaveShaper soft-clip), dig (50-70ms bandpass 700-1400Hz random tick), breakBlock (120ms bandpass ~350Hz + high sparkle layer), place (sine 170->70Hz 90ms + click), ignite (highpass sweep 200->2000Hz 0.5s), horn (2 detuned saws 340/425Hz, 350ms, lowpassed), pearl (chirp 500->1200Hz + delayed reverse-whoosh burst), eat (3 scheduled crunch bites ~500ms), hurt (square 240->110Hz), thud (lowpass noise 150ms + 80Hz sine), enterCar (95Hz thunk + click), collapse (1.8s dual-layer lowpass 120Hz rumble), pickup (600->900Hz pop), fireCrackle (p=0.6 tiny random highpass crackle).
- Engine loop: startEngine creates persistent saw osc 55Hz (plus half-freq detuned sub layer) through lowpass 400Hz; setEngine(speed01) drives freq 55+speed01*130 and gain 0.028+speed01*0.05 via setTargetAtTime; stopEngine ramps down and tears down nodes.
- Built shared private helpers to keep the file lean: noise(dur, at), env(g, t0, a, d, peak), farGain(far) (0..1 -> 1..0.06), filter(), osc(), chain(), plus generic burst()/tone() one-shot factories used by all event SFX.
- Guarded every public method with `if (!this.ctx) return` inside try/catch; dispose() stops engine, closes context, nulls all state.
- Iterated 4x on tsc: fixed Float32Array<ArrayBuffer> vs ArrayBufferLike generic mismatch (TS 5.7 lib) by generating the distortion curve inline per boom instead of caching it; compacted file from 538 -> 328 lines.
- Verified with `bunx tsc --noEmit`: zero errors attributable to audio.ts (remaining 4 project errors are pre-existing in examples/ and skills/, unrelated to this task).

Stage Summary:
- Exported: `export class HyperionAudio` (single export) from src/components/game/engine/audio.ts.
- Public methods: constructor(), unlock(), setMasterVolume(v), boom(far), dig(), breakBlock(), place(), ignite(far), horn(far), pearl(), eat(), hurt(), thud(far), enterCar(), collapse(far), pickup(), startEngine(), setEngine(speed01), stopEngine(), fireCrackle(far), dispose().
- Key decisions: 100% procedural (no assets/network); master gain default 0.8 with setTargetAtTime smoothing; far sounds also keep fullband but attenuated via farGain (1 -> 0.06); all one-shots are fire-and-forget (nodes auto-GC after stop); engine loop is the only persistent graph; every call site is crash-proof via try/catch; file is 328 lines, TS strict clean.
---
Task ID: 2-a
Agent: textures-subagent
Task: Create procedural textures module for Project Hyperion

Work Log:
- Read worklog.md + tsconfig (strict mode, ES2017 target) and verified three@0.186.1 installed; created src/components/game/engine/.
- Wrote src/components/game/engine/textures.ts (~487 lines): pure canvas-based procedural generators, no assets/network, all DOM access inside functions.
- Built shared helpers: mulberry32 seeded RNG, makeCanvas/ctx2d, px() pixel-rect, toTexture() (SRGB + RepeatWrapping), speckle(), vGrad(), litPane(), wrapBlob()/wrapStroke() (3x3 wrapped copies for seamless tiling), disc(), pixelTexture() (NearestFilter, no mipmaps).
- makeFacadeTexture: 128px 3m-x-3m tile per style — concrete (beige/gray wall, ledges, punched window with sky-reflection gradient + sill), glass (charcoal curtain wall, 2x2 glossy panes, thin mullions, sparse lit panes), brick (running-bond red-brown rows, smaller light-framed window), white (panel seams, wide window band with mullions); emissiveMap is black with lit panes in warm #ffd27f at seeded random alpha.
- makeRoofTexture: gravel/tar noise, wrapped lighter/darker patches, occasional metal vent.
- Ground quad canvases (256px, raw canvas for compositor drawImage): makeAsphaltTile (seamless dark speckle + blobs), makeSidewalkTile (slab tint variation + seam lines every 64px), makeGrassTile (green noise, wrapped patches, blade flecks).
- makeLayerTexture: dirt (brown noise + stones + rare root random-walks), stone (gray + wrapped cracks), deepslate (dark blue-gray grain + broken horizontal strata), bedrock (chaotic near-black blocks with sharp gray edges); 256px, SRGB, RepeatWrapping.
- makeBlockTexture: 32px pixel tiles (dirt/cobblestone/planks/grass-top) with per-pixel palettes, NearestFilter + no mipmaps.
- makeTNTTextures: side (red + white band + pixel "TNT" glyph bitmaps), top (red border, gray-white concentric circles), bottom (red, dark center); 32px Nearest.
- makeFrondTexture (128x64 transparent stem+leaflets, quadratic-curve leaflets in #2e7d32..#66bb6a), makeTrunkTexture (64x128 rings + fiber streaks, RepeatWrapping), makeCloudTexture (overlapping radial-gradient puffs on transparent), makeSunSprite (white core -> orange halo).
- makeSteveTextures: native-resolution canvases — headFront 8x8 (hair rows 0-1 + sideburns, eyes white/#523d89 pupils at y4, nose, 3px mouth y6), headSide, headTop (all hair), body 8x12 teal #00a8a8, arm 4x12 skin with darker shading column, leg 4x12 denim #3f4aa4 + gray shoe.
- Verified with `bunx tsc --noEmit`: zero errors referencing textures.ts (remaining project errors are pre-existing in examples/ and skills/). Compressed file to 487 lines (under ~500). No other files created/modified except worklog.md.

Stage Summary:
- Exported symbols: FacadeStyle (interface), makeFacadeTexture(style, seed), makeRoofTexture(), makeAsphaltTile(), makeSidewalkTile(), makeGrassTile(), makeLayerTexture(kind, seed), makeBlockTexture(kind), makeTNTTextures(), makeFrondTexture(), makeTrunkTexture(), makeCloudTexture(), makeSunSprite(), makeSteveTextures().
- Key decisions: single 128px facade tile (=3m) with per-building seed variation; lit windows only on emissiveMap (black base, warm #ffd27f gradient panes); ground compositor tiles returned as raw HTMLCanvasElement; all THREE textures sRGB, RepeatWrapping except frond/cloud/sun (clamp, transparent); Minecraft tiles 32px with magFilter=minFilter=NearestFilter and generateMipmaps=false; seamlessness achieved via 3x3 wrapped blob/stroke drawing; everything deterministic through mulberry32 seeds.

---

Task ID: 1,3,4,5,6,7,8,9 (main agent)
Agent: Z.ai Code (main)
Task: Build Project Hyperion — GTA-style realistic city × Minecraft mechanics WebGL engine

Work Log:
- Task 1: installed three@0.186.1 + @types/three; confirmed dev server on :3000
- Task 2-a/2-b: delegated textures.ts + audio.ts to subagents (see their sections above)
- Task 3: wrote engine/constants.ts, engine/types.ts, engine/input.ts (pointer-lock + drag-look fallback), engine/destruction.ts (micro-voxel carve system: per-mesh spatial hash with packed numeric keys, tri-centroid sphere removal, radial crater-lip vertex displacement, index compaction, world-space 1m occupancy grid for collision/tunneling, analytic strata-layer ray hits), engine/particles.ts (instanced icosahedron debris pool, custom-shader fire/smoke Points with near-camera clipping, explosion flash light + shockwave ring)
- Task 4: engine/city.ts — procedural city: 13×13 road grid, composite 2048px ground texture (grass/sidewalk/asphalt/double-yellow lanes/crosswalks/parking stalls), ~110 high-subdivision destructible buildings (0.85m micro-voxel tris, 4 facade styles with emissive lit windows, roof caps, dark interior shells), instanced sidewalk slabs/palms (merged drooping fronds)/streetlights, distant hills, building collapse system (sink animation + dust + rubble), on-demand strata layers (dirt→stone→deepslate→bedrock) for infinite digging
- Task 5: engine/player.ts (blocky Steve from pixel canvas skin, walk/sprint/jump + creative flight double-space, fall damage, regen, limb animation, third-person visibility), engine/vehicles.ts (4 smooth RoundedBox car types with glass canopies/wheels/lights, right-hand lane traffic AI with intersection turns + braking + honking, driveable arcade physics with building/car collision + damage, fire→explode chain, fall-into-dug-road-holes), engine/npcs.ts (26 pedestrians on sidewalk rings, flee, ragdoll + respawn)
- Task 6: engine/items.ts — universal Minecraft item map (Diamond Pickaxe/Sword/TNT/Dirt/Cobblestone/Planks/Glass/Flint&Steel/Ender Pearl/Golden Apple) with 16×16 pixel-art icon generator, UI hearts/stars icons, smooth beveled block materials (RoundedBoxGeometry), TNT block textures
- Task 7: engine/game.ts orchestrator (~1200 lines: sky shader dome + sun + clouds, golden-hour lighting + RoomEnvironment, hybrid collision: floorHeightAt via strata occupancy + resolveCircleXZ vs building AABBs/blocks with carve-aware tunneling, aim pipeline: analytic layers → prefiltered mesh raycast → block AABB → car/NPC/TNT spheres, dig/place/TNT/flint/pearl/apple actions, explosions with chain reactions, chaos score + wanted stars, camera first/third/chase + shake, adaptive quality, minimap renderer, HUD state emit), engine/game-utils.ts (ray-AABB slab, sky builder, clouds), hud.tsx (React HUD: hotbar/hearts/stars/minimap/debug/hints/toasts/inventory/pause/death/start screens with splash art), HyperionClient.tsx, page.tsx, layout metadata, globals.css (toast animation)
- Task 8: fixed all TS strict errors (grant item naming, capsule limb offsets, ReactNode types), migrated destruction grid to packed numeric keys (~10× memory reduction), cleaned vehicle throttle logic; `bun run lint` → 0 problems, `tsc --noEmit` → 0 errors
- Task 9: agent-browser QA — start screen + splash render; PLAY → pointer lock works; city renders (verified via screenshots); dig carves micro-voxels (totalRemoved>0); TNT full chain verified (fuse → explosion → 464 voxels removed → player damage 20→8 → CHAOS score + wanted star → fire particles + debris); traffic cars move; creative flight toggles; third-person blocky Steve renders in the realistic street; car enter/drive/exit works; dirt block places (smooth beveled voxel) with inventory consumption; minimap draws city + player arrow + car dots; zero console errors; dev.log clean

Stage Summary:
- COMPLETE, browser-verified engine. / route = fullscreen game. Key decisions: WebGL/three.js instead of Python/ModernGL (preview panel constraint, same architecture), destruction via dense tri-grid + occupancy cells (not blocky cubes), only player + items are blocky per user spec.
- Known env-only artifact: headless-software-renderer compositor shows a stale y-flipped minimap rect in screenshots — framebuffer readback proves it is NOT in the render (real GPU browsers unaffected).
- Performance: heavy scene (~1.5M tris + 320k-tri ground); adaptive quality lowers pixelRatio/shadows if fps<36. Headless software rendering runs ~4-20fps; real GPU preview expected much faster.
- Follow-ups for next cycles: place-block rejection when aiming at own feet (correct but could auto-retry adjacent cell), car radio/missions/police response to 5 stars, save/load world edits to localStorage, mobile touch controls, texture atlas to cut draw calls.
