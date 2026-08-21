import { describe, expect, it } from "vitest";
import { GeneratedHouse } from "@shared/house";
import { GRID, TOTAL_EGGS, WALL, FLOOR, runLanding, runTopCell } from "@shared/types";

const SEEDS: string[] = [
  ...Array.from({ length: 50 }, (_, i) => `S${i}`),
  "Piranesi",
  "the-house",
  "hall-11",
  "wrack",
  "gulls",
  "Endless Corridors",
  "statue with a bird on its head",
  "tide",
  "S0",
];
// NOTE: SEEDS has 60 entries (50 numbered + 10 named; S0 intentionally duplicated).

function house(seed: string): GeneratedHouse {
  return new GeneratedHouse({ seed });
}

const inEllipse = (x: number, z: number): boolean =>
  ((x - GRID / 2) / 26) ** 2 + ((z - GRID / 2) / 18) ** 2 <= 1;

describe("GeneratedHouse invariants (60 seeds × floors 0..5)", () => {
  for (const seed of SEEDS) {
    it(`seed "${seed}": every floor passes checkFloor`, () => {
      const h = house(seed);
      for (let f = 0; f <= 5; f++) {
        expect(h.checkFloor(f), `floor ${f}`).toEqual([]);
      }
    });
  }
});

describe("the stairs — the core requirement", () => {
  for (const seed of SEEDS.slice(0, 30)) {
    it(`seed "${seed}": no stair exits into a wall, top or bottom`, () => {
      const h = house(seed);
      for (let f = 0; f <= 4; f++) {
        const layout = h.floor(f);
        const up = h.floor(f + 1);
        for (const run of layout.stairsUp) {
          const s0 = { x: run.x, z: run.z };
          const L = runLanding(run);
          const count = (cellOf: (x: number, z: number) => number) => {
            let floorN = 0;
            let walkN = 0;
            const dirs = [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ];
            for (const [dx, dz] of dirs) {
              const c = cellOf(L.x + dx, L.z + dz);
              if (c === FLOOR) floorN++;
              if (c !== WALL) walkN++;
            }
            return { floorN, walkN };
          };
          // landing above: open onto the corridor, never a wall pocket
          const above = count((x, z) => (x >= 0 && x < GRID && z >= 0 && z < GRID ? up.cells[z * GRID + x] : WALL));
          expect(above.walkN, `landing (${L.x},${L.z}) f${f + 1} walkable neighbours`).toBeGreaterThanOrEqual(2);
          expect(above.floorN, `landing (${L.x},${L.z}) f${f + 1} FLOOR neighbours`).toBeGreaterThanOrEqual(1);
          // base below: there is an approach from open floor
          let approach = 0;
          for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const x = s0.x + dx;
            const z = s0.z + dz;
            if (x >= 0 && x < GRID && z >= 0 && z < GRID && layout.cells[z * GRID + x] === FLOOR) approach++;
          }
          expect(approach, `base (${s0.x},${s0.z}) f${f} FLOOR approach`).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it(`seed "${seed}": stair throats are enclosed`, () => {
      const h = house(seed);
      for (let f = 0; f <= 4; f++) {
        const layout = h.floor(f);
        const up = h.floor(f + 1);
        for (const run of layout.stairsUp) {
          const s1 = runTopCell(run);
          const s0 = { x: run.x, z: run.z };
          let walkN = 0;
          for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const x = s1.x + dx;
            const z = s1.z + dz;
            const c =
              x >= 0 && x < GRID && z >= 0 && z < GRID ? layout.cells[z * GRID + x] : WALL;
            if (c !== WALL) walkN++;
          }
          expect(walkN, `throat (${s1.x},${s1.z}) f${f} walkable neighbours`).toBe(1); // only s0
          // nothing open above the run — a room never grows through the staircase
          expect(up.cells[s1.z * GRID + s1.x], `s1 (${s1.x},${s1.z}) above f${f + 1}`).toBe(WALL);
          expect(up.cells[s0.z * GRID + s0.x], `s0 (${s0.x},${s0.z}) above f${f + 1}`).toBe(WALL);
        }
      }
    });
  }
});

describe("reachability", () => {
  for (const seed of SEEDS.slice(0, 8)) {
    it(`seed "${seed}": every egg, base and landing is reachable`, () => {
      const h = house(seed);
      const maxEggFloor = Math.ceil(TOTAL_EGGS / 2);
      expect(h.checkReachability(maxEggFloor)).toEqual([]);
    });
  }

  it("eggs are placed only on FLOOR cells (spot-check floors 0..5 of 5 seeds)", () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const h = house(seed);
      for (let f = 0; f <= 5; f++) {
        const layout = h.floor(f);
        for (const e of layout.eggs) {
          expect(layout.cells[e.z * GRID + e.x], `seed ${seed} f${f} egg`).toBe(FLOOR);
        }
      }
    }
  });
});

describe("determinism", () => {
  it("same seed ⇒ identical floors 0..2", () => {
    const a = house("gulls");
    const b = house("gulls");
    for (let f = 0; f <= 2; f++) {
      const la = a.floor(f);
      const lb = b.floor(f);
      expect(Array.from(la.cells)).toEqual(Array.from(lb.cells));
      expect(la.stairsUp).toEqual(lb.stairsUp);
      expect(la.eggs).toEqual(lb.eggs);
      expect(la.wrecks).toEqual(lb.wrecks);
      expect(la.landings).toEqual(lb.landings);
      expect(la.start).toEqual(lb.start);
    }
  });
});

describe("egg budget", () => {
  it("all 40 eggs are placed, across floors up to maxEggFloor", () => {
    for (const seed of SEEDS) {
      const h = house(seed);
      let total = 0;
      let floors = 0;
      for (let f = 0; total < TOTAL_EGGS && f <= Math.ceil(TOTAL_EGGS / 2) + 1; f++) {
        total += h.floor(f).eggs.length;
        floors = f;
      }
      expect(total, `seed ${seed}`).toBe(TOTAL_EGGS);
      expect(floors, `seed ${seed}: eggs should not run past maxEggFloor`).toBeLessThanOrEqual(Math.ceil(TOTAL_EGGS / 2));
    }
  });
});

describe("floor 0", () => {
  it("has a start cell, a flooded ground floor and wrack in the central ellipse", () => {
    for (const seed of SEEDS) {
      const h = house(seed);
      const f0 = h.floor(0);
      expect(f0.start, `seed ${seed}`).toBeDefined();
      expect(f0.floodCells.length, `seed ${seed} flood`).toBeGreaterThan(0);
      expect(f0.wrecks.length, `seed ${seed} wracks`).toBeGreaterThanOrEqual(6);
      for (const w of f0.wrecks) {
        expect(inEllipse(w.x, w.z), `seed ${seed} wreck (${w.x},${w.z}) off the ellipse`).toBe(true);
      }
    }
  });
});

describe("scale", () => {
  it("floors are grand halls, not cubbies: open cells within [400, GRID²/2]", () => {
    for (const seed of SEEDS) {
      const h = house(seed);
      for (let f = 0; f <= 5; f++) {
        const cells = h.floor(f).cells;
        let open = 0;
        for (const c of cells) if (c !== WALL) open++;
        expect(open, `seed ${seed} f${f}`).toBeGreaterThanOrEqual(400);
        expect(open, `seed ${seed} f${f}`).toBeLessThanOrEqual((GRID * GRID) / 2);
      }
    }
  });
});
