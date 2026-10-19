// Holographic window: head-tracked off-axis projection onto a 24" monitor.
import * as THREE from 'three';
import { W, H, boxRoom, space, valley } from './scenes.js';
import { HeadTracker } from './tracker.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const hud = $('hud'), hudText = $('hud-text'), hudCam = $('hud-cam').getContext('2d'), toastEl = $('toast');

// ---------- renderer + camera ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
const camera = new THREE.PerspectiveCamera(); // projection is set by hand every frame
const NEAR = 1;

// The canvas as a physical rectangle on the monitor. In fullscreen it is exactly W x H.
let physW = W, physH = H;
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  if (params.has('fit')) { // treat the window as the whole monitor width (handy when not fullscreen)
    physW = W; physH = W * innerHeight / innerWidth;
  } else {
    physW = innerWidth * W / screen.width;
    physH = innerHeight * H / screen.height;
  }
}
addEventListener('resize', resize);
resize();

// Eye at (x, y, z) cm in front of the screen plane z = 0; camera at the eye, no rotation.
function setProjection(eye, far) {
  const ez = Math.max(eye.z, 5), k = NEAR / ez;
  const left = (-physW / 2 - eye.x) * k, right = (physW / 2 - eye.x) * k;
  const top = (physH / 2 - eye.y) * k, bottom = (-physH / 2 - eye.y) * k;
  camera.position.set(eye.x, eye.y, ez);
  camera.quaternion.identity();
  camera.near = NEAR; camera.far = far;
  camera.projectionMatrix.makePerspective(left, right, top, bottom, NEAR, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

// ---------- scenes ----------
const scenes = [boxRoom(), space(), valley()];
let current = Math.min(2, Math.max(0, (parseInt(params.get('scene'), 10) || 1) - 1));

// ---------- head position state ----------
const DEFAULT_CALIB = { camX: 0, camY: -(H / 2 + 3), zScale: 1, fov: 70 }; // camera just below the monitor
let calib = { ...DEFAULT_CALIB };
try { Object.assign(calib, JSON.parse(localStorage.getItem('holo-calib') || '{}')); } catch {}
const saveCalib = () => { try { localStorage.setItem('holo-calib', JSON.stringify(calib)); } catch {} };

const eye = new THREE.Vector3(0, 0, 60);     // smoothed eye used for rendering
const target = new THREE.Vector3(0, 0, 60);  // where the eye is heading
const rawSmooth = new THREE.Vector3(0, 0, 60); // smoothed camera-relative reading, for calibration
let mode = 'mouse';      // 'mouse' | 'starting' | 'tracking' | 'lost'
let forceMouse = params.has('mouse');
let mouseZ = 60;

const tracker = new HeadTracker($('cam'));
tracker.fovDeg = calib.fov;

function toast(msg, ms = 2500) {
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { console.info('holo: no camera API, using the mouse'); return; }
  mode = 'starting';
  try {
    await tracker.start();
    if (mode === 'starting') mode = 'lost';
    toast('Camera on: look at the screen. C = calibrate, H = HUD');
  } catch (err) {
    console.info('holo: camera unavailable, using the mouse:', err && err.name);
    mode = 'mouse';
    toast('No camera: move the mouse to look around');
  }
}

addEventListener('mousemove', (e) => {
  if (mode !== 'mouse' && !forceMouse) return;
  target.x = (e.clientX / innerWidth - 0.5) * W * 1.6;
  target.y = -(e.clientY / innerHeight - 0.5) * H * 1.6;
});
addEventListener('wheel', (e) => {
  if (mode !== 'mouse' && !forceMouse) return;
  mouseZ = Math.min(150, Math.max(25, mouseZ + e.deltaY * 0.05));
}, { passive: true });

function calibrate() {
  if (forceMouse || mode !== 'tracking') { toast('Calibration needs the camera to see your face'); return; }
  let n = 3;
  const tick = () => {
    if (n > 0) { toast(`Sit centred, about 60 cm away… ${n}`, 1100); n--; setTimeout(tick, 1000); return; }
    if (mode !== 'tracking') { toast('Lost your face, press C to try again'); return; }
    calib.zScale = 60 / rawSmooth.z;
    calib.camX = -rawSmooth.x * calib.zScale;
    calib.camY = -rawSmooth.y * calib.zScale;
    saveCalib();
    toast('Calibrated ✓');
  };
  tick();
}

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === '1' || k === '2' || k === '3') { current = +k - 1; toast(scenes[current].name, 1200); }
  else if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => toast('Fullscreen was blocked'));
  }
  else if (k === 'h') hud.classList.toggle('hidden');
  else if (k === 'c') calibrate();
  else if (k === 'r') { calib = { ...DEFAULT_CALIB, fov: calib.fov }; saveCalib(); toast('Calibration reset'); }
  else if (k === '[' || k === ']') {
    calib.fov = Math.min(120, Math.max(40, calib.fov + (k === ']' ? 2 : -2)));
    tracker.fovDeg = calib.fov; saveCalib(); toast(`Camera FOV ${calib.fov}°`, 1200);
  }
  else if (k === 'm') {
    forceMouse = !forceMouse;
    toast(forceMouse ? 'Mouse mode' : 'Head tracking');
    if (!forceMouse && mode === 'mouse') startCamera();
  }
});

// ---------- loop ----------
let last = performance.now(), fps = 60, hudTimer = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  if (!forceMouse && tracker.ready) {
    const raw = tracker.poll(now);
    if (raw) {
      mode = 'tracking';
      rawSmooth.lerp(raw, 0.3);
      target.set(raw.x * calib.zScale + calib.camX, raw.y * calib.zScale + calib.camY, raw.z * calib.zScale);
    } else if (raw === null && mode === 'tracking') {
      mode = 'lost'; // hold the last position
    }
  }
  if (mode === 'mouse' || forceMouse) target.z = mouseZ;

  eye.lerp(target, 1 - Math.exp(-dt * 12));
  const s = scenes[current];
  s.update(now / 1000, dt, camera);
  setProjection(eye, s.far);
  renderer.render(s.scene, camera);

  if (!hud.classList.contains('hidden') && (hudTimer += dt) > 0.1) {
    hudTimer = 0;
    const shown = forceMouse ? 'mouse (forced)' : mode;
    hudText.textContent =
      `${s.name}  [1/2/3]\n` +
      `head  x ${eye.x.toFixed(1).padStart(6)}  y ${eye.y.toFixed(1).padStart(6)}  z ${eye.z.toFixed(1).padStart(6)} cm\n` +
      `fps   ${fps.toFixed(0)}    mode ${shown}\n` +
      `cam   fov ${calib.fov}°  offset ${calib.camX.toFixed(1)}, ${calib.camY.toFixed(1)}  z×${calib.zScale.toFixed(2)}\n` +
      `F fullscreen · C calibrate · [ ] fov · M mouse · R reset`;
    hudCam.canvas.style.display = tracker.ready && !forceMouse ? 'block' : 'none';
    if (tracker.ready && !forceMouse) tracker.drawPreview(hudCam);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

toast('1/2/3 scenes · F fullscreen · C calibrate · H HUD', 5000);
if (!forceMouse) startCamera();

// Handy from the devtools console.
window.holo = { eye, target, get mode() { return mode; }, setScene: (i) => { current = i; } };
