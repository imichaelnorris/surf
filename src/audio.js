// ---------------------------------------------------------------------------
// Sound — all effects are synthesized with the Web Audio API; there are no
// audio files to load, matching the rest of the game (everything procedural).
//
// The graph is built lazily on the first user gesture because browsers keep
// an AudioContext suspended until then. Two persistent looping voices model
// the *continuous* sounds (skis carving the snow + wind rush) and have their
// gains/filters ramped each frame from the skier's speed. Everything else is
// a short-lived one-shot created on demand and discarded when it finishes.
// ---------------------------------------------------------------------------

let ctx = null;
let master = null;
let noiseBuf = null;

// Persistent skiing voices whose params we steer with speed.
let carveGain = null, carveFilter = null;  // hiss of skis on snow
let windGain = null,  windFilter = null;   // low rush that swells with speed
let loopsStarted = false;
let running = false; // true between startRun() and death / menu
let muted = false;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Build (once) the context, master bus and shared noise buffer.
function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.9;
  // A gentle limiter so layered impacts (crack + thud + tumble) don't clip.
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);

  const len = Math.floor(ctx.sampleRate * 2);
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

function noise(loop = false) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = loop;
  return s;
}

// A pitched blip: from f0→f1 over dur, with a quick attack and exp decay.
function tone(type, f0, f1, amp, dur, t0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(amp, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

// A filtered noise burst — the workhorse for whooshes, cracks and tumbles.
function burst({ filter = 'lowpass', f0, f1 = f0, Q = 0.8, amp, attack = 0.005, dur }, t0) {
  const src = noise();
  const flt = ctx.createBiquadFilter();
  flt.type = filter;
  flt.Q.value = Q;
  flt.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(amp, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(flt).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// Bring up the two continuous voices (idempotent). Started silent; gains are
// driven by updateMotion.
function startLoops() {
  if (loopsStarted || !ctx) return;
  loopsStarted = true;

  carveFilter = ctx.createBiquadFilter();
  carveFilter.type = 'bandpass';
  carveFilter.frequency.value = 800;
  carveFilter.Q.value = 0.7;
  carveGain = ctx.createGain();
  carveGain.gain.value = 0;
  const cn = noise(true);
  cn.connect(carveFilter).connect(carveGain).connect(master);
  cn.start();

  windFilter = ctx.createBiquadFilter();
  windFilter.type = 'lowpass';
  windFilter.frequency.value = 500;
  windGain = ctx.createGain();
  windGain.gain.value = 0;
  const wn = noise(true);
  wn.connect(windFilter).connect(windGain).connect(master);
  wn.start();
}

// --- public API ------------------------------------------------------------

// Unlock audio from a user gesture (Play, a key, a tap).
export function resume() {
  if (!ensureCtx()) return;
  if (ctx.state === 'suspended') ctx.resume();
}

// Start/stop the continuous skiing voices.
export function setRunning(on) {
  if (!ensureCtx()) return;
  startLoops();
  running = on;
  if (!on) {
    const t = ctx.currentTime;
    carveGain.gain.setTargetAtTime(0, t, 0.1);
    windGain.gain.setTargetAtTime(0, t, 0.1);
  }
}

// Per-frame: shape the carve hiss + wind rush from current speed. The carve
// fades out in the air (skis off the snow); wind swells with speed² and gets
// a little boost while airborne.
export function updateMotion(speed, maxSpeed, airborne) {
  if (!ctx || !running) return;
  const t = ctx.currentTime;
  const f = clamp01(speed / Math.max(1, maxSpeed));
  carveGain.gain.setTargetAtTime(airborne ? 0 : 0.03 + 0.17 * f, t, 0.08);
  windGain.gain.setTargetAtTime((airborne ? 0.05 : 0) + 0.13 * f * f, t, 0.12);
  carveFilter.frequency.setTargetAtTime(600 + 1900 * f, t, 0.1);
  windFilter.frequency.setTargetAtTime(280 + 760 * f, t, 0.1);
}

// Soft snow "whump" on touchdown; intensity (0..1) scales with impact speed.
export function land(intensity = 1) {
  if (!ensureCtx() || muted) return;
  const t = ctx.currentTime;
  const amp = 0.18 + 0.32 * clamp01(intensity);
  burst({ filter: 'lowpass', f0: 1400, f1: 300, amp, attack: 0.01, dur: 0.28 }, t);
  tone('sine', 90, 60, amp * 0.6, 0.18, t); // low body thump
}

// Quick upward whoosh when you pop off the snow (Space / tap).
export function jump() {
  if (!ensureCtx() || muted) return;
  burst({ filter: 'bandpass', f0: 500, f1: 1600, Q: 1.2, amp: 0.12, attack: 0.02, dur: 0.22 }, ctx.currentTime);
}

// Bigger launch off a ramp: whoosh + a rising tone.
export function ramp() {
  if (!ensureCtx() || muted) return;
  const t = ctx.currentTime;
  burst({ filter: 'bandpass', f0: 400, f1: 2200, Q: 0.9, amp: 0.2, attack: 0.03, dur: 0.34 }, t);
  tone('triangle', 240, 720, 0.16, 0.32, t);
}

// Woody thud + bark crack.
export function hitTree() {
  if (!ensureCtx() || muted) return;
  const t = ctx.currentTime;
  tone('triangle', 150, 70, 0.3, 0.2, t);
  tone('sine', 90, 55, 0.25, 0.22, t);
  burst({ filter: 'bandpass', f0: 1800, Q: 0.8, amp: 0.25, attack: 0.001, dur: 0.08 }, t);
}

// Hard, bright contact + a stony ring.
export function hitRock() {
  if (!ensureCtx() || muted) return;
  const t = ctx.currentTime;
  burst({ filter: 'highpass', f0: 1500, amp: 0.35, attack: 0.001, dur: 0.05 }, t);
  tone('square', 320, 180, 0.14, 0.12, t);
  tone('square', 470, 240, 0.1, 0.1, t);
}

// Wipeout: cut the skiing voices, then a descending "wah" + snow tumble.
export function die() {
  if (!ensureCtx()) return;
  setRunning(false);
  if (muted) return;
  const t = ctx.currentTime;
  tone('sawtooth', 420, 60, 0.22, 0.6, t);
  burst({ filter: 'lowpass', f0: 1600, f1: 200, amp: 0.2, attack: 0.005, dur: 0.5 }, t);
}

// Toggle mute; returns the new state.
export function toggleMute() {
  if (!ensureCtx()) { muted = !muted; return muted; }
  muted = !muted;
  master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
  return muted;
}
