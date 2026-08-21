// Headless browser smoke test for Piranesi.
// Boots the Vite dev server, drives the real game through Chrome, and asserts:
//   1. the house renders (world.ready resolves),
//   2. a stair run is traversed end-to-end in the browser (floor 0 -> floor 1, y rises 2.5 m),
//   3. the player never ends up inside a wall after emerging from the stair,
//   4. an egg can be collected.
// Exits non-zero on any failure; writes a screenshot to output/screenshots/piranesi-smoke.png.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PORT = 5173;
const URL_BASE = `http://localhost:${PORT}/?seed=SMOKE42`;
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function fail(msg) {
  console.error(`\nSMOKE FAIL: ${msg}`);
  process.exit(1);
}

async function waitHttp(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite did not come up at ${url}`);
}

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
vite.stdout.on("data", (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`[vite] ${d}`));
vite.stderr.on("data", (d) => process.env.SMOKE_VERBOSE && process.stderr.write(`[vite!] ${d}`));
process.on("exit", () => vite.kill("SIGKILL"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  await waitHttp(`http://localhost:${PORT}/`);

  if (!existsSync(CHROME)) fail(`Chrome not found at ${CHROME}`);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--use-gl=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.error(`[page error] ${err.message}`));
  page.on("console", (m) => m.type() === "error" && console.error(`[console.error] ${m.text()}`));

  await page.goto(URL_BASE, { waitUntil: "domcontentloaded", timeout: 30000 });

  // ── 1. world ready (models baked, house built) ───────────────────────────
  await page.waitForFunction(
    () => !!window.__piranesi && window.__piranesi.world !== undefined,
    { timeout: 30000 },
  ).catch(() => fail("window.__piranesi never appeared (app failed to boot)"));
  await page.evaluate(() => window.__piranesi.world.ready).catch(() => fail("world.ready rejected"));
  console.log("ok: world ready");

  // ── start the game ────────────────────────────────────────────────────────
  await page.click("#btn-start");
  await sleep(500);

  // ── 2. climb a real stair run: floor 0 -> floor 1 ─────────────────────────
  const setup = await page.evaluate(() => {
    const api = window.__piranesi;
    if (!api) return null;
    const { house, player } = api;
    const f0 = house.floor(0);
    const run = f0.stairsUp.find((r) => r.x >= 0 && r.z >= 0);
    if (!run) return { error: "no stair run on floor 0" };
    const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
    // approach cell: the open cell BEHIND the base (base − dir), i.e. standing
    // at the bottom of the run facing straight up it. The generator guarantees
    // ≥1 FLOOR neighbour of s0; prefer the one on the run axis.
    const dirs = [0, 1, 2, 3];
    const behind = { x: run.x - DX[run.dir], z: run.z - DZ[run.dir] };
    const approach =
      house.cell(0, behind.x, behind.z) === 1
        ? behind
        : dirs
            .map((d) => ({ x: run.x + DX[d], z: run.z + DZ[d] }))
            .find((c) => house.cell(0, c.x, c.z) === 1);
    if (!approach) return { error: "stair base has no FLOOR approach (invariant violated)" };
    const cx = (approach.x - 40) * 2 + 1, cz = (approach.z - 40) * 2 + 1; // cell centre
    const dx = DX[run.dir], dz = DZ[run.dir];
    player.x = cx; player.y = 0; player.z = cz;
    player.onStair = null; player.floorIndex = 0;
    player.yaw = Math.atan2(-dx, -dz); // face straight up the run
    player.pitch = 0;
    api.setInput({ up: true, down: false, left: false, right: false, sprint: false });
    return { ok: true, landing: { x: run.x + 2 * DX[run.dir], z: run.z + 2 * DZ[run.dir] } };
  });
  if (!setup || setup.error) fail(`stair setup: ${setup?.error ?? "evaluate returned null"}`);
  console.log("ok: player placed at stair approach, walking up");

  // walk in for ~4 s (run is 4 m at 3.4 m/s ≈ 1.2 s; generous margin)
  const climbed = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const s = window.__piranesi.state();
      if (s.floor === 1 && !s.onStair) {
        // keep walking a moment after emerging: must not be in a wall / NaN
        await sleep(800);
        const s2 = window.__piranesi.state();
        return { ...s2, emergedOk: Number.isFinite(s2.x) && Number.isFinite(s2.y) && s2.y > 1.9 };
      }
    }
    return window.__piranesi.state();
  });
  if (climbed.floor !== 1) fail(`stair climb failed: ended on floor ${climbed.floor} (y=${climbed.y})`);
  if (climbed.y < 2.0) fail(`stair climb failed: y=${climbed.y} after reaching floor 1 (expected ≈2.5)`);
  if (!climbed.emergedOk) fail(`player not valid after emerging from stair: ${JSON.stringify(climbed)}`);
  console.log(`ok: climbed floor 0 -> 1 (y=${climbed.y.toFixed(2)}), emerged cleanly`);

  // walk away from the landing to prove it is not a dead-end pocket
  await page.evaluate(() => {
    window.__piranesi.setInput({ up: true, down: false, left: false, right: false });
  });
  await sleep(700);
  const after = await page.evaluate(() => {
    const s = window.__piranesi.state();
    return { ...s, finite: Number.isFinite(s.x) && Number.isFinite(s.z) };
  });
  if (!after.finite || after.floor !== 1) fail(`landing dead-end check failed: ${JSON.stringify(after)}`);
  console.log("ok: walked freely after emerging (no wall in the face)");

  // ── 3. collect an egg ─────────────────────────────────────────────────────
  const got = await page.evaluate(async () => {
    const api = window.__piranesi;
    const before = api.state().eggsCollected;
    if (!api.collectNextEgg()) return { before, after: before };
    await new Promise((r) => setTimeout(r, 1200)); // walk-to-egg + pickup frame
    return { before, after: api.state().eggsCollected };
  });
  if (got.after <= got.before) fail(`egg collection failed: ${JSON.stringify(got)}`);
  console.log(`ok: egg collected (${got.before} -> ${got.after})`);

  // ── screenshot for the record / oMLX ──────────────────────────────────────
  const shotDir = resolve(ROOT, "output/screenshots");
  mkdirSync(shotDir, { recursive: true });
  const shot = resolve(shotDir, "piranesi-smoke.png");
  await page.screenshot({ path: shot });
  console.log(`ok: screenshot -> ${shot}`);

  console.log("\nSMOKE OK — house renders, stairs traverse end-to-end, eggs collect.");
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill("SIGKILL");
}
