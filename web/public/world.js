/* world.js: the beckett archipelago, second expedition.
 *
 * One coherent 3D voxel world (three.js, instanced cubes). The world IS the
 * pitch: a main island (this Beckett's home) surrounded by a federation of
 * smaller islands (everyone else's), with signal arcs carrying packets
 * between them. Scroll drives a choreographed camera path from the hero
 * close-up to the wide federation reveal — and now it also drives TIME:
 * the page is one day on the archipelago, morning at the hero, golden hour
 * over the capabilities, and full night by the CTA, when the windows come
 * on, the fireflies come out and the network glows.
 *
 * New since the first expedition:
 *   - scroll-linked day cycle (sky, sun, fog, lights, all keyframed)
 *   - hand-rolled post stack: HDR scene target -> bright pass -> separable
 *     blur -> composite with bloom, night grade, vignette and grain
 *   - the world is touchable: islands lift and introduce themselves under
 *     the pointer, clicking one fires a signal burst down its arc, clicking
 *     Beckett's turf plants a flower, clicking the pond ripples it
 *   - a waterfall off the home island rim, birds circling the grove,
 *     stars + shooting stars + fireflies after dusk, and a beacon on the
 *     cabin that tethers the live console card into the scene
 *
 * Geometry stays deterministic (seeded hash noise) so the world is identical
 * on every visit and every resize; only transient effects use the clock.
 * Reduced-motion renders still frames (day cycle included, per scroll).
 * No WebGL -> the CSS sky gradient stays and the page works fine.
 */
import * as THREE from './vendor/three.module.min.js';

/* ── deterministic noise (same hash the old site used) ─────────────────── */
function rnd(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2246822519) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return h / 4294967295;
}

/* ── palette: pastel cyan + pastel lavender, opaque and soft ───────────── */
const P = {
  grassA: 0xb7e2c1, grassB: 0xa9d6b3,
  soilA: 0xcbbadf, soilB: 0xb9a7d1, core: 0xa392bf,   // lavender earth under mint turf
  pathA: 0xefe7d4, pathB: 0xe4d9c2,
  trunk: 0xbc9f8c,
  blossom: [0xdcc9f4, 0xcfb9ee, 0xe9d7f8, 0xf2dcf0],
  pine: [0x9ed8c3, 0x8ccab2, 0x7dbda3],
  stone: 0xc9c4d9, stoneD: 0xb6b0cc, snow: 0xfbfcff,
  water: 0xa9e3ea, waterD: 0x99dae2,
  wall: 0xf7f0e0, wallD: 0xebe2cd, roof: 0xb3a4dd, roofD: 0xa090d0,
  win: 0xffe2a1,
  cloud: 0xffffff,
  crystal: [0xc7b6f2, 0xd7c9f7, 0xb5a1ea],
  shroomCap: 0xe8b7cd, shroomDot: 0xfdf3f7, shroomStem: 0xf4eee2,
  flower: [0xf4c9d9, 0xffe2a1, 0xcfb9ee, 0xffffff],
  flag: [0x8fd8de, 0xcfb9ee, 0xf4c9d9, 0xffe2a1, 0x9ed8c3],
  balloon: [0xa9dfe6, 0xcfb9ee, 0xf6dcea, 0xffffff],
  basket: 0xbc9f8c,
  bird: 0x847bab,
  beacon: 0x8fe8f0,
};

/* ── the day, keyframed on scroll progress. p is 0 at the hero, 1 at the
   footer. Everything the light touches is listed here. ───────────────── */
const CYCLE = [
  { p: 0.00, top: 0xbfe6ee, mid: 0xe4ddf5, low: 0xd9cff0, fog: 0xded7f2, sun: 0xfff6e8, sunI: 1.25, hs: 0xe3f6f8, hg: 0xc7b9e6, hemiI: 0.95, sunPos: [55, 90, 35], warm: 0.06, night: 0, disk: 1 },
  { p: 0.44, top: 0xb7e4f0, mid: 0xe9e3f5, low: 0xdccff0, fog: 0xe0d9f2, sun: 0xfff3de, sunI: 1.32, hs: 0xecf9f9, hg: 0xccbfe9, hemiI: 1.00, sunPos: [28, 96, 22], warm: 0.05, night: 0, disk: 1 },
  { p: 0.72, top: 0xcdc2ec, mid: 0xf3cdd8, low: 0xf8d8bc, fog: 0xeed2dc, sun: 0xffc998, sunI: 1.05, hs: 0xffe9d2, hg: 0xc7addd, hemiI: 0.88, sunPos: [88, 26, 6], warm: 0.60, night: 0.08, disk: 1 },
  { p: 0.90, top: 0x6b62a4, mid: 0xa383b4, low: 0xd39aa8, fog: 0x8a78b0, sun: 0xffa07e, sunI: 0.70, hs: 0xb4a0d6, hg: 0x776aa4, hemiI: 0.78, sunPos: [96, 8, -8], warm: 1.00, night: 0.50, disk: 0.80 },
  // night stays MOONLIT pastel, not blackout: the world should still read
  { p: 1.00, top: 0x2e2952, mid: 0x4c4480, low: 0x6a5d99, fog: 0x4a4074, sun: 0xaabdff, sunI: 0.55, hs: 0x8579b8, hg: 0x4f4880, hemiI: 0.80, sunPos: [-45, 75, -25], warm: 0.00, night: 1, disk: 0 },
];

/* ── tiny voxel-list builders (all in integer grid space) ──────────────── */
function heightAt(gx, gy, seed) {
  const n = Math.sin(gx * 0.42 + seed) * 0.9 + Math.cos(gy * 0.47 + seed * 2.3) * 0.8
    + (rnd(gx, gy, seed | 0) - 0.5) * 1.4;
  return Math.max(0, Math.min(3, Math.round(n * 0.6 + 0.9)));
}

/* a floating island: mint turf on top, lavender soil tapering to a point */
function islandBase(vox, r, seed) {
  const tops = [];
  for (let gx = -r; gx <= r; gx++) for (let gy = -r; gy <= r; gy++) {
    const dd = Math.sqrt(gx * gx + gy * gy);
    if (dd > r + (rnd(gx, gy, seed + 9) - 0.5) * 1.6) continue;
    const edge = Math.max(0, 1 - dd / r);              // lower toward the rim
    const h = Math.round(heightAt(gx, gy, seed) * Math.min(1, edge * 2.4));
    for (let z = h; z >= h - 1; z--)
      vox.push({ x: gx, y: z, z: gy, c: ((gx + gy + z) & 1) ? P.grassA : P.grassB });
    tops.push({ gx, gy, h });
    // the underside: soil shrinking with depth, eroded by noise
    const depth = Math.round(r * 0.85 + 2);
    for (let d = 1; d <= depth; d++) {
      const rr = r * (1 - d / depth);
      const e = (rnd(gx + seed, gy - seed, d) - 0.5) * 2.2;
      if (dd <= rr + e) {
        const c = d <= 2 ? P.soilA : (d <= depth * 0.55 ? P.soilB : P.core);
        vox.push({ x: gx, y: h - 1 - d, z: gy, c });
      }
    }
  }
  return tops;
}
function topAt(tops, gx, gy) {
  let best = 0;
  for (const t of tops) if (t.gx === gx && t.gy === gy) best = t.h;
  return best;
}

function blossomTree(vox, ox, oy, oz, seed) {
  for (let z = 0; z < 4; z++) vox.push({ x: ox, y: oy + z, z: oz, c: P.trunk });
  for (let bx = -3; bx <= 3; bx++) for (let by = -3; by <= 3; by++) for (let bz = 3; bz <= 7; bz++) {
    const dz = bz - 5, rr = bx * bx + by * by + dz * dz * 1.6;
    if (rr < 8.5 && rnd(bx + seed, by, bz) > 0.18)
      vox.push({ x: ox + bx, y: oy + bz, z: oz + by, c: P.blossom[(Math.abs(bx + by * 2 + bz)) % P.blossom.length] });
  }
}
function pineTree(vox, ox, oy, oz) {
  for (let z = 0; z < 2; z++) vox.push({ x: ox, y: oy + z, z: oz, c: P.trunk });
  [[2, 2], [3, 2], [4, 1], [5, 1], [6, 0]].forEach(([z, rr]) => {
    for (let gx = -rr; gx <= rr; gx++) for (let gy = -rr; gy <= rr; gy++)
      if (Math.abs(gx) + Math.abs(gy) <= rr + 0.5)
        vox.push({ x: ox + gx, y: oy + z, z: oz + gy, c: P.pine[(z + Math.abs(gx)) % P.pine.length] });
  });
}
function cabin(vox, glow, ox, oy, oz) {
  for (let gx = 0; gx < 5; gx++) for (let gy = 0; gy < 5; gy++) for (let gz = 0; gz < 4; gz++)
    if (gx === 0 || gx === 4 || gy === 0 || gy === 4)
      vox.push({ x: ox + gx, y: oy + gz, z: oz + gy, c: ((gx + gy) & 1) ? P.wall : P.wallD });
  // door + lit windows on the +z face, which is the side the camera lives on
  vox.push({ x: ox + 2, y: oy, z: oz + 4, c: P.wallD });
  glow.push({ x: ox + 1, y: oy + 2, z: oz + 4, c: P.win });
  glow.push({ x: ox + 3, y: oy + 2, z: oz + 4, c: P.win });
  for (let inset = 0, gz = 4; inset <= 2; inset++, gz++)
    for (let rx = inset; rx <= 4 - inset; rx++) for (let ry = inset; ry <= 4 - inset; ry++)
      vox.push({ x: ox + rx, y: oy + gz, z: oz + ry, c: inset === 0 ? P.roof : P.roofD });
  vox.push({ x: ox + 1, y: oy + 6, z: oz + 1, c: P.stoneD });           // chimney
  vox.push({ x: ox + 1, y: oy + 7, z: oz + 1, c: P.stone });
  // the antenna mast: the cabin talks to the page (see the tether)
  vox.push({ x: ox + 2, y: oy + 7, z: oz + 2, c: P.stoneD });
  vox.push({ x: ox + 2, y: oy + 8, z: oz + 2, c: P.stoneD });
}
function hut(vox, glow, ox, oy, oz) {                                    // satellite dwelling
  for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) for (let gz = 0; gz < 2; gz++)
    if (gx === 0 || gx === 2 || gy === 0 || gy === 2)
      vox.push({ x: ox + gx, y: oy + gz, z: oz + gy, c: ((gx + gy) & 1) ? P.wall : P.wallD });
  glow.push({ x: ox + 1, y: oy + 1, z: oz, c: P.win });
  for (let rx = 0; rx < 3; rx++) for (let ry = 0; ry < 3; ry++)
    vox.push({ x: ox + rx, y: oy + 2, z: oz + ry, c: P.roof });
  vox.push({ x: ox + 1, y: oy + 3, z: oz + 1, c: P.roofD });
}
function tower(vox, glow, ox, oy, oz) {
  for (let gz = 0; gz < 6; gz++) for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++)
    if (gx !== 1 || gy !== 1)
      vox.push({ x: ox + gx, y: oy + gz, z: oz + gy, c: ((gx + gy + gz) & 1) ? P.stone : P.stoneD });
  glow.push({ x: ox + 1, y: oy + 4, z: oz, c: P.win });
  for (let rx = -1; rx < 4; rx++) for (let ry = -1; ry < 4; ry++)
    vox.push({ x: ox + rx, y: oy + 6, z: oz + ry, c: P.roof });
  vox.push({ x: ox + 1, y: oy + 7, z: oz + 1, c: P.roofD });
}
function crystals(vox, glow, ox, oy, oz, seed) {
  [[0, 0, 4], [1, 0, 2], [-1, 1, 3], [0, -1, 2], [1, 1, 1]].forEach(([gx, gy, h], i) => {
    for (let z = 0; z < h; z++) {
      const v = { x: ox + gx, y: oy + z, z: oz + gy, c: P.crystal[(i + z + seed) % P.crystal.length] };
      (z === h - 1 ? glow : vox).push(v);                               // lit tips
    }
  });
}
function shroom(vox, ox, oy, oz) {
  vox.push({ x: ox, y: oy, z: oz, c: P.shroomStem });
  vox.push({ x: ox, y: oy + 1, z: oz, c: P.shroomStem });
  for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++)
    vox.push({ x: ox + gx, y: oy + 2, z: oz + gy, c: (gx === 0 && gy === 0) ? P.shroomDot : P.shroomCap });
  vox.push({ x: ox, y: oy + 3, z: oz, c: P.shroomCap });
}
function flag(vox, ox, oy, oz, ci) {
  for (let z = 0; z < 4; z++) vox.push({ x: ox, y: oy + z, z: oz, c: P.trunk });
  vox.push({ x: ox + 1, y: oy + 3, z: oz, c: P.flag[ci % P.flag.length] });
  vox.push({ x: ox + 2, y: oy + 3, z: oz, c: P.flag[ci % P.flag.length] });
  vox.push({ x: ox + 1, y: oy + 2, z: oz, c: P.flag[ci % P.flag.length] });
}
function pond(vox, glow, tops, ox, oz) {
  for (let gx = -2; gx <= 2; gx++) for (let gy = -2; gy <= 2; gy++) {
    const d = gx * gx + gy * gy;
    if (d < 5) glow.push({ x: ox + gx, y: 0, z: oz + gy, c: ((gx + gy) & 1) ? P.water : P.waterD, soft: true });
  }
}
function cloudSlab(vox, a, b, seed) {
  for (let gx = -a; gx <= a; gx++) for (let gy = -b; gy <= b; gy++) {
    const d = (gx * gx) / (a * a) + (gy * gy) / (b * b);
    if (d <= 1 && rnd(gx + seed * 13, gy + seed * 7, seed) > 0.16)
      vox.push({ x: gx, y: 0, z: gy, c: P.cloud, soft: true });
    if (d <= 0.45 && rnd(gx + seed * 5, gy + seed * 3, seed + 1) > 0.5)
      vox.push({ x: gx, y: 1, z: gy, c: P.cloud, soft: true });
  }
}
function balloon(vox, glow) {
  [[10, 1], [9, 2], [8, 3], [7, 3], [6, 3], [5, 2], [4, 1]].forEach(([y, rr]) => {
    for (let gx = -rr; gx <= rr; gx++) for (let gy = -rr; gy <= rr; gy++)
      if (gx * gx + gy * gy <= rr * rr + rr)
        vox.push({ x: gx, y, z: gy, c: P.balloon[(Math.abs(gx) + (gx < 0 ? 1 : 0)) % P.balloon.length] });
  });
  vox.push({ x: 0, y: 3, z: 0, c: P.basket });
  vox.push({ x: 0, y: 1, z: 0, c: P.basket });
  vox.push({ x: 0, y: 0, z: 0, c: P.basket });
}

/* ── voxel list -> meshes, interior cells culled ────────────────────────
   Three materials per group: lit (Lambert, takes the day cycle through the
   lights), glowHard (windows/crystal tips: self-lit, BRIGHTENS at night and
   feeds the bloom pass), glowSoft (water/clouds: self-lit but dims with the
   sun, so ponds don't turn into lamps at midnight). */
function buildMeshes(vox, glow) {
  const key = (v) => v.x + '|' + v.y + '|' + v.z;
  const solid = new Set();
  vox.forEach(v => solid.add(key(v)));
  glow.forEach(v => solid.add(key(v)));
  const exposed = (v) =>
    !(solid.has((v.x + 1) + '|' + v.y + '|' + v.z) && solid.has((v.x - 1) + '|' + v.y + '|' + v.z) &&
      solid.has(v.x + '|' + (v.y + 1) + '|' + v.z) && solid.has(v.x + '|' + (v.y - 1) + '|' + v.z) &&
      solid.has(v.x + '|' + v.y + '|' + (v.z + 1)) && solid.has(v.x + '|' + v.y + '|' + (v.z - 1)));
  const lit = vox.filter(exposed);
  const group = new THREE.Group();
  const m4 = new THREE.Matrix4(), col = new THREE.Color();

  function instanced(list, material, name, tint) {
    const mesh = new THREE.InstancedMesh(BOX, material, list.length);
    list.forEach((v, i) => {
      m4.setPosition(v.x, v.y, v.z);
      mesh.setMatrixAt(i, m4);
      col.setHex(v.c).multiplyScalar(tint ? tint(v) : 1);
      mesh.setColorAt(i, col);
    });
    mesh.name = name;
    group.add(mesh);
    return mesh;
  }
  if (lit.length) {
    const mesh = instanced(lit, new THREE.MeshLambertMaterial(), 'lit', (v) => {
      // baked texture: per-voxel brightness jitter + soft AO when covered
      let f = 0.94 + 0.12 * rnd(v.x * 3 + 7, v.y * 5 + 1, v.z * 7 + 3);
      if (solid.has(v.x + '|' + (v.y + 1) + '|' + v.z)) f *= 0.82;
      return f;
    });
    mesh.castShadow = mesh.receiveShadow = true;
  }
  const hard = glow.filter(v => !v.soft), soft = glow.filter(v => v.soft);
  if (hard.length) instanced(hard, new THREE.MeshBasicMaterial(), 'glowHard');
  if (soft.length) instanced(soft, new THREE.MeshBasicMaterial(), 'glowSoft', () => 0.97);
  return group;
}
const BOX = new THREE.BoxGeometry(1, 1, 1);

/* ── island factories ──────────────────────────────────────────────────── */
function makeIsland(kind, r, seed, flagIx) {
  const vox = [], glow = [];
  const tops = islandBase(vox, r, seed);
  const top = (gx, gy) => topAt(tops, gx, gy) + 1;
  const anchors = {};
  const sprinkle = (n, fn) => {
    for (let i = 0; i < n; i++) {
      const gx = Math.round((rnd(i * 3 + 1, seed, 11) - 0.5) * 2 * (r - 2));
      const gy = Math.round((rnd(i * 5 + 2, seed, 17) - 0.5) * 2 * (r - 2));
      if (gx * gx + gy * gy < (r - 2) * (r - 2)) fn(gx, gy);
    }
  };
  if (kind === 'home') {
    // camera lives in the +x/+z quadrant: cabin faces it, trees stay behind
    const cy0 = top(4, 4);
    cabin(vox, glow, 2, cy0, 2);
    anchors.beacon = [4, cy0 + 9.4, 4];
    pond(vox, glow, tops, -5, 5);
    anchors.pond = [-5, 0.6, 5];
    // the stream: pond water spilling toward the near rim, then off it
    for (let s = 7; s <= 12; s++) {
      glow.push({ x: -5, y: topAt(tops, -5, s), z: s, c: (s & 1) ? P.water : P.waterD, soft: true });
      if (s > 9) glow.push({ x: -6, y: topAt(tops, -6, s), z: s, c: P.waterD, soft: true });
    }
    anchors.falls = [-5.5, 0.4, 12.6];
    blossomTree(vox, -7, top(-7, -5), -5, seed);
    blossomTree(vox, 8, top(8, -6), -6, seed + 4);
    pineTree(vox, -4, top(-4, -9), -9);
    pineTree(vox, -10, top(-10, 1), 1);
    // sand path from the door out toward the near rim
    for (let s = 0; s < 5; s++) {
      const gz = 7 + s, gx = 4 + Math.round(Math.sin(s * 0.9) * 1.4);
      vox.push({ x: gx, y: top(gx, gz) - 1, z: gz, c: (s & 1) ? P.pathA : P.pathB });
    }
    crystals(vox, glow, -9, top(-9, 8), 8, seed);
    sprinkle(10, (gx, gy) => vox.push({ x: gx, y: top(gx, gy), z: gy, c: P.flower[(gx * 7 + gy * 13 & 1023) % P.flower.length] }));
  } else if (kind === 'blossom') {
    blossomTree(vox, 0, top(0, 0), 0, seed);
    blossomTree(vox, -3, top(-3, 3), 3, seed + 2);
    hut(vox, glow, 2, top(3, -3), -4);
    sprinkle(6, (gx, gy) => vox.push({ x: gx, y: top(gx, gy), z: gy, c: P.flower[(gx * 7 + gy * 13 & 1023) % P.flower.length] }));
  } else if (kind === 'pine') {
    pineTree(vox, -2, top(-2, -2), -2);
    pineTree(vox, 3, top(3, 1), 1);
    pineTree(vox, -1, top(-1, 4), 4);
    hut(vox, glow, 1, top(2, -4), -5);
  } else if (kind === 'crystal') {
    crystals(vox, glow, 0, top(0, 0), 0, seed);
    crystals(vox, glow, -3, top(-3, 2), 2, seed + 1);
    hut(vox, glow, 1, top(2, -2), -3);
  } else if (kind === 'shroom') {
    shroom(vox, 0, top(0, 0), 0);
    shroom(vox, -3, top(-3, 2), 2);
    shroom(vox, 2, top(2, 3), 3);
    hut(vox, glow, 1, top(2, -3), -4);
  } else if (kind === 'snow') {
    // frost the turf
    vox.forEach(v => { if (v.c === P.grassA || v.c === P.grassB) v.c = ((v.x + v.z) & 1) ? P.snow : 0xeef1fb; });
    pineTree(vox, -2, top(-2, -1), -1);
    pineTree(vox, 2, top(2, 2), 2);
    hut(vox, glow, 0, top(1, -3), -4);
  } else if (kind === 'tower') {
    tower(vox, glow, -1, top(0, 0), -1);
    pineTree(vox, 3, top(3, 3), 3);
  }
  if (flagIx !== undefined) flag(vox, r - 2, top(r - 2, 0), 0, flagIx);
  const group = buildMeshes(vox, glow);
  group.userData.anchors = anchors;
  return group;
}

/* ── post stack: scene -> HDR target -> bright pass -> blur -> composite.
   Hand-rolled because we ship zero dependencies beyond three core. ─────── */
function makePost(renderer) {
  const isWebGL2 = renderer.capabilities.isWebGL2;
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.BufferGeometry();       // one triangle covers the screen
  quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(quadGeo, null);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const VERT = 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const opts = (m) => Object.assign(m, { depthTest: false, depthWrite: false });

  const bright = opts(new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, uTh: { value: 0.9 } },
    vertexShader: VERT,
    fragmentShader: `varying vec2 vUv; uniform sampler2D tex; uniform float uTh;
      void main(){
        vec3 c = texture2D(tex, vUv).rgb;
        vec3 g = pow(max(c, 0.0), vec3(1.0 / 2.2));
        float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor = vec4(c * smoothstep(uTh - 0.09, uTh + 0.12, l), 1.0);
      }`,
  }));
  const blur = opts(new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, texel: { value: new THREE.Vector2() } },
    vertexShader: VERT,
    fragmentShader: `varying vec2 vUv; uniform sampler2D tex; uniform vec2 dir; uniform vec2 texel;
      void main(){
        vec2 o = dir * texel;
        vec3 c = texture2D(tex, vUv).rgb * 0.227;
        c += (texture2D(tex, vUv + o).rgb + texture2D(tex, vUv - o).rgb) * 0.194;
        c += (texture2D(tex, vUv + o * 2.0).rgb + texture2D(tex, vUv - o * 2.0).rgb) * 0.121;
        c += (texture2D(tex, vUv + o * 3.0).rgb + texture2D(tex, vUv - o * 3.0).rgb) * 0.054;
        c += (texture2D(tex, vUv + o * 4.0).rgb + texture2D(tex, vUv - o * 4.0).rgb) * 0.016;
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  const comp = opts(new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null }, tBloom: { value: null },
      uStr: { value: 0.5 }, uNight: { value: 0 }, uT: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: `varying vec2 vUv; uniform sampler2D tScene; uniform sampler2D tBloom;
      uniform float uStr; uniform float uNight; uniform float uT;
      void main(){
        vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uStr;
        c = mix(c, c * vec3(0.90, 0.95, 1.14), uNight * 0.30);        // moonlight grade
        c = pow(max(c, 0.0), vec3(1.0 / 2.2));                        // linear -> screen
        float d = distance(vUv, vec2(0.5));
        c *= 1.0 - smoothstep(0.52, 0.95, d) * (0.13 + 0.13 * uNight); // vignette
        float g = fract(sin(dot(vUv + fract(uT), vec2(12.9898, 78.233))) * 43758.5453);
        gl_FragColor = vec4(c + (g - 0.5) * 0.016, 1.0);               // grain
      }`,
  }));

  let rtScene = null, rtA = null, rtB = null, ok = true;
  function alloc() {
    [rtScene, rtA, rtB].forEach(rt => rt && rt.dispose());
    try {
      // HDR targets when the GPU can render to them; clamped bytes otherwise
      const hdr = isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
      const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      rtScene = new THREE.WebGLRenderTarget(size.x, size.y, {
        type, samples: isWebGL2 ? 4 : 0, depthBuffer: true,
      });
      const bw = Math.max(4, Math.floor(size.x / 4)), bh = Math.max(4, Math.floor(size.y / 4));
      rtA = new THREE.WebGLRenderTarget(bw, bh, { type, depthBuffer: false });
      rtB = new THREE.WebGLRenderTarget(bw, bh, { type, depthBuffer: false });
      blur.uniforms.texel.value.set(1 / bw, 1 / bh);
      ok = true;
    } catch (e) { ok = false; }
  }
  function pass(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }
  return {
    enabled: true,
    get ok() { return ok; },
    alloc,
    render(scene, camera, t, night) {
      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);
      bright.uniforms.tex.value = rtScene.texture;
      bright.uniforms.uTh.value = 0.93 - 0.33 * night;
      pass(bright, rtA);
      for (let i = 0; i < 2; i++) {
        blur.uniforms.tex.value = rtA.texture; blur.uniforms.dir.value.set(1, 0); pass(blur, rtB);
        blur.uniforms.tex.value = rtB.texture; blur.uniforms.dir.value.set(0, 1); pass(blur, rtA);
      }
      comp.uniforms.tScene.value = rtScene.texture;
      comp.uniforms.tBloom.value = rtA.texture;
      comp.uniforms.uStr.value = 0.42 + 0.6 * night;
      comp.uniforms.uNight.value = night;
      comp.uniforms.uT.value = t * 0.001;
      pass(comp, null);
    },
  };
}

/* ── scene ─────────────────────────────────────────────────────────────── */
export function startWorld(canvas, opts = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) { return false; }
  renderer.setPixelRatio(Math.min(1.75, devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(CYCLE[0].fog, 110, 430);

  /* sky dome: keyframed pastel gradient + an actual sun, immune to fog */
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(520, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(CYCLE[0].top) },
        mid: { value: new THREE.Color(CYCLE[0].mid) },
        low: { value: new THREE.Color(CYCLE[0].low) },
        sunCol: { value: new THREE.Color(CYCLE[0].sun) },
        sunDir: { value: new THREE.Vector3(0.5, 0.7, 0.3).normalize() },
        warm: { value: CYCLE[0].warm },
        disk: { value: 1 },
      },
      vertexShader: 'varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vp;
        uniform vec3 top; uniform vec3 mid; uniform vec3 low; uniform vec3 sunCol;
        uniform vec3 sunDir; uniform float warm; uniform float disk;
        void main(){
          vec3 n = normalize(vp);
          float h = n.y;
          vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.55, h)) : mix(mid, low, smoothstep(0.0, -0.5, h));
          float d = max(dot(n, sunDir), 0.0);
          c += sunCol * pow(d, 900.0) * 3.2 * disk;   // the disk itself (bloom food)
          c += sunCol * pow(d, 40.0) * 0.35 * disk;   // near halo
          c += sunCol * pow(d, 5.0) * 0.22 * warm;    // the dusk wash
          gl_FragColor = vec4(c, 1.0); }`,
    })
  );
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(CYCLE[0].hs, CYCLE[0].hg, CYCLE[0].hemiI);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(CYCLE[0].sun, CYCLE[0].sunI);
  sun.position.set(...CYCLE[0].sunPos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -34;
  sun.shadow.camera.right = sun.shadow.camera.top = 34;
  sun.shadow.camera.near = 40; sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 800);

  /* the federation: home island + satellites, each with a claim flag.
     Names because a federation without names is just a load balancer. */
  const NAMES = [
    ['beckett · prime', 'home island · this beckett'],
    ['hana', 'federation node'], ['juniper', 'federation node'],
    ['quartz', 'federation node'], ['miso', 'federation node'],
    ['tundra', 'federation node'], ['beacon', 'federation node'],
    ['petal', 'federation node'], ['fir', 'federation node'],
    ['prism', 'federation node'],
  ];
  const islands = [], pickMeshes = [];
  const glowHardMats = [], glowSoftMats = [];
  function addIsland(kind, r, seed, x, y, z, flagIx, bobAmp, bobSp) {
    const g = makeIsland(kind, r, seed, flagIx);
    g.position.set(x, y, z);
    const ix = islands.length;
    g.userData = Object.assign(g.userData, {
      baseY: y, amp: bobAmp, sp: bobSp, ph: rnd(seed, 3, 5) * 6.28,
      r, lift: 0, name: NAMES[ix] ? NAMES[ix][0] : kind, sub: NAMES[ix] ? NAMES[ix][1] : '',
      labelY: kind === 'home' ? 15 : r + 8,
    });
    // shadows are a home-island luxury; satellites are too far to read them
    if (kind !== 'home') g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = false; });
    g.traverse(o => {
      if (!o.isMesh) return;
      o.userData.isl = ix;
      pickMeshes.push(o);
      if (o.name === 'glowHard') glowHardMats.push(o.material);
      if (o.name === 'glowSoft') glowSoftMats.push(o.material);
    });
    scene.add(g);
    islands.push(g);
    return g;
  }
  const home = addIsland('home', 13, 7, 0, 0, 0, undefined, 0.6, 0.16);
  addIsland('blossom', 7, 21, -48, 7, -34, 1, 1.2, 0.22);
  addIsland('pine', 8, 33, 40, -6, -56, 4, 1.1, 0.19);
  addIsland('crystal', 5, 44, -26, 16, -74, 2, 1.5, 0.26);
  addIsland('shroom', 5, 55, 64, 12, -26, 3, 1.3, 0.24);
  addIsland('snow', 6, 66, -76, 24, -12, 0, 1.2, 0.21);
  addIsland('tower', 6, 77, 14, 28, -96, 1, 1.4, 0.23);
  addIsland('blossom', 4, 88, -56, -4, 38, 3, 1.1, 0.25);
  addIsland('pine', 5, 99, 52, 22, -108, 0, 1.3, 0.2);
  addIsland('crystal', 4, 111, 96, 16, -56, 2, 1.4, 0.24);
  sun.target.position.set(0, 0, 0);

  /* clouds: unlit white voxel slabs drifting slowly; they dim to grey ghosts
     at night instead of hanging there like fluorescent tubes */
  const clouds = [], cloudMats = [];
  [[9, 4, 1, -85, 32, -85, 0.9], [12, 5, 2, 55, 40, -115, 0.7], [7, 3, 3, -45, 14, 62, 1.1],
   [10, 4, 4, 105, 22, -70, 0.8], [6, 3, 5, -120, 18, -20, 1.0],
  ].forEach(([a, b, seed, x, y, z, sp]) => {
    const vox = [];
    cloudSlab(vox, a, b, seed);
    const g = buildMeshes([], vox);
    g.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = false; cloudMats.push(o.material); } });
    g.position.set(x, y, z);
    g.scale.setScalar(1.4);
    g.userData = { sp };
    scene.add(g);
    clouds.push(g);
  });

  /* blossom petals: a slow pastel drift around the home island. The pointer
     is wind: fast moves push them sideways. */
  let petals = null;
  {
    const N = 100, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), ph = [];
    const tint = new THREE.Color();
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rnd(i, 1, 1) - 0.5) * 70;
      pos[i * 3 + 1] = rnd(i, 2, 2) * 34 - 6;
      pos[i * 3 + 2] = (rnd(i, 3, 3) - 0.5) * 70;
      tint.setHex(P.blossom[i % P.blossom.length]);
      col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b;
      ph.push(rnd(i, 4, 4) * 6.28);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.5, vertexColors: true, sizeAttenuation: true }));
    scene.add(pts);
    petals = { pts, pos, ph, N };
  }

  /* the balloon: one slow lap around the archipelago */
  const balloonVox = [], balloonGlow = [];
  balloon(balloonVox, balloonGlow);
  const bal = buildMeshes(balloonVox, balloonGlow);
  bal.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  scene.add(bal);

  /* signal arcs: the islands talking to each other. At night the network is
     the brightest thing in the world, which is the whole point. */
  const packets = [];
  const arcMat = new THREE.LineBasicMaterial({ color: 0x9a86d8, transparent: true, opacity: 0.32 });
  const packetGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
  const arcByIsland = {};
  [[1, 0.0], [2, 0.35], [3, 0.6], [4, 0.15], [5, 0.8], [6, 0.45], [7, 0.7], [8, 0.25]].forEach(([ix, ph]) => {
    const a = new THREE.Vector3(0, 9, 0);
    const b = islands[ix].position.clone().add(new THREE.Vector3(0, 6, 0));
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += 14 + a.distanceTo(b) * 0.12;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)), arcMat));
    const p1 = new THREE.Mesh(packetGeo, new THREE.MeshBasicMaterial({ color: 0x4ea9b3 }));
    const p2 = new THREE.Mesh(packetGeo, new THREE.MeshBasicMaterial({ color: 0x4ea9b3, transparent: true, opacity: 0.3 }));
    p2.scale.setScalar(1.8);
    scene.add(p1, p2);
    const pk = { curve, p1, p2, ph, sp: 0.05 + rnd(ix, 2, 4) * 0.04 };
    packets.push(pk);
    arcByIsland[ix] = pk;
  });

  /* signal bursts: what clicking an island fires down its arc */
  const bursts = [];
  const burstGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  function fireBurst(pk, reverse) {
    if (bursts.length > 8) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0xbdfaff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    mat.color.multiplyScalar(2.2);                     // over 1.0 on purpose: bloom food
    const mesh = new THREE.Mesh(burstGeo, mat);
    scene.add(mesh);
    bursts.push({ pk, mesh, t0: performance.now(), reverse });
  }

  /* the beacon: a pulsing light on the cabin mast. It is also the world end
     of the tether that plugs the live console card into the scene. */
  const beaconLocal = new THREE.Vector3(...(home.userData.anchors.beacon || [4, 12, 4]));
  const beaconMat = new THREE.MeshBasicMaterial({ color: P.beacon });
  const beaconMesh = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.72, 0.72), beaconMat);
  beaconMesh.position.copy(beaconLocal);
  home.add(beaconMesh);
  let beaconPulse = 0;

  /* the waterfall: pond overflow going over the rim into the sky.
     Points parented to the island so they bob with it. */
  let falls = null;
  {
    const N = 150, M = 26;
    const pos = new Float32Array((N + M) * 3), col = new Float32Array((N + M) * 3), vel = [];
    const c1 = new THREE.Color(P.water), c2 = new THREE.Color(0xeffbfd);
    const fx = home.userData.anchors.falls || [-5.5, 0.4, 12.6];
    for (let i = 0; i < N + M; i++) {
      const mist = i >= N;
      const u = rnd(i, 8, 1);
      pos[i * 3] = fx[0] + (rnd(i, 5, 2) - 0.5) * (mist ? 4.5 : 2.4);
      pos[i * 3 + 1] = mist ? -20 - rnd(i, 6, 3) * 10 : fx[1] - u * 32;
      pos[i * 3 + 2] = fx[2] + (rnd(i, 7, 4) - 0.5) * (mist ? 3 : 1.2) + (mist ? 1 : u * 1.6);
      // mist stays water-cyan: near-white points bloom into smears at dusk
      const c = (!mist && rnd(i, 9, 5) > 0.6) ? c2 : c1;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      vel.push(mist ? 0.02 + rnd(i, 10, 6) * 0.02 : 0.16 + rnd(i, 10, 6) * 0.2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: 0.55, vertexColors: true, transparent: true, opacity: 0.85 });
    const pts = new THREE.Points(geo, mat);
    home.add(pts);
    falls = { pts, pos, vel, N, M, fx };
  }

  /* birds: a lazy loop around the grove. They roost at dusk. */
  const BIRDS = 5;
  const birdMat = new THREE.MeshLambertMaterial({ color: 0x9a92c0, transparent: true });
  const birds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.95, 0.1, 0.42), birdMat, BIRDS * 2);
  birds.castShadow = birds.receiveShadow = false;
  scene.add(birds);
  const birdDummy = new THREE.Object3D();

  /* stars: a camera-locked dome that fades in with the night */
  let stars = null;
  {
    const N = 340, pos = new Float32Array(N * 3), aPh = new Float32Array(N), aSz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const az = rnd(i, 11, 3) * Math.PI * 2, el = 0.06 + rnd(i, 12, 7) * 1.35;
      const r = 460;
      pos[i * 3] = Math.cos(az) * Math.cos(el) * r;
      pos[i * 3 + 1] = Math.sin(el) * r;
      pos[i * 3 + 2] = Math.sin(az) * Math.cos(el) * r;
      aPh[i] = rnd(i, 13, 9) * 6.28;
      aSz[i] = 1.3 + rnd(i, 14, 11) * 2.1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPh', new THREE.BufferAttribute(aPh, 1));
    geo.setAttribute('aSz', new THREE.BufferAttribute(aSz, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uOp: { value: 0 }, uT: { value: 0 }, uPR: { value: renderer.getPixelRatio() } },
      vertexShader: `attribute float aPh; attribute float aSz; varying float vA; uniform float uT; uniform float uPR;
        void main(){
          vA = 0.55 + 0.45 * sin(uT * (0.6 + fract(aPh) * 1.7) + aPh);
          gl_PointSize = aSz * uPR;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `varying float vA; uniform float uOp;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(0.92, 0.94, 1.0, smoothstep(0.5, 0.12, d) * vA * uOp);
        }`,
    });
    const pts = new THREE.Points(geo, mat);
    scene.add(pts);
    stars = { pts, mat };
  }

  /* one shooting star, reused; it only bothers to exist after dusk */
  const shoot = {
    mesh: new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })),
    active: false, t0: 0, from: new THREE.Vector3(), to: new THREE.Vector3(),
  };
  scene.add(shoot.mesh);

  /* fireflies: the night shift around the cabin, faintly curious about the
     pointer. Amber and cyan, blinking out of phase. */
  let flies = null;
  {
    const N = 34, base = [], pos = new Float32Array(N * 3), aPh = new Float32Array(N), aC = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      base.push(new THREE.Vector3((rnd(i, 21, 1) - 0.5) * 26, 3 + rnd(i, 22, 2) * 8, (rnd(i, 23, 3) - 0.5) * 26));
      aPh[i] = rnd(i, 24, 4) * 6.28;
      aC[i] = rnd(i, 25, 5) > 0.4 ? 1 : 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPh', new THREE.BufferAttribute(aPh, 1));
    geo.setAttribute('aC', new THREE.BufferAttribute(aC, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uOp: { value: 0 }, uT: { value: 0 }, uPR: { value: renderer.getPixelRatio() } },
      vertexShader: `attribute float aPh; attribute float aC; varying float vA; varying float vC;
        uniform float uT; uniform float uPR;
        void main(){
          vC = aC;
          float b = sin(uT * (1.1 + fract(aPh)) + aPh);
          vA = smoothstep(-0.2, 0.9, b);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (5.5 + 2.0 * vA) * uPR * (60.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA; varying float vC; uniform float uOp;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          vec3 c = mix(vec3(1.0, 0.86, 0.55), vec3(0.62, 0.95, 0.98), vC);
          gl_FragColor = vec4(c * 1.6, smoothstep(0.5, 0.05, d) * vA * uOp);
        }`,
    });
    const pts = new THREE.Points(geo, mat);
    scene.add(pts);
    flies = { pts, mat, base, pos, N, ph: aPh };
  }

  /* click keepsakes: flowers planted on the turf, ripples on the pond */
  const flowersG = new THREE.Group();
  home.add(flowersG);
  const flowers = [];
  function plantFlower(local) {
    if (flowers.length >= 24) { const f = flowers.shift(); flowersG.remove(f.g); }
    const g = new THREE.Group();
    const stem = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: P.pine[1] }));
    stem.scale.set(0.28, 0.6, 0.28); stem.position.y = 0.3;
    const head = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({
      color: P.flower[Math.floor(rnd(Math.round(local.x * 9), Math.round(local.z * 9), 31) * P.flower.length) % P.flower.length],
    }));
    head.scale.setScalar(0.55); head.position.y = 0.86;
    g.add(stem, head);
    g.position.set(Math.round(local.x), Math.round(local.y) + 0.5, Math.round(local.z));
    g.scale.setScalar(0.01);
    flowersG.add(g);
    flowers.push({ g, t0: performance.now() });
  }
  const ripples = [];
  const rippleGeo = new THREE.RingGeometry(0.55, 0.72, 26);
  function makeRipple() {
    if (ripples.length > 5) return;
    const m = new THREE.Mesh(rippleGeo, new THREE.MeshBasicMaterial({ color: 0xe8fbfd, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    const pc = home.userData.anchors.pond || [-5, 0.6, 5];
    m.position.set(pc[0], pc[1] + 0.06, pc[2]);
    home.add(m);
    ripples.push({ m, t0: performance.now() });
  }

  /* ── the camera script: one shot per page section ──────────────────── */
  const SHOTS = (opts.shots || [
    { sel: '#hero',    pos: [44, 19, 58],   look: [-13, 1, -3] },
    { sel: '#console', pos: [24, 13, 38],   look: [0, 3, 3] },
    { sel: '#how',     pos: [-6, 13, 40],   look: [-13, 2, -8] },
    { sel: '#caps',    pos: [-32, 26, 52],  look: [-2, 3, -20] },
    { sel: '#cta',     pos: [-36, 52, 108], look: [6, 9, -32] },   // tilted up: stars
  ]).map(s => ({ el: document.querySelector(s.sel), pos: new THREE.Vector3(...s.pos), look: new THREE.Vector3(...s.look) }))
    .filter(s => s.el);

  let anchors = [], docH = 1;
  function layout() {
    const vh = innerHeight;
    anchors = SHOTS.map((s, i) => i === 0 ? 0 : Math.max(1, s.el.offsetTop - vh * 0.45));
    docH = Math.max(1, document.documentElement.scrollHeight - vh);
  }
  const smooth = (x) => x * x * (3 - 2 * x);
  const pos = new THREE.Vector3(), look = new THREE.Vector3();
  function shotAt(s) {
    let i = 0;
    while (i < anchors.length - 1 && s > anchors[i + 1]) i++;
    if (i >= SHOTS.length - 1) { pos.copy(SHOTS[SHOTS.length - 1].pos); look.copy(SHOTS[SHOTS.length - 1].look); return; }
    const u = smooth(Math.min(1, Math.max(0, (s - anchors[i]) / (anchors[i + 1] - anchors[i] || 1))));
    pos.lerpVectors(SHOTS[i].pos, SHOTS[i + 1].pos, u);
    look.lerpVectors(SHOTS[i].look, SHOTS[i + 1].look, u);
  }

  /* ── the day cycle, applied ────────────────────────────────────────── */
  const _c = { a: new THREE.Color(), b: new THREE.Color() };
  const lerpHex = (out, h1, h2, u) => out.setHex(h1).lerp(_c.b.setHex(h2), u);
  const sunDirV = new THREE.Vector3();
  let night = 0, dayP = 0, nightAttr = false;
  const scrimEl = document.querySelector('.scrim');
  const scrimNightEl = document.getElementById('scrimNight');
  function applyCycle(p) {
    dayP = p;
    let i = 0;
    while (i < CYCLE.length - 2 && p > CYCLE[i + 1].p) i++;
    const A = CYCLE[i], B = CYCLE[i + 1];
    const u = Math.min(1, Math.max(0, (p - A.p) / (B.p - A.p || 1)));
    const lv = (k) => A[k] + (B[k] - A[k]) * u;
    night = lv('night');
    const day = 1 - night;

    const su = sky.material.uniforms;
    lerpHex(su.top.value, A.top, B.top, u);
    lerpHex(su.mid.value, A.mid, B.mid, u);
    lerpHex(su.low.value, A.low, B.low, u);
    lerpHex(su.sunCol.value, A.sun, B.sun, u);
    su.warm.value = lv('warm');
    su.disk.value = lv('disk');
    sunDirV.set(
      A.sunPos[0] + (B.sunPos[0] - A.sunPos[0]) * u,
      A.sunPos[1] + (B.sunPos[1] - A.sunPos[1]) * u,
      A.sunPos[2] + (B.sunPos[2] - A.sunPos[2]) * u);
    su.sunDir.value.copy(sunDirV).normalize();
    sun.position.copy(sunDirV);
    lerpHex(sun.color, A.sun, B.sun, u);
    sun.intensity = lv('sunI');
    lerpHex(hemi.color, A.hs, B.hs, u);
    lerpHex(hemi.groundColor, A.hg, B.hg, u);
    hemi.intensity = lv('hemiI');
    lerpHex(scene.fog.color, A.fog, B.fog, u);
    scene.fog.far = 430 - 60 * night;

    // materials that live outside the lighting model follow the sun by hand
    glowHardMats.forEach(m => m.color.setScalar(1 + 1.9 * night));
    glowSoftMats.forEach(m => m.color.setScalar(0.78 + 0.22 * day));
    cloudMats.forEach(m => m.color.setScalar(0.26 + 0.74 * day));
    if (petals) petals.pts.material.color.setScalar(0.5 + 0.5 * day);
    arcMat.opacity = 0.3 + 0.34 * night;
    packets.forEach(pk => {
      pk.p1.material.color.setHex(0x4ea9b3).multiplyScalar(1 + 1.7 * night);
      pk.p2.material.color.setHex(0x4ea9b3).multiplyScalar(1 + 1.7 * night);
    });
    if (stars) stars.mat.uniforms.uOp.value = Math.max(0, night - 0.25) / 0.75;
    if (flies) flies.mat.uniforms.uOp.value = Math.max(0, night - 0.3) / 0.7;
    birdMat.opacity = Math.max(0, Math.min(1, day * 1.35 - 0.35));
    if (falls) falls.pts.material.opacity = 0.55 + 0.3 * day;

    // the page follows the sky: mist thins, the night scrim breathes in,
    // and copy flips to its night colors past dusk. Pages without the night
    // stylesheet hooks (federation/caas) keep their full mist so text stays
    // readable while the world darkens behind it.
    if (scrimNightEl) {
      if (scrimEl) scrimEl.style.opacity = String(1 - night * 0.6);
      scrimNightEl.style.opacity = String(night * 0.55);
      const wantNight = nightAttr ? night > 0.4 : night > 0.5;   // hysteresis
      if (wantNight !== nightAttr) {
        nightAttr = wantNight;
        document.body.toggleAttribute('data-night', nightAttr);
      }
    }
  }

  /* ── post pipeline ─────────────────────────────────────────────────── */
  const post = makePost(renderer);

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (stars) stars.mat.uniforms.uPR.value = renderer.getPixelRatio();
    if (flies) flies.mat.uniforms.uPR.value = renderer.getPixelRatio();
    post.alloc();
    layout();
  }
  resize();
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); render(perf()); }, 120); }, { passive: true });

  /* input state, all lerped in the loop */
  let scroll = scrollY, mx = 0, my = 0, cs = scrollY, cmx = 0, cmy = 0;
  let wind = 0, lastMx = 0;
  addEventListener('scroll', () => { scroll = scrollY; }, { passive: true });
  addEventListener('mousemove', (e) => { mx = (e.clientX / innerWidth - 0.5) * 2; my = (e.clientY / innerHeight - 0.5) * 2; }, { passive: true });

  /* ── touching the world: hover names islands, click pokes them ─────── */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let havePointer = false, needPick = false, hover = -1;
  const tipEl = document.getElementById('tip');
  const curEl = document.getElementById('cur');
  const canHover = matchMedia('(hover:hover)').matches;
  addEventListener('pointermove', (e) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    havePointer = true; needPick = true;
  }, { passive: true });

  // hover is a cheap ray-vs-sphere sweep; precise triangles only on click.
  // Winner is the island the ray passes MOST CENTRALLY through (miss distance
  // over radius), not the nearest hit: the big home island would otherwise
  // shadow every satellite behind it.
  function spherePick() {
    ray.setFromCamera(ndc, camera);
    let best = -1, bestM = 1;
    for (let i = 0; i < islands.length; i++) {
      const g = islands[i];
      _v1.set(g.position.x, g.position.y + 3, g.position.z).sub(ray.ray.origin);
      const along = _v1.dot(ray.ray.direction);
      if (along < 0) continue;                            // behind the camera
      const miss = Math.sqrt(Math.max(0, _v1.lengthSq() - along * along));
      const m = miss / (g.userData.r * 1.15 + 2);
      if (m < bestM) { bestM = m; best = i; }
    }
    return best;
  }
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
  function setHover(i) {
    if (i === hover) return;
    hover = i;
    if (curEl) curEl.classList.toggle('lg', i >= 0);
    if (tipEl) {
      if (i >= 0) {
        tipEl.innerHTML = islands[i].userData.name + '<b>' + islands[i].userData.sub + '</b>';
        tipEl.style.opacity = '1';
      } else tipEl.style.opacity = '0';
    }
  }
  let downX = 0, downY = 0, downT = 0;
  addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downT = performance.now(); }, { passive: true });
  addEventListener('pointerup', (e) => {
    if (reduced) return;
    if (Math.abs(e.clientX - downX) > 7 || Math.abs(e.clientY - downY) > 7 || performance.now() - downT > 500) return;
    if (e.target && (e.target.closest && e.target.closest('a,button,nav,.console,.tile,.step'))) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    const i = spherePick();
    if (i < 0) return;
    if (i > 0) {                                    // satellite: ping it
      const pk = arcByIsland[i];
      if (pk) { fireBurst(pk, false); setTimeout(() => fireBurst(pk, true), 420); }
      islands[i].userData.lift = Math.min(islands[i].userData.lift + 1.2, 4);
      beaconPulse = 1;
      return;
    }
    // home island: precise hit decides pond ripple vs planted flower
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(home.children.filter(o => o.isMesh && o.name === 'lit'), false);
    beaconPulse = 1;
    if (!hits.length) return;
    const local = home.worldToLocal(hits[0].point.clone());
    const pc = home.userData.anchors.pond || [-5, 0.6, 5];
    if ((local.x - pc[0]) * (local.x - pc[0]) + (local.z - pc[2]) * (local.z - pc[2]) < 12) makeRipple();
    else if (hits[0].face && hits[0].face.normal.y > 0.5 && local.y > -1) plantFlower(local);
  }, { passive: true });

  /* the tether: an SVG line from the cabin beacon to the console card.
     Content isn't floating over the world; it's plugged into it. */
  const tetherSvg = document.getElementById('tether');
  const tetherPath = tetherSvg ? tetherSvg.querySelector('path') : null;
  const tetherDot = tetherSvg ? tetherSvg.querySelector('circle') : null;
  const consoleCard = document.querySelector('#console .console');
  let dashOff = 0;
  function updateTether(t) {
    if (!tetherSvg || !tetherPath || !consoleCard) return;
    const rect = consoleCard.getBoundingClientRect();
    const visible = rect.top < innerHeight * 0.95 && rect.bottom > 40;
    _v1.set(beaconLocal.x, beaconLocal.y + home.position.y, beaconLocal.z).project(camera);
    const onScreen = _v1.z < 1 && Math.abs(_v1.x) < 1.4 && Math.abs(_v1.y) < 1.4;
    if (!visible || !onScreen) { tetherSvg.style.opacity = '0'; return; }
    const ax = (_v1.x * 0.5 + 0.5) * innerWidth, ay = (-_v1.y * 0.5 + 0.5) * innerHeight;
    const bx = rect.left + 26, by = rect.top + 14;
    const mxq = (ax + bx) / 2, myq = Math.min(ay, by) - 46;
    tetherPath.setAttribute('d', `M${ax.toFixed(1)} ${ay.toFixed(1)} Q${mxq.toFixed(1)} ${myq.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`);
    dashOff -= 0.55;
    tetherPath.setAttribute('stroke-dashoffset', dashOff.toFixed(1));
    if (tetherDot && tetherPath.getTotalLength) {
      const L = tetherPath.getTotalLength();
      const pt = tetherPath.getPointAtLength(((t * 0.00028) % 1) * L);
      tetherDot.setAttribute('cx', pt.x); tetherDot.setAttribute('cy', pt.y);
    }
    tetherSvg.style.opacity = '1';
  }

  const right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  function render(t) {
    applyCycle(Math.min(1, Math.max(0, cs / docH)));

    islands.forEach(g => {
      const ud = g.userData;
      ud.lift += (((hover === islands.indexOf(g)) ? (islands.indexOf(g) === 0 ? 1.1 : 2.2) : 0) - ud.lift) * 0.07;
      g.position.y = ud.baseY + Math.sin(t * 0.0006 * ud.sp * 4 + ud.ph) * ud.amp + ud.lift;
    });
    clouds.forEach(g => {
      g.position.x += 0.014 * g.userData.sp;
      if (g.position.x > 150) g.position.x = -150;
    });
    const ba = t * 0.000021;
    bal.position.set(Math.cos(ba) * 66, 26 + Math.sin(t * 0.0004) * 2.2, Math.sin(ba) * 66 - 30);

    if (petals) {
      wind += (mx - lastMx) * 1.8; lastMx = mx; wind *= 0.94;
      const a = petals.pos;
      for (let i = 0; i < petals.N; i++) {
        a[i * 3] += Math.sin(t * 0.0004 + petals.ph[i]) * 0.012 + wind * 0.05;
        a[i * 3 + 1] -= 0.008 + 0.006 * Math.sin(petals.ph[i]);
        if (a[i * 3 + 1] < -14) a[i * 3 + 1] = 30;
        if (a[i * 3] > 40) a[i * 3] = -40; else if (a[i * 3] < -40) a[i * 3] = 40;
      }
      petals.pts.geometry.attributes.position.needsUpdate = true;
    }
    packets.forEach(pk => {
      const u = (t * 0.0001 * pk.sp * 4 + pk.ph) % 1;
      pk.curve.getPoint(u, pk.p1.position);
      pk.p2.position.copy(pk.p1.position);
      pk.p2.material.opacity = 0.15 + 0.2 * Math.sin(u * Math.PI);
    });
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i], u = (t - b.t0) / 850;
      if (u >= 1) { scene.remove(b.mesh); b.mesh.material.dispose(); bursts.splice(i, 1); continue; }
      b.pk.curve.getPoint(b.reverse ? 1 - u : u, b.mesh.position);
      b.mesh.material.opacity = Math.sin(u * Math.PI);
      b.mesh.scale.setScalar(1 + Math.sin(u * Math.PI) * 0.8);
    }

    // the waterfall: fall, splash into mist, recycle
    if (falls) {
      const a = falls.pos;
      for (let i = 0; i < falls.N; i++) {
        a[i * 3 + 1] -= falls.vel[i];
        a[i * 3 + 2] += 0.012;
        if (a[i * 3 + 1] < -34) {
          a[i * 3] = falls.fx[0] + (rnd(i, 5, (t / 700) | 0) - 0.5) * 2.4;
          a[i * 3 + 1] = falls.fx[1] + 0.5;
          a[i * 3 + 2] = falls.fx[2] + (rnd(i, 7, (t / 900) | 0) - 0.5) * 1.2;
        }
      }
      for (let i = falls.N; i < falls.N + falls.M; i++) {
        a[i * 3 + 1] += falls.vel[i] * 0.5;
        if (a[i * 3 + 1] > -16) a[i * 3 + 1] = -32;
      }
      falls.pts.geometry.attributes.position.needsUpdate = true;
    }

    // birds: wing pairs flapping around a wide ellipse
    if (birdMat.opacity > 0.02) {
      for (let i = 0; i < BIRDS; i++) {
        const r0 = 31 + i * 2.6, spd = 0.00016 + i * 0.00002, ph0 = i * 1.7;
        const ang = t * spd + ph0;
        const bx = Math.cos(ang) * r0, bz = Math.sin(ang) * r0 * 0.8 - 16;
        const by = 18 + Math.sin(t * 0.0009 + i) * 1.6 + i * 1.1;
        const flap = Math.sin(t * 0.014 + ph0) * 0.85;
        for (let w = 0; w < 2; w++) {
          birdDummy.position.set(bx, by, bz);
          birdDummy.rotation.set(0, -ang, w ? flap : -flap);
          birdDummy.translateX(w ? 0.55 : -0.55);
          birdDummy.updateMatrix();
          birds.setMatrixAt(i * 2 + w, birdDummy.matrix);
        }
      }
      birds.instanceMatrix.needsUpdate = true;
      birds.visible = true;
    } else birds.visible = false;

    // fireflies wander; the pointer is mildly magnetic
    if (flies && flies.mat.uniforms.uOp.value > 0.01) {
      flies.mat.uniforms.uT.value = t * 0.001;
      let px = 0, pz = 0, pull = 0;
      if (havePointer) {
        ray.setFromCamera(ndc, camera);
        const tt = (6 - ray.ray.origin.y) / (ray.ray.direction.y || 1e-6);
        if (tt > 0 && tt < 400) {
          _v2.copy(ray.ray.origin).addScaledVector(ray.ray.direction, tt);
          if (_v2.length() < 70) { px = _v2.x; pz = _v2.z; pull = 0.0035 * night; }
        }
      }
      const a = flies.pos;
      for (let i = 0; i < flies.N; i++) {
        const b = flies.base[i], ph = flies.ph[i];
        let x = b.x + Math.sin(t * 0.0005 + ph) * 3.2, z = b.z + Math.cos(t * 0.0004 + ph * 1.3) * 3.2;
        if (pull) { x += (px - x) * pull * 30; z += (pz - z) * pull * 30; }
        a[i * 3] = x;
        a[i * 3 + 1] = b.y + Math.sin(t * 0.0007 + ph * 2.1) * 1.6;
        a[i * 3 + 2] = z;
      }
      flies.pts.geometry.attributes.position.needsUpdate = true;
      flies.pts.visible = true;
    } else if (flies) flies.pts.visible = false;

    // stars twinkle from the camera's shoulder; sometimes one falls
    if (stars) {
      stars.pts.position.copy(camera.position);
      stars.mat.uniforms.uT.value = t * 0.001;
    }
    if (night > 0.5) {
      if (!shoot.active && Math.random() < 0.004) {
        shoot.active = true; shoot.t0 = t;
        camera.getWorldDirection(_v1);
        _v2.copy(camera.position).addScaledVector(_v1, 240);
        shoot.from.set(_v2.x + (Math.random() - 0.5) * 240, camera.position.y + 90 + Math.random() * 60, _v2.z + (Math.random() - 0.5) * 120);
        shoot.to.copy(shoot.from).add(new THREE.Vector3(-40 - Math.random() * 60, -26 - Math.random() * 18, 20));
      }
    }
    if (shoot.active) {
      const u = (t - shoot.t0) / 1150;
      if (u >= 1 || night < 0.4) { shoot.active = false; shoot.mesh.material.opacity = 0; }
      else {
        shoot.mesh.position.lerpVectors(shoot.from, shoot.to, u);
        shoot.mesh.lookAt(shoot.to);
        shoot.mesh.material.opacity = Math.sin(u * Math.PI) * 0.9 * night;
      }
    }

    // the beacon breathes; harder at night, and flashes when poked
    beaconPulse *= 0.94;
    beaconMat.color.setHex(P.beacon).multiplyScalar(
      0.75 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.004)) + 1.1 * night + 2.2 * beaconPulse);

    // click keepsakes easing in and out
    for (let i = flowers.length - 1; i >= 0; i--) {
      const f = flowers[i], u = Math.min(1, (t - f.t0) / 420);
      const s = u < 1 ? 1.25 * u * (2.2 - 1.2 * u) : 1;    // overshoot then settle
      f.g.scale.setScalar(Math.max(0.01, s));
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i], u = (t - r.t0) / 1300;
      if (u >= 1) { home.remove(r.m); r.m.material.dispose(); ripples.splice(i, 1); continue; }
      r.m.scale.setScalar(1 + u * 4.5);
      r.m.material.opacity = 0.55 * (1 - u);
    }

    shotAt(cs);
    // mouse parallax + a slow breathing drift so the frame never sits dead still
    camera.position.copy(pos);
    camera.lookAt(look);
    right.setFromMatrixColumn(camera.matrix, 0);
    camera.position.addScaledVector(right, cmx * 2.2 + Math.sin(t * 0.00013) * 0.7);
    camera.position.addScaledVector(up, -cmy * 1.4 + Math.cos(t * 0.00011) * 0.5);
    camera.lookAt(look);
    sky.position.copy(camera.position);

    // hover naming, after the camera settles for this frame
    if (canHover && !reduced && needPick && havePointer) {
      needPick = false;
      setHover(sphrottle());
    }
    if (tipEl && hover >= 0) {
      const g = islands[hover];
      _v1.set(g.position.x, g.position.y + g.userData.labelY, g.position.z).project(camera);
      if (_v1.z > 1) setHover(-1);
      else {
        tipEl.style.transform = 'translate(-50%,-120%) translate(' +
          ((_v1.x * 0.5 + 0.5) * innerWidth).toFixed(1) + 'px,' +
          ((-_v1.y * 0.5 + 0.5) * innerHeight).toFixed(1) + 'px)';
      }
    }
    updateTether(t);

    if (post.enabled && post.ok) post.render(scene, camera, t, night);
    else { renderer.setRenderTarget(null); renderer.render(scene, camera); }
  }
  // pick at most every other frame: ray-vs-spheres is cheap but not free
  let pickTick = 0;
  function sphrottle() { return (pickTick++ & 1) ? hover : spherePickSafe(); }
  function spherePickSafe() { try { return spherePick(); } catch (e) { return -1; } }

  const perf = () => performance.now();
  if (reduced) {
    // calm still frames: day cycle still applies, interactions don't
    cs = scroll;
    layout();
    render(1200);
    addEventListener('scroll', () => { cs = scrollY; render(1200); }, { passive: true });
    return true;
  }

  /* adaptive quality: weak GPUs shed the post stack first, then shadows,
     then resolution, so the page stays alive everywhere */
  let frames = 0, windowStart = 0, tier = 0;
  function adapt(t) {
    // a >400ms gap means the tab was hidden or the machine hitched: throw the
    // window away, or fast machines get wrongly downgraded after a tab switch
    if (stats.lastGap > 400) { windowStart = t; frames = 0; return; }
    if (!windowStart) { windowStart = t; frames = 0; return; }
    frames++;
    const dt = t - windowStart;
    if (dt < 1600) return;
    const fps = frames * 1000 / dt;
    if (fps < 28 && tier === 0) {
      tier = 1;
      post.enabled = false;
    } else if (fps < 24 && tier === 1) {
      tier = 2;
      renderer.shadowMap.enabled = false;
      sun.castShadow = false;
      scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
    } else if (fps < 19 && tier === 2) {
      tier = 3;
      renderer.setPixelRatio(Math.max(0.66, (devicePixelRatio || 1) * 0.55));
      resize();
    } else {
      tier = 4;                                          // good enough: stop probing
    }
    windowStart = t; frames = 0;
  }

  // debug/console access (also handy for the curious: it IS an open source site)
  const stats = { frame: 0, lastMs: 0, avgMs: 0, lastGap: 0 };
  window.__world = {
    renderer, scene, camera, info: renderer.info, tierOf: () => tier, stats, post,
    nightOf: () => night, dayOf: () => dayP,
    snap() { cs = scroll; render(performance.now()); },   // jump the camera, no lerp
  };

  let raf, lastT = 0;
  function loop(t) {
    cs += (scroll - cs) * 0.07;
    cmx += (mx - cmx) * 0.05;
    cmy += (my - cmy) * 0.05;
    stats.lastGap = t - lastT; lastT = t;
    if (tier < 4) adapt(t);
    const r0 = performance.now();
    render(t);
    stats.lastMs = performance.now() - r0;
    stats.avgMs += (stats.lastMs - stats.avgMs) * 0.1;
    stats.frame++;
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else raf = requestAnimationFrame(loop);
  });
  return true;
}
