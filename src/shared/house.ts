// The House: deterministic, lazy, effectively infinite.
//
// Every floor is a 160×160 m hall (80×80 cells) generated from its own RNG
// stream — floor i's shape depends only on (seed, i, floor i−1's stair runs).
// The stair contract is enforced by construction AND audited by checkFloor():
// a run's landing is carved into the floor above *before* that floor's rooms
// are grown, so you can never emerge from a staircase into a wall.

import {
  Cell,
  DX,
  DZ,
  FLOOR,
  FloorLayout,
  GRID,
  House,
  HouseConfig,
  STAIR,
  StairRun,
  Vec2i,
  WALL,
  runBase,
  runLanding,
  runTopCell,
} from "./types";
import { Rng, hashString } from "./rng";

const IDX = (x: number, z: number): number => z * GRID + x;
const inRange = (x: number, z: number): boolean => x >= 0 && x < GRID && z >= 0 && z < GRID;
const toVec = (idx: number): Vec2i => ({ x: idx % GRID, z: Math.floor(idx / GRID) });

/** Lowest / highest open cells per floor, enforced by the generator + validator. */
const MIN_OPEN = 400;
const MAX_OPEN = (GRID * GRID) / 2;

/** Rooms per floor and their side lengths. */
const ROOMS_MIN = 6;
const ROOMS_MAX = 9;
const ROOM_MIN = 5;
const ROOM_MAX = 10;

/** Floor-0 forced rooms. */
const START_ROOM_X = 37;
const START_ROOM_Z = 37;
const START_ROOM_S = 5;
const DOCK_X0 = 35;
const DOCK_Z0 = 37;
const DOCK_X1 = 43;
const DOCK_Z1 = 43;

/** Wrack placement ellipse (semi-axes, cells) centred on the grid centre. */
const WRECK_AX = 26;
const WRECK_AZ = 18;
const MIN_OPEN_EGGS_PER_FLOOR = 2; // eggs per floor: 2..3 (see generateFloor)

export class GeneratedHouse extends House {
  private readonly floors = new Map<number, FloorLayout>();

  constructor(config: HouseConfig) {
    super(config);
  }

  floor(i: number): FloorLayout {
    if (i < 0) throw new RangeError(`no floor ${i}: the House begins at 0`);
    for (let f = 0; f <= i; f++) {
      if (!this.floors.has(f)) this.floors.set(f, this.generateFloor(f));
    }
    return this.floors.get(i)!;
  }

  cell(f: number, x: number, z: number): Cell {
    if (f < 0 || !inRange(x, z)) return WALL;
    return this.floor(f).cells[IDX(x, z)] as Cell;
  }

  isWalkable(f: number, x: number, z: number): boolean {
    return this.cell(f, x, z) !== WALL;
  }

  // ── generation ───────────────────────────────────────────────────────────

  private generateFloor(i: number): FloorLayout {
    const rng = new Rng(hashString(this.config.seed) ^ Math.imul(i + 1, 0x9e3779b9));
    const cells = new Uint8Array(GRID * GRID); // WALL everywhere

    // Cells that must stay WALL: the s0/s1 of runs based one floor below —
    // anything open there would be a room built straight through a staircase.
    const protectedSet = new Set<number>();
    const landings: Vec2i[] = [];
    if (i > 0) {
      const prev = this.floor(i - 1);
      for (const run of prev.stairsUp) {
        for (const c of [runBase(run), runTopCell(run)]) {
          if (inRange(c.x, c.z)) protectedSet.add(IDX(c.x, c.z));
        }
        const L = runLanding(run);
        if (inRange(L.x, L.z)) landings.push({ x: L.x, z: L.z });
      }
    }
    const landingSet = new Set(landings.map((l) => IDX(l.x, l.z)));

    const carve = (idx: number): void => {
      cells[idx] = FLOOR;
    };
    const openList = (): number[] => {
      const out: number[] = [];
      for (let idx = 0; idx < cells.length; idx++) if (cells[idx] !== WALL) out.push(idx);
      return out;
    };

    // 1. Rooms — interlocking halls, allowed to touch and overlap.
    const roomCount = ROOMS_MIN + rng.int(ROOMS_MAX - ROOMS_MIN + 1);
    for (let k = 0; k < roomCount; k++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const w = ROOM_MIN + rng.int(ROOM_MAX - ROOM_MIN + 1);
        const h = ROOM_MIN + rng.int(ROOM_MAX - ROOM_MIN + 1);
        const x = rng.int(GRID - w + 1);
        const z = rng.int(GRID - h + 1);
        let hitsProtected = false;
        for (let zz = z; zz < z + h && !hitsProtected; zz++) {
          for (let xx = x; xx < x + w; xx++) {
            if (protectedSet.has(IDX(xx, zz))) {
              hitsProtected = true;
              break;
            }
          }
        }
        if (hitsProtected) continue;
        for (let zz = z; zz < z + h; zz++) {
          for (let xx = x; xx < x + w; xx++) carve(IDX(xx, zz));
        }
        break;
      }
    }

    // 2. Floor 0 forced rooms: the spawn hall and the flooded dock.
    if (i === 0) {
      for (let zz = START_ROOM_Z; zz < START_ROOM_Z + START_ROOM_S; zz++) {
        for (let xx = START_ROOM_X; xx < START_ROOM_X + START_ROOM_S; xx++) carve(IDX(xx, zz));
      }
      for (let zz = DOCK_Z0; zz <= DOCK_Z1; zz++) {
        for (let xx = DOCK_X0; xx <= DOCK_X1; xx++) carve(IDX(xx, zz));
      }
    }

    // 3. Landings inherited from below: carve, connect, reinforce.
    for (const L of landings) {
      const li = IDX(L.x, L.z);
      carve(li);
      this.connectLanding(cells, protectedSet, L, rng);
      this.reinforceLanding(cells, protectedSet, L, rng);
      cells[li] = FLOOR; // a landing is always plain FLOOR, never STAIR
    }

    // 4. Meandering corridors between the halls, + filler to MIN_OPEN.
    const meander = (steps: number): void => {
      const open = openList();
      if (open.length === 0) return;
      let cur = toVec(open[rng.int(open.length)]);
      let dir = rng.int(4);
      for (let s = 0; s < steps; s++) {
        if (!rng.chance(0.7)) dir = (dir + (rng.chance(0.5) ? 1 : 3)) % 4;
        const nx = cur.x + DX[dir];
        const nz = cur.z + DZ[dir];
        if (!inRange(nx, nz) || protectedSet.has(IDX(nx, nz))) {
          dir = (dir + (rng.chance(0.5) ? 1 : 3)) % 4;
          continue;
        }
        carve(IDX(nx, nz));
        cur = { x: nx, z: nz };
      }
    };
    for (let k = 0; k < 3; k++) meander(8 + rng.int(9));
    for (let k = 0; k < 16 && openList().length < MIN_OPEN; k++) meander(12);

    // 4b. Top-up: guarantee MIN_OPEN even if the meander no-oped.
    for (let k = 0; k < 500 && openList().length < MIN_OPEN; k++) {
      let idx = -1;
      for (let t = 0; t < 40; t++) {
        const cand = rng.int(GRID * GRID);
        if (cells[cand] === WALL && !protectedSet.has(cand)) {
          idx = cand;
          break;
        }
      }
      if (idx < 0) break;
      const cx = idx % GRID;
      const cz = Math.floor(idx / GRID);
      const dir = rng.int(4);
      for (let s = 0; s < 8; s++) {
        const nx = cx + s * DX[dir];
        const nz = cz + s * DZ[dir];
        if (!inRange(nx, nz) || protectedSet.has(IDX(nx, nz))) break;
        cells[IDX(nx, nz)] = FLOOR;
      }
    }

    // 4c. Connect every open component to the entry's component, so no hall,
    // run base or landing is stranded in a pocket the player can't reach.
    const entry: Vec2i | undefined =
      i === 0 ? { x: START_ROOM_X + 2, z: START_ROOM_Z + 2 } : landings[0];
    if (entry !== undefined) this.ensureConnected(cells, protectedSet, entry);

    // 5. Stair runs up to the next floor.
    const stairsUp: StairRun[] = [];
    const reserved = new Set<number>(); // s0/s1/L of runs on this floor
    const wantRuns = 1 + rng.int(3);
    for (let k = 0; k < wantRuns; k++) {
      const open = openList();
      let placed = false;
      for (let attempt = 0; attempt < 600 && !placed && open.length > 0; attempt++) {
        const idx = open[rng.int(open.length)];
        const x = idx % GRID;
        const z = Math.floor(idx / GRID);
        const dir = rng.int(4);
        if (!this.validRun(cells, landingSet, reserved, protectedSet, x, z, dir)) continue;
        cells[idx] = STAIR;
        cells[IDX(x + DX[dir], z + DZ[dir])] = STAIR;
        reserved.add(idx);
        reserved.add(IDX(x + DX[dir], z + DZ[dir]));
        reserved.add(IDX(x + 2 * DX[dir], z + 2 * DZ[dir]));
        stairsUp.push({ x, z, dir });
        placed = true;
      }
    }
    if (stairsUp.length === 0) this.forceOneRun(cells, landingSet, reserved, protectedSet, stairsUp);

    // 6. Floor 0: the tide, the wrack, the spawn.
    // (Runs before eggs: the reachability BFS seeds from the spawn cell.)
    const floodCells: number[] = [];
    const wrecks: FloorLayout["wrecks"] = [];
    let start: Vec2i | undefined;
    if (i === 0) {
      for (let idx = 0; idx < cells.length; idx++) if (cells[idx] !== WALL) floodCells.push(idx);

      const want = 6 + rng.int(4);
      const placed: Vec2i[] = [];
      const dockOpen: number[] = [];
      for (let zz = DOCK_Z0; zz <= DOCK_Z1; zz++) {
        for (let xx = DOCK_X0; xx <= DOCK_X1; xx++) {
          if (cells[IDX(xx, zz)] !== WALL) dockOpen.push(IDX(xx, zz));
        }
      }
      const shuffled = rng.shuffled(dockOpen);
      const fits = (c: Vec2i, spacing: number): boolean =>
        placed.every((p) => Math.hypot(p.x - c.x, p.z - c.z) >= spacing);
      for (const spacing of [3, 2]) {
        if (placed.length >= want) break;
        for (const idx of shuffled) {
          if (placed.length >= want) break;
          const c = toVec(idx);
          if (placed.some((p) => p.x === c.x && p.z === c.z)) continue;
          if (!fits(c, spacing)) continue;
          const roll = rng.next();
          const kind = roll < 0.5 ? "boat" : roll < 0.8 ? "crate" : "rocks";
          placed.push(c);
          wrecks.push({ x: c.x, z: c.z, kind });
        }
      }

      const spawnCells: number[] = [];
      for (let zz = START_ROOM_Z; zz < START_ROOM_Z + START_ROOM_S; zz++) {
        for (let xx = START_ROOM_X; xx < START_ROOM_X + START_ROOM_S; xx++) {
          if (cells[IDX(xx, zz)] !== WALL) spawnCells.push(IDX(xx, zz));
        }
      }
      start = toVec(spawnCells[rng.int(spawnCells.length)]);
    }

    // Build the layout and pre-cache it: the egg BFS below must be able to
    // read floor i (via reachableCells → floor(i)) without re-entering
    // generateFloor.
    const layout: FloorLayout = {
      index: i,
      cells,
      stairsUp,
      landings,
      eggs: [],
      ...(start !== undefined ? { start } : {}),
      floodCells,
      wrecks,
    };
    this.floors.set(i, layout);

    // 7. Eggs — only on cells proven reachable from the start.
    const total = this.config.totalEggs ?? 40;
    const maxEggFloor = Math.ceil(total / 2);
    const placedSoFar = this.eggsPlacedBelow(i);
    if (i <= maxEggFloor && placedSoFar < total) {
      const visited = this.reachableCells(i); // visited[f] = Set<idx> for f in 0..i
      const mine = visited.get(i) ?? new Set<number>();
      const candidates: number[] = [];
      for (const idx of mine) if (cells[idx] === FLOOR) candidates.push(idx);
      const nThisFloor = Math.min(
        candidates.length,
        MIN_OPEN_EGGS_PER_FLOOR + rng.int(2),
        total - placedSoFar,
      );
      for (let k = 0; k < nThisFloor; k++) {
        const pick = candidates.splice(rng.int(candidates.length), 1)[0];
        if (pick === undefined) break;
        layout.eggs.push(toVec(pick));
      }
    }

    return layout;
  }

  /** Carve a corridor from a fresh landing until it touches existing open space. */
  private connectLanding(
    cells: Uint8Array,
    protectedSet: Set<number>,
    L: Vec2i,
    rng: Rng,
  ): void {
    const hasOpenNeighbour = (x: number, z: number): boolean => {
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const nz = z + DZ[d];
        if (inRange(nx, nz) && cells[IDX(nx, nz)] !== WALL) return true;
      }
      return false;
    };
    if (hasOpenNeighbour(L.x, L.z)) return;

    // Random walk with straight bias (the corridor look), bounded…
    let cx = L.x;
    let cz = L.z;
    let dir = rng.int(4);
    let connected = false;
    for (let step = 0; step < 20 && !connected; step++) {
      if (!rng.chance(0.7)) dir = (dir + (rng.chance(0.5) ? 1 : 3)) % 4;
      let nx = cx + DX[dir];
      let nz = cz + DZ[dir];
      if (!inRange(nx, nz) || protectedSet.has(IDX(nx, nz))) {
        dir = (dir + (rng.chance(0.5) ? 1 : 3)) % 4;
        nx = cx + DX[dir];
        nz = cz + DZ[dir];
        if (!inRange(nx, nz) || protectedSet.has(IDX(nx, nz))) continue;
      }
      cells[IDX(nx, nz)] = FLOOR;
      cx = nx;
      cz = nz;
      connected = hasOpenNeighbour(cx, cz);
    }
    if (connected) return;

    // …and a deterministic fallback: BFS through carvable space (the handful of
    // protected cells can never enclose the landing on an 80×80 grid).
    const startIdx = IDX(L.x, L.z);
    const parent = new Map<number, number>();
    parent.set(startIdx, -1);
    const queue: number[] = [startIdx];
    let meet = -1;
    while (queue.length > 0 && meet < 0) {
      const cur = queue.shift()!;
      for (let d = 0; d < 4; d++) {
        const c = toVec(cur);
        const nx = c.x + DX[d];
        const nz = c.z + DZ[d];
        if (!inRange(nx, nz)) continue;
        const ni = IDX(nx, nz);
        if (parent.has(ni) || protectedSet.has(ni)) continue;
        parent.set(ni, cur);
        if (cells[ni] !== WALL && ni !== startIdx) {
          meet = ni;
          break;
        }
        queue.push(ni);
      }
    }
    if (meet >= 0) {
      let cur = meet;
      while (cur !== startIdx && cur >= 0) {
        cells[cur] = FLOOR;
        cur = parent.get(cur)!;
      }
    }
  }

  /** Guarantee the landing has ≥1 FLOOR neighbour and ≥2 walkable ones,
   *  without ever carving into a protected (stair-through) cell. */
  private reinforceLanding(
    cells: Uint8Array,
    protectedSet: Set<number>,
    L: Vec2i,
    rng: Rng,
  ): void {
    for (let iter = 0; iter < 6; iter++) {
      let floorN = 0;
      let walkN = 0;
      for (let d = 0; d < 4; d++) {
        const nx = L.x + DX[d];
        const nz = L.z + DZ[d];
        if (!inRange(nx, nz)) continue;
        const c = cells[IDX(nx, nz)];
        if (c === FLOOR) floorN++;
        if (c !== WALL) walkN++;
      }
      if (floorN >= 1 && walkN >= 2) return;

      // Carve a stub in the direction with the most open runway.
      let bestDir = -1;
      let bestRunway = -1;
      for (let d = 0; d < 4; d++) {
        let runway = 0;
        for (let s = 1; s <= 3; s++) {
          const nx = L.x + s * DX[d];
          const nz = L.z + s * DZ[d];
          if (!inRange(nx, nz) || protectedSet.has(IDX(nx, nz)) || cells[IDX(nx, nz)] !== WALL)
            break;
          runway++;
        }
        if (runway > bestRunway) {
          bestRunway = runway;
          bestDir = d;
        }
      }
      if (bestDir < 0) return; // boxed in by open/protected cells — neighbours exist
      for (let s = 1; s <= Math.min(3, Math.max(bestRunway, 1)); s++) {
        const nx = L.x + s * DX[bestDir];
        const nz = L.z + s * DZ[bestDir];
        if (!inRange(nx, nz) || protectedSet.has(IDX(nx, nz)) || cells[IDX(nx, nz)] !== WALL)
          break;
        cells[IDX(nx, nz)] = FLOOR;
      }
    }
  }

  /** A run is valid if the base is plain floor with an approach, and the throat
   *  (s1) is enclosed — reachable only from s0, so the stairs can't be walked
   *  around on the base floor. s1 may be WALL: the throat is carved into the
   *  wall, and its three forward/side neighbours being WALL is what seals it. */
  private validRun(
    cells: Uint8Array,
    landingSet: Set<number>,
    reserved: Set<number>,
    protectedSet: Set<number>,
    x: number,
    z: number,
    dir: number,
  ): boolean {
    const i0 = IDX(x, z);
    if (cells[i0] !== FLOOR || landingSet.has(i0) || reserved.has(i0) || protectedSet.has(i0)) return false;
    const s1x = x + DX[dir];
    const s1z = z + DZ[dir];
    const Lx = x + 2 * DX[dir];
    const Lz = z + 2 * DZ[dir];
    if (!inRange(s1x, s1z) || !inRange(Lx, Lz)) return false;
    const s1i = IDX(s1x, s1z);
    const Li = IDX(Lx, Lz);
    if (cells[s1i] === STAIR || landingSet.has(s1i) || reserved.has(s1i) || protectedSet.has(s1i)) return false;
    if (reserved.has(Li)) return false;
    // Throat: s1's other three neighbours (ahead = L, two sides) are WALL/edge.
    for (let d = 0; d < 4; d++) {
      if (d === (dir + 2) % 4) continue; // s0, behind
      const nx = s1x + DX[d];
      const nz = s1z + DZ[d];
      if (inRange(nx, nz) && cells[IDX(nx, nz)] !== WALL) return false;
    }
    // Approach: s0 has ≥1 FLOOR neighbour.
    let approach = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const nz = z + DZ[d];
      if (inRange(nx, nz) && cells[IDX(nx, nz)] === FLOOR) approach++;
    }
    return approach >= 1;
  }

  /**
   * Connect every open component to the entry's component via the shortest
   * corridor through wall space (never through protected cells). Without this,
   * a run base or landing can end up stranded in a pocket the player can't
   * reach, and the reachability BFS (and the eggs) follow it into the void.
   *
   * Runs to a fixpoint, recomputing components each pass: carving a corridor
   * for one component changes connectivity for the next, so a single pass over
   * a stale component map can leave nested pockets (a room ringed by a corridor
   * that itself needed connecting) stranded.
   */
  private ensureConnected(
    cells: Uint8Array,
    protectedSet: Set<number>,
    entry: Vec2i,
  ): void {
    const entryIdx = IDX(entry.x, entry.z);
    const parent = new Int32Array(GRID * GRID);
    const queue: number[] = [];
    for (let iter = 0; iter < 64; iter++) {
      const { comp, count } = this.computeComponents(cells, queue);
      if (count <= 1) return; // fully connected
      const mainCid = comp[entryIdx];
      if (mainCid < 0) return; // entry is a wall (shouldn't happen)
      let merged = false;
      for (let cid = 0; cid < count; cid++) {
        if (cid === mainCid) continue;
        parent.fill(-2);
        const q: number[] = [];
        for (let idx = 0; idx < cells.length; idx++) {
          if (comp[idx] === cid) {
            parent[idx] = -1;
            q.push(idx);
          }
        }
        let head = 0;
        let target = -1;
        while (head < q.length && target < 0) {
          const cur = q[head++];
          const c = toVec(cur);
          for (let d = 0; d < 4; d++) {
            const nx = c.x + DX[d];
            const nz = c.z + DZ[d];
            if (!inRange(nx, nz)) continue;
            const ni = IDX(nx, nz);
            if (comp[ni] === mainCid) {
              parent[ni] = cur;
              target = ni;
              break;
            }
            if (parent[ni] !== -2) continue;
            if (cells[ni] !== WALL || protectedSet.has(ni)) continue;
            parent[ni] = cur;
            q.push(ni);
          }
        }
        if (target < 0) continue; // sealed off this pass; retry after others merge
        let cur = target;
        while (cur >= 0) {
          const p = parent[cur];
          if (p === -1 || p === -2) break;
          cells[cur] = FLOOR;
          cur = p;
        }
        merged = true;
      }
      if (!merged) return; // no progress; avoid an infinite loop
    }
  }

  /** Label every open cell with its connected-component id. */
  private computeComponents(
    cells: Uint8Array,
    queue: number[],
  ): { comp: Int32Array; count: number } {
    const comp = new Int32Array(GRID * GRID).fill(-1);
    let count = 0;
    for (let idx = 0; idx < cells.length; idx++) {
      if (cells[idx] === WALL || comp[idx] !== -1) continue;
      const cid = count++;
      comp[idx] = cid;
      queue.length = 0;
      let head = 0;
      queue.push(idx);
      while (head < queue.length) {
        const cur = queue[head++];
        const c = toVec(cur);
        for (let d = 0; d < 4; d++) {
          const nx = c.x + DX[d];
          const nz = c.z + DZ[d];
          if (!inRange(nx, nz)) continue;
          const ni = IDX(nx, nz);
          if (cells[ni] === WALL || comp[ni] !== -1) continue;
          comp[ni] = cid;
          queue.push(ni);
        }
      }
    }
    return { comp, count };
  }

  /** Last-resort run placement when sampling found nothing (practically never). */
  private forceOneRun(
    cells: Uint8Array,
    landingSet: Set<number>,
    reserved: Set<number>,
    protectedSet: Set<number>,
    out: StairRun[],
  ): void {
    for (let z = 1; z < GRID - 1 && out.length === 0; z++) {
      for (let x = 1; x < GRID - 1 && out.length === 0; x++) {
        for (let dir = 0; dir < 4; dir++) {
          if (!this.validRun(cells, landingSet, reserved, protectedSet, x, z, dir)) continue;
          cells[IDX(x, z)] = STAIR;
          cells[IDX(x + DX[dir], z + DZ[dir])] = STAIR;
          reserved.add(IDX(x, z));
          reserved.add(IDX(x + DX[dir], z + DZ[dir]));
          reserved.add(IDX(x + 2 * DX[dir], z + 2 * DZ[dir]));
          out.push({ x, z, dir });
          break;
        }
      }
    }
  }

  private eggsPlacedBelow(i: number): number {
    let total = 0;
    for (let f = 0; f < i; f++) {
      if (this.floors.has(f)) total += this.floors.get(f)!.eggs.length;
    }
    return total;
  }

  // ── validation ───────────────────────────────────────────────────────────

  checkFloor(i: number): string[] {
    const v: string[] = [];
    const f = this.floor(i);
    const at = (x: number, z: number): number =>
      inRange(x, z) ? f.cells[IDX(x, z)] : WALL;
    const neighbours = (x: number, z: number): { floorN: number; walkN: number } => {
      let floorN = 0;
      let walkN = 0;
      for (let d = 0; d < 4; d++) {
        const c = at(x + DX[d], z + DZ[d]);
        if (c === FLOOR) floorN++;
        if (c !== WALL) walkN++;
      }
      return { floorN, walkN };
    };

    // (a) inherited landings are FLOOR here — never walls, never stairs.
    if (i > 0) {
      const prev = this.floor(i - 1);
      for (const run of prev.stairsUp) {
        const L = runLanding(run);
        if (!inRange(L.x, L.z)) continue;
        if (at(L.x, L.z) !== FLOOR) v.push(`f${i}: landing (${L.x},${L.z}) is not FLOOR`);
      }
      // (b) each landing opens onto open corridor, not a wall pocket.
      for (const L of f.landings) {
        const { floorN, walkN } = neighbours(L.x, L.z);
        if (floorN < 1) v.push(`f${i}: landing (${L.x},${L.z}) has no FLOOR neighbour`);
        if (walkN < 2) v.push(`f${i}: landing (${L.x},${L.z}) has only ${walkN} walkable neighbours`);
      }
    }

    // (c) the runs based here.
    let openCount = 0;
    for (let idx = 0; idx < f.cells.length; idx++) if (f.cells[idx] !== WALL) openCount++;
    const upper = this.floor(i + 1);
    for (const run of f.stairsUp) {
      const s0 = runBase(run);
      const s1 = runTopCell(run);
      const L = runLanding(run);
      const tag = `f${i} run@(${s0.x},${s0.z})dir${run.dir}`;
      if (at(s0.x, s0.z) !== STAIR) v.push(`${tag}: s0 not STAIR`);
      if (at(s1.x, s1.z) !== STAIR) v.push(`${tag}: s1 not STAIR`);
      const s0n = neighbours(s0.x, s0.z);
      if (s0n.floorN < 1) v.push(`${tag}: no FLOOR approach at the base`);
      const s1n = neighbours(s1.x, s1.z);
      if (s1n.walkN !== 1) v.push(`${tag}: throat open on ${s1n.walkN} sides (want exactly s0)`);
      const upAt = (x: number, z: number): number =>
        inRange(x, z) ? upper.cells[IDX(x, z)] : WALL;
      if (upAt(s0.x, s0.z) !== WALL) v.push(`${tag}: s0 not WALL above (double occupancy)`);
      if (upAt(s1.x, s1.z) !== WALL) v.push(`${tag}: s1 not WALL above (double occupancy)`);
      if (!inRange(L.x, L.z)) {
        v.push(`${tag}: landing out of range`);
      } else {
        if (upAt(L.x, L.z) !== FLOOR) v.push(`${tag}: landing not FLOOR above`);
        let floorN = 0;
        let walkN = 0;
        for (let d = 0; d < 4; d++) {
          const c = upAt(L.x + DX[d], L.z + DZ[d]);
          if (c === FLOOR) floorN++;
          if (c !== WALL) walkN++;
        }
        if (floorN < 1 || walkN < 2) {
          v.push(`${tag}: landing above (${L.x},${L.z}) opens into wall (floorN=${floorN}, walkN=${walkN})`);
        }
      }
    }

    // (d) runs on a floor never share s0/s1/L.
    const reserved = new Set<number>();
    for (const run of f.stairsUp) {
      for (const c of [runBase(run), runTopCell(run), runLanding(run)]) {
        const key = IDX(c.x, c.z);
        if (reserved.has(key)) v.push(`f${i}: runs share cell (${c.x},${c.z})`);
        reserved.add(key);
      }
    }

    // (e) every floor climbs.
    if (f.stairsUp.length < 1) v.push(`f${i}: no stair run`);
    if (i > 0 && f.landings.length < 1) v.push(`f${i}: no landing`);

    // (f) a hall, not a cubby.
    if (openCount < MIN_OPEN) v.push(`f${i}: only ${openCount} open cells (< ${MIN_OPEN})`);
    if (openCount > MAX_OPEN) v.push(`f${i}: ${openCount} open cells (> ${MAX_OPEN})`);

    // (g) eggs sit on distinct in-range FLOOR cells.
    const eggSet = new Set<number>();
    for (const e of f.eggs) {
      if (!inRange(e.x, e.z) || at(e.x, e.z) !== FLOOR) v.push(`f${i}: egg on non-FLOOR (${e.x},${e.z})`);
      const key = IDX(e.x, e.z);
      if (eggSet.has(key)) v.push(`f${i}: duplicate egg (${e.x},${e.z})`);
      eggSet.add(key);
    }

    // (h) spawn is walkable.
    if (f.start !== undefined && !this.isWalkable(i, f.start.x, f.start.z)) {
      v.push(`f0: start not walkable`);
    }

    return v;
  }

  checkReachability(maxFloor: number): string[] {
    const v: string[] = [];
    const visited = this.reachableCells(maxFloor);
    const has = (f: number, x: number, z: number): boolean =>
      (visited.get(f)?.has(IDX(x, z))) === true;
    for (let f = 0; f <= maxFloor; f++) {
      const layout = this.floor(f);
      for (const e of layout.eggs) {
        if (!has(f, e.x, e.z)) v.push(`egg (${e.x},${e.z}) on f${f} unreachable`);
      }
      for (const run of layout.stairsUp) {
        const s0 = runBase(run);
        if (!has(f, s0.x, s0.z)) v.push(`run base (${s0.x},${s0.z}) on f${f} unreachable`);
        const L = runLanding(run);
        if (f + 1 <= maxFloor && !has(f + 1, L.x, L.z)) {
          v.push(`landing (${L.x},${L.z}) on f${f + 1} unreachable`);
        }
      }
    }
    return v;
  }

  /**
   * BFS from the floor-0 spawn across floors 0..maxFloor. Returns
   * visited[f] = Set<open-cell idx>. The graph: walkable 4-adjacency within a
   * floor, plus s0 ↔ landing edges for every run (both endpoints in range).
   */
  private reachableCells(maxFloor: number): Map<number, Set<number>> {
    const visited = new Map<number, Set<number>>();
    for (let f = 0; f <= maxFloor; f++) visited.set(f, new Set<number>());
    const f0 = this.floor(0);
    if (f0.start === undefined) return visited;

    const open = (f: number, idx: number): boolean => this.floor(f).cells[idx] !== WALL;

    // Run-edge lookups: which cells are run bases (per floor) and landings.
    const baseRun = new Map<number, { floor: number; L: Vec2i }>();
    const landingOf = new Map<number, number>(); // (floor<<16|idx of landing) -> base floor idx
    for (let f = 0; f <= maxFloor; f++) {
      for (const run of this.floor(f).stairsUp) {
        const s0 = runBase(run);
        const L = runLanding(run);
        if (inRange(s0.x, s0.z)) baseRun.set(IDX(s0.x, s0.z) + f * 0x10000, { floor: f, L });
        if (inRange(L.x, L.z) && f + 1 <= maxFloor) {
          landingOf.set(IDX(L.x, L.z) + (f + 1) * 0x10000, f);
        }
      }
    }

    const queue: number[] = [IDX(f0.start.x, f0.start.z) + 0];
    visited.get(0)!.add(IDX(f0.start.x, f0.start.z));
    while (queue.length > 0) {
      const node = queue.shift()!;
      const f = Math.floor(node / 0x10000);
      const idx = node % 0x10000;
      const c = toVec(idx);

      for (let d = 0; d < 4; d++) {
        const nx = c.x + DX[d];
        const nz = c.z + DZ[d];
        if (!inRange(nx, nz)) continue;
        const ni = IDX(nx, nz);
        if (!open(f, ni)) continue;
        const nn = ni + f * 0x10000;
        if (!visited.get(f)!.has(ni)) {
          visited.get(f)!.add(ni);
          queue.push(nn);
        }
      }
      const up = baseRun.get(node);
      if (up && up.floor + 1 <= maxFloor && open(up.floor + 1, IDX(up.L.x, up.L.z))) {
        const li = IDX(up.L.x, up.L.z);
        const key = li + (up.floor + 1) * 0x10000;
        if (!visited.get(up.floor + 1)!.has(li)) {
          visited.get(up.floor + 1)!.add(li);
          queue.push(key);
        }
      }
      const down = landingOf.get(node);
      if (down !== undefined) {
        const run = this.floor(down).stairsUp.find((r) => {
          const L = runLanding(r);
          return L.x === c.x && L.z === c.z;
        });
        if (run) {
          const s0 = runBase(run);
          const si = IDX(s0.x, s0.z);
          if (open(down, si) && !visited.get(down)!.has(si)) {
            visited.get(down)!.add(si);
            queue.push(si + down * 0x10000);
          }
        }
      }
    }
    return visited;
  }
}
