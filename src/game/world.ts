// World: the Three.js renderer. Kenney models baked into instanced meshes per
// floor, streamed in/out around the player; tide plane, bobbing wrack,
// procedural gulls; fog + day/dusk cycle.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import {
  CELL,
  DX,
  DZ,
  FLOOR,
  FLOOR_H,
  GRID,
  SLAB_T,
  STAIR,
  WALL,
  cellCenter,
} from "@shared/types";
import type { FloorLayout, House } from "@shared/types";
import { TIDE_PERIOD, tideLevel } from "@shared/tide";

/** Floors kept instantiated around the player's current floor. */
const STREAM_RADIUS = 2;

const MODEL_FILES = {
  floor: "bk_floor.glb",
  wall: "bk_wall.glb",
  wallWindow: "bk_wall_window_square.glb",
  wallLow: "bk_wall_low.glb",
  column: "bk_column.glb",
  columnWide: "bk_column_wide.glb",
  stairs: "bk_stairs_center.glb",
  rocks: "md_rocks.glb",
  boat: "wc_boat_row_large.glb",
  crate: "wc_cargo_container_a.glb",
} as const;

type ModelKey = keyof typeof MODEL_FILES;

interface FloorGroup {
  group: THREE.Group;
  index: number;
}

export class World {
  readonly ready: Promise<void>;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly models = new Map<ModelKey, THREE.Object3D>();
  private readonly floors = new Map<number, FloorGroup>();
  private readonly eggMeshes: THREE.Mesh[] = [];
  private collectedEggs = new Set<string>();
  private readonly water: THREE.Mesh;
  private readonly gulls: GullFlock;
  private readonly sun: THREE.DirectionalLight;
  private time = 0;

  constructor(
    private house: House,
    canvas: HTMLCanvasElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.05,
      400,
    );

    this.scene.background = new THREE.Color(0xdfe3e6);
    this.scene.fog = new THREE.Fog(0xdfe3e6, 30, 140);

    const hemi = new THREE.HemisphereLight(0xf4f0e8, 0x6a6a66, 1.1);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
    this.sun.position.set(40, 80, 20);
    this.scene.add(this.sun);

    // The tide: one big plane at floor-0 level, raised/lowered each frame.
    // Kept faint (low opacity) so the flooded halls stay readable underneath —
    // the tide is an atmosphere layer, not a lid.
    const waterGeo = new THREE.PlaneGeometry(GRID * CELL, GRID * CELL);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x3d6e7f,
      transparent: true,
      opacity: 0.35,
      roughness: 0.15,
      metalness: 0.1,
      depthWrite: false,
    });
    this.water = new THREE.Mesh(waterGeo, waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -10; // below the world until the first frame
    this.scene.add(this.water);

    this.gulls = new GullFlock();
    this.scene.add(this.gulls.points());

    this.ready = (async () => {
      await this.loadModels();
      this.streamFloors(0);
    })();
  }

  /** Player moved to (x,y,z) on floor f — restream floors, update camera. */
  sync(x: number, y: number, z: number, floorIndex: number): void {
    this.camera.position.set(x, y + EYE, z);
    if (this.models.size === 0) return; // models still loading
    this.streamFloors(floorIndex);
  }

  look(yaw: number, pitch: number): void {
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = yaw;
    this.camera.rotation.x = pitch;
  }

  /** Advance animations (tide, wrack bobbing, gulls, light). */
  update(dtSec: number): void {
    this.time += dtSec;

    // Tide on floor 0.
    const level = tideLevel(this.time);
    this.water.position.y = level + SLAB_T * 0.5;

    // Day/dusk cycle drives fog + sun colour over a long period.
    const dayT = (Math.sin((this.time / TIDE_PERIOD) * Math.PI) + 1) / 2;
    const skyDay = new THREE.Color(0xdfe3e6);
    const skyDusk = new THREE.Color(0xc9a689);
    const sky = skyDay.clone().lerp(skyDusk, 1 - dayT);
    (this.scene.background as THREE.Color).copy(sky);
    (this.scene.fog as THREE.Fog).color.copy(sky);
    this.sun.intensity = 0.9 + 0.6 * dayT;

    this.gulls.update(dtSec, this.time);

    // Wrack bobbing: every wreck mesh drifts on the water.
    for (const w of this.wreckMeshes) {
      w.mesh.position.y = level + Math.sin(this.time * 0.8 + w.phase) * 0.06;
      w.mesh.rotation.z = Math.sin(this.time * 0.5 + w.phase) * 0.04;
    }

    // Egg idle spin and bob.
    for (const e of this.eggMeshes) {
      if (!e.visible) continue;
      e.rotation.y += dtSec * 1.5;
      e.position.y = e.userData.baseY + Math.sin(this.time * 2 + e.userData.phase) * 0.08;
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /** True when the egg exists and is not yet collected. */
  hasEgg(key: string): boolean {
    return !this.collectedEggs.has(key);
  }

  /** Mark an egg collected; hides its mesh. Returns false if already gone. */
  collectEgg(floor: number, x: number, z: number): boolean {
    const key = `${floor}:${x}:${z}`;
    if (this.collectedEggs.has(key)) return false;
    this.collectedEggs.add(key);
    for (const m of this.eggMeshes) {
      if (m.userData.key === key) m.visible = false;
    }
    return true;
  }

  nearestVisibleEgg(): { pos: THREE.Vector3; key: string } | null {
    let best: { pos: THREE.Vector3; key: string; d: number } | null = null;
    for (const m of this.eggMeshes) {
      if (!m.visible) continue;
      const d = m.position.distanceTo(this.camera.position);
      if (best === null || d < best.d) best = { pos: m.position.clone(), key: m.userData.key, d };
    }
    return best === null ? null : { pos: best.pos, key: best.key };
  }

  // ── model loading & baking ────────────────────────────────────────────────

  private async loadModels(): Promise<void> {
    const loader = new GLTFLoader();
    const entries = Object.entries(MODEL_FILES) as Array<[ModelKey, string]>;
    await Promise.all(
      entries.map(
        ([key, file]) =>
          new Promise<void>((resolve, reject) => {
            loader.load(
              `assets/models/${file}`,
              (gltf) => {
                const root = gltf.scene;
                root.traverse((o) => {
                  if (o instanceof THREE.Mesh) {
                    o.castShadow = false;
                    o.receiveShadow = false;
                  }
                });
                this.models.set(key, root);
                resolve();
              },
              undefined,
              reject,
            );
          }),
      ),
    );
  }

  /** Instantiate/destroy per-floor groups so [f−RADIUS, f+RADIUS] exist. */
  private streamFloors(current: number): void {
    for (let f = Math.max(0, current - STREAM_RADIUS); f <= current + STREAM_RADIUS; f++) {
      if (!this.floors.has(f)) this.buildFloor(f);
    }
    for (const [f, fg] of this.floors) {
      if (Math.abs(f - current) > STREAM_RADIUS + 1) {
        this.scene.remove(fg.group);
        disposeGroup(fg.group);
        this.floors.delete(f);
      }
    }
  }

  private buildFloor(i: number): void {
    const layout: FloorLayout = this.house.floor(i);
    const group = new THREE.Group();
    group.name = `floor-${i}`;

    // Slab per open, non-stair cell; collect open cells for wall pass.
    const open: Array<{ x: number; z: number }> = [];
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        if (layout.cells[z * GRID + x] === WALL) continue;
        open.push({ x, z });
        if (layout.cells[z * GRID + x] === STAIR) continue;
        const c = cellCenter(i, x, z);
        const slab = this.instantiate("floor");
        slab.position.set(c.x, this.house.floorY(i), c.z);
        group.add(slab);
      }
    }

    // Walls: any face of an open cell adjacent to WALL (or out of range).
    for (const { x, z } of open) {
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const nz = z + DZ[d];
        const neighbourWall =
          nx < 0 || nx >= GRID || nz < 0 || nz >= GRID ||
          layout.cells[nz * GRID + nx] === WALL;
        if (!neighbourWall) continue;
        this.placeWall(group, i, x, z, d);
      }
    }

    // Colonnades: a column at the wall corner of every 3rd open cell that has
    // two opposite open neighbours (a hall edge), giving the long sightlines
    // their rhythm. Skipped on cells already walled on both sides.
    for (const { x, z } of open) {
      if ((x + z) % 3 !== 0) continue;
      const openN = [0, 1, 2, 3].filter((d) => {
        const nx = x + DX[d];
        const nz = z + DZ[d];
        return (
          nx >= 0 && nx < GRID && nz >= 0 && nz < GRID &&
          layout.cells[nz * GRID + nx] !== WALL
        );
      });
      const hasOpposite =
        openN.includes(0) && openN.includes(2) ? true :
        openN.includes(1) && openN.includes(3);
      if (!hasOpposite) continue;
      this.placeColumn(group, i, x, z);
    }

    // Stair runs: one stairs-center model per run, base cell → landing.
    for (const run of layout.stairsUp) {
      const c = cellCenter(i, run.x, run.z);
      const obj = this.instantiate("stairs");
      obj.position.set(c.x, this.house.floorY(i), c.z);
      obj.rotation.y = STAIR_YAW[run.dir];
      group.add(obj);
    }

    // Eggs: small procedural eggs on FLOOR cells.
    for (const e of layout.eggs) {
      const key = `${i}:${e.x}:${e.z}`;
      if (this.collectedEggs.has(key)) continue;
      const c = cellCenter(i, e.x, e.z);
      const egg = makeEgg();
      egg.position.set(c.x, this.house.floorY(i) + 0.35, c.z);
      egg.userData = { key, baseY: egg.position.y, phase: Math.random() * Math.PI * 2 };
      group.add(egg);
      this.eggMeshes.push(egg);
    }

    // Wrack drifts on the tide — floor 0 only.
    if (i === 0) {
      for (const w of layout.wrecks) {
        const c = cellCenter(0, w.x, w.z);
        const kind: ModelKey =
          w.kind === "rocks" ? "rocks" : w.kind === "boat" ? "boat" : "crate";
        const obj = this.instantiate(kind);
        obj.scale.setScalar(w.kind === "rocks" ? 1.6 : 1.4);
        obj.position.set(c.x, 0, c.z);
        obj.rotation.y = Math.random() * Math.PI * 2;
        group.add(obj);
        this.wreckMeshes.push({ mesh: obj, phase: Math.random() * Math.PI * 2 });
      }
    }

    this.scene.add(group);
    this.floors.set(i, { group, index: i });
  }

  private placeWall(group: THREE.Group, i: number, x: number, z: number, d: number): void {
    const c = cellCenter(i, x, z);
    const obj = this.instantiate("wall");
    // Walls are thin along x in model space (±0.05); rotate to face outward.
    obj.rotation.y = WALL_YAW[d];
    const off = CELL / 2 - 0.05;
    obj.position.set(
      c.x + DX[d] * off,
      this.house.floorY(i),
      c.z + DZ[d] * off,
    );
    group.add(obj);
  }

  private placeColumn(group: THREE.Group, i: number, x: number, z: number): void {
    const c = cellCenter(i, x, z);
    const obj = this.instantiate("column");
    obj.position.set(c.x, this.house.floorY(i), c.z);
    group.add(obj);
  }


  private instantiate(key: ModelKey): THREE.Object3D {
    const src = this.models.get(key);
    if (!src) throw new Error(`model ${key} not loaded`);
    return src.clone(true);
  }

  private wreckMeshes: WreckRef[] = [];
}

interface WreckRef {
  mesh: THREE.Object3D;
  phase: number;
}

const EYE = 1.62;

/** Model ascends towards +z; yaw needed to ascend along dir 0=+x,1=+z,2=−x,3=−z. */
const STAIR_YAW = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

/** Wall model is thin along x; yaw per direction so the thin axis faces the gap. */
const WALL_YAW = [Math.PI / 2, 0, Math.PI / 2, 0];

function makeEgg(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(0.16, 12, 10);
  geo.scale(1, 1.3, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xe8ddc8, roughness: 0.5 });
  return new THREE.Mesh(geo, mat);
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m.dispose();
    }
  });
}

// ── gulls ────────────────────────────────────────────────────────────────────

/** Procedural gulls: white specks circling high up, with lazy wing flap. */
class GullFlock {
  private readonly flock: THREE.Points;
  private readonly seeds: Float32Array;

  constructor(count = 24) {
    this.seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.seeds[i * 4] = Math.random() * Math.PI * 2; // orbit phase
      this.seeds[i * 4 + 1] = 14 + Math.random() * 26; // height
      this.seeds[i * 4 + 2] = 18 + Math.random() * 50; // orbit radius
      this.seeds[i * 4 + 3] = 0.2 + Math.random() * 0.25; // angular speed
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.5 });
    this.flock = new THREE.Points(geo, mat);
  }

  points(): THREE.Points {
    return this.flock;
  }

  update(_dt: number, t: number): void {
    const attr = this.flock.geometry.getAttribute("position") as THREE.BufferAttribute;
    const n = this.seeds.length / 4;
    for (let i = 0; i < n; i++) {
      const phase = this.seeds[i * 4] + t * this.seeds[i * 4 + 3];
      const h = this.seeds[i * 4 + 1];
      const r = this.seeds[i * 4 + 2];
      attr.setXYZ(i, Math.cos(phase) * r, h + Math.sin(phase * 3) * 1.5, Math.sin(phase) * r);
    }
    attr.needsUpdate = true;
  }
}
