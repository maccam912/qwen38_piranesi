#!/usr/bin/env node
// Copies the Kenney Game Assets we need into public/assets/ (idempotent).
// Run: node tools/copy-assets.mjs

import { cpSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.join(homedir(), "Downloads", "Kenney Game Assets All-in-1 3.5.0");
const PUBLIC = path.join(process.cwd(), "public", "assets");

const BK = path.join(ROOT, "3D assets/Building Kit/Models/GLB format");
const MD = path.join(ROOT, "3D assets/Mini Dungeon/Models/GLB format");
const WC = path.join(ROOT, "3D assets/Watercraft Pack/Models/GLB format");
const MUS = path.join(ROOT, "Audio/Music Loops/Loops");
const UI = path.join(ROOT, "Audio/Interface Sounds/Audio");
const JING = path.join(ROOT, "Audio/Music Jingles/Audio (Pizzicato)");

// [source dir, source name, destination name under public/assets]
const copies = [
  // Models (12 GLBs; self-contained — embedded BIN textures, no sibling Textures dirs)
  [BK, "floor.glb", "models/bk_floor.glb"],
  [BK, "wall.glb", "models/bk_wall.glb"],
  [BK, "wall-window-square.glb", "models/bk_wall_window_square.glb"],
  [BK, "wall-low.glb", "models/bk_wall_low.glb"],
  [BK, "column.glb", "models/bk_column.glb"],
  [BK, "column-wide.glb", "models/bk_column_wide.glb"],
  [BK, "stairs-center.glb", "models/bk_stairs_center.glb"],
  [MD, "rocks.glb", "models/md_rocks.glb"],
  [MD, "column.glb", "models/md_column.glb"],
  [WC, "boat-row-large.glb", "models/wc_boat_row_large.glb"],
  [WC, "cargo-container-a.glb", "models/wc_cargo_container_a.glb"],
  [WC, "cargo-container-b.glb", "models/wc_cargo_container_b.glb"],
  // Audio (5 OGGs)
  [MUS, "Infinite Descent.ogg", "audio/music_infinite_descent.ogg"],
  [MUS, "Night at the Beach.ogg", "audio/music_night_at_the_beach.ogg"],
  [UI, "select_004.ogg", "audio/ui_select.ogg"],
  [UI, "toggle_001.ogg", "audio/ui_toggle.ogg"],
  [JING, "jingles-pizzicato_04.ogg", "audio/egg_chime.ogg"],
  // CC0 license attribution
  [path.join(BK, "..", ".."), "License.txt", "Kenney-CC0-LICENSE.txt"],
].map(([dir, name, dest]) => ({ source: path.join(dir, name), dest }));

let failed = 0;
const rows = [];

for (const { source, dest } of copies) {
  const target = path.join(PUBLIC, dest);
  if (!statSync(source, { throwIfNoEntry: false })) {
    console.error(`MISSING source: ${source}`);
    failed++;
    continue;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target); // overwrite — idempotent

  const bytes = statSync(target).size;
  const head = readFileSync(target, { start: 0 });
  let magic = "ok";
  if (dest.endsWith(".glb")) {
    const m = head.subarray(0, 4).toString("latin1");
    magic = m === "glTF" ? "glTF ✓" : `BAD MAGIC "${m}"`;
  } else if (dest.endsWith(".ogg")) {
    const m = head.subarray(0, 4).toString("latin1");
    magic = m === "OggS" ? "OggS ✓" : `BAD MAGIC "${m}"`;
  }
  const good = bytes > 0 && (magic === "ok" || magic.endsWith("✓"));
  if (!good) failed++;
  rows.push([dest, bytes, magic]);
}

// destination → bytes table
const col1 = Math.max(...rows.map((r) => r[0].length), "destination".length);
console.log(`\n${"destination".padEnd(col1)}  ${"bytes".padStart(9)}  magic`);
for (const [dest, bytes, magic] of rows) {
  console.log(`${dest.padEnd(col1)}  ${String(bytes).padStart(9)}  ${magic}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${copies.length} copies failed verification.`);
  process.exit(1);
}
console.log(`\n${copies.length}/${copies.length} files in place under public/assets/`);
