// The tide: a slow, eternal oscillation through the ground floor of the House.

/** Seconds per full tide cycle (high → low → high). */
export const TIDE_PERIOD = 150;

/** Tide height in metres above floor-0 level, in [0.15, 1.05]. */
export function tideLevel(tSec: number): number {
  return 0.6 + 0.45 * Math.sin((2 * Math.PI * tSec) / TIDE_PERIOD);
}

/** True when the water is deep enough to slow a walker (wading). */
export function isWading(tSec: number): boolean {
  return tideLevel(tSec) > 0.35;
}
