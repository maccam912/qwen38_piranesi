// Player: movement, collision, and the stair state machine. Pure TS, no engine.
//
// The world is a grid of 2 m cells; walls are solid, floors and stairs are
// walkable. A stair run is two STAIR cells (s0 → s1) rising one floor along its
// direction; while on a run the player's height follows the ramp and exit is
// only allowed onto cells that exist at the correct height — the landing above,
// or open floor at the base.

import {
  CELL,
  DX,
  DZ,
  GRID,
  RUN_LEN_M,
  STAIR,
  WALL,
  cellAtWorld,
  runBase,
  runTopCell,
} from "@shared/types";
import type { House } from "@shared/types";

/** Walk speed in m/s; Shift strides at ~1.6×. */
const WALK = 3.4;
const STRIDE = 5.4;

/** Player capsule radius (m). Corridors are 2 m wide; 0.25 m keeps a
 *  0.5 m footprint clear of the walls while still blocking face-hugging. */
export const PLAYER_R = 0.25;

/** Eye height above the feet (m). */
export const EYE_H = 1.62;

/** Gravity for settling after stepping off a stair top. */
const GRAVITY = 18;

/** Input snapshot; app.ts fills this from keyboard/mouse each frame. */
export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
}

export function makeInput(): InputState {
  return { up: false, down: false, left: false, right: false, sprint: false };
}

interface StairRef {
  /** Floor the run is based on. */
  baseFloor: number;
  x: number;
  z: number;
  dir: number;
}

export class Player {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0; // radians; 0 faces −z
  pitch = 0;
  floorIndex = 0;
  /** The stair run currently underfoot, if any. */
  onStair: StairRef | null = null;
  private vy = 0;

  constructor(private house: House) {}

  spawn(): void {
    const f0 = this.house.floor(0);
    const s = f0.start ?? { x: GRID / 2, z: GRID / 2 };
    // cellCenter gives the cell's min corner; the walkable centre is +CELL/2.
    this.x = (s.x - GRID / 2) * CELL + CELL / 2;
    this.z = (s.z - GRID / 2) * CELL + CELL / 2;
    this.y = 0;
    this.floorIndex = 0;
    this.onStair = null;
    this.vy = 0;
    // Face the open middle of the hall rather than a random wall.
    const toCentre = Math.atan2(-this.x, -this.z);
    this.yaw = Number.isFinite(toCentre) ? toCentre : 0;
    this.pitch = 0;
  }

  /**
   * Advance one fixed step. `dt` should be small (the caller runs a fixed-step
   * loop); input comes from the shared mutable state object.
   */
  update(dt: number, input: InputState): void {
    const speed = input.sprint ? STRIDE : WALK;

    // Camera-relative move basis from yaw only (walking never pitches you).
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let mx = 0;
    let mz = 0;
    if (input.up) {
      mx -= sin;
      mz -= cos;
    }
    if (input.down) {
      mx += sin;
      mz += cos;
    }
    if (input.left) {
      mx -= cos;
      mz += sin;
    }
    if (input.right) {
      mx += cos;
      mz -= sin;
    }
    const basis = Math.hypot(mx, mz);
    const step = basis > 0 ? (speed * dt) : 0;
    if (basis > 0) {
      mx = (mx / basis) * step;
      mz = (mz / basis) * step;
    }

    // Wall-slide assist: when the desired move is fully blocked, slide along
    // the wall. The side is chosen by lookahead — slide each perpendicular up
    // to LOOKAHEAD_STEPS and keep the one that reopens forward motion. This
    // walks the player around corners (and onto stair runs beside their path)
    // instead of pinning them to the wall face.
    if (step > 0 && !this.canStand(this.x + mx, this.z + mz)) {
      const side = this.pickSlideSide(mx, mz, step);
      if (side !== 0) {
        // perpendicular of the blocked move, scaled to one step of travel
        const nx = (-mz / step) * side * step;
        const nz = (mx / step) * side * step;
        mx = nx;
        mz = nz;
      } else {
        mx = 0;
        mz = 0;
      }
    }

    if (this.onStair !== null) {
      this.updateOnStair(mx, mz);
    } else {
      this.updateOnFloor(mx, mz, dt);
    }
  }

  // ── flat-floor movement ────────────────────────────────────────────────────

  private updateOnFloor(mx: number, mz: number, dt: number): void {
    this.moveWithCollision(mx, mz);

    // Vertical: settle onto the ground height underfoot (or fall to it).
    const targetY = this.groundY(this.floorIndex, this.x, this.z);
    if (this.y > targetY + 0.01) {
      this.vy -= GRAVITY * dt;
      this.y = Math.max(targetY, this.y + this.vy * dt);
      if (this.y <= targetY + 1e-4) {
        this.y = targetY;
        this.vy = 0;
      }
    } else {
      this.y = targetY;
      this.vy = 0;
    }

    this.maybeEnterStair();
  }

  /** Ground y under (x,z) on floor f, following stair ramps where present. */
  private groundY(f: number, x: number, z: number): number {
    const c = cellAtWorld(x, z);
    if (this.house.cell(f, c.x, c.z) === STAIR) {
      const run = this.findRun(f, c.x, c.z);
      if (run) return this.stairHeight(run, x, z);
    }
    return this.house.floorY(f);
  }

  private findRun(f: number, cx: number, cz: number): StairRef | null {
    for (const r of this.house.floor(f).stairsUp) {
      const b = runBase(r);
      const t = runTopCell(r);
      if ((b.x === cx && b.z === cz) || (t.x === cx && t.z === cz)) {
        return { baseFloor: f, x: b.x, z: b.z, dir: r.dir };
      }
    }
    return null;
  }

  /** Ramp height along a run at world (x,z), clamped to [base, base+rise]. */
  private stairHeight(run: StairRef, x: number, z: number): number {
    const bx = (run.x - GRID / 2) * CELL;
    const bz = (run.z - GRID / 2) * CELL;
    const along = (x - bx) * DX[run.dir] + (z - bz) * DZ[run.dir];
    const t = Math.max(0, Math.min(RUN_LEN_M, along)) / RUN_LEN_M;
    const y0 = this.house.floorY(run.baseFloor);
    return y0 + t * (this.house.floorY(run.baseFloor + 1) - y0);
  }

  /** Step onto a stair run when walking into one of its cells at the right height.
   *  The centre cell OR any footprint corner counts — brushing the ramp edge
   *  while walking past is enough to step on. */
  private maybeEnterStair(): void {
    const centre = cellAtWorld(this.x, this.z);
    const candidates: Array<{ x: number; z: number }> = [centre];
    for (const [px, pz] of FOOTPRINT_OFFSETS) {
      candidates.push(cellAtWorld(this.x + px, this.z + pz));
    }
    for (const cand of candidates) {
      if (this.house.cell(this.floorIndex, cand.x, cand.z) !== STAIR) continue;
      const run = this.findRun(this.floorIndex, cand.x, cand.z);
      if (!run) continue;
      const base = runBase({ x: run.x, z: run.z, dir: run.dir });
      const top = runTopCell({ x: run.x, z: run.z, dir: run.dir });
      const onBase = cand.x === base.x && cand.z === base.z;
      const onTop = cand.x === top.x && cand.z === top.z;
      if (onBase && this.nearLevel(this.house.floorY(run.baseFloor))) {
        this.onStair = run; // entering from the low end
        return;
      }
      if (onTop && this.nearLevel(this.house.floorY(run.baseFloor + 1))) {
        this.onStair = run; // stepping onto the upper cell from the landing
        return;
      }
      if ((onBase || onTop) && cand.x === centre.x && cand.z === centre.z) {
        // Centre is on a run cell at the wrong height — undo this move.
        this.x = this.prevX;
        this.z = this.prevZ;
        return;
      }
    }
  }

  private nearLevel(y: number): boolean {
    return Math.abs(this.y - y) < 0.75;
  }

  // ── stair traversal ────────────────────────────────────────────────────────

  private updateOnStair(mx: number, mz: number): void {
    const run = this.onStair!;
    const base = { x: run.x, z: run.z };
    const top = { x: run.x + DX[run.dir], z: run.z + DZ[run.dir] };

    const beforeX = this.prevX;
    const beforeZ = this.prevZ;
    this.moveWithCollision(mx, mz);

    // On the run while the centre OR any footprint corner overlaps its cells —
    // brushing the ramp edge keeps you on it (no skating across in one frame).
    if (this.overlapsRun(base, top)) {
      this.y = this.stairHeight(run, this.x, this.z);
      this.prevX = this.x;
      this.prevZ = this.z;
      return;
    }

    // Fully off the run: exit only where the world actually has ground.
    const c = cellAtWorld(this.x, this.z);
    const towardsTop =
      Math.abs(c.x - top.x) + Math.abs(c.z - top.z) <=
      Math.abs(c.x - base.x) + Math.abs(c.z - base.z);
    const upFloor = run.baseFloor + 1;

    if (towardsTop) {
      const L = { x: run.x + 2 * DX[run.dir], z: run.z + 2 * DZ[run.dir] };
      if (
        c.x === L.x &&
        c.z === L.z &&
        this.house.isWalkable(upFloor, L.x, L.z)
      ) {
        this.exitStair(upFloor);
        return;
      }
      // The throat is sealed by construction — anything else here is a wall.
      this.reject(beforeX, beforeZ, run);
      return;
    }

    // Towards the bottom end: any walkable cell on the base floor works.
    if (this.house.isWalkable(run.baseFloor, c.x, c.z)) {
      this.exitStair(run.baseFloor);
      return;
    }
    this.reject(beforeX, beforeZ, run);
  }

  /** True when the centre or any footprint corner is on one of the run cells. */
  private overlapsRun(
    base: { x: number; z: number },
    top: { x: number; z: number },
  ): boolean {
    for (const [px, pz] of [[0, 0], ...FOOTPRINT_OFFSETS] as const) {
      const c = cellAtWorld(this.x + px, this.z + pz);
      if ((c.x === base.x && c.z === base.z) || (c.x === top.x && c.z === top.z)) {
        return true;
      }
    }
    return false;
  }

  private exitStair(floor: number): void {
    this.onStair = null;
    this.floorIndex = floor;
    this.y = this.house.floorY(floor);
    this.vy = 0;
    this.prevX = this.x;
    this.prevZ = this.z;
  }

  private reject(x: number, z: number, run: StairRef): void {
    this.x = x;
    this.z = z;
    this.y = this.stairHeight(run, x, z);
  }

  // ── collision ──────────────────────────────────────────────────────────────

  /**
   * Axis-separated slide against walls. While on a stair run the player spans
   * two floors, so a cell blocks only when it is WALL on both the run's base
   * floor and the floor above (the landing lives up there).
   */
  private moveWithCollision(mx: number, mz: number): void {
    this.prevX = this.x;
    this.prevZ = this.z;
    const nx = this.x + mx;
    if (this.canStand(nx, this.z)) this.x = nx;
    const nz = this.z + mz;
    if (this.canStand(this.x, nz)) this.z = nz;
  }

  private canStand(x: number, z: number): boolean {
    const f = this.onStair !== null ? this.onStair.baseFloor : this.floorIndex;
    for (const [px, pz] of FOOTPRINT_OFFSETS) {
      const c = cellAtWorld(x + px, z + pz);
      if (
        this.house.cell(f, c.x, c.z) === WALL &&
        this.house.cell(f + 1, c.x, c.z) === WALL
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Slide along a blocking wall in whichever perpendicular direction reopens
   * forward motion within LOOKAHEAD_STEPS. Returns +1, −1, or 0 for pinned.
   */
  private pickSlideSide(mx: number, mz: number, len: number): number {
    // Probe in fixed world-metre increments, independent of frame rate.
    const step = WALK * (1 / 120);
    for (const side of [1, -1] as const) {
      let px = this.x;
      let pz = this.z;
      let clear = true;
      for (let s = 0; s < LOOKAHEAD_STEPS; s++) {
        px += (-mz / len) * side * step;
        pz += (mx / len) * side * step;
        if (!this.canStand(px, pz)) {
          clear = false;
          break;
        }
      }
      if (clear && this.canStand(px + mx, pz + mz)) return side;
    }
    // Neither side reopens forward motion: slide towards open space anyway.
    for (const side of [1, -1] as const) {
      let px = this.x;
      let pz = this.z;
      let clear = true;
      for (let s = 0; s < LOOKAHEAD_STEPS; s++) {
        px += (-mz / len) * side * step;
        pz += (mx / len) * side * step;
        if (!this.canStand(px, pz)) {
          clear = false;
          break;
        }
      }
      if (clear) return side;
    }
    return 0;
  }


  // last accepted position, for rejecting moves that leave the world
  private prevX = 0;
  private prevZ = 0;
}

/** Steps probed when choosing a wall-slide direction (~0.5 s of walking). */
const LOOKAHEAD_STEPS = 60;

/** Half-metre footprint corners around the player centre. */
const FOOTPRINT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-PLAYER_R, -PLAYER_R],
  [PLAYER_R, -PLAYER_R],
  [-PLAYER_R, PLAYER_R],
  [PLAYER_R, PLAYER_R],
];

