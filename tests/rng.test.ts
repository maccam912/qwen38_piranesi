import { describe, expect, it } from "vitest";
import { Rng, hashString } from "@shared/rng";

describe("hashString", () => {
  it("is deterministic per string", () => {
    expect(hashString("piranesi")).toBe(hashString("piranesi"));
  });

  it("differs across seeds", () => {
    const a = new Set([hashString("a"), hashString("b"), hashString("c"), hashString("d")]);
    expect(a.size).toBe(4);
  });
});

describe("Rng", () => {
  it("is deterministic for the same seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const sa = Array.from({ length: 20 }, () => a.next());
    const sb = Array.from({ length: 20 }, () => b.next());
    expect(sa).toEqual(sb);
  });

  it("differs across seeds", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it("next() stays in [0,1)", () => {
    const r = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int(n) stays in [0,n)", () => {
    const r = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = r.int(13);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(13);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("is roughly uniform (10 buckets within 25% of expected)", () => {
    const r = new Rng(99);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) buckets[Math.floor(r.next() * 10)]++;
    const expected = 10_000;
    for (const b of buckets) {
      expect(b).toBeGreaterThan(expected * 0.75);
      expect(b).toBeLessThan(expected * 1.25);
    }
  });

  it("chance(p) honours p", () => {
    const r = new Rng(5);
    let yes = 0;
    for (let i = 0; i < 10_000; i++) if (r.chance(0.3)) yes++;
    expect(yes).toBeGreaterThan(2500);
    expect(yes).toBeLessThan(3500);
  });

  it("pick returns an element of the array", () => {
    const r = new Rng(3);
    const arr = ["boat", "crate", "rocks"];
    for (let i = 0; i < 100; i++) expect(arr).toContain(r.pick(arr));
  });
});
