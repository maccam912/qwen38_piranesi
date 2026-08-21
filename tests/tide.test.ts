import { describe, expect, it } from "vitest";
import { TIDE_PERIOD, isWading, tideLevel } from "@shared/tide";

describe("tide", () => {
  it("stays within [0.15, 1.05] over a long run", () => {
    for (let t = 0; t <= 600; t += 1) {
      const h = tideLevel(t);
      expect(h).toBeGreaterThanOrEqual(0.15);
      expect(h).toBeLessThanOrEqual(1.05);
    }
  });

  it("is periodic with TIDE_PERIOD", () => {
    for (const t of [0, 37, 100, 221.5]) {
      expect(tideLevel(t)).toBeCloseTo(tideLevel(t + TIDE_PERIOD), 10);
    }
  });

  it("reaches its extremes at the expected phases", () => {
    expect(tideLevel(0)).toBeCloseTo(0.6, 10);
    expect(tideLevel(TIDE_PERIOD / 4)).toBeCloseTo(1.05, 5);
    expect(tideLevel((3 * TIDE_PERIOD) / 4)).toBeCloseTo(0.15, 5);
  });

  it("isWading tracks a depth threshold", () => {
    // high tide (1.05 > 0.35) wades; low tide (0.15) does not
    expect(isWading(TIDE_PERIOD / 4)).toBe(true);
    expect(isWading((3 * TIDE_PERIOD) / 4)).toBe(false);
  });
});
