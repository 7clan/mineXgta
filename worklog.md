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

Task ID: cron-review-3 (2026-10-10)
Agent: Z.ai Code (webDevReview cycle 3)
Task: Status assessment + QA, then feature development: police evade/lose-them system, location contracts, rain weather, radio persistence, HUD styling pass

Work Log:
- QA baseline: dev.log clean, lint 0 problems, tsc 0 errors (game code), agent-browser smoke test — start screen renders (CONTINUE SAVED CITY + NEW GAME), HUD renders (CHAOS/stars/hearts/hotbar/minimap/clock), zero console errors in cleared console, carve verified (38 voxels), saveNow() ok, 175 buildings / 26 NPCs / playing=true. Verdict: STABLE → feature development.
- QA lesson: HUD DOM probing needs content-based selectors (body.innerText), not guessed class names; window.__hyperion runtime handle remains the reliable QA surface.
- FEATURE: POLICE EVADE / LOSE-THEM SYSTEM (game.ts) — fixes corner-camping at high stars:
  - updatePolice() now tracks line-of-sight: any unit within 68m = seen (underground y<-2.5 = never seen — tunnels are safe houses).
  - Unseen → evadeT accumulates; at 5s "You are losing them — stay out of sight!" toast; at 16s heat ×0.4 + "You lost the cops!" + despawn all units.
  - Heat decay is 10.5/s while evading (evadeT>1.5) vs 2.5/s normally — breaking LOS visibly drains the wanted meter.
  - HUD: `evading` 0..1 emitted; new EvadeChip (👁 LOSING THEM + % + amber→emerald gradient bar, hyperion-losing pulse glow) shown when wanted + evading.
- FEATURE: LOCATION CONTRACTS (missions.ts + game.ts) — 2 new contract types, 6 total:
  - DEMOLISH THE TOWER: pins a specific tall building (h≥20, within 260m, picked via cb.pickBuilding) as the ONLY valid target — onCollapse(id) is building-index-gated; wrong building doesn't progress (verified: wrong→0, target→COMPLETED).
  - GRAND THEFT: steal a police cruiser — progressed via onCarEnter('police') wired in enterNearestCar.
  - snapshot(markerFor) callback pattern: game supplies missionMarker(buildingId) — marker {x,z} flows to HUD (◆ live distance in contract chip) + minimap (pulsing amber diamond, edge-clamped, upright distance label drawn in screen space via inverse map-rotation math).
  - World-space beacon: additive translucent amber pillar (110m) pulsing at the marked building, auto-created/hidden by updateBeacon().
- FEATURE: RAIN WEATHER SYSTEM (new weather.ts + audio.ts + game.ts):
  - Weather machine: clear → overcast → rain, random 24-190s states, intensity eases toward target (0 / 0.35 / 1).
  - Rendering: 1500 camera-anchored rain streak LineSegments (slanted by sinusoidal wind, wrapped in a 60m box), opacity ramped in above intensity 0.45.
  - Atmosphere in updateDayNight(): rain lerps sky toward overcast grays, sun ×(1-0.82·I), fog compresses (near 150→88, far 620→380), stars hidden, windows brighten via applyNight(max(night, 0.45·I)).
  - LIGHTNING: random 9-26s strikes during rain → 0.24s white sky/sun/hemi spike + 2-roll procedural thunder (lowpass sweep 300→55Hz + delayed second rumble) + small shake.
  - Rain audio bed: looping noise through highpass 400 + lowpass 5200, gain 0.026-0.1 tracking intensity; setRain(0) tears down.
  - Gameplay consequence: heavy rain douses fire patches (ttl ×4.5 decay + steam puffs) and burning cars (prob 1.4/s → vehicles.extinguish(): burning→parked (or police), health floored at 14, steam puff, toast).
- FEATURE: RADIO PERSISTENCE — save.ts v1 optional `radio` field; saveNow writes audio.radioStation, applySave restores (verified round-trip 2→0→applySave→2).
- STYLING PASS: WeatherChip (☀️/☁️/🌧 + 3 animated CSS droplets, state-colored borders — sky during rain, amber clear), EvadeChip, minimap contract diamond + distance, contract chip ◆ distance, hyperion-drop + hyperion-losing keyframes in globals.css.
- Verification (agent-browser, deterministic via runtime where headless fps throttles): rain forced → streaks render + fog 391 + sun 0.12 + screenshot shows storm look; WEATHER chip renders; lightning boltIn=0.01 → boltFired=true + lightningT spike; location contract injected → beacon visible at target + minimap ◆ 215m + chip distance; collapse gating verified; GRAND THEFT verified (enter police car → COMPLETED); evade: cop 17m → evadeT stays 0, teleport 420m → accumulates, prime 15.9 → heat 400→158 + all units despawned; radio round-trip ok; extinguish → parked/health 25; final showcase screenshot (rain + 3 stars + POLICE ×1 + LOSING THEM 55% + storm sky) — all UI layers correct.
- lint 0 problems, tsc 0 errors, zero console errors, dev.log clean after all tests.

Stage Summary:
- New systems this cycle: police lose-them/evade loop (LOS + fast heat drain + despawn), location-based contracts with beacon + minimap marker + gated completion, full rain weather (state machine, 1500-streak renderer, lightning + thunder, audio bed, fire/car dousing), radio persistence, weather/evade HUD chips.
- All browser-verified; lint/tsc clean; zero console errors.
- Known quirks: lightning flash only during rain state (by design); police LOS is distance-based (68m) not occlusion-raycast (cheap but means a 68m LOS through a building counts as seen — acceptable, units path around buildings); headless software renderer can't easily demonstrate probabilistic dousing (verified via simulated updates; ~75%/s at real 60fps).
- Next-cycle priorities (suggested): (1) rain wet-road specular via envMapIntensity boost on ground material, (2) occlusion-aware police LOS (single raycast per unit per 0.25s), (3) mobile touch controls, (4) draw-call reduction via material atlas, (5) contract chain: complete 3 contracts → bonus unlock (jetpack item?).

---

Task ID: cron-review-4 (2026-10-10)
Agent: Z.ai Code (webDevReview cycle 4)
Task: Status assessment + QA, then feature development: wet-road rain specular, Chaos Jetpack + contract chain, occlusion-aware police LOS, HUD styling pass

Work Log:
- QA baseline: dev.log clean, lint 0 problems, tsc 0 errors (game code), agent-browser fresh session — start screen renders, NEW GAME → 34 cars / 26 NPCs / 175 buildings, carve pipeline works (15 voxels via carveSphere(Vector3, radius)), ZERO console errors. One environment-only hiccup: first browser launch landed on about:blank (session glitch, not a code bug) — re-open resolved it. Verdict: STABLE → feature development.
- QA lesson: carveSphere takes (Vector3, radius) not (x,y,z,r); private TS members are runtime-callable through window.__hyperion which makes deterministic headless testing easy.
- FEATURE: WET-ROAD RAIN SPECULAR (city.ts + game.ts) — cycle-3 priority #1:
  - city.setWet(w): ground material roughness 0.94→0.32, envMapIntensity 1→3.4 (IBL sheen), color darkened/tinted bluish (wet asphalt).
  - game.updateWeather: wetT accumulator — soaks at 0.24/s while raining (>0.35 intensity), dries at 0.028/s (~35s) after; drives city.setWet every frame. Verified numerically (r0 0.94 → r1 0.32) and visually (glossy reflective asphalt vs matte sidewalk in daylight screenshot).
  - HUD: WeatherChip shows a 💧 WET tag while roads stay wet after rain stops (wet > 0.3 && !rain).
- FEATURE: CHAOS JETPACK (contract-chain bonus) — new item across types/items/audio/game/hud/save:
  - items.ts: 'jetpack' ItemId + ItemDef (kind 'jetpack', 16×16 pixel-art twin-tank + flame icon, maxStack 1).
  - Mechanic: select it, HOLD RMB → 34 m/s² vertical accel (vy cap 13.5) + forward boost (horiz cap 17); fuel 0..1 drains over ~6.5s of continuous burn, refills over ~9s idle; sputter/stop at 0 with one-shot "fuel depleted" toast; fall damage applies if you run dry mid-air (verified: climbed to 43.95m, drained 0.93→0.315 in 4s = exactly 1/6.5 per s).
  - Feedback: firePuff+smokePuff exhaust plume at the nozzles, new audio.jetThrust(on) loop (92Hz saw growl + bandpassed noise roar, fade-out teardown, dispose-safe).
  - Unlock: Missions now tracks chainCount; every CHAIN_GOAL=3 completed contracts fires cb.chainReward → grants jetpack +80 score + toast. Verified E2E: chain 2→3 via WRECKAGE/DEMOLITION/DEMOLISH THE TOWER completions → claimed=true, item granted.
  - Persistence: save.ts optional jetFuel field; saveNow/applySave round-trip verified (0.3 in localStorage).
- FEATURE: OCCLUSION-AWARE POLICE LOS (game.ts) — fixes the known "68m ray through walls" quirk:
  - computeCopLOS(): segment cop-eye→player-eye vs standing-building AABBs via rayBox at 4 Hz (losT); <4m point-blank always sees; collapsed/collapsing buildings skipped; underground (<−2.5y) still never seen. Evade/lose-them loop now consumes this.
  - Verified: cop 15m in open → seen; cop on far side of a h≥25 building → blocked (LOS false).
- STYLING PASS: JetFuelChip (orange gradient gauge, 🔥 BURNING flicker state via hyperion-flame keyframes, low-fuel red, "HOLD RMB — THRUST" hint, shown when jetpack selected or thrusting), MissionChip chain row (3 amber diamonds → "Jetpack" / "🔥 JETPACK CLAIMED ✓" emerald), start-screen copy mentions the jetpack, CONTROLS list + ["RMB (hold) 🚀", "Jetpack thrust (selected)"], globals.css hyperion-flame-flicker keyframes.
- Verification: lint 0 problems, tsc 0 errors, 0 console errors, dev.log clean; agent-browser screenshots confirm wet-road gloss, JETPACK 47% gauge chip, WET tag, JETPACK CLAIMED chain row, jetpack hotbar icon.

Stage Summary:
- New systems this cycle: rain wet-road material response (with slow drying + HUD tag), Chaos Jetpack item with fuel/thrust/exhaust/audio + 3-contract chain unlock, occlusion-aware police line-of-sight, jetpack fuel-gauge + chain-progress HUD.
- All browser-verified; lint/tsc clean; zero console errors.
- Known quirks: jetpack fuel yo-yo sputters near empty (by design — sounds like a dying engine); police LOS still distance-capped at 68m (occlusion only refines within range); jetpack maxStack 1 means a second chain bonus can sit unused in the inventory (acceptable).
- Next-cycle priorities (suggested): (1) mobile touch controls (dig/place/jetpack buttons), (2) draw-call reduction via material atlas for ~175 buildings, (3) contract chain tier 2 rewards (e.g. infinite-TNT "Mega Pack" or a tank vehicle), (4) police helicopter at 5 stars with spotlight, (5) jetpack recoil camera shake + surface scorch decals under thrust.

---

Task ID: cron-review-5 (2026-10-10)
Agent: Z.ai Code (webDevReview cycle 5)
Task: Status assessment + QA, then feature development: police helicopter air support, Rhino Tank (chain tier-2), tank gunnery, speedometer + scorch decals + HUD styling pass

Work Log:
- QA baseline: dev.log clean, lint 0 problems, tsc 0 errors (game code), agent-browser fresh session — start screen renders (CONTINUE + NEW GAME), NEW GAME → 175 buildings / 34 cars, carve pipeline works (67 voxels via carveSphere), 5-star escalation works (stars=5, heat 900), ZERO console errors in cleared console. One stale-console lesson re-confirmed: always clear console before reading errors. Verdict: STABLE → feature development.
- FEATURE: POLICE HELICOPTER / AIR SUPPORT (new helicopter.ts + audio.ts + game.ts + hud.tsx):
  - Smooth (non-blocky) chopper: ellipsoid fuselage, glass canopy, white belly band, tapered tail boom + fin, spinning main rotor (4 blades, 27 rad/s) + tail rotor, skids, red/blue belly flashers alternating at 4 Hz.
  - Motion: parametric orbit (radius 64±11 m, slow drift) around the player, altitude auto-clamped above the tallest standing building within 110 m (re-scan every 1.2 s, minAlt = maxH+9), banks into the turn, bobs.
  - SEARCHLIGHT: SpotLight (2600 cd, warm) targeted at the player with a lazy circular sweep + additive volumetric beam cone (opacity flicker) — verified light pool on the asphalt in screenshots.
  - DOOR GUN: every 2.3-3.2 s when the chopper sees the player (surface only, <135 m horizontal): 3-round burst — additive tracer lines (pooled, 0.08 s life), gunCrack audio, 62% hit chance → 3 dmg + hit marker; near-misses shake + debris.
  - LOS integration: heli counts as "cops see you" (copsSee = computeCopLOS(units) || heliSees) so surface evasion is impossible at 5 stars — GOING UNDERGROUND (y < −2.5) blinds it → tunnels are the counterplay (toast explains).
  - Rotor wash: dust puffs on the street when hovering < 17 m above ground.
  - AUDIO: heliLoop() — 12.5 Hz square-LFO chopped noise (blade slap) through bandpass 95 Hz + 34 Hz saw rumble; setHeliDist() attenuates by distance; stopHeli() fades + tears down; wired into dispose().
  - HUD: 🚁 AIR SUPPORT chip (red/blue blinking border + circular radar sweep via new hyperion-radar conic-gradient keyframes); minimap shows a blinking red ring + dot at the chopper.
- FEATURE: RHINO TANK (vehicles.ts + game.ts) — contract chain tier-2 reward:
  - New CarType 'tank': smooth olive hull (rounded), sloped glacis, engine deck, two treads, 8 spinning road wheels, ROTATING TURRET (cylinder + hatch + mantlet) with barrel pivot + muzzle brake + muzzle anchor Object3D; health 400, name 'Rhino Tank'.
  - Drive physics: accel 5.5, max 16 m/s (58 km/h), heavy steering 1.05, wide collision radius 1.95, takes 0.35× collision damage, bounces off buildings softly (−0.08), CRUSHES civilian cars (contact at >4 m/s → instant health 0 + ignite → explosion chain) instead of bouncing.
  - GUNNERY: mouse orbits aim (tankAimYaw/Pitch), gun-cam camera (10.5 m behind aim direction, look at turret), turret world-yaw = aim − hull yaw, barrel pitch tracks the camera ray; LMB fires when reload ready (2.6 s cd) → shell projectile (66 m/s, slight gravity, smoke trail) → impact tests (ground / building AABB / car sphere → ignite / NPC) → explode(radius 7.4) + score; muzzle fire+smoke puffs, cannon() audio (distorted boom + 44 Hz sub + crack), 0.42 shake, hull recoil.
  - Unlock: Missions chainReward now TIERED — tier 1 jetpack (unchanged), tier 2 spawns a tank on the nearest road point (spawnTank, toast "RHINO TANK delivered"), tier 3+ grants TNT ×32 "MEGA PACK" (+200 score). Verified E2E via runtime: chainCount 5 → voxels contract → chainCount 6 → chainTier 2 → second tank spawned + toast.
- FEATURE: SCORCH DECALS (game.ts) — every explosion (TNT, cars, shells) leaves a dark circle decal on the ground (random size/rotation, polygonOffset against z-fighting), fades over 70 s, cap 26 (FIFO). Air bursts > 7 m above floor skip. Verified: ground explosion → decals 0→1 visible in screenshot; building-facade shell hit → correctly no decal.
- STYLING PASS (mandatory detail mandate):
  - SPEEDOMETER: replaced the plain km/h chip with an SVG arc gauge (amber arc for cars, lime for tank) — needle, ticks, big tabular-nums readout, KM/H label, hull-integrity bar (sky→emerald, red gradient when < 30%), vehicle name row; tank variant adds CANNON status chip ("● LMB · FIRE" emerald when ready / "RELOAD N%") + lime reload progress bar.
  - Cinematic vignette overlay (radial gradient, always on while playing) — subtle filmic framing on top of the existing damage vignette.
  - Start screen copy + CONTROLS list updated (tank + chopper mentioned, "LMB (tank) — Fire the cannon" row).
  - MissionChip chain row is now TIERED: claimed-tier emoji badges (🔥🪖) + 3 diamonds for the current tier + next-reward label (→ Jetpack / → Tank / → TNT Mega). Verified: "CHAIN BONUS → TNT MEGA" renders after tier 2.
- Misc: jetpack thrust now adds a tiny recoil shake (random ~2.4/s × 0.05); CHAIN_GOAL import cleaned up in game.ts.
- Verification: lint 0 problems, tsc 0 errors, zero console errors, dev.log clean; agent-browser E2E — heli spawn at 5 stars + climb to rooftop-safe alt (y 10→40→minAlt 70), AIR SUPPORT chip + minimap ring, door-gun burst (hitMark 0→1, health 20→17), heli LOS keeps evadeT at 0 while visible, heli despawn at stars<5; tank enter → gun-cam + Speedo + reload chip, cannon fire → shell → 1047 voxels carved, scorch decal on ground explosion, tank crush (sedan 100→0 hp → burning), exit works; chain tier-2 reward flow grants a tank + toast; start screen copy/controls verified.

Stage Summary:
- New systems this cycle: police helicopter air support (orbit AI, rooftop-safe altitude, volumetric searchlight, door-gun bursts with tracers, LOS integration forcing underground evasion), Rhino Tank with full gunnery (rotating turret, camera-ray aiming, shell projectiles with gravity + impact explosions), tiered contract-chain rewards (jetpack → tank → TNT mega packs), scorch decals, SVG speedometer with hull + cannon reload readout, cinematic vignette.
- All browser-verified; lint/tsc clean; zero console errors.
- Known quirks: heli LOS is horizontal-distance based (<135 m, no occlusion raycast — acceptable for an airborne unit); heli gun damage is probabilistic spread (62%); tank shells vs wrecked/falling cars are skipped (no overkill); scorch decals don't stick to building walls (ground only by design); headless throttling makes game-time crawl (deterministic QA via direct runtime calls, real GPU browsers unaffected).
- Next-cycle priorities (suggested): (1) mobile touch controls (dig/place/drive/fire buttons), (2) draw-call reduction via material atlas for ~175 buildings, (3) heli spotlight as gameplay tool — spotlights expose you to ground cops even behind cover (deepen stealth loop), (4) tank vs police balance — cops should target the tank with ramming + heli focuses tank, (5) radio station HUD presets + volume settings persisted in save.

---
Task ID: cron-review-6 (2026-10-10)
Agent: Z.ai Code (webDevReview cycle 6)
Task: Status assessment + QA via agent-browser; then feature development — police roadblocks with spike strips, destructible hydrant geysers, respray heat fix, HUD styling pass

Work Log:
- QA BASELINE: dev.log clean, lint 0 problems, tsc 0 errors (game code), agent-browser fresh session — game loads (175 buildings / 34 cars / 26 NPCs), carve pipeline works (109 voxels), pause menu + settings panel render, ZERO console errors in cleared console. Verdict: STABLE → feature development.
- DISCOVERY — undocumented prior-session work found in code (previous session ran out of context before writing its worklog entry). QA-verified it all works and documented here:
  - PAY'N'SPRAY (game.ts + audio.spray()): 2 neon garages on parking lots (cyan pulsing ring + arch + sign + PointLight). Drive in slow → clears wanted heat + full repair + heal 4 for a CHAOS fee; 20s cooldown; HUD chip shows nearest bay distance; minimap cyan disc with 'S'; controls list row; spray() = aerosol hiss + 2-note jingle.
  - TOUCH CONTROLS (hud.tsx TouchControls + input.ts virtual layer): analog joystick (pointer-captured, R=50 clamp), full-screen drag-look, action buttons (dig hold / place / jump / jet / fly down / sprint toggle + E/M/F chips), tap-to-use items, settings-gated (Settings → Touch ON/OFF). Verified rendering in browser.
  - SETTINGS PANEL (game.ts settings + save.ts + hud.tsx SettingsPanel): master volume slider (0-100, persisted), radio presets (OFF/HYP FM/MIDNIGHT/VOXEL HARDWARE, live-apply while driving), touch toggle; writeSettings() persistence verified round-trip.
  - HELI SPOTLIGHT EXPOSURE (game.ts): beam hot-spot within 5.6m → SPOTTED lock 3.6s (ground cops converge even behind cover, evade reset), SpottedChip + toast; verified via runtime.
  - TANK-vs-POLICE balance already present: cops bounce off the Rhino taking 24 dmg themselves; heli door-gun prefers the tank (0.8 hit chance, chews hull 5hp).
- BUG FIX (real): Pay'n'Spray respray left residual heat — fee was capped at 150 but heat was only reduced by the fee (heat 350 → 200 remaining) while the toast claimed "heat cleared". GTA canon: the garage clears your wanted level entirely. Fix: heat = 0 when wanted (fee = service cost); also now repairs shredded tires (tires=1). Verified: heat 420 → 0, tires fixed.
- FEATURE: POLICE ROADBLOCKS (game.ts spawnRoadblock/updateRoadblocks/clearRoadblock + vehicles.ts makeParkedPolice/removeCar + hud.tsx RoadblockChip + globals.css):
  - At 4+ stars while driving faster than 9 m/s, every 13-19s a blockade drops ~105m AHEAD of the player, snapped onto the current road centerline (skips intersections): spike strip with 11 silver teeth, red/white hazard barricade boards on legs, 4 cones, 2 angled parked cruisers with manually-flashed lightbars.
  - SPIKE STRIPS: non-tank car crossing the strip at >6 m/s → tires shredded (max speed ×0.52, accel ×0.65, strong sinusoidal yaw pull, rubber debris) + toast; tank tracks immune. Fix: Pay'n'Spray respray.
  - BARRICADE: smash through at >9 m/s (strip flies off with tumble animation, −9 hull) or bounce off slow; tank always smashes; +8 score per smash.
  - Cleanup when stars < 4 (+70m away) or 240m past — cruisers despawned (a stolen roadblock cruiser the player drives is spared); shared geometry/material cache built once (no per-spawn leak).
  - HUD: ROADBLOCK chip (animated marching hazard-stripe icon via hyperion-hazard keyframes, live distance, "DODGE OR SMASH" pulsing state under 45m via hyperion-roadblock-pulse), blinking red ✕ minimap markers.
- FEATURE: FIRE HYDRANTS (game.ts buildHydrants/maybeBreakHydrants/burstHydrant/updateHydrants + particles.ts water system + audio.ts geyser loop):
  - 27 instanced hydrants (body cylinder + dome cap, shared geo/mat → 2 draw calls) on sidewalk corners at alternating intersections, skipping building footprints.
  - Explosions (radius ×1.1) or street-level digs within radius shear them: cap vanishes, body topples, red debris, toast; geyser runs 15-22s (pressure decays).
  - WATER GEYSER: new dedicated water Points system (520 particles, custom WATER_FRAG shader — bright cyan-white droplets, NormalBlending), waterJet() launches 3-4/frame with 7.5-14 m/s upward velocity + -16.5 gravity arc; verified 103 active particles, 13m column at correct world position.
  - CONSEQUENCES: extinguishes fire patches within 7m, douses burning cars within 6.5m (vehicles.extinguish + steam), proximity-driven setGeyser() audio loop (noise → highpass 780 + bandpass 2600, gain by distance; stopGeyser teardown, dispose-safe); new hint "💧 Burst hydrant — the geyser douses fires & burning cars" within 26m.
  - Verified E2E: burst → geyserT 20 + cap hidden; fire placed near geyser → extinguished (fires 1→0); burning car near geyser → doused (parked, health floored).
- FEATURE: TIRE SHRED STATE (vehicles.ts): Car.tires (1 = fine, 0 = shredded) + wobbleT accumulator; drivePlayer applies speed cap, reduced accel, yaw pull while moving, rubber debris; HudState.driving.tires → speedometer "🛞 SHREDDED" flickering tag (hyperion-flame); verified in DOM.
- STYLING PASS: RoadblockChip (marching hazard stripes + proximity pulse), 🛞 Shredded speedo tag, hydrant hint, ROADBLOCK minimap ✕, controls list row ("🛞 Spike strips — 4★ roadblocks shred tires — respray to fix"), start-screen copy now mentions roadblocks + hydrant geysers, globals.css hyperion-hazard + hyperion-roadblock-pulse keyframes.
- QA VERIFICATION (agent-browser, deterministic runtime calls): roadblock spawned exactly 105m ahead on the driven road (pos 0,106 from yaw 0 origin), 2 cruisers + strip + boards + cones; spike crossing shredded tires (tires 1→0, speed damped, toast + chip); respray full-clear verified (420→0); tank smash-through (flyT triggered) + cleanup despawn (36→34 cars); water geyser particles confirmed (drawRange 103, positions within 0.5m of hydrant, up to y=13.3); dousing verified; fresh-session smoke test: 27 hydrants, carve ok, geyser ok, zero console errors.
- lint 0 problems, tsc 0 errors, dev.log clean.

Stage Summary:
- New systems this cycle: police roadblocks with spike strips + smash-through barricades at 4★, destructible fire hydrants with water-geyser columns that fight fires, respray full-heat-clear + tire-repair fix (real bug), tire-shred driving state, plus documentation of the prior session's undocumented Pay'n'Spray / touch controls / settings systems.
- All browser-verified; lint/tsc clean; zero console errors.
- Known quirks: hydrant corners are often visually enclosed by buildings (geyser can be hard to see from street level — placement skips building footprints but not their surroundings); roadblock spike strip is dark and low-profile at night (cones + cruisers carry visibility); water particles are normal-blended (not refractive); roadblock cleanup doesn't remove the flying strip mid-animation (it despawns with the group).
- Next-cycle priorities (suggested): (1) hydrant placement bias toward open corners (raycast 4 ways before accepting a spot), (2) spike strips visible glow at night (emissive edges), (3) roadblock dispatch prediction (aim ahead of the car's ACTUAL lane using traffic dir, not yaw), (4) contract type: "break through a roadblock" tied to onRoadblockSmash, (5) draw-call reduction via material atlas for ~175 buildings, (6) water puddle decals left by geysers (reuse scorch decal system with blue tint).

---
Task ID: cron-review-7 (2026-10-10)
Agent: Z.ai Code (webDevReview cycle 7)
Task: Status assessment + QA via agent-browser; then feature development — GTA stunt jump ramps + air-time scoring + STUNT MAN contract, roadblock dispatch lane prediction, HUD styling pass

Work Log:
- QA BASELINE: dev.log clean (compiles + 200s), lint 0 problems, tsc 0 errors (game code; only vendored examples/skills noise), agent-browser fresh session — start screen renders, game runs (175 buildings / 34 cars / 26 NPCs), carve pipeline works (15 voxels), ZERO console errors. One repeat of the known about:blank first-launch glitch — re-open resolved it. Verdict: STABLE → feature development.
- DISCOVERY — undocumented prior-session work found in code (session ran out of context before its worklog entry, again). QA-verified ALL of it works and documented here:
  - ROADBLOCK RUN ('smash') + FUEL CRISIS ('gas') contract types wired end-to-end (missions.ts DEFS + onRoadblockSmash/onGasBlowup; game.ts fires them on barrier smash / pump detonation).
  - WATER PUDDLE DECALS: addPuddle() — faint blue sheen circles under active geysers, jittered placement, 25s fade, shares the scorch FIFO (cap 26).
  - SPIKE-STRIP NIGHT GLOW: emissive end-cap lights on the strip (0x400000 body, 0xff2418 emissive 2.2), intensity oscillated 0.9-3.1 in updateRoadblocks — reads at night.
  - HYDRANT OPEN-CORNER BIAS: buildHydrants probes 4 ways (±3.5m) and skips corners with >1 building neighbor — verified placement logic.
- FEATURE: STUNT JUMP RAMPS (game.ts — the GTA signature, cycle's headline):
  - 4 mid-block launch ramps (yellow/black chevron incline via custom canvas texture, dark steel body, glowing amber edge strips for night visibility). Custom buildWedgeGeometry(): non-indexed right-triangle prism with 2 material groups (incline/walls), correct outward winding verified in-browser.
  - Placement: fixed slots on alternating road axes at mid-block positions, nudged/skipped to stay 26m clear of gas stations + Pay'n'Spray lots, kept 18m inside the city edge.
  - LAUNCH: grounded car (>8 m/s) crossing the incline face along the launch direction → airborne (vy = min(19, speed×0.6), apex up to ~8m at top speed). Physics lives in game.ts airCars map (vehicles.ts ground clamp only pushes up, so no conflict); gravity 22, nose pitch follows vy (climbs nose-up, falls nose-down, resets on land).
  - Airborne gating: drivePlayer frozen mid-air (momentum carries), spike strips + barricade checks y-gated (<0.5/0.6m) so a jumped car sails clean over roadblocks; facade splat: flying into a building AABB reverts to last-good pos, kills forward speed (×−0.18), damps vy, debris + damage.
  - LANDING: dust burst + thud + shake scaled by impact; hard landing (>15 m/s) chips hull; AI cars get launched too (spectacle) and can be wrecked by hard landings. Deep-pit handoff: landing over a carved pit converts traffic cars to the engine's own 'falling' state (explosion chain preserved) — reclaim logic prevents vehicles.update from double-integrating.
  - BACK-WALL CRASH: approaching the tall end against the launch direction at >6 m/s → speed bounce (×−0.22), debris, shake, coaching toast. Verified: −16 m/s → +3.52 m/s + toast in DOM.
  - AIR TIME SCORING (player car only): t ≥ 0.55s on landing → +26 CHAOS/s, toast, missions.onStuntAir(t); session-best tracking (bestAir) with 🏆 NEW RECORD toast; save.ts v1 optional bestAir field, saveNow/applySave round-trip verified (1.2 written → zeroed → restored 1.2).
- FEATURE: STUNT MAN CONTRACT ('stunt' kind in missions.ts): "Log 4.5s of air time off the yellow stunt ramps", 95s timer, +190 CHAOS, Ender Pearl ×6 + TNT ×6. Fractional progress renders as x.x in MissionChip. Verified E2E via runtime: offer→accept→onStuntAir(2.0)→progress 2/4.5→onStuntAir(3.0)→complete + chainCount 1.
- FIX: ROADBLOCK DISPATCH LANE PREDICTION (cycle-6 priority #3, the last unimplemented one): spawnRoadblock now (a) flips the heading by the velocity sign (reversing at 4★ no longer drops the blockade behind you... or ahead in the wrong direction), (b) snaps onto the road the car is CURRENTLY on (centerline nearest the car, not the 105m-projected point that could snap to a cross street mid-turn), (c) aborts when off-road (bestD > 5m). Verified: +x at z=2 → blockade (105, 0); speed −20 → blockade (−105, 0).
- FIX: AIR TIME landing pop never faded in throttled tabs (CSS animation fill stalls when rendering is blocked) — pop lifetime is now engine-driven (airPopT 2.2s of game time → airPop null → React unmounts). HUD overlay made fully stateless (no useEffect setState — also satisfies the react-hooks/set-state-in-effect lint rule).
- STYLING PASS (mandatory detail mandate):
  - AIR TIME overlay: live airborne counter (5xl italic amber gradient, heartbeat pulse via new hyperion-airlive keyframes) + landing pop (+N CHAOS emerald gradient, scale-in drift-out via new hyperion-airpop keyframes) + subtle "best Xs" line under the live counter.
  - Speedometer: new "🪂 Airborne" amber tag (alongside Shredded/CANNON tags) while state.air > 0.12.
  - Minimap: pulsing amber chevron markers at all 4 ramps (outlined triangles, sin-pulse alpha).
  - Hint: "🛫 Stunt ramp ahead — hit it at speed for AIR TIME!" when driving >12 m/s within 34m of a ramp.
  - CONTROLS list + start-screen copy updated (ramp row + stunt paragraph).
- QA VERIFICATION (agent-browser, deterministic runtime calls + real-frame play): 4 ramps built at (−48,−96)/(80,96)/(−32,80)/(64,−112); sync-loop launch → 1.29s flight → +34 CHAOS, pop {sec 1.29, score 34, record}, bestAir 1.29, pitch reset; real-frames launch → airborne y 3.4m captured in screenshot WITH live "AIR TIME 0.6s" overlay + speedo 🪂 AIRBORNE tag + ramp hint chip (showcase shot); scored landing 1.2s → +31, NEW RECORD toast; wall crash bounce verified; contract E2E verified; dispatch fwd/rev verified; save round-trip verified; fresh-session smoke: 4 ramps, 175 buildings, zero console errors.
- QA LESSONS: (1) innerText applies CSS text-transform in Chrome — case-sensitive 'Air time' matches fail against 'AIR TIME'; (2) CSS animation fills stall in render-throttled headless tabs — engine-side TTLs are the reliable pattern; (3) headless game-time crawls ~20:1 under load — arm test cars close to trigger zones; (4) player camera yaw convention is opposite to car yaw (player yaw π/2 faces −x).
- lint 0 problems, tsc 0 errors, zero console errors, dev.log clean.

Stage Summary:
- New systems this cycle: GTA stunt-jump ramp network (custom wedge geometry + chevron texture + glowing edges), airborne car physics with launch/facade-splat/deep-pit-handoff/landing effects, air-time scoring with session records + save persistence, STUNT MAN contract feeding the existing chain-reward loop, velocity-aware roadblock dispatch prediction, engine-driven HUD pop lifetime.
- Documented + QA-verified the undocumented prior session's systems (smash/gas contracts, puddle decals, spike-strip night glow, hydrant open-corner bias).
- All browser-verified; lint/tsc clean; zero console errors.
- Known quirks: slow-speed ramp hits (< ~10 m/s after drag) produce sub-0.55s hops that don't score (by design — keeps ramps a speed mechanic); the ramp wedge has no floor collision so a car landing exactly on it visually clips briefly at low speeds; AI cars launched into the air keep their ground steering state frozen (momentum only) — acceptable spectacle; jetpack chain reward at tier 1 can re-grant if a second chain completes with the jetpack still in inventory (maxStack 1, sits unused).
- Next-cycle priorities (suggested): (1) ramp visual polish — skid marks / tire screech audio on launch approach, (2) slow-motion air-time camera effect (brief timeScale dip on big airs) if frame pacing allows, (3) draw-call reduction via material atlas for ~175 buildings (carried priority), (4) stunt contract variety — "landing zone" rings placed after ramps for bonus multipliers, (5) occlusion raycast for heli LOS (carried), (6) water puddle reflections at night (emissive envMap trick on puddle decals).

---
Task ID: gta-look-1 (2026-10-10)
Agent: Z.ai Code (main)
Task: Save project to GitHub branch + GTA 5 visual overhaul (reference: Gorka Games "How to Create GTA in Unreal Engine 5 - Full Course" + user's GTA 5 screenshots)

Work Log:
- GITHUB: remote origin set to 7clan/mineXgta; branch `project-hyperion` created with full project commit. PUSH BLOCKED: the provided fine-grained PAT has NO "Contents: read and write" permission (API says admin, but blob-create/push return 403 "Resource not accessible by personal access token"). USER ACTION NEEDED: GitHub → Settings → Developer settings → Fine-grained tokens → edit token → Repository access: 7clan/mineXgta → Permissions → Repository permissions → Contents: **Read and write** → save; then run `git push -u origin project-hyperion` (remote is already configured in the sandbox).
- RESEARCH: video identified via oEmbed = Gorka Games UE5 GTA full course; gorkagames.com resources = gated UE5 city-asset zip (not usable in WebGL directly). Extracted the LOOK instead (matching the user's screenshots): dusk purple-pink sky, lit skyscraper windows, neon billboards, wet reflective streets, palm-lined avenues, glossy metallic cars, filmic grade.
- RENDERING PIPELINE (game.ts): EffectComposer chain = RenderPass → UnrealBloomPass (0.42/0.5/0.85) → GradeShader (S-curve contrast 1.07, saturation 1.13, teal-orange split-tone, in-shader vignette) → OutputPass; ACES tone mapping retained. Bloom toggle in Settings (persisted `hyperion-settings-v1.bloom`), quality tier 2 auto-drops bloom; auto-quality now has a 6 s warm-up grace + requires 2 consecutive low-fps samples (startup dips no longer kill bloom instantly).
- SKY (game-utils.ts): new 4-stop GTA dusk gradient (horizon/bottom/mid/top) + sun-azimuth glow band in the shader + dithering; added moon sprite (procedural canvas: disc + craters + halo, night opacity), sun sprite now rides the actual cycle direction and fades out at night (fixes the giant white bloom blob at night); stars 420→620; cloud material exposed via scene.userData.cloudMat — tinted white→pink→dark across the cycle; boot time set to 17:45 (GTA dusk).
- DAY/NIGHT PALETTE (game.ts): full GTA dusk set — indigo top 0x40307a, hot-pink mid 0xc45496, amber-orange bottom 0xff8a50, amber horizon 0xff7e4d, purple dusk fog; hemisphere light drifts violet at dusk / deep blue at night; environmentIntensity dims at night.
- NEW FILE props.ts (~570 lines) — GTA street dressing, all procedural canvas: 12 parody-brand billboard ads (SPRUNK, LUXOR, AMMU-NATION, 24/7, ROGUE, FLEECA, CLUCKIN' BELL, BOBO, UP-N-ATOM, WIZARD ISLE, LOS SANTOS CUSTOMS, COFFEE SHARK) drawn as 512×256 canvases used as map+emissiveMap; 11 rooftop billboards on the tallest well-spaced buildings (legs + truss skirt) + pole billboards on avenue edges; emissiveIntensity night-driven with one dying-tube flicker board; WORKING TRAFFIC LIGHTS — merged pole+arm+housing instanced at 25 major intersections ×2 diagonal poles, DoubleSide 3-lamp stacks, real phase cycle (green 8 s → amber 2 s → red 10 s, citywide synced, emissive boosted at night); POWER POLES + 48 sagging catenary wire lines on two avenues (intersection-skipping placement); 24 NEON SHOP SIGNS (BAR/DINER/NOODLES/MOTEL/LIQUOR/PAWN/...) on street-facing facades (face-road-edge distance test), additive-style MeshBasic with breathing opacity + rare stutter; rooftop clutter: water towers (tank+cone+4 legs), AC boxes, antennas with blinking aviation beacons.
- VEHICLES (vehicles.ts): paint → MeshPhysicalMaterial clearcoat 1.0 / clearcoatRoughness 0.06 / envMapIntensity 1.35 (candy metallic GTA paint), glass → physical clearcoat 0.6; new 12-color palette (crimson, deep black, pearl white, teal, sunset orange, lime, magenta, royal purple, silver, champagne gold, racing green, burnt sienna); taillight emissive up.
- CITY (city.ts): asphalt baseline roughness 0.94→0.78 + envMapIntensity 0.55 (dusk sky sheen on streets; rain setWet rebased to match).
- HUD (hud.tsx): minimap restyled GTA-5-style — thick black frame, in-map clock + "LOS SANTOS" strip, health bar strip under the map (green → red gradient when low); CHAOS score now money-style "$N" (Arial Black italic, green with hard shadow); Settings panel adds "✨ Bloom glow" toggle.
- QA (agent-browser): start screen → NEW GAME; zero console errors; composer active + toggle round-trip persists to localStorage; carve works (4 voxels); car enter ("Comet Sports") + drive + radio chip + speedo + exit; pause menu Settings shows Bloom/Touch/Radio; screenshots verified dusk (purple-pink + glowing windows), noon, night (starry sky + streetlight grid + neon/billboard glow, no sun blob); aerial night shot shows streetlight grid + neon signs + billboard glow. lint 0 problems, tsc 0 errors, dev.log clean.

Stage Summary:
- The game now boots into a GTA 5 dusk city: filmic graded image with bloom-lit windows/neon/billboards, purple-pink sky with sun-side glow, working traffic lights, power lines, water towers, blinking aviation beacons, glossy clearcoat cars, GTA-style HUD (money counter, framed minimap with clock + health strip).
- Known quirks: in headless software rendering bloom auto-drops after the 6 s grace (by design — weak-GPU fallback; real GPU browsers keep it); traffic lights are decorative (AI cars don't brake at red — good next-cycle feature); minimap draw can flicker black in heavily throttled headless tabs (pre-existing).
- Next-cycle priorities: (1) AI traffic brakes/stops at red lights + player running a red raises heat, (2) GTA-style mission text popups ("Mission Passed" banner with jingle on contract complete), (3) pawnshop/ammunation interiors or doors on some buildings, (4) bridge + highway overpass props, (5) push to GitHub once the token gains Contents:write, (6) daytime reflections via cube envmap refresh per time-of-day.

---
Task ID: 3-c
Agent: HUD Minecraft-restyle agent (subagent 3-c)
Task: Restyle game HUD elements into an authentic Minecraft replica look — MC hotbar slots + white selection frame, polished hearts row, new decorative hunger bar (pixel drumsticks), new XP bar driven by chaos score, and a Minecraft creative-inventory restyle of the inventory overlay. Files touched: src/components/game/hud.tsx + src/app/globals.css only.

Work Log:
- Read hud.tsx fully (HudProps, HudState usage, Slot, Hearts, hotbar row, inventory overlay, itemIconURL pixel-icon pipeline) + engine/types.ts (confirmed HudState.score exists) + engine/items.ts (confirmed ITEMS/ItemDef.kind union + UI_ICONS) before editing.
- Hotbar: replaced generic dark-glass frame (rounded border-2 black/60 bg-black/40) with per-slot classic MC cells — 48px sharp square, bg rgba(0,0,0,0.42), 2px inset borders (top/left #2b2b2b, bottom/right #5a5a5a), 1px outer ring at 35% black; slots butt together with 2px gaps, no rounded corners, no outer container frame.
- Selection: new absolute -inset-[3px] overlay frame, 3px solid #f0f0f0, extending ~3px beyond slot bounds with soft white glow (box-shadow 0 0 8px rgba(255,255,255,0.45)); replaced the old scale-110 outline treatment. Click/scroll behavior untouched (still props.onSlotClick).
- Hearts: 22px → 18px, added 1px black drop-shadow (MC sprite look), kept 2px gap and full/empty logic.
- Hunger bar (new): module-level drumstickIconURL() builds a cached 9×9 pixel canvas data URL (dark outline #3b2a1e, meat #b5654a with #d8936e highlight top-left, tan bone #e8dcc0 diagonal to bottom-right); HungerBar renders 10 static full drumsticks at 18px (imageRendering pixelated, scaleX(-1) so bones point bottom-left mirroring the hearts side), right-aligned in the same row as hearts, SSR-guarded via typeof document.
- XP bar (new): XpBar component — 6px bar spanning exactly the hotbar width (flex items-stretch column), #1c1c1c track with 1px #000 border, #7efc20 fill with lighter inset top edge, level number centered ON the bar in #7efc20 font-bold tabular-nums with 8-direction heavy black text-shadow. Driven from state.score: level = floor(score/100), progress = (score%100)/100 (no fallback needed — score field exists).
- Bottom-center stack restructured (bottom→top): hotbar, hearts+hunger mirrored row, XP bar, actionbar line (creative flight tag / selected item name — moved above the XP bar, keeps min-height to avoid layout jump). z-index layering and pointer-events contract unchanged.
- Inventory overlay → MC creative panel: extracted into InventoryOverlay component with local useState tab filter. Panel: #c6c6c6, 2px black outer border + 3px raised bevel (top/left #ffffff, bottom/right #555555), zero border-radius, p-4/5, title "Creative Inventory" #3f3f3f. Tabs: 🧱 Blocks (placeable+tnt), ⚔️ Tools (tool+weapon+igniter), 🍎 Misc (food+throwable+jetpack) — active tab #c6c6c6 merged into panel top (-mb-[2px] over black border), inactive #8b8b8b, black text, rounded-t-[6px] only. Grid filters via ITEMS[stack.id].kind with ORIGINAL inventory indices preserved for onInventorySwap; flex-wrap grid; empty-tab placeholder. Slots: 44px MC inset style (bg #8b8b8b, top/left #373737, bottom/right #ffffff), icons at 32px, white/40 hover overlay (group-hover), hotbar mirror row with white selection frame. Close button now a 28px MC beveled ✕. Backdrop kept bg-black/55 + backdrop-blur-[2px]; panel responsive (w-[470px] min-w-[340px] max-w-[92vw], max-h ~80vh, overflow-y-auto + custom thin MC scrollbar).
- globals.css: added .hyperion-mc-scroll thin beveled scrollbar styles (firefox scrollbar-color + webkit pseudo styles).
- Untouched: TouchControls, minimap, chips, mission UI, pause/death/start screens, Stars, engine/*.
- Verification: bun run lint → 0 problems; bunx tsc --noEmit → 0 errors in project source (only pre-existing vendored noise in examples/ + skills/).

Stage Summary:
- HUD bottom-center is now a faithful Minecraft survival stack: XP bar (chaos-score driven) above mirrored hearts/hunger row above the 9-slot MC hotbar with the iconic white selection frame.
- Inventory overlay is now a Minecraft creative panel with functional kind-based filter tabs; all swap/close behavior and z-index layering preserved.
- New pixel-art drumstick generated in-hud via cached 9×9 canvas; XP level = floor(score/100), progress = (score%100)/100 from HudState.score.

---
Task ID: 3-b
Agent: blockset-subagent (3-b)
Task: Expand the placeable block set to original-Minecraft iconic blocks — add 6 new placeable items (grass, stone, log, leaves, sand, bricks) across types.ts, items.ts, textures.ts, game.ts, save.ts (icons, textures, materials, inventory, debris colors, save compatibility).

Work Log:
- types.ts: extended ItemId union with 'grass' | 'stone' | 'log' | 'leaves' | 'sand' | 'bricks'; added a shared `PlaceableId` union (the 10 placeable block kinds); retyped `AimHit.grant` from the inline 4-kind literal to `PlaceableId` so newly granted block types flow through the dig pipeline type-safely.
- items.ts: added 6 new ITEMS entries copying dirt's numeric shape (kind 'placeable', maxStack 64, digRadius 0, cooldown 0.2), each with a hand-drawn 16x16 pixel-art icon + palette and spec'd heldColor: grass (green top strip + jagged transition over dirt body, 0x5d9c3f), stone (gray speckle, 0x8a8a8a), log (vertical bark stripes with knots, 0x6b5233), leaves (mottled greens, 0x3f7d2c), sand (pale yellow speckle, 0xd8cf9e), bricks (3 brick bands with light #a8a8a8 mortar rows + half-brick-offset middle band, 0x96513d). Names: Grass Block / Stone / Oak Log / Oak Leaves / Sand / Bricks. ICONS auto-generate via existing initIcons().
- items.ts makeBlockMaterial: kind union widened to the full placeable set (typed as PlaceableId); added module-level `blockMatCache = new Map<PlaceableId, THREE.MeshStandardMaterial>()` so repeated place/load calls now SHARE one material per block kind (previously a fresh material per call leaked per placed block; glass behavior identical but cached too); texture mapping grass→'grass-side', log→'log-side', others 1:1; roughness map: planks 0.7, sand 0.9, leaves 0.85, glass 0.05 (unchanged), everything else 0.95. Break only disposes geometry, so shared materials are safe.
- textures.ts: makeBlockTexture kind union extended with 'grass-side' | 'stone' | 'log-side' | 'log-top' | 'leaves' | 'sand' | 'bricks' (exported as BlockTextureKind); seed source moved to an explicit BLOCK_SEEDS table — legacy kinds keep their exact original `0xb10c + len` seeds (dirt/cobblestone/planks/grass-top pixels unchanged), new kinds get distinct seeds. New 32px tiles: grass-side = dirt base + per-column green strip (8-11px, jagged bottom dipping 2-4px + dark #3f6e28 fringe); stone = gray pixelNoise; log-side = per-column bark color with vertical streak breaks; log-top = bark ring + concentric wood rings via disc() (#a8834f / #8a6a3c) + center knot; leaves = mottled greens + deep-shadow holes; sand = pale yellow noise; bricks = mortar base + 4 rows of 15x7 bricks, alternating fills, rows offset by 8px (half brick), speckle finish.
- game.ts: (1) initInventory now also gives grass 64, stone 64, log 32, leaves 32, sand 64, bricks 64 (inventory has room: 16 distinct ids vs 27 slots); (2) placed-block aim hit grants `b.type` directly (old grant ternary chain removed — every placed block now grants itself when broken); (3) carve debris color now uses module-level DEBRIS_COLORS map (dirt/grass 0x6b4a2f, stone 0x8a8a8a, cobblestone 0x777777, sand 0xd8cf9e, bricks 0x96513d, log 0x6b5233, leaves 0x3f7d2c, planks 0xa9844f, fallback 0x55555a) instead of the 2-way ternary; (4) placeBlock narrows once via `const kind = type as PlaceableId` (with comment: useItem only routes kind==='placeable' items here — verified caller) and passes makeBlockMaterial(kind); PlacedBlock.type retyped to PlaceableId; (5) applySave's existing makeBlockMaterial(type) compiles unchanged against the widened signature.
- save.ts: SAVE_TYPES extended append-only to ['dirt','cobblestone','planks','glass','grass','stone','log','leaves','sand','bricks'] with a MUST-append comment — old saves keep valid indexes 0-3, new block kinds serialize at indexes 4-9 via the existing SAVE_TYPES.indexOf write path and restore via the existing index lookup; saveNow's `b.type as (typeof SAVE_TYPES)[number]` cast still compiles.
- Placeable-validation sweep (spec item 7): RMB place logic goes through useItem()'s switch on ITEMS[id].kind === 'placeable' (ITEMS-driven, auto-covers new items); HUD renders icons/names generically from ICON_URLS/ITEMS (no hardcoded block lists in hud.tsx); city.ts strata grants ('dirt'/'cobblestone') remain valid against the widened AimHit.grant; TNT placement paths (placeTNT/makeTNTMaterials) untouched.
- Verification: script-checked all 6 new icons (16 rows x 16 cols, every palette key used/defined); `bun run lint` = 0 problems; `bunx tsc --noEmit` = only the 4 pre-existing vendored examples//skills/ errors, zero errors in src/. Tooling note for future agents: the Bash-output transport eats `[h` sequences (e.g. displays `DEBRIS_COLORS[hit.grant]` as `DEBRIS_COLORSit.grant]`) — use the Grep/Read tools, not Bash rg/git-diff eyeballing, to verify bracket-containing lines.

Stage Summary:
- Placed-block set expanded from 4 to 10 Minecraft-iconic types (dirt, cobblestone, planks, glass, grass, stone, oak log, oak leaves, sand, bricks): each with pixel-art hotbar icon, procedural 32px block texture, shared cached MeshStandardMaterial, self-granting drops, per-type debris colors, and save/load support (append-only SAVE_TYPES keeps all existing saves valid).
- Key decisions: introduced PlaceableId as the single source of truth for the placeable set (AimHit.grant, PlacedBlock.type, makeBlockMaterial, blockMatCache all typed by it); single-cast narrowing in placeBlock instead of signature change; material cache fixes a per-block material leak; texture seeds table preserves legacy tiles byte-identically while giving new kinds distinct seeds.
- Known quirks: grass/log render their side texture on all 6 faces (no per-face material groups on RoundedBoxGeometry — top/bottom variation would need multi-material geometry, out of scope); leaves are opaque (no alpha holes) by design; new blocks land in the inventory (hotbar stays 9 items) — reachable via the inventory UI.
---
Task ID: gta-look-2 (2026-10-10)
Agent: Z.ai Code (main)
Task: GitHub save (user fixed PAT permissions) + "make the game EXACTLY like the GTA 5 photos" with mandatory photo-comparison every change + GTA 5 NPC design + Minecraft exact-replica pass

Work Log:
- GITHUB SAVE COMPLETE: user fixed the fine-grained PAT (Contents: read/write). Remote origin set to 7clan/mineXgta with the new token; pushed commit "Save state: GTA5 NPC reference photos + latest worklog" (9d350b3) to BOTH `main` and `project-hyperion` — `git ls-remote` confirms both branches at 9d350b3. Comparison reference photos stored in upload/ (6 GTA scene refs + NPC search screenshot).
- COMPARISON WORKFLOW (user mandate: "every time you change make a comparison either with my photos or the search online"): baseline captured BEFORE changes (tool-results/baseline-2-dusk-street.png), after-shots per feature, all verified against the user's uploaded GTA 5 refs (downtown dusk w/ lit windows, sunny street driving, NPC closeups, palm-lined avenues, car meet).
- NPC OVERHAUL (npcs.ts full rewrite, ~600 lines) — GTA 5 pedestrians, replacing the old capsule people:
  - Articulated rig: shoulder→upper arm→ELBOW→forearm+hand, hip→thigh→KNEE→shin+shoe (2-segment limbs, 16 meshes/NPC, shared geometry + shared material pools for perf).
  - FACES: 128px canvas FACE DECAL on a transparent plane floating just in front of the head sphere (deterministic, no sphere-UV guesswork): heavy brows, large eyes w/ iris+pupil+dark outline, nose shading, mouth, optional stubble/beard shadow, 6 skin tones. Verified readable at 1.2-2.5m (tool-results/npc-face-beauty.png).
  - Hair styles: bald / buzz / afro (shifted up+back so the face stays exposed — real bug found & fixed) / long w/ back panel / baseball cap w/ front brim; 5 hair colors.
  - Wardrobe archetypes: tee, tank top, SHIRTLESS (Trevor-style), suit w/ white chest V + tie, hoodie w/ draped hood, reflective safety vest, jacket; 12 shirt colors, 7 pants, 3 shoes.
  - Walk cycle: knee flex (heel kick peaking as the leg swings forward), elbow bend, torso bob, slight forward lean, head sway; flee = sprint w/ bigger amplitude + lean.
  - Idle behaviours: phone call (arm raised to ear, phone mesh parented to the right elbow so it follows), standing look-around w/ slow head sweeps; random transitions.
  - Ragdoll sprawl poses (limbs splayed) + get-up/respawn resets pose.
  - CRITICAL DISCOVERY: the model's true forward is -z (legacy convention hidden by the old symmetric capsules). Fixed globally: face decal side, cap brim, long-hair back panel, hood, suit V/tie, shoe toe, phone offset, faceRing yawMap [-PI/2, PI, PI/2, 0], torso lean signs. (Old NPCs had been walking backwards — nobody could tell with capsules.)
- MINECRAFT EXACT-REPLICA PASS (subagents 3-b + 3-c, both lint/tsc clean):
  - 3-b (blocks): placeable set 4→10 — +grass (grass-side texture w/ jagged green strip), stone, oak log (bark), oak leaves, sand, bricks (MC-style offset brick pattern w/ mortar). Pixel icons for all; makeBlockTexture kinds +7; makeBlockMaterial now PlaceableId-typed with a module-level material CACHE (fixes per-placement material leak); game.ts: initInventory gives new blocks, placed blocks grant THEMSELVES when broken, DEBRIS_COLORS map per block, save.ts SAVE_TYPES append-only (old saves stay valid).
  - 3-c (HUD): authentic MC hotbar (sharp slots, inset bevels, iconic white selection frame extending past the slot), hearts polished w/ black drop shadow, NEW hunger bar (10 pixel drumsticks, mirrored row), NEW XP bar (green #7efc20, level = floor(score/100)) driven by CHAOS score, inventory overlay rebuilt as the MC CREATIVE INVENTORY: #c6c6c6 beveled panel, tabs 🧱 Blocks / ⚔️ Tools / 🍎 Misc filtering by item kind, inset slot grid w/ hover highlight, MC close button, thin beveled scrollbar.
- BUG FIX (real UX): E could open but never CLOSE the inventory (engine update loop is gated by uiOpen so the in-loop KeyE check goes dead). Added a document-level capture keydown listener in HyperionClient: E or Esc closes the inventory MC-style while it's open.
- QA (agent-browser, deterministic runtime + real frames): fresh session boots 175 buildings/34 cars/26 NPCs, zero console errors; NPC closeup face verified (tool-results/npc-face-beauty.png); street scene w/ mid-stride pedestrians (final-2-npcs-day.png); creative inventory renders w/ tabs + pixel icons (inventory-test.png); placed 2 grass blocks via runtime placeBlock (placed.size 2, types ['grass','grass'], count 64→62, visible in world); hotbar shows new blocks; lint 0 problems; tsc 0 errors (src only).
- COMPARISON VERDICT vs user's refs: dusk city w/ purple sky + glowing windows ✓ (baseline-2 vs final-1), sunny street + palm + pedestrian ✓ (final-2 vs Franklin photo), NPC humans w/ faces/outfits ✓ (npc-face-beauty vs ref photo 1), MC hotbar/hearts/hunger/XP/creative inventory ✓, block building ✓. Remaining gap vs refs: building facades are still flat texture boxes (no inset windows/glass reflections), vehicle variety vs the car-meet photo, no overpass/highway signs — next cycle.

Stage Summary:
- The game now has living GTA 5-style sidewalks: articulated pedestrians with faces, hair, outfits, phone calls and panic sprints — plus a much deeper Minecraft layer: 10-iconic-block palette, creative inventory w/ tabs, hunger/XP bars, E-to-close inventory.
- GitHub: both branches pushed at 9d350b3 + this worklog commit; remote auth working.
- Known quirks: headless browser throttles game-time (QA uses runtime calls); NPC draw count grew (~16 meshes x 26) — auto-quality may drop NPC count if needed on weak GPUs; face decal slightly floats at the sphere edge (invisible at gameplay distance); inventory E-close fix needs a real-pointer-lock smoke test (headless lacks lock).
- Next-cycle priorities: (1) facade realism pass — inset window geometry / parallax-mapped glass + envMap reflections on tower styles (photo 7), (2) 2-3 new vehicle silhouettes (sports w/ spoiler, muscle, SUV — photo 3), (3) highway overpass + green exit signs (photo 2), (4) NPC density variety — pairs talking, sitting on benches, crossing at crosswalks, (5) first-person blocky hand holding the selected block (photo 6 GTA-FPS + MC hand), (6) block-break crack overlay animation.
