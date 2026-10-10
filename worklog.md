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

---

Task ID: cron-review-1 (2026-10-10)
Agent: Z.ai Code (webDevReview cycle 1)
Task: Status assessment, QA, then feature development: police pursuit, day/night, HUD polish

Work Log:
- QA baseline: agent-browser smoke test — game loads, PLAY works, 34 cars / 26 NPCs / 175 buildings, zero console errors, dev.log clean. Status: STABLE → proceeded to feature development.
- Feature: POLICE PURSUIT SYSTEM
  - vehicles.ts: new 'police' car type (white cruiser, black hood/trunk stripes, red/blue lightbar meshes) + 'police' state; spawnPolice() spawns on roads 90-150m from player; despawnExtraPolice() removes farthest units; drivePolice() pursuit AI — seek player (yaw seek + speed curve 30 m/s), building-collision probe with stuck detection → reverse-unstick maneuver, shoves civilian traffic aside (traffic→parked), rams the player on foot (7 dmg + shake + thud); lightbar flashes red/blue at 7Hz via emissiveIntensity; hook into update() (state==='police' && not player-driven); police cars are enterable (steal a cop car), burn/explode/fall-into-holes like all cars.
  - game.ts updatePolice(): star-gated dispatch — stars≥2 → min(4, stars-1) units, 5s spawn interval, "WANTED — police units responding!" toast once per escalation; despawn when stars drop; siren loop managed by distance (<95m) via audio.sirenLoop()/stopSiren().
  - audio.ts: sirenLoop() — triangle osc 720Hz wailed by a 0.42Hz sine LFO (±210Hz via AudioParam modulation), 0.042 gain with attack ramp; stopSiren() fades + tears down; wired into dispose().
- Feature: DAY/NIGHT CYCLE (300s game-time per 24h; starts 17:20 golden hour)
  - game-utils.ts buildSky() refactor: returns { skyUniforms, starsMat }; added 420-point night starfield (upper-hemisphere, opacity animated).
  - game.ts updateDayNight(): sun arc (position/intensity 0.08..2.78/color warm→dusk orange), hemi 0.14..0.76, sky shader uniforms lerped day↔night palettes with dusk orange boost on the bottom band, fog color + near/far night compression, stars opacity, city.applyNight() (window emissive 0.55→1.6, streetlights 0.45→3.25), 24h clock string for HUD/minimap.
  - city.ts: nightMaterials[] registry (facade mats) + headMat ref + applyNight(night).
- Fix: block placement auto-retry — candidates = [direct cell, one cell along horizontal aim direction (feet-friendly), one along face normal]; verified placing while looking straight down at feet now succeeds.
- Styling/HUD: hit-marker X (SVG, remount-per-hit via key → pop animation, increments on car melee / NPC knock / player damage), 🚓 POLICE ×N chip with red/blue blinking border, emerald DEPTH −N M chip when underground, quick-hints chip (E/F5/F/F3), minimap day/night clock chip (☀/☾ + HH:MM, drawn per frame).
- globals.css: hyperion-hitmark-pop + hyperion-police-blink keyframes.
- Verification: lint 0 problems, tsc 0 errors; agent-browser QA — 4-star chaos spawned police (lightbar 2 meshes, pursuit closes distance over game-time), dusk screenshot shows stars + lit windows + glowing streetlights, midnight forced → dark sky/stars/☾ 00:00 clock, hitMark 0→1 on damage, feet placement placed=1 dirt 64→63, POLICE chip + hints chip + clock chip all render.

Stage Summary:
- New systems this cycle: police pursuit (star-gated, sirens, lightbars, ramming, unstick AI) + full day/night cycle + HUD detail pass (hit marker, police/depth/hints/clock chips) + placement retry fix. All browser-verified; codebase stays lint/tsc clean.
- Risks: police AI can corner-camp the player at high stars (mitigate later with lose-them-line-of-sight cooldown); day/night changes shadow direction every frame (cheap, but shadowmap updates could cost on low-end GPUs — adaptive quality already throttles pixelRatio/shadows).
- Next-cycle priorities (suggested): (1) car radio — procedural chiptune while driving, (2) chaos missions/contracts ("wreck 3 cars in 60s") with golden-apple rewards, (3) save/load placed blocks + carve stats to localStorage, (4) reduce draw calls via material atlas, (5) mobile touch controls.

---

Task ID: cron-review-2 (2026-10-10)
Agent: Z.ai Code (webDevReview cycle 2)
Task: Status assessment + QA, bug fixes, then feature development: car radio, chaos contracts, save/load, HUD styling pass

Work Log:
- QA baseline: dev.log clean, lint 0 problems, tsc 0 errors (only pre-existing examples/skills errors). agent-browser: game loads, renders, zero console errors in fresh session. Verdict: STABLE → feature development.
- ENV FIX: stale corrupted Turbopack cache served a broken audio.ts (phantom parse error at line 342 even though disk file was byte-clean). rm -rf .next + dev-server restart + fresh browser session resolved it. Lesson: verify console errors from a CLEARED console — agent-browser console accumulates history across navigations.
- BUG FIX (real): Esc-pause desync — input.ts Esc path set engine `paused=true` without notifying React, so no pause menu appeared whenever pointer lock wasn't held (normal case after CONTINUE / failed lock). Fix: GameCallbacks.onPauseRequest() → HyperionClient syncs setPaused(true) + game.setPaused(true) + inputExitLock(). Verified: Esc → menu with RESUME + Save world buttons.
- UX FIX: CONTINUE SAVED CITY button popped in late (only after first HUD emit). Fix: HyperionClient seeds initial React state with hasSave from localStorage at first paint.
- FEATURE: CAR RADIO (audio.ts) — 3 procedural chiptune stations + OFF via lookahead scheduler (50ms interval, 0.18s queue): HYP FM 101.3 (128bpm major-pentatonic square lead/triangle bass/hats), MIDNIGHT 84.5 (82bpm dreamy sine pads), VOXEL HARDWARE (152bpm aggressive saw riff + every-16th hats). New primitives: radioNote() absolute-time scheduling, radioHat() noise hats. Radio auto-starts on entering a car, stops on exit, KeyR cycles with toast; dispose() tears down.
- FEATURE: CHAOS CONTRACTS (new missions.ts) — 4 timed contracts (WRECKAGE wreck 3 cars/75s; DEMOLITION carve 900 voxels/60s; SKYLINE DEMOLITION collapse a building/90s; RAMPAGE 6 peds/60s), offer → M to accept (15s TTL) → countdown → rewards (TNT/cobble/golden apples + CHAOS score) or fail; M abandons. Event feed wired: explode(isCar)→onCarWreck, carveSphere→onVoxels, city.onCollapseStart→onCollapse, npc hit/ragdoll→onPed. Verified E2E: offer chip, accept, completion rewards (apple:3 granted, +140 score), abandon path.
- FEATURE: SAVE/LOAD (new save.ts + game.ts saveNow/applySave/resetNewGame) — localStorage v1: placed blocks (shared RoundedBoxGeometry on load), player transform/health/flying, hotbar/inventory/slot, timeT, CHAOS heat, micro-voxel total. Autosave every 15s (silent), manual Save world button in pause menu (toast), CONTINUE SAVED CITY on start screen (applies save), NEW GAME wipes save. Verified E2E: 600-byte payload, reload → CONTINUE → pos/timeT/inventory restored exactly.
- STYLING PASS: MissionChip (top-center: title/countdown/progress bar/reward row; pulsing amber glow for offers via .hyperion-offer keyframes), radio chip with 4 animated EQ bars (.hyperion-eqbar), full-screen red/blue police light wash during pursuit (.hyperion-policeflash), CHAOS→next-star progress bar (amber→red gradient), Save/Continue buttons (emerald outline style), controls list updated (M/R). types.ts: HudState + mission/radio/hasSave.
- QA note: headless background-tab rAF throttling makes gameplay time crawl (~1.5fps → clamped dt 0.05/frame); deterministic testing done via direct runtime calls (missions.update(999), saveNow(), etc.). Real GPU browsers unaffected.

Stage Summary:
- New systems: procedural car radio (3 stations), chaos contract loop, world save/load, plus one real bug fix (Esc-pause desync) and a HUD styling pass. All browser-verified; lint/tsc stay clean; zero console errors.
- Known quirks: stale hint chip at very low fps (cosmetic, refreshes within 0.18s of gameplay time); building-carve geometry intentionally NOT serialized (city regenerates pristine, carve counter carries over); radio station resets to HYP FM on reload (station index not persisted).
- Next-cycle priorities (suggested): (1) police lose-them cooldown (line-of-sight timer) to fix corner-camping at high stars; (2) draw-call reduction via material atlas; (3) mobile touch controls; (4) contract variety — location-based contracts ("demolish building X" with a minimap marker); (5) persist radio station + settings in the save file.
