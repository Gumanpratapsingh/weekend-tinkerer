// The three worlds behind the window. Units are centimetres; the monitor is the
// rectangle W x H centred on the origin in the z = 0 plane, the viewer sits at +z.
import * as THREE from 'three';

export const W = 53.1, H = 29.9; // MSI G24C4: 24" 16:9 panel, visible area

// ---------- small helpers ----------
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, y * f); f *= 2.03; amp *= 0.5; }
  return s / (1 - Math.pow(0.5, oct));
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rr = (a, b) => a + (b - a) * rand();

function radialTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner); grad.addColorStop(1, outer);
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Give every triangle of a (non-indexed) geometry one flat colour.
function paintFaces(geo, colorAt) {
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    colorAt(c, x, y, z);
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// ---------- 1. the deep box room ----------
export function boxRoom() {
  const scene = new THREE.Scene();
  const bg = 0x03060d;
  scene.background = new THREE.Color(bg);
  scene.fog = new THREE.Fog(bg, 70, 150);
  const D = 50, hw = W / 2, hh = H / 2;

  // Wall panels, nudged 0.1 cm outward so the grid lines never z-fight with them.
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x0c1a2e });
  const e = 0.1;
  const wall = (w, h, pos, rot) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.set(...pos); m.rotation.set(...rot); scene.add(m);
  };
  wall(W, H, [0, 0, -D - e], [0, 0, 0]);                         // back
  wall(W, D, [0, -hh - e, -D / 2], [-Math.PI / 2, 0, 0]);         // floor
  wall(W, D, [0, hh + e, -D / 2], [Math.PI / 2, 0, 0]);           // ceiling
  wall(D, H, [-hw - e, 0, -D / 2], [0, Math.PI / 2, 0]);          // left
  wall(D, H, [hw + e, 0, -D / 2], [0, -Math.PI / 2, 0]);          // right

  // Grid lines on the five walls, ~5 cm apart.
  const pts = [], seg = (a, b) => pts.push(...a, ...b);
  const NX = 10, NY = 6, NZ = 10;
  for (let i = 0; i <= NX; i++) {
    const x = -hw + i * W / NX;
    seg([x, -hh, -D], [x, hh, -D]); seg([x, -hh, 0], [x, -hh, -D]); seg([x, hh, 0], [x, hh, -D]);
  }
  for (let j = 0; j <= NY; j++) {
    const y = -hh + j * H / NY;
    seg([-hw, y, -D], [hw, y, -D]); seg([-hw, y, 0], [-hw, y, -D]); seg([hw, y, 0], [hw, y, -D]);
  }
  for (let k = 0; k <= NZ; k++) {
    const z = -k * D / NZ;
    seg([-hw, -hh, z], [hw, -hh, z]); seg([-hw, hh, z], [hw, hh, z]);
    seg([-hw, -hh, z], [-hw, hh, z]); seg([hw, -hh, z], [hw, hh, z]);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x3fb8ff })));

  scene.add(new THREE.AmbientLight(0x6070a0, 1.1));
  const lamp = new THREE.PointLight(0xfff2dd, 2.2, 0, 0); lamp.position.set(0, hh - 2, -18); scene.add(lamp);
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(25, 30, 60); scene.add(key);

  // Floating targets on strings; the last few hang in front of the glass.
  const defs = [
    [-15, 5, -38, 3.0, 0xff4466], [13, -6, -28, 2.6, 0x44c4ff], [-7, -8, -14, 2.0, 0xffc244],
    [18, 8, -44, 3.4, 0x66ff99], [1, 10, -22, 2.3, 0xff9455], [-19, -3, -6, 2.2, 0xb48cff],
    [5, 2, 8, 2.0, 0xff7ae0], [-12, 7, 15, 1.7, 0x7affff], [11, -5, 20, 1.5, 0xffffff],
  ];
  const shadowTex = radialTexture('rgba(0,0,0,0.75)', 'rgba(0,0,0,0)');
  const stringMat = new THREE.LineBasicMaterial({ color: 0xc8d8f0, transparent: true, opacity: 0.7 });
  const balls = defs.map(([x, y, z, r, c], i) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 24),
      new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.18, roughness: 0.35, metalness: 0.1 }));
    scene.add(mesh);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([x, y, z, x, y, -D], 3));
    const string = new THREE.Line(sg, stringMat); scene.add(string);
    let shadow = null;
    if (z < 0) {
      shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; scene.add(shadow);
    }
    return { mesh, string, shadow, x, y, z, r, phase: i * 1.7 };
  });

  return {
    name: 'Box room', scene, far: 2000,
    update(t) {
      for (const b of balls) {
        const y = b.y + Math.sin(t * 0.9 + b.phase) * 1.2, x = b.x + Math.sin(t * 0.5 + b.phase * 2) * 0.6;
        b.mesh.position.set(x, y, b.z);
        const p = b.string.geometry.attributes.position;
        p.setXYZ(0, x, y, b.z); p.setXYZ(1, b.x, b.y, -D); p.needsUpdate = true;
        if (b.shadow) {
          const s = b.r * 2.6 * (1 + (y + hh) / H * 0.6);
          b.shadow.position.set(x, -hh + 0.05, b.z); b.shadow.scale.set(s, s, 1);
          b.shadow.material.opacity = 1 - (y + hh) / H * 0.6;
        }
      }
    },
  };
}

// ---------- 2. space ----------
export function space() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010209);
  seed = 11;

  // Starfield on a far shell.
  const N = 7000, sp = new Float32Array(N * 3), sc = new Float32Array(N * 3), c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const u = rr(-1, 1), th = rr(0, Math.PI * 2), r = rr(5000, 12000), s = Math.sqrt(1 - u * u);
    sp.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
    c.setHSL(rr(0.55, 0.68) + (rand() < 0.2 ? -0.5 : 0), rr(0.2, 0.7), rr(0.6, 1)); sc.set([c.r, c.g, c.b], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  sg.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const dpr = Math.min(devicePixelRatio || 1, 2);
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.8 * dpr, sizeAttenuation: false, vertexColors: true })));

  // Sun glow far off to the right, and the light it casts.
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture('rgba(255,240,210,1)', 'rgba(255,170,80,0)'), blending: THREE.AdditiveBlending, depthWrite: false }));
  sun.position.set(5200, 1400, -7000); sun.scale.set(1600, 1600, 1); scene.add(sun);
  const sunLight = new THREE.DirectionalLight(0xfff1dc, 3.0); sunLight.position.set(5200, 1400, -2000); scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x223355, 0.35));

  // Ringed planet with a banded canvas texture.
  const pc = document.createElement('canvas'); pc.width = 512; pc.height = 256;
  const pg = pc.getContext('2d');
  for (let y = 0; y < 256; y++) {
    const n = fbm(0, y / 18, 4), hue = 28 + n * 18, l = 45 + n * 30;
    pg.fillStyle = `hsl(${hue}, ${40 + n * 25}%, ${l}%)`; pg.fillRect(0, y, 512, 1);
  }
  const pTex = new THREE.CanvasTexture(pc); pTex.colorSpace = THREE.SRGBColorSpace;
  const planetGroup = new THREE.Group();
  planetGroup.position.set(-90, 30, -700); planetGroup.rotation.z = 0.38; scene.add(planetGroup);
  const planet = new THREE.Mesh(new THREE.SphereGeometry(90, 64, 48), new THREE.MeshStandardMaterial({ map: pTex, roughness: 1 }));
  planetGroup.add(planet);
  const rIn = 125, rOut = 215, ringGeo = new THREE.RingGeometry(rIn, rOut, 160, 1);
  const uv = ringGeo.attributes.uv, rp = ringGeo.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (Math.hypot(rp.getX(i), rp.getY(i)) - rIn) / (rOut - rIn), 0.5);
  const rc = document.createElement('canvas'); rc.width = 512; rc.height = 4;
  const rg = rc.getContext('2d');
  for (let x = 0; x < 512; x++) {
    const n = fbm(x / 9, 3.3, 4), gap = x > 300 && x < 322 ? 0.05 : 1;
    rg.fillStyle = `rgba(${200 + n * 40}, ${180 + n * 30}, ${150 + n * 20}, ${(0.25 + n * 0.7) * gap})`;
    rg.fillRect(x, 0, 1, 4);
  }
  const rTex = new THREE.CanvasTexture(rc); rTex.colorSpace = THREE.SRGBColorSpace;
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({
    map: rTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 1 }));
  ring.rotation.x = Math.PI / 2 - 0.32; planetGroup.add(ring);

  const moon = new THREE.Mesh(new THREE.SphereGeometry(14, 32, 20), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 1 }));
  moon.position.set(140, -60, -520); scene.add(moon);

  // The asteroid: a lumpy, flat-shaded icosahedron.
  const ag = new THREE.IcosahedronGeometry(6, 2), ap = ag.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < ap.count; i++) {
    v.fromBufferAttribute(ap, i);
    const n = fbm(v.x * 0.25 + 10, v.y * 0.25 + v.z * 0.17, 3);
    v.multiplyScalar(0.7 + n * 0.6); ap.setXYZ(i, v.x, v.y, v.z);
  }
  ag.computeVertexNormals();
  const asteroid = new THREE.Mesh(ag, new THREE.MeshStandardMaterial({ color: 0x8c7d6c, roughness: 1, flatShading: true }));
  scene.add(asteroid);

  // Dust drifting toward the viewer, some of it in front of the glass.
  const DN = 500, dp = new Float32Array(DN * 3);
  for (let i = 0; i < DN; i++) dp.set([rr(-90, 90), rr(-55, 55), rr(-300, 45)], i * 3);
  const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  const dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0x8899aa, size: 0.35, transparent: true, opacity: 0.8 }));
  scene.add(dust);

  const CYCLE = 20;
  return {
    name: 'Space', scene, far: 30000,
    update(t, dt) {
      planet.rotation.y = t * 0.03;
      // Mostly straight at the glass, then it slows a little and swerves past your left ear.
      const u = (t % CYCLE) / CYCLE;
      const z = -1500 + 1555 * (0.35 * u + 0.65 * (1 - (1 - u) * (1 - u)));
      const s = (z + 1500) / 1500;
      const x = 40 - 44 * s - 0.0132 * Math.max(0, z) ** 2;
      const y = -18 + 20 * s + 0.003 * Math.max(0, z) ** 2;
      asteroid.position.set(x, y, z);
      asteroid.rotation.set(t * 0.4, t * 0.27, t * 0.13);
      const p = dg.attributes.position;
      for (let i = 0; i < DN; i++) {
        let dz = p.getZ(i) + dt * 6;
        if (dz > 45) dz -= 345;
        p.setZ(i, dz);
      }
      p.needsUpdate = true;
    },
  };
}

// ---------- 3. low-poly mountain valley ----------
export function valley() {
  const scene = new THREE.Scene();
  const fogColor = 0xc6d9e8;
  scene.background = new THREE.Color(fogColor);
  scene.fog = new THREE.Fog(fogColor, 900, 22000);
  seed = 23;

  // Sky dome with a vertical gradient (drawn first, never depth-tested).
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x4f86c9) }, bottom: { value: new THREE.Color(fogColor) } },
    vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float h; void main(){ gl_FragColor = vec4(mix(bottom, top, smoothstep(0.0, 0.45, h)), 1.0); }',
  }));
  sky.renderOrder = -1000; sky.frustumCulled = false; scene.add(sky);

  scene.add(new THREE.HemisphereLight(0xdcebff, 0x4d5a3a, 1.3));
  const sunLight = new THREE.DirectionalLight(0xffe6c4, 2.2); sunLight.position.set(-0.6, 0.8, 0.35); scene.add(sunLight);

  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });

  // The ledge you are standing on: just below the bottom edge of the monitor, sloping away.
  const ledgeH = (x, z) => -16.5 - (20 - z) * 0.1 + (fbm(x / 45 + 3, z / 45) - 0.5) * 7 + (Math.abs(x) / 160) ** 2 * 25;
  const lg = new THREE.PlaneGeometry(340, 280, 42, 34).toNonIndexed();
  lg.rotateX(-Math.PI / 2); lg.translate(0, 0, -120);
  const lp = lg.attributes.position;
  for (let i = 0; i < lp.count; i++) lp.setY(i, ledgeH(lp.getX(i), lp.getZ(i)));
  lg.computeVertexNormals();
  paintFaces(lg, (col, x, y, z) => col.setHSL(0.25 + hash(x, z) * 0.05, 0.45, 0.28 + hash(z, x) * 0.08));
  scene.add(new THREE.Mesh(lg, terrainMat));

  // The valley and the ranges around it.
  const valleyH = (x, z) => {
    const n = fbm(x / 1900 + 7, z / 1900 + 2, 5);
    const sides = (Math.abs(x) / 3200) ** 2 * 2000;
    const range = smooth(-2500, -11000, z) * 3200;
    return -420 + sides * (0.5 + n) + range * (0.3 + n * 1.1) + (n - 0.5) * 260;
  };
  const vg = new THREE.PlaneGeometry(26000, 17000, 170, 120).toNonIndexed();
  vg.rotateX(-Math.PI / 2); vg.translate(0, 0, -8500 - 150);
  const vp = vg.attributes.position;
  for (let i = 0; i < vp.count; i++) vp.setY(i, valleyH(vp.getX(i), vp.getZ(i)));
  vg.computeVertexNormals();
  paintFaces(vg, (col, x, y, z) => {
    const j = hash(x, z) * 0.06;
    if (y > 1900 + hash(z, x) * 300) col.setHSL(0.6, 0.15, 0.93 + j * 0.5);   // snow
    else if (y > 700) col.setHSL(0.08, 0.1, 0.42 + j);                       // rock
    else if (y > 150) col.setHSL(0.22, 0.35, 0.3 + j);                        // high meadow
    else col.setHSL(0.27, 0.5, 0.27 + j);                                     // valley floor
  });
  scene.add(new THREE.Mesh(vg, terrainMat));

  // A lake on the valley floor.
  const lake = new THREE.Mesh(new THREE.CircleGeometry(900, 24),
    new THREE.MeshStandardMaterial({ color: 0x5f8fb5, roughness: 0.25, metalness: 0.2, flatShading: true }));
  lake.rotation.x = -Math.PI / 2; lake.scale.set(1.6, 1, 1); lake.position.set(300, -400, -3800); scene.add(lake);

  // Low-poly conifers.
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b3d26, flatShading: true, roughness: 1 });
  const leafMats = [0x1f4d2b, 0x2a5e33, 0x1a3f26, 0x31693a].map((c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 1 }));
  const tree = (x, z, h) => {
    const g = new THREE.Group(), y = ledgeH(x, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.035, h * 0.05, h * 0.3, 6), trunkMat);
    trunk.position.y = h * 0.15; g.add(trunk);
    const mat = leafMats[Math.floor(rand() * leafMats.length)];
    for (let k = 0; k < 3; k++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(h * (0.3 - k * 0.07), h * (0.45 - k * 0.07), 7), mat);
      cone.position.y = h * (0.38 + k * 0.2); cone.rotation.y = rand() * 3; g.add(cone);
    }
    g.position.set(x, y - 0.5, z); scene.add(g);
  };
  // [x, z, height] — the first two stand in front of the glass, at the corners.
  [[-22, 7, 26], [24, 12, 32], [-34, -14, 30], [33, -30, 24], [-10, -70, 22], [16, -95, 30],
   [-40, -110, 38], [52, -140, 40], [-62, -60, 34], [70, -70, 30], [2, -185, 34], [-85, -170, 44],
   [95, -200, 42], [-25, -215, 30], [38, -230, 36]].forEach(([x, z, h]) => tree(x, z, h));

  // Many small trees down in the valley, as one instanced mesh.
  const coneGeo = new THREE.ConeGeometry(1, 2.6, 6); coneGeo.translate(0, 1.3, 0);
  const forest = new THREE.InstancedMesh(coneGeo, new THREE.MeshStandardMaterial({ color: 0x24532e, flatShading: true, roughness: 1 }), 700);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  let placed = 0;
  for (let tries = 0; tries < 6000 && placed < 700; tries++) {
    const x = rr(-6000, 6000), z = rr(-9000, -1600), y = valleyH(x, z);
    if (y > 500 || Math.hypot((x - 300) / 1.6, z + 3800) < 950) continue;
    const s = rr(60, 140);
    m.compose(ps.set(x, y - 10, z), q, sc.set(s, s * rr(0.9, 1.3), s));
    forest.setMatrixAt(placed++, m);
  }
  forest.count = placed; scene.add(forest);

  // A few drifting low-poly clouds.
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, transparent: true, opacity: 0.92 });
  const clouds = [];
  for (let i = 0; i < 7; i++) {
    const g = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(rr(220, 420), 0), cloudMat);
      b.position.set(rr(-500, 500), rr(-60, 120), rr(-200, 200)); b.scale.y = 0.55; g.add(b);
    }
    g.position.set(rr(-7000, 7000), rr(1400, 2600), rr(-11000, -5000)); scene.add(g); clouds.push(g);
  }

  return {
    name: 'Mountain valley', scene, far: 60000,
    update(t, dt, camera) {
      sky.position.copy(camera.position);
      for (const c of clouds) { c.position.x += dt * 60; if (c.position.x > 9000) c.position.x = -9000; }
    },
  };
}
