# Piranesi

A single-player 3D browser game: a procedurally generated house, larger than any cathedral,
with no doors to the outside. White colonnaded halls, staircases that rise floor after floor
into an endless top story, tides moving through the ground corridors, wrack on the water,
gulls in the rafters — after the House in Susanna Clarke's novel *Piranesi*.

**The game:** find all **40 gull eggs**, hidden across the floors. Every house is generated
from a seed — share it with a link (`?seed=…`).

## Play

```
npm install
npm run dev        # → http://localhost:5173
```

- **WASD** walk · **mouse** look (pointer lock) · **Shift** stride
- Walk up any staircase: the run rises exactly one floor and always opens onto open corridor —
  never into a wall, at the top or the bottom.
- The ground floor floods with the tide; wrecks drift on it.
- **M** mute · **Esc** pause

## The house (and the stairs)

The house is a deterministic function of its seed. Each floor is an 80×80 grid of 2 m cells
(160 m across) generated floor by floor:

- **Rooms & corridors** are grown per floor (random rectangles + meandering diggers);
  every open cell is connected.
- **Stair runs** are the contract of the House. A run is two stair cells on its base floor +
  a landing cell on the floor above (a 4 m run, 2.5 m rise — one Kenney staircase model).
  The generator *seeds the landings into the upper floor's corridor growth* before that floor
  is built, and a validator then asserts, for every run:
  - the landing upstairs has ≥2 open neighbours (≥1 of them ordinary floor) — you never
    emerge into a wall,
  - the base downstairs has an open approach — you can always *enter* a stair,
  - the throat cell is otherwise enclosed (you can only be on it via the run itself),
  - the cells above the run are solid (no room built through a staircase).
- **Infinity**: floors generate on demand and stream in/out around you; the House has no top.
- **Reachability**: eggs are only placed on cells proven reachable from the start by a BFS
  over all floors generated so far (connectivity only ever grows), so every egg is findable.

## Architecture

- `src/shared/` — engine-free core: seeded RNG, the `GeneratedHouse` generator + validators,
  tide curve. Fully unit-tested (`npm test`), including a 60-seed invariant sweep of every
  stair run.
- `src/game/world.ts` — Three.js renderer: Kenney models baked into instanced meshes per
  floor, streamed; tide plane, bobbing wrack, procedural gulls; fog + day/dusk cycle.
- `src/game/player.ts` — movement/collision/stair state machine (pure TS, no engine).
- `src/game/audio.ts` — WebAudio director (Kenney loops + synthesized water/steps).
- `src/app.ts` — composition root, HUD, menus, win state.
- `tests/` — unit + invariant tests; `*.omlx.test.ts` gated vision checks (`npm run test:visual`).
- `scripts/smoke-e2e.mjs` — headless-Chrome end-to-end: boots the game, climbs a real stair
  run floor 0→1 in the browser, collects an egg, screenshots (`npm run smoke`).

## Assets

All art and audio from **Kenney's "Game Assets All-in-1" 3.5** — CC0, no attribution
required (credited anyway): [kenney.com](https://kenney.io) — Building Kit, Mini Dungeon,
Watercraft Pack, Music Loops, Interface Sounds, Music Jingles. Gulls and gull eggs are
procedural (Kenney ships no 3D birds/eggs).
