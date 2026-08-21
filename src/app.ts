// App: composition root. Wires the House (shared), the World (renderer), the
// Player, and the AudioDirector together; owns the HUD, menus, pointer lock,
// and win state. Exposes `window.__piranesi` for tests.

import { GeneratedHouse } from "@shared/house";
import { TOTAL_EGGS } from "@shared/types";
import { Player, EYE_H, makeInput } from "./game/player";
import { World } from "./game/world";
import { AudioDirector } from "./game/audio";
import type { InputState } from "./game/player";

declare global {
  interface Window {
    __piranesi: {
      house: GeneratedHouse;
      world: World;
      player: Player;
      setInput(next: Partial<InputState>): void;
      collectNextEgg(): boolean;
      state(): Record<string, unknown>;
    };
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const seed = params.get("seed") || String(Math.floor(Math.random() * 1e9));

const house = new GeneratedHouse({ seed });
const canvas = document.createElement("canvas");
document.getElementById("app")!.appendChild(canvas);
const world = new World(house, canvas);
const player = new Player(house);
const audio = new AudioDirector();
const input = makeInput();

let state: "menu" | "playing" | "paused" | "won" = "menu";
let eggsCollected = 0;
let startTime = 0;

player.spawn();

// ── DOM handles ──────────────────────────────────────────────────────────────

const el = {
  hud: document.getElementById("hud")!,
  hall: document.getElementById("hud-hall")!,
  eggs: document.getElementById("hud-eggs")!,
  seedBox: document.getElementById("hud-seed")!,
  hint: document.getElementById("hud-hint")!,
  toast: document.getElementById("toast")!,
  menuStart: document.getElementById("menu-start")!,
  menuPause: document.getElementById("menu-pause")!,
  menuWin: document.getElementById("menu-win")!,
  btnStart: document.getElementById("btn-start")!,
  btnResume: document.getElementById("btn-resume")!,
  pauseStats: document.getElementById("pause-stats")!,
  winStats: document.getElementById("win-stats")!,
  menuSeed: document.getElementById("menu-seed")!,
};

el.menuSeed.textContent = `seed: ${seed}`;
el.seedBox.textContent = `seed: ${seed}`;
el.seedBox.addEventListener("click", () => {
  const url = `${location.origin}${location.pathname}?seed=${encodeURIComponent(seed)}`;
  void navigator.clipboard?.writeText(url);
  showToast("link copied");
});

// ── input ────────────────────────────────────────────────────────────────────

const KEYMAP: Record<string, keyof typeof input> = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
};

window.addEventListener("keydown", (e) => {
  const k = KEYMAP[e.code];
  if (k !== undefined) {
    input[k] = true;
    e.preventDefault();
  }
  if (e.code === "KeyM") {
    const muted = audio.toggleMute();
    showToast(muted ? "muted" : "sound on");
  }
  if (e.code === "Escape" && state === "playing") pause();
});
window.addEventListener("keyup", (e) => {
  const k = KEYMAP[e.code];
  if (k !== undefined) input[k] = false;
});

// Pointer lock: `requestPointerLock()` returns a Promise in current Chrome and
// REJECTS (silently, when voided) on the ~1.25 s cooldown after an Escape
// exit, or without a user gesture. Every failure must surface and re-arm.

function requestLock(): void {
  const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      showToast("click to capture mouse");
    });
  }
}

canvas.addEventListener("click", () => {
  if (state === "playing" && document.pointerLockElement !== canvas) {
    requestLock();
  }
});

document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch -= e.movementY * 0.0022;
  const lim = Math.PI / 2 - 0.05;
  player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
});

document.addEventListener("pointerlockerror", () => {
  if (state === "playing") showToast("click to capture mouse");
});

document.addEventListener("pointerlockchange", () => {
  // Losing lock while playing means Escape was pressed — pause via that path.
  if (document.pointerLockElement !== canvas && state === "playing" && !suppressPauseOnUnlock) pause();
});

/** True while we intentionally released the lock (pause/win transitions). */
let suppressPauseOnUnlock = false;

// ── menus ────────────────────────────────────────────────────────────────────

function show(which: "start" | "pause" | "win" | null): void {
  el.menuStart.classList.toggle("hidden", which !== "start");
  el.menuPause.classList.toggle("hidden", which !== "pause");
  el.menuWin.classList.toggle("hidden", which !== "win");
  el.hud.classList.toggle("hidden", which !== null);
}

function startGame(): void {
  void audio.start();
  audio.playSelect();
  state = "playing";
  show(null);
  startTime = performance.now();
  requestLock();
}

function pause(): void {
  if (state !== "playing") return;
  state = "paused";
  input.up = input.down = input.left = input.right = input.sprint = false;
  el.pauseStats.textContent =
    `${eggsCollected} of ${TOTAL_EGGS} gull eggs · floor ${player.floorIndex + 1}`;
  show("pause");
  if (document.pointerLockElement === canvas) {
    suppressPauseOnUnlock = true;
    document.exitPointerLock();
    suppressPauseOnUnlock = false;
  }
}

function resume(): void {
  audio.playSelect();
  state = "playing";
  show(null);
  requestLock();
}

function newHouse(): void {
  location.href = `${location.origin}${location.pathname}?seed=${encodeURIComponent(
    String(Math.floor(Math.random() * 1e9)),
  )}`;
}

el.btnStart.addEventListener("click", startGame);
el.btnResume.addEventListener("click", resume);
for (const id of ["btn-newhouse", "btn-newhouse2"]) {
  document.getElementById(id)!.addEventListener("click", newHouse);
}

// ── HUD helpers ──────────────────────────────────────────────────────────────

let toastTimer = 0;
function showToast(msg: string): void {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.remove("show"), 1800);
}

// ── main loop ────────────────────────────────────────────────────────────────

const STEP = 1 / 120;
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  if (state === "playing") {
    acc += dt;
    while (acc >= STEP) {
      player.update(STEP, input);
      acc -= STEP;
    }
    checkEggPickup();
  }

  const tSec = now / 1000;
  world.sync(player.x, player.y, player.z, player.floorIndex);
  world.look(player.yaw, player.pitch);
  world.update(state === "playing" ? dt : 0);
  world.render();
  audio.update(tSec, player.floorIndex === 0, input.up || input.down || input.left || input.right);

  // HUD
  el.hall.textContent = `Hall ${player.floorIndex + 1}`;
  el.eggs.textContent = `Gull eggs ${eggsCollected} / ${TOTAL_EGGS}`;
}

/** Pick up any egg within reach; chime + toast on collection. */
function checkEggPickup(): void {
  const near = world.nearestVisibleEgg();
  if (!near) return;
  const dx = near.pos.x - player.x;
  const dz = near.pos.z - player.z;
  const dy = near.pos.y - (player.y + EYE_H * 0.5);
  if (dx * dx + dz * dz > 1.44 || Math.abs(dy) > 1.6) return;
  const [f, x, z] = near.key.split(":").map(Number);
  if (!world.collectEgg(f, x, z)) return;
  eggsCollected++;
  audio.playChime();
  showToast(eggsCollected === TOTAL_EGGS ? "the House is searched" : "a gull egg");
  if (eggsCollected === TOTAL_EGGS) win();
}

function win(): void {
  state = "won";
  const secs = Math.round((performance.now() - startTime) / 1000);
  el.winStats.textContent = `All ${TOTAL_EGGS} eggs · ${Math.floor(secs / 60)}m ${secs % 60}s · seed ${seed}`;
  if (document.pointerLockElement === canvas) {
    suppressPauseOnUnlock = true;
    document.exitPointerLock();
    suppressPauseOnUnlock = false;
  }
}

// ── test hooks ───────────────────────────────────────────────────────────────

window.__piranesi = {
  house,
  world,
  player,
  setInput(next: Partial<typeof input>): void {
    Object.assign(input, next);
  },
  collectNextEgg(): boolean {
    // Teleport beside the nearest un-collected egg (its mesh must exist so the
    // pickup check can fire) and face it; walking one step collects it.
    for (let f = Math.max(0, player.floorIndex - 1); f <= player.floorIndex + 2; f++) {
      const layout = house.floor(f);
      for (const e of layout.eggs) {
        const key = `${f}:${e.x}:${e.z}`;
        if (!world.hasEgg(key)) continue;
        const c = { x: (e.x - 40) * 2 + 1, z: (e.z - 40) * 2 + 1 };
        player.x = c.x;
        player.z = c.z - 0.9;
        player.y = f * 2.5;
        player.floorIndex = f;
        player.onStair = null;
        player.yaw = 0; // forward is −z: towards the egg
        return true;
      }
    }
    return false;
  },
  state(): Record<string, unknown> {
    return {
      x: player.x,
      y: player.y,
      z: player.z,
      floor: player.floorIndex,
      onStair: player.onStair !== null,
      eggsCollected,
      state,
    };
  },
};

show("start");
requestAnimationFrame(frame);
