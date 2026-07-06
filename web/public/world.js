/* world.js: the beckett archipelago.
 *
 * One coherent 3D voxel world (three.js, instanced cubes) instead of the old
 * stacked-parallax-planes canvas. The world IS the pitch: a main island (this
 * Beckett's home) surrounded by a federation of smaller islands (everyone
 * else's), with signal arcs carrying packets between them. Scroll drives a
 * choreographed camera path from the hero close-up to the wide federation
 * reveal; the mouse adds a gentle parallax on top.
 *
 * Everything is deterministic (seeded hash noise) so the world is identical
 * on every visit and every resize. Reduced-motion renders one still frame.
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
  signal: 0x63c6cf,
};
const SKY_TOP = 0xbfe6ee, SKY_MID = 0xe4ddf5, SKY_LOW = 0xd9cff0, FOG = 0xded7f2;

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
      vox.push({ x: gx, y: 0, z: gy, c: P.cloud });
    if (d <= 0.45 && rnd(gx + seed * 5, gy + seed * 3, seed + 1) > 0.5)
      vox.push({ x: gx, y: 1, z: gy, c: P.cloud });
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

/* ── voxel list -> meshes (lit + self-lit), interior cells culled ──────── */
const BOX = new THREE.BoxGeometry(1, 1, 1);
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

  if (lit.length) {
    const mesh = new THREE.InstancedMesh(BOX, new THREE.MeshLambertMaterial(), lit.length);
    lit.forEach((v, i) => {
      m4.setPosition(v.x, v.y, v.z);
      mesh.setMatrixAt(i, m4);
      // baked texture: per-voxel brightness jitter + soft AO when covered
      let f = 0.94 + 0.12 * rnd(v.x * 3 + 7, v.y * 5 + 1, v.z * 7 + 3);
      if (solid.has(v.x + '|' + (v.y + 1) + '|' + v.z)) f *= 0.82;
      col.setHex(v.c).multiplyScalar(f);
      mesh.setColorAt(i, col);
    });
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (glow.length) {
    // windows, crystal tips, water: unlit so they read as their own light
    const mesh = new THREE.InstancedMesh(BOX, new THREE.MeshBasicMaterial(), glow.length);
    glow.forEach((v, i) => {
      m4.setPosition(v.x, v.y, v.z);
      mesh.setMatrixAt(i, m4);
      col.setHex(v.c).multiplyScalar(v.soft ? 0.97 : 1);
      mesh.setColorAt(i, col);
    });
    group.add(mesh);
  }
  return group;
}

/* ── island factories ──────────────────────────────────────────────────── */
function makeIsland(kind, r, seed, flagIx) {
  const vox = [], glow = [];
  const tops = islandBase(vox, r, seed);
  const top = (gx, gy) => topAt(tops, gx, gy) + 1;
  const sprinkle = (n, fn) => {
    for (let i = 0; i < n; i++) {
      const gx = Math.round((rnd(i * 3 + 1, seed, 11) - 0.5) * 2 * (r - 2));
      const gy = Math.round((rnd(i * 5 + 2, seed, 17) - 0.5) * 2 * (r - 2));
      if (gx * gx + gy * gy < (r - 2) * (r - 2)) fn(gx, gy);
    }
  };
  if (kind === 'home') {
    // camera lives in the +x/+z quadrant: cabin faces it, trees stay behind
    cabin(vox, glow, 2, top(4, 4), 2);
    pond(vox, glow, tops, -5, 5);
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
  return buildMeshes(vox, glow);
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
  scene.fog = new THREE.Fog(FOG, 110, 430);

  /* sky dome: vertical pastel gradient, immune to fog */
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(520, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(SKY_TOP) },
        mid: { value: new THREE.Color(SKY_MID) },
        low: { value: new THREE.Color(SKY_LOW) },
      },
      vertexShader: 'varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vp; uniform vec3 top; uniform vec3 mid; uniform vec3 low;
        void main(){ float h = normalize(vp).y;
          vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.55, h)) : mix(mid, low, smoothstep(0.0, -0.5, h));
          gl_FragColor = vec4(c, 1.0); }`,
    })
  );
  scene.add(sky);

  scene.add(new THREE.HemisphereLight(0xe3f6f8, 0xc7b9e6, 0.95));
  const sun = new THREE.DirectionalLight(0xfff6e8, 1.25);
  sun.position.set(55, 90, 35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -34;
  sun.shadow.camera.right = sun.shadow.camera.top = 34;
  sun.shadow.camera.near = 40; sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 800);

  /* the federation: home island + satellites, each with a claim flag */
  const islands = [];
  function addIsland(kind, r, seed, x, y, z, flagIx, bobAmp, bobSp) {
    const g = makeIsland(kind, r, seed, flagIx);
    g.position.set(x, y, z);
    g.userData = { baseY: y, amp: bobAmp, sp: bobSp, ph: rnd(seed, 3, 5) * 6.28 };
    // shadows are a home-island luxury; satellites are too far to read them
    if (kind !== 'home') g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = false; });
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

  /* clouds: unlit white voxel slabs (Lambert shades them grey) drifting slowly,
     kept low and to the edges so they never mud the composition */
  const clouds = [];
  [[9, 4, 1, -85, 32, -85, 0.9], [12, 5, 2, 55, 40, -115, 0.7], [7, 3, 3, -45, 14, 62, 1.1],
   [10, 4, 4, 105, 22, -70, 0.8], [6, 3, 5, -120, 18, -20, 1.0],
  ].forEach(([a, b, seed, x, y, z, sp]) => {
    const vox = [];
    cloudSlab(vox, a, b, seed);
    const g = buildMeshes([], vox);                       // glow list = unlit
    g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = false; });
    g.position.set(x, y, z);
    g.scale.setScalar(1.4);
    g.userData = { sp };
    scene.add(g);
    clouds.push(g);
  });

  /* blossom petals: a slow pastel drift around the home island */
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

  /* signal arcs: the islands talking to each other */
  const packets = [];
  const arcMat = new THREE.LineBasicMaterial({ color: 0x9a86d8, transparent: true, opacity: 0.32 });
  const packetGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
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
    packets.push({ curve, p1, p2, ph, sp: 0.05 + rnd(ix, 2, 4) * 0.04 });
  });

  /* ── the camera script: one shot per page section ──────────────────── */
  const SHOTS = (opts.shots || [
    { sel: '#hero',    pos: [44, 19, 58],   look: [-13, 1, -3] },
    { sel: '#console', pos: [24, 13, 38],   look: [0, 3, 3] },
    { sel: '#how',     pos: [-6, 13, 40],   look: [-13, 2, -8] },
    { sel: '#caps',    pos: [-32, 26, 52],  look: [-2, 3, -20] },
    { sel: '#cta',     pos: [-36, 52, 108], look: [6, 2, -32] },
  ]).map(s => ({ el: document.querySelector(s.sel), pos: new THREE.Vector3(...s.pos), look: new THREE.Vector3(...s.look) }))
    .filter(s => s.el);

  let anchors = [];
  function layout() {
    const vh = innerHeight;
    anchors = SHOTS.map((s, i) => i === 0 ? 0 : Math.max(1, s.el.offsetTop - vh * 0.45));
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

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    layout();
  }
  resize();
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); render(perf()); }, 120); }, { passive: true });

  /* input state, all lerped in the loop */
  let scroll = scrollY, mx = 0, my = 0, cs = scrollY, cmx = 0, cmy = 0;
  addEventListener('scroll', () => { scroll = scrollY; }, { passive: true });
  addEventListener('mousemove', (e) => { mx = (e.clientX / innerWidth - 0.5) * 2; my = (e.clientY / innerHeight - 0.5) * 2; }, { passive: true });

  const right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  function render(t) {
    islands.forEach(g => { g.position.y = g.userData.baseY + Math.sin(t * 0.0006 * g.userData.sp * 4 + g.userData.ph) * g.userData.amp; });
    clouds.forEach(g => {
      g.position.x += 0.014 * g.userData.sp;
      if (g.position.x > 150) g.position.x = -150;
    });
    const ba = t * 0.000021;
    bal.position.set(Math.cos(ba) * 66, 26 + Math.sin(t * 0.0004) * 2.2, Math.sin(ba) * 66 - 30);
    if (petals) {
      const a = petals.pos;
      for (let i = 0; i < petals.N; i++) {
        a[i * 3] += Math.sin(t * 0.0004 + petals.ph[i]) * 0.012;
        a[i * 3 + 1] -= 0.008 + 0.006 * Math.sin(petals.ph[i]);
        if (a[i * 3 + 1] < -14) a[i * 3 + 1] = 30;
      }
      petals.pts.geometry.attributes.position.needsUpdate = true;
    }
    packets.forEach(pk => {
      const u = (t * 0.0001 * pk.sp * 4 + pk.ph) % 1;
      pk.curve.getPoint(u, pk.p1.position);
      pk.p2.position.copy(pk.p1.position);
      pk.p2.material.opacity = 0.15 + 0.2 * Math.sin(u * Math.PI);
    });
    shotAt(cs);
    // mouse parallax + a slow breathing drift so the frame never sits dead still
    camera.position.copy(pos);
    camera.lookAt(look);
    right.setFromMatrixColumn(camera.matrix, 0);
    camera.position.addScaledVector(right, cmx * 2.2 + Math.sin(t * 0.00013) * 0.7);
    camera.position.addScaledVector(up, -cmy * 1.4 + Math.cos(t * 0.00011) * 0.5);
    camera.lookAt(look);
    sky.position.copy(camera.position);
    renderer.render(scene, camera);
  }

  const perf = () => performance.now();
  if (reduced) {
    // one calm still frame (and a fresh one on resize, handled above)
    cs = scroll;
    render(1200);
    addEventListener('scroll', () => { cs = scrollY; render(1200); }, { passive: true });
    return true;
  }

  /* adaptive quality: weak GPUs shed shadows first, then resolution, so the
     page stays alive everywhere instead of gorgeous on M-series only */
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
    if (fps < 26 && tier === 0) {
      tier = 1;
      renderer.shadowMap.enabled = false;
      sun.castShadow = false;
      scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
    } else if (fps < 20 && tier === 1) {
      tier = 2;
      renderer.setPixelRatio(Math.max(0.66, (devicePixelRatio || 1) * 0.55));
      resize();
    } else {
      tier = 3;                                          // good enough: stop probing
    }
    windowStart = t; frames = 0;
  }

  // debug/console access (also handy for the curious: it IS an open source site)
  const stats = { frame: 0, lastMs: 0, avgMs: 0, lastGap: 0 };
  window.__world = {
    renderer, scene, camera, info: renderer.info, tierOf: () => tier, stats,
    snap() { cs = scroll; render(performance.now()); },   // jump the camera, no lerp
  };

  let raf, lastT = 0;
  function loop(t) {
    cs += (scroll - cs) * 0.07;
    cmx += (mx - cmx) * 0.05;
    cmy += (my - cmy) * 0.05;
    stats.lastGap = t - lastT; lastT = t;
    if (tier < 3) adapt(t);
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
