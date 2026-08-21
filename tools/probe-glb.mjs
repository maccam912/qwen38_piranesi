// Probe GLB files: print node names, transforms, and bounding boxes (from POSITION accessors).
import { readFileSync } from "node:fs";

const ROOT = "/Users/maccam912/Downloads/Kenney Game Assets All-in-1 3.5.0";
const targets = process.argv.slice(2);

function loadGlb(path) {
  const buf = readFileSync(path);
  if (buf.length < 12 || String.fromCharCode(buf[0], buf[1], buf[2]) !== "glT") throw new Error("not glb: " + path);
  const magic = String.fromCharCode(...buf.subarray(0, 4));
  if (magic !== "glTF") throw new Error("bad magic " + magic + " in " + path);
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = String.fromCharCode(...buf.subarray(off + 4, off + 8));
    if (type === "JSON") {
      const json = JSON.parse(Buffer.from(buf.subarray(off + 8, off + 8 + len)).toString("utf8"));
      return { json, bin: buf.subarray(off + 8, off + 8 + len) };
    }
    off += 8 + len;
    if (off > buf.length) break;
  }
  throw new Error("no JSON chunk in " + path);
}
function readAccessor(json, bin, accIdx) {
  const acc = json.accessors[accIdx];
  if (!acc) return null;
  const bv = json.bufferViews[acc.bufferView];
  let byteOffset = bv.byteOffset + (acc.byteOffset || 0);
  const compo = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const size = { UBYTE: 1, BYTE: 1, USHORT: 2, SHORT: 2, UINT: 4, INT: 4, FLOAT: 4 }[acc.componentType];
  const total = size * compo;
  if (bv.byteOffset + bv.byteLength > bin.length) return null;
  const chunk = Buffer.from(bin.subarray(byteOffset, byteOffset + Math.min(total * (acc.count || 1), bin.length - byteOffset)));
  const out = [];
  const count = Math.min(acc.count || 0, Math.floor(chunk.length / total));
  for (let i = 0; i < count; i++) {
    const v = [];
    for (let c = 0; c < compo; c++) {
      const o = i * total + c * size;
      v.push(size === 1 ? chunk[o] : size === 2 ? chunk.readUInt16LE(o) : chunk.readFloatLE(o));
    }
    out.push(v.length === 1 ? v[0] : v);
  }
  return { min: acc.min, max: acc.max, pts: out };
}

for (const rel of targets) {
  const path = `${ROOT}/${rel}`;
  let g;
  try { g = loadGlb(path); } catch (e) { console.log(`${rel}  ERR ${e.message}`); continue; }
  const { json, bin } = g;
  console.log(`\n### ${rel}`);
  const nodes = json.nodes || [];
  function nodeBBox(i, tx, ty, tz) {
    const n = nodes[i];
    // world translation of this node (we only handle top-level; Kenney exports are flat-ish)
    const tr = n.translation || [0, 0, 0];
    const ox = tx + tr[0], oy = ty + tr[1], oz = tz + tr[2];
    let bb = null;
    const prim = n.mesh ? (json.meshes[n.mesh]?.primitives || []) : [];
    for (const p of prim) {
      const pos = readAccessor(json, bin, p.attributes?.POSITION);
      if (!pos) continue;
      let mn, mx;
      if (pos.min && pos.max) {
        mn = pos.min.map((v, k) => v + [ox, oy, oz][k]);
        mx = pos.max.map((v, k) => v + [ox, oy, oz][k]);
      } else if (pos.pts.length) {
        mn = [Infinity, Infinity, Infinity]; mx = [-Infinity, -Infinity, -Infinity];
        for (const v of pos.pts) {
          const w = [v[0] + ox, v[1] + oy, v[2] + oz];
          for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); }
        }
      } else continue;
      bb = bb ? bb.map((a, k) => [Math.min(a[0], mn[k]), Math.max(a[1], mx[k])]).map(([a, b]) => a + " " + b) : null;
      // accumulate simply:
    }
  }
  // Simpler: one bbox per mesh primitive, with node name chain (Kenney GLBs: 1 scene, few nodes)
  for (let mi = 0; mi < (json.meshes || []).length; mi++) {
    const m = json.meshes[mi];
    let owner = "?";
    for (let ni = 0; ni < nodes.length; ni++) if (nodes[ni].mesh === mi) owner = nodes[ni].name ?? `node${ni}`;
    for (const p of m.primitives || []) {
      const pos = readAccessor(json, bin, p.attributes?.POSITION);
      let box;
      if (pos && pos.min && pos.max) box = `[${pos.min.map((v) => v.toFixed(2))} .. ${pos.max.map((v) => v.toFixed(2))}]`;
      else if (pos && pos.pts.length) {
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const v of pos.pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); }
        box = `[${mn.map((v) => v.toFixed(2))} .. ${mx.map((v) => v.toFixed(2))}]`;
      } else box = "(no positions)";
      const mode = p.mode === 4 ? "tri" : p.mode ?? "?";
      console.log(`  mesh[${mi}] ${m.name || owner} mode=${mode} verts=${pos?.pts?.length ?? "?"} bbox=${box}`);
    }
  }
  console.log(`  nodes: ${nodes.map((n) => n.name ?? "?").join(", ")}; materials: ${(json.materials || []).map((m) => m.name).join(", ")}`);
}
