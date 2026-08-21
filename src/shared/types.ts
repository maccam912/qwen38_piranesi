// ─────────────────────────────────────────────────────────────────────────────
// Piranesi — shared contract.
// Pure, isomorphic, engine-free. Both the generator (shared/house.ts) and the
// Three.js client (game/*) import from here. No runtime dependencies.
// ─────────────────────────────────────────────────────────────────────────────

/** Metres per grid cell. Kenney Building Kit floor slab is 2×2 m. */
export const CELL = 2;
/** Floor-to-floor height: Kenney wall 2.4 m + slab 0.1 m. */
export const FLOOR_H = 2.5;
/** Floor slab thickness (top of slab sits at floor level). */
export const SLAB_T = 0.1;
/** Wall height between slabs. */
export const WALL_H = 2.4;
/** Cells per side of every floor's grid (160 m world span, centred on origin). */
export const GRID = 80;
/** A stair run spans this many cells (4 m) and rises exactly one floor. */
export const RUN_CELLS = 2;
/** World-metre length of a stair run. */
export const RUN_LEN_M = CELL * RUN_CELLS; // 4
/** Rise of a stair run. */
export const RUN_RISE_M = FLOOR_H; // 2.5
/** Total gull eggs to find (win condition). */
export const TOTAL_EGGS = 40;

/** Cell kinds. STAIR cells are walkable — they belong to a stair run whose base is on the same floor. */
export const WALL = 0;
export const FLOOR = 1;
export const STAIR = 2;
export type Cell = typeof WALL | typeof FLOOR | typeof STAIR;

/** Direction vectors: 0=+x, 1=+z, 2=−x, 3=−z. */
export const DX = [1, 0, -1, 0] as const;
export const DZ = [0, 1, 0, -1] as const;

/** Integer grid cell (x, z). In-range means 0 ≤ x,z < GRID. */
export interface Vec2i {
  x: number;
  z: number;
}

/**
 * A stair run: two walkable STAIR cells on its base floor, ascending along `dir`,
 * exiting onto the landing cell (base + 2·dir) on floor `baseFloor + 1`.
 * Base cell s0 = (x, z); upper cell s1 = (x + DX[dir], z + DZ[dir]);
 * landing L   = (x + 2·DX[dir], z + 2·DZ[dir]).
 * The Kenney `stairs-center` model (4 m run, 2.5 m rise) maps exactly onto s0..L.
 */
export interface StairRun {
  x: number;
  z: number;
  dir: number; // 0..3
}

export function runBase(r: StairRun): Vec2i {
  return { x: r.x, z: r.z };
}
export function runTopCell(r: StairRun): Vec2i {
  return { x: r.x + DX[r.dir], z: r.z + DZ[r.dir] };
}
export function runLanding(r: StairRun): Vec2i {
  return { x: r.x + 2 * DX[r.dir], z: r.z + 2 * DZ[r.dir] };
}

/** Wrack (wreckage) kind, rendered with Kenney watercraft props. */
export type WreckKind = "boat" | "crate" | "rocks";

export interface WreckItem {
  x: number;
  z: number;
  kind: WreckKind;
}

/** One generated floor. Coordinates are grid cells in [0, GRID). */
export interface FloorLayout {
  index: number;
  /** Row-major z*GRID+x, values Cell. */
  cells: Uint8Array;
  /** Runs whose base is on this floor (climb up to index+1). */
  stairsUp: StairRun[];
  /** Landing cells on this floor (tops of runs based on index−1). These are FLOOR cells. */
  landings: Vec2i[];
  /** Gull-egg cells on this floor (FLOOR cells only). */
  eggs: Vec2i[];
  /** Player spawn cell (floor 0 only). */
  start?: Vec2i;
  /** Indices (z*GRID+x) of cells covered by the tide — floor 0 only, [] elsewhere. */
  floodCells: number[];
  /** Wrack placements — floor 0 only, [] elsewhere. */
  wrecks: WreckItem[];
}

export interface HouseConfig {
  /** Any string; hashed to a numeric seed. */
  seed: string;
  totalEggs?: number; // default TOTAL_EGGS
}

/**
 * Deterministic, lazy house. `floor(i)` generates on demand (floors depend only
 * on i−1) and caches. Same seed ⇒ identical house, in any process.
 */
export abstract class House {
  readonly config: HouseConfig;
  constructor(config: HouseConfig) {
    this.config = { totalEggs: TOTAL_EGGS, ...config };
  }

  /** Lazily generate (and cache) floor i. */
  abstract floor(i: number): FloorLayout;

  /** Cell at (x,z) on floor f. Out-of-range is WALL. */
  abstract cell(f: number, x: number, z: number): Cell;

  /** True if the cell is FLOOR or STAIR and in range. */
  abstract isWalkable(f: number, x: number, z: number): boolean;

  /** World-metre floor level (y) of floor i. */
  floorY(i: number): number {
    return i * FLOOR_H;
  }

  /** Invariant violations for floor i (may inspect i−1..i+1). [] means valid. */
  abstract checkFloor(i: number): string[];

  /**
   * Connectivity audit over floors 0..maxFloor: BFS from the floor-0 start cell
   * (adjacency = walkable 4-neighbours on a floor + run edge s0(rb) ↔ L(rb+1)).
   * Violations: any egg, run base or landing in range that is unreachable. [] means valid.
   */
  abstract checkReachability(maxFloor: number): string[];
}

// ── world coordinate helpers (pure) ──────────────────────────────────────────

/** World-metre centre of a grid cell on floor f. Grid is centred on the origin. */
export function cellCenter(f: number, x: number, z: number): { x: number; y: number; z: number } {
  return {
    x: (x - GRID / 2) * CELL,
    y: f * FLOOR_H,
    z: (z - GRID / 2) * CELL,
  };
}

/** Grid cell containing world x,z (floor-independent; result may be out of [0,GRID)). */
export function cellAtWorld(x: number, z: number): Vec2i {
  return {
    x: Math.floor((x / CELL) + GRID / 2),
    z: Math.floor((z / CELL) + GRID / 2),
  };
}

/** Stair position along a run. s = metres from the base end, 0..RUN_LEN_M. */
export function stairPoint(r: StairRun, baseFloor: number, s: number): { x: number; y: number; z: number } {
  const t = Math.max(0, Math.min(1, s / RUN_LEN_M));
  const c0 = cellCenter(baseFloor, r.x, r.z);
  return {
    x: c0.x + DX[r.dir] * CELL * t,
    y: baseFloor * FLOOR_H + RUN_RISE_M * t,
    z: c0.z + DZ[r.dir] * CELL * t,
  };
}
