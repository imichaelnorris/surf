import * as THREE from 'three';
import GUI from 'lil-gui';

// ---------------------------------------------------------------------------
// Coordinate system
//   +X = right (lateral),  +Z = downhill (the fall line),  +Y = up.
// The skier travels mostly in +Z; the world is recycled around it so the
// slope is effectively infinite. Everything here is intentionally tunable —
// the whole point of this milestone is to dial in *feel*, so the numbers
// below are exposed through the lil-gui panel rather than baked in.
// ---------------------------------------------------------------------------

const CONFIG = {
  // --- skier motion (the fall-line model) ---
  maxSpeed: 34,        // top speed when pointing straight down the fall line
  accel: 28,           // m/s^2 gained while below target speed
  friction: 40,        // m/s^2 shed while above target speed (carving/braking)
  steerRate: 2.6,      // rad/s the heading swings while ← → held
  maxHeading: 1.30,    // rad (~75°) — how far across the slope you can point
  brakeStrength: 55,   // extra deceleration while ↓ snowplow is held
  airControl: 0.45,    // fraction of steer authority while airborne
  touchSensitivity: 90,// px of horizontal drag for full steering input (mobile)

  // --- jumping ---
  gravity: 60,         // m/s^2 pulling back to the snow
  jumpImpulse: 18,     // upward launch from Space
  rampImpulse: 26,     // upward launch from hitting a ramp

  // --- camera (fixed-angle 3D chase) ---
  camHeight: 14,
  camDistance: 16,
  camLookAhead: 18,
  camLagX: 6,          // higher = camera tracks lateral motion more tightly

  // --- world / obstacles ---
  spawnDensity: 0.55,  // obstacles per meter of descent
  corridorWidth: 70,   // lateral span obstacles spawn across
  treeScale: 1.0,
  skierScale: 1.0,

  // --- debug ---
  showColliders: false,
};

// Pristine defaults (captured before any saved values are applied) so the GUI
// can offer a "restore defaults" action.
const DEFAULTS = { ...CONFIG };
const STORAGE_KEY = 'surf-feel-v1';

function loadFeel() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof saved[k] === typeof DEFAULTS[k]) CONFIG[k] = saved[k];
    }
  } catch { /* ignore corrupt/unavailable storage */ }
}
function saveFeel() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG)); } catch {}
}
loadFeel(); // apply persisted tuning before the GUI reads CONFIG

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------

const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfe8f5);
scene.fog = new THREE.Fog(0xcfe8f5, 60, 180);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);

const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-30, 60, -20);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 200;
sun.shadow.camera.left = -80;
sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80;
sun.shadow.camera.bottom = -80;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xffffff, 0xa9c7d6, 0.7));

// ---------------------------------------------------------------------------
// Snow ground — a plane that recenters on the skier each frame, with a
// scrolling grid texture so you can read your speed against the surface.
// ---------------------------------------------------------------------------

function makeSnowTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4fbff';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(160,196,214,0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 40);
  tex.anisotropy = 4;
  return tex;
}

const groundTex = makeSnowTexture();
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshLambertMaterial({ color: 0xffffff, map: groundTex })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------------------------------------------------------------------------
// Skier — low-poly procedural model in a group we rotate to face the heading.
// ---------------------------------------------------------------------------

function makeSkier() {
  const g = new THREE.Group();

  const suit = new THREE.MeshLambertMaterial({ color: 0xe23b3b });
  const skin = new THREE.MeshLambertMaterial({ color: 0xf0c39a });
  const ski = new THREE.MeshLambertMaterial({ color: 0x2b6cb0 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.1, 4, 8), suit);
  torso.position.y = 1.6;
  torso.rotation.x = 0.25; // lean forward
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 12), skin);
  head.position.set(0, 2.5, 0.15);
  head.castShadow = true;
  g.add(head);

  for (const side of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 3.4), ski);
    s.position.set(side * 0.35, 0.06, 0.4);
    s.castShadow = true;
    g.add(s);
  }

  return g;
}

const skier = makeSkier();
scene.add(skier);

// Skier dynamic state.
const state = {
  x: 0,
  z: 0,
  y: 0,            // height above snow
  vy: 0,           // vertical velocity
  heading: 0,      // rad; 0 = straight down the fall line
  speed: 0,        // scalar speed along heading
  airborne: false,
  dead: false,     // hit a tree/rock — run is over until replay
  distance: 0,
};

// ---------------------------------------------------------------------------
// Obstacles — pooled. Trees & rocks crash you; ramps launch you.
// We keep a rolling set ahead of the skier and recycle ones left behind.
// ---------------------------------------------------------------------------

const TREE = 'tree', ROCK = 'rock', RAMP = 'ramp';

function makeTree() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.35, 1.4, 6),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2b })
  );
  trunk.position.y = 0.7;
  const foliage = new THREE.Mesh(
    new THREE.ConeGeometry(1.6, 4.5, 7),
    new THREE.MeshLambertMaterial({ color: 0x2f7d4f })
  );
  foliage.position.y = 3.4;
  trunk.castShadow = foliage.castShadow = true;
  g.add(trunk, foliage);
  g.userData = { type: TREE, radius: 1.1 };
  return g;
}

function makeRock() {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.0, 0),
    new THREE.MeshLambertMaterial({ color: 0x8a8f96, flatShading: true })
  );
  rock.position.y = 0.5;
  rock.scale.set(1, 0.7, 1);
  rock.castShadow = true;
  g.add(rock);
  g.userData = { type: ROCK, radius: 1.1 };
  return g;
}

function makeRamp() {
  const g = new THREE.Group();
  const wedge = new THREE.Mesh(
    new THREE.BoxGeometry(4, 1.4, 3),
    new THREE.MeshLambertMaterial({ color: 0xdfe9f0 })
  );
  wedge.rotation.x = -0.35;
  wedge.position.y = 0.7;
  wedge.castShadow = true;
  g.add(wedge);
  g.userData = { type: RAMP, radius: 2.2 };
  return g;
}

const factories = { [TREE]: makeTree, [ROCK]: makeRock, [RAMP]: makeRamp };
const obstacles = [];
let lastSpawnZ = 0;

function spawnAhead(targetZ) {
  while (lastSpawnZ < targetZ) {
    const step = 1 / Math.max(0.01, CONFIG.spawnDensity);
    lastSpawnZ += step;
    const r = Math.random();
    const type = r < 0.62 ? TREE : r < 0.85 ? ROCK : RAMP;
    const obj = factories[type]();
    obj.position.set(
      (Math.random() - 0.5) * CONFIG.corridorWidth,
      0,
      lastSpawnZ
    );
    const s = type === RAMP ? 1 : CONFIG.treeScale * (0.8 + Math.random() * 0.5);
    obj.scale.setScalar(s);
    obj.userData.collideRadius = obj.userData.radius * s;
    scene.add(obj);
    obstacles.push(obj);
  }
}

function recycleBehind() {
  for (let i = obstacles.length - 1; i >= 0; i--) {
    if (obstacles[i].position.z < state.z - 30) {
      scene.remove(obstacles[i]);
      obstacles.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const keys = new Set();
// Clicking the canvas drops focus off any GUI field so it can't eat arrow keys.
canvas.addEventListener('pointerdown', () => {
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
});
// If the window loses focus (e.g. after a hot-reload), clear held keys so the
// skier doesn't get stuck steering.
addEventListener('blur', () => keys.clear());
const jumpCodes = ['Space', 'KeyW'];
const handledCodes = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'Space', 'KeyA', 'KeyD', 'KeyS', 'KeyW'];
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (jumpCodes.includes(e.code) && !state.airborne && !state.dead) {
    state.vy = CONFIG.jumpImpulse;
    state.airborne = true;
  }
  if (handledCodes.includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));

// --- touch / swipe controls (mobile) ---
// Drag-to-steer: while a finger is down, its horizontal offset from the touch
// origin becomes a -1..1 steering axis (further = sharper carve). A drag down
// brakes; a quick tap with little movement jumps.
const SWIPE_DEADZONE = 16; // px before a drag registers as input
const touch = { active: false, startX: 0, startY: 0, dx: 0, dy: 0, startT: 0, moved: false };

canvas.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  touch.active = true;
  touch.startX = t.clientX;
  touch.startY = t.clientY;
  touch.dx = touch.dy = 0;
  touch.startT = performance.now();
  touch.moved = false;
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (!touch.active) return;
  const t = e.changedTouches[0];
  touch.dx = t.clientX - touch.startX;
  touch.dy = t.clientY - touch.startY;
  if (Math.hypot(touch.dx, touch.dy) > SWIPE_DEADZONE) touch.moved = true;
  e.preventDefault();
}, { passive: false });

function endTouch(e) {
  // Quick tap, barely moved → jump.
  const dur = performance.now() - touch.startT;
  if (touch.active && !touch.moved && dur < 250 && !state.airborne && !state.dead) {
    state.vy = CONFIG.jumpImpulse;
    state.airborne = true;
  }
  touch.active = false;
  touch.dx = touch.dy = 0;
  if (e) e.preventDefault();
}
canvas.addEventListener('touchend', endTouch, { passive: false });
canvas.addEventListener('touchcancel', endTouch, { passive: false });

// ---------------------------------------------------------------------------
// Simulation step
// ---------------------------------------------------------------------------

function update(dt) {
  // Dead: run is frozen until the player hits Replay.
  if (state.dead) return;

  // Steering: combine keyboard (±1) and touch drag (−1..1) into one axis;
  // authority is reduced in the air.
  const steerAuth = state.airborne ? CONFIG.airControl : 1;
  let steerInput = 0;
  if (keys.has('ArrowLeft')  || keys.has('KeyA')) steerInput -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) steerInput += 1;
  if (touch.active && Math.abs(touch.dx) > SWIPE_DEADZONE) {
    steerInput += touch.dx / CONFIG.touchSensitivity;
  }
  steerInput = THREE.MathUtils.clamp(steerInput, -1, 1);
  state.heading += steerInput * CONFIG.steerRate * steerAuth * dt;
  state.heading = THREE.MathUtils.clamp(state.heading, -CONFIG.maxHeading, CONFIG.maxHeading);

  // Fall-line speed model: the more squarely you point downhill, the faster
  // you *want* to go. Pointing across the slope bleeds speed (a carve/brake).
  if (!state.airborne) {
    const target = CONFIG.maxSpeed * Math.cos(state.heading);
    if (state.speed < target) {
      state.speed = Math.min(target, state.speed + CONFIG.accel * dt);
    } else {
      state.speed = Math.max(target, state.speed - CONFIG.friction * dt);
    }
    const touchBrake = touch.active && touch.dy > SWIPE_DEADZONE * 2.5;
    if (keys.has('ArrowDown') || keys.has('KeyS') || touchBrake) {
      state.speed = Math.max(0, state.speed - CONFIG.brakeStrength * dt);
    }
  }

  // Translate along the heading. X is negated so lateral motion matches the
  // skier's on-screen facing (the camera looks down +Z, which mirrors X).
  state.x -= Math.sin(state.heading) * state.speed * dt;
  state.z += Math.cos(state.heading) * state.speed * dt;

  // Vertical / jump physics.
  if (state.airborne) {
    state.vy -= CONFIG.gravity * dt;
    state.y += state.vy * dt;
    if (state.y <= 0) {
      state.y = 0;
      state.vy = 0;
      state.airborne = false;
    }
  }

  // Spawn ahead, retire behind, then test collisions.
  spawnAhead(state.z + 200);
  recycleBehind();
  if (!state.airborne) checkCollisions();

  state.distance = Math.max(state.distance, state.z);
}

function checkCollisions() {
  for (const o of obstacles) {
    const dx = o.position.x - state.x;
    const dz = o.position.z - state.z;
    const r = o.userData.collideRadius + 0.6;
    if (dx * dx + dz * dz < r * r) {
      if (o.userData.type === RAMP) {
        state.vy = CONFIG.rampImpulse;
        state.airborne = true;
      } else {
        die();
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Visual sync (separate from sim so we can lerp the camera for feel)
// ---------------------------------------------------------------------------

function render() {
  skier.scale.setScalar(CONFIG.skierScale);
  skier.position.set(state.x, state.y, state.z);
  // Face the heading. Dead = tipped over.
  skier.rotation.y = -state.heading;
  skier.rotation.z = state.dead ? 1.3 : THREE.MathUtils.lerp(skier.rotation.z, 0, 0.2);

  // Fixed-angle chase camera: above & behind, looking down the fall line.
  const camTargetX = THREE.MathUtils.damp(camera.position.x, state.x, CONFIG.camLagX, 1 / 60);
  camera.position.set(camTargetX, state.y + CONFIG.camHeight, state.z - CONFIG.camDistance);
  camera.lookAt(state.x, state.y + 1.5, state.z + CONFIG.camLookAhead);

  // Keep the ground & its scrolling texture centered on the skier.
  ground.position.set(state.x, 0, state.z);
  groundTex.offset.set(state.x / 10, -state.z / 10);

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const elDist = document.getElementById('distance');
const elSpeed = document.getElementById('speed');
const elStatus = document.getElementById('status');

function updateHud() {
  elDist.textContent = `${Math.floor(state.distance)} m`;
  elSpeed.textContent = `${state.speed.toFixed(1)} m/s`;
  elStatus.textContent = state.dead ? '💥 wipeout' : state.airborne ? '🪂 air' : '';
}

// ---------------------------------------------------------------------------
// Death & replay
// ---------------------------------------------------------------------------

const overlay = document.getElementById('gameover');
const elFinal = document.getElementById('final');

function die() {
  if (state.dead) return;
  state.dead = true;
  elFinal.textContent = `${Math.floor(state.distance)} m`;
  overlay.classList.add('show');
}

function resetGame() {
  Object.assign(state, {
    x: 0, z: 0, y: 0, vy: 0, heading: 0, speed: 0,
    airborne: false, dead: false, distance: 0,
  });
  for (const o of obstacles) scene.remove(o);
  obstacles.length = 0;
  lastSpawnZ = 0;
  spawnAhead(state.z + 200);
  camera.position.set(0, CONFIG.camHeight, -CONFIG.camDistance);
  overlay.classList.remove('show');
}

document.getElementById('replay').addEventListener('click', resetGame);
addEventListener('keydown', (e) => {
  if (state.dead && (e.code === 'Enter' || e.code === 'KeyR')) resetGame();
});

// ---------------------------------------------------------------------------
// GUI — live tuning of feel
// ---------------------------------------------------------------------------

const gui = new GUI({ title: 'feel' });
const fMotion = gui.addFolder('motion');
fMotion.add(CONFIG, 'maxSpeed', 5, 80, 1);
fMotion.add(CONFIG, 'accel', 5, 80, 1);
fMotion.add(CONFIG, 'friction', 5, 100, 1);
fMotion.add(CONFIG, 'steerRate', 0.5, 6, 0.1);
fMotion.add(CONFIG, 'maxHeading', 0.4, 1.55, 0.01);
fMotion.add(CONFIG, 'brakeStrength', 10, 120, 1);
fMotion.add(CONFIG, 'touchSensitivity', 30, 200, 5).name('touch sens (px)');

const fAir = gui.addFolder('air');
fAir.add(CONFIG, 'gravity', 20, 120, 1);
fAir.add(CONFIG, 'jumpImpulse', 5, 40, 1);
fAir.add(CONFIG, 'rampImpulse', 5, 50, 1);
fAir.add(CONFIG, 'airControl', 0, 1, 0.05);

const fCam = gui.addFolder('camera');
fCam.add(CONFIG, 'camHeight', 4, 40, 1);
fCam.add(CONFIG, 'camDistance', 4, 40, 1);
fCam.add(CONFIG, 'camLookAhead', 0, 40, 1);
fCam.add(CONFIG, 'camLagX', 1, 20, 0.5);

const fWorld = gui.addFolder('world');
fWorld.add(CONFIG, 'spawnDensity', 0.1, 2, 0.05);
fWorld.add(CONFIG, 'corridorWidth', 20, 140, 1);
fWorld.add(CONFIG, 'treeScale', 0.4, 2.5, 0.1);
fWorld.add(CONFIG, 'skierScale', 0.4, 2.5, 0.1);
fWorld.close();

// Restore every tunable to its built-in default, then refresh the sliders.
gui.add({
  restoreDefaults() {
    Object.assign(CONFIG, DEFAULTS);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    saveFeel();
  },
}, 'restoreDefaults').name('↺ restore defaults');

// Persist tuning across refreshes — fires whenever any slider changes.
gui.onChange(saveFeel);

// Start collapsed — on mobile an open panel covers the screen. Tap the
// "feel" title bar to expand it.
gui.close();

// ---------------------------------------------------------------------------
// Loop & resize
// ---------------------------------------------------------------------------

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  render();
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
