// Open Dock pet: an animated desk companion with a life of its own. Edit here, then run `node scripts/sync-pet.ts`
// to refresh the phone copy (phone-app/src/pet-source.ts). Plain browser JavaScript with no imports: the desktop
// imports it and the phone runs it inside the widget WebView, like the clock faces and PC stats.
// It defines globalThis.OpenDockPet = { faces, defaultColor, mount(host, options), setPaused(paused) }.
// mount returns { destroy(), touch(kind, x, y), step(now, dt) } (kind: down, move, up, cancel; x, y in the widget's
// own px; step advances the pet by hand, for scripts/check-pet.ts).
//
// Touch: tap startles it (then it giggles, or grumbles when it is in a bad mood), a double tap makes it dance, four
// taps in a steady beat make it groove, holding it makes it purr (long enough and it falls in love), slow strokes pet
// it, a drag makes its eyes follow, a fast swipe whips them across, circling a finger makes it spin, tapping an eye
// pokes it (a few pokes make it cry), tapping a screen edge makes it shy, and too many taps make it dizzy, then angry.
// Tap corners clockwise for a party, or in a zigzag to make it sing. Three quick taps open the game menu:
// rock paper scissors, bang (it plays dead), chase the dot, peek-a-boo and a staring contest.
// On its own it blinks, glances, winks, hops, yawns, stretches, thinks, rolls its eyes, chases dots, glitches, gets sad
// when ignored and dozes off. It greets you after a long time away, chimes on the hour, stretches awake in the
// morning, wears a nightcap at night and a hat on a few days of the year.
// How it feels (joy, energy) carries from one touch to the next and across every pet on the page.
(function () {
'use strict';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FACES = [
  { id: 'buddy', name: 'Buddy', blurb: 'Two bright eyes on a little screen.', eyes: 2 },
  { id: 'cyclops', name: 'Cyclops', blurb: 'One big round robot eye.', eyes: 1 },
  { id: 'pixel', name: 'Pixel', blurb: 'Square retro eyes that move in steps.', eyes: 2, pixel: true },
  { id: 'cat', name: 'Cat', blurb: 'Round eyes with slit pupils.', eyes: 2, cat: true },
];
const DEFAULT_COLOR = '#2dd4bf';
const SCREEN = '#0b0d12';
const POOL = 12;
// Outfits, in the same order as PET_OUTFITS in lib.rs (scripts/check-pet.ts keeps them in sync).
const OUTFITS = ['auto', 'none', 'glasses', 'mustache', 'crown', 'tophat', 'bowtie'];
// Mood ring colours: low spirits, anger, tiredness, love.
const MOODS = { blue: '#60a5fa', red: '#f87171', purple: '#a78bfa', pink: '#f472b6' };
const SFX = {
  startle: [[900, 0.06], [1400, 0.08]], giggle: [[700, 0.07], [900, 0.07], [1100, 0.09]], grumpy: [[220, 0.12], [180, 0.16]],
  dance: [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.14]], love: [[784, 0.1], [988, 0.1], [1175, 0.18]], poke: [[1300, 0.05]],
  cry: [[400, 0.15], [330, 0.2], [260, 0.25]], excited: [[660, 0.07], [880, 0.07], [1320, 0.12]], yawn: [[300, 0.25], [220, 0.3]],
  chime: [[1047, 0.25], [1319, 0.35]], morning: [[392, 0.12], [523, 0.12], [659, 0.18]], shy: [[1000, 0.05], [1200, 0.05]],
  party: [[523, 0.1], [659, 0.1], [784, 0.1], [659, 0.1], [784, 0.1], [1047, 0.2]], sad: [[330, 0.2], [262, 0.3]],
  sing: [[523, 0.18], [587, 0.18], [659, 0.18], [523, 0.18], [659, 0.18], [698, 0.3]], dizzy: [[500, 0.08], [420, 0.08], [500, 0.08], [420, 0.08]],
  angry: [[160, 0.2], [140, 0.25]], fling: [[1500, 0.05]], spin: [[600, 0.05], [900, 0.05], [1200, 0.05]], wink: [[1000, 0.05]], bang: [[140, 0.2], [70, 0.25]],
};

// --- One shared life -------------------------------------------------------------------------
// One frame loop (about 22 fps) for every pet on the page, and one mood shared by all of them.
// ponytail: the mood lives in the page, so it resets when the phone frees the widget page; persist it if that matters.
const pets = new Set();
const PET = { joy: 0.55, energy: 0.9, touchAt: performance.now() };
// What the host tells it about the world (setWorld): music playing on the PC, and the game in front on the PC.
// The phone's senses too: battery 0 to 1, charging, tilt to the right (-1 to 1), time of the last shake, face down, room light in lux, how it is held.
const WORLD = { music: false, game: null, battery: undefined, charging: false, tiltX: 0, shakeAt: 0, facedown: false, lux: undefined, orientation: undefined };
let raf = 0, last = 0, off = false;
function loop(now) {
  raf = 0;
  if (off) return;
  if (now - last >= 44) { const dt = Math.min(0.25, (now - last) / 1000); last = now; pets.forEach((pet) => pet.tick(now, dt)); }
  if (pets.size) raf = requestAnimationFrame(loop);
}
function start() {
  if (raf || off || !pets.size || typeof requestAnimationFrame !== 'function') return;
  // Reduced motion: the pet draws once and again on each touch, and does not run on its own.
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

// --- Drawing helpers (every number is finite, so no path contains NaN) -----------------------
const f1 = (v) => (Number.isFinite(v) ? v : 0).toFixed(1);
const rr = (x, y, a, b, r) => `M${f1(x + r)},${f1(y)}H${f1(x + a - r)}Q${f1(x + a)},${f1(y)} ${f1(x + a)},${f1(y + r)}V${f1(y + b - r)}Q${f1(x + a)},${f1(y + b)} ${f1(x + a - r)},${f1(y + b)}H${f1(x + r)}Q${f1(x)},${f1(y + b)} ${f1(x)},${f1(y + b - r)}V${f1(y + r)}Q${f1(x)},${f1(y)} ${f1(x + r)},${f1(y)}Z`;
const heart = (x, y, s) => `M${f1(x)},${f1(y + s * 0.45)}C${f1(x - s * 0.9)},${f1(y - s * 0.05)} ${f1(x - s * 0.45)},${f1(y - s * 0.6)} ${f1(x)},${f1(y - s * 0.2)}C${f1(x + s * 0.45)},${f1(y - s * 0.6)} ${f1(x + s * 0.9)},${f1(y - s * 0.05)} ${f1(x)},${f1(y + s * 0.45)}Z`;
const drop = (x, y, s) => `M${f1(x)},${f1(y - s)}C${f1(x + s * 0.9)},${f1(y + s * 0.3)} ${f1(x + s * 0.7)},${f1(y + s * 1.1)} ${f1(x)},${f1(y + s * 1.1)}C${f1(x - s * 0.7)},${f1(y + s * 1.1)} ${f1(x - s * 0.9)},${f1(y + s * 0.3)} ${f1(x)},${f1(y - s)}Z`;
const zed = (x, y, s) => `M${f1(x)},${f1(y)}H${f1(x + s)}L${f1(x)},${f1(y + s)}H${f1(x + s)}`;
const circ = (x, y, r) => `M${f1(x - r)},${f1(y)}a${f1(r)},${f1(r)} 0 1,0 ${f1(2 * r)},0a${f1(r)},${f1(r)} 0 1,0 ${f1(-2 * r)},0`;
const seg = (x1, y1, x2, y2) => `M${f1(x1)},${f1(y1)}L${f1(x2)},${f1(y2)}`;
const tri = (x1, y1, x2, y2, x3, y3) => `M${f1(x1)},${f1(y1)}L${f1(x2)},${f1(y2)}L${f1(x3)},${f1(y3)}Z`;
const star = (x, y, s) => `M${f1(x)},${f1(y - s)}Q${f1(x)},${f1(y)} ${f1(x + s)},${f1(y)}Q${f1(x)},${f1(y)} ${f1(x)},${f1(y + s)}Q${f1(x)},${f1(y)} ${f1(x - s)},${f1(y)}Q${f1(x)},${f1(y)} ${f1(x)},${f1(y - s)}Z`;
const spiral = (x, y, r) => { let d = ''; for (let i = 0; i <= 26; i++) { const t = i * 0.62, k = r * i / 26; d += `${i ? 'L' : 'M'}${f1(x + Math.cos(t) * k)},${f1(y + Math.sin(t) * k)}`; } return d; };
const note = (x, y, s) => `${circ(x - s * 0.5, y + s * 0.1, s * 0.45)}M${f1(x - s * 0.05)},${f1(y)}L${f1(x - s * 0.05)},${f1(y - s * 1.7)}q${f1(s * 0.9)},${f1(s * 0.3)} ${f1(s * 0.5)},${f1(s * 1.1)}`;
const sun = (x, y, r, turn) => { let d = circ(x, y, r); for (let i = 0; i < 8; i++) { const t = turn + i * Math.PI / 4; d += seg(x + Math.cos(t) * r * 1.4, y + Math.sin(t) * r * 1.4, x + Math.cos(t) * r * 2, y + Math.sin(t) * r * 2); } return d; };
const cloud = (x, y, r) => `${circ(x - r * 1.1, y, r * 0.8)}${circ(x, y - r * 0.35, r)}${circ(x + r * 1.1, y, r * 0.8)}`;
const icon = (kind, x, y, s) => kind === 0 ? heart(x, y, s * 1.2) : kind === 1 ? star(x, y, s) : kind === 2 ? note(x + s * 0.2, y + s * 0.5, s * 0.6) : sun(x, y, s * 0.4, 0);

function eye(node, shape, x, y, a, b, side, face) {
  if (!shape) { node.setAttribute('opacity', '0'); return; }
  node.setAttribute('opacity', '1');
  let d, filled = true, width = 1.5;
  if (shape === 'round') { b = Math.max(2, b); d = rr(x - a / 2, y - b / 2, a, b, face.pixel ? 0 : Math.min(a, b) * 0.4); }
  else if (shape === 'happy') { d = `M${f1(x - a * 0.5)},${f1(y + b * 0.18)}Q${f1(x)},${f1(y - b * 0.5)} ${f1(x + a * 0.5)},${f1(y + b * 0.18)}`; filled = false; width = a * 0.26; }
  else if (shape === 'x') { const q = Math.min(a, b) * 0.38; d = `M${f1(x - q)},${f1(y - q)}L${f1(x + q)},${f1(y + q)}M${f1(x + q)},${f1(y - q)}L${f1(x - q)},${f1(y + q)}`; filled = false; width = a * 0.24; }
  else if (shape === 'angry') { const t = b * 0.4, i = side * a / 2, o = -side * a / 2; d = `M${f1(x + o)},${f1(y - b / 2)}L${f1(x + i)},${f1(y - b / 2 + t)}L${f1(x + i)},${f1(y + b / 2)}L${f1(x + o)},${f1(y + b / 2)}Z`; }
  else if (shape === 'heart') d = heart(x, y - Math.min(a, b) * 0.05, Math.min(a, b) * 0.72);
  else if (shape === 'star') d = star(x, y, Math.min(a, b) * 0.62);
  else if (shape === 'spiral') { d = spiral(x, y, Math.min(a, b) * 0.5); filled = false; width = Math.max(1.5, a * 0.09); }
  else { d = `M${f1(x - a * 0.45)},${f1(y)}L${f1(x + a * 0.45)},${f1(y)}`; filled = false; width = Math.max(2, b * 0.12); }
  node.setAttribute('d', d); node.style.fill = filled ? 'var(--pet)' : 'none'; node.setAttribute('stroke-width', f1(width));
}

// What each timed action does when its time is up (anything else goes back to idle).
const ENDS = {
  startle: (T) => (PET.joy > 0.3 + (T.grumpy - 1) * 0.25 ? ['giggle', 1100] : ['grumpy', 1100]),
  yawn: () => (PET.energy < 0.45 ? ['sleep', 0] : null),
  spin: () => ['dizzy', 1800],
  fling: () => ['curious', 500],
  morning: () => ['giggle', 800],
  charge: () => (WORLD.battery >= 0.99 ? ['giggle', 900] : null),
  party: () => ['giggle', 900],
  sing: () => ['giggle', 900],
  love: () => ['giggle', 500],
};
const GAMES = ['rps', 'bang', 'chase', 'peek', 'stare'];

function mount(host, { face, color, width, height, opacity = 100, pet: options }) {
  const opt = options && typeof options === 'object' ? options : {};
  const info = FACES.find((item) => item.id === face) || FACES[0];
  const root = document.createElement('div');
  root.style.cssText = `position:relative;overflow:hidden;width:${width}px;height:${height}px;--pet:${/^#[0-9a-fA-F]{6}$/.test(color || '') ? color : DEFAULT_COLOR}`;
  host.replaceChildren(root);

  const p = clamp(Math.min(width, height) * 0.06, 3, 12);
  const sw = Math.max(8, width - 2 * p), sh = Math.max(8, height - 2 * p);
  const one = info.eyes === 1;
  const ew = one ? clamp(Math.min(sw * 0.36, sh * 0.5), 6, 160) : clamp(sw * 0.2, 4, 120), eh = one ? ew : clamp(sh * 0.4, 6, 160), eg = sw * 0.16;
  const cx = p + sw / 2, cy = p + sh / 2, offset = one ? 0 : (ew + eg) / 2;
  const lw = clamp(sh * 0.025, 1.2, 3.5);
  const ink = 'style="fill:var(--pet);stroke:var(--pet);stroke-linecap:round;stroke-linejoin:round"';
  const eyePath = `<path class="pe" ${ink}/>`;
  const fxPaths = `<path class="pf" ${ink} opacity="0"/>`.repeat(POOL);
  root.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="position:absolute;inset:0;overflow:visible"><rect x="${f1(p)}" y="${f1(p)}" width="${f1(sw)}" height="${f1(sh)}" rx="${f1(Math.min(sw, sh) * 0.16)}" fill="${SCREEN}" fill-opacity="${f1(clamp(opacity, 0, 100) / 100)}" stroke="#24252b" stroke-opacity="${f1(clamp(opacity, 0, 100) / 100)}"/><g class="pg">${one ? eyePath : eyePath + eyePath}</g>${fxPaths}</svg>`;
  const eyes = [...root.querySelectorAll('.pe')], fx = [...root.querySelectorAll('.pf')], group = root.querySelectorAll('.pg')[0];

  // Personality sliders (0 to 10, 5 is the default) become multipliers around 1.
  const trait = (name) => 0.4 + 0.12 * (Number.isInteger(opt[name]) ? clamp(opt[name], 0, 10) : 5);
  const T = { sleepy: trait('sleepy'), hyper: trait('hyper'), shy: trait('shy'), grumpy: trait('grumpy') };
  const outfit = OUTFITS.includes(opt.outfit) ? opt.outfit : 'auto';
  const quiet = (hour) => Number.isInteger(opt.quietFrom) && Number.isInteger(opt.quietTo) && opt.quietFrom !== opt.quietTo && (opt.quietFrom < opt.quietTo ? hour >= opt.quietFrom && hour < opt.quietTo : hour >= opt.quietFrom || hour < opt.quietTo);
  const baseColor = /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : DEFAULT_COLOR;
  let audio = null;
  const sfx = (name) => {
    if (!opt.sound || quiet(new Date().getHours()) || !SFX[name]) return;
    try {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) return;
      audio = audio || new Context();
      if (audio.state === 'suspended') audio.resume();
      let at = audio.currentTime;
      for (const [hz, length] of SFX[name]) {
        const osc = audio.createOscillator(), gain = audio.createGain();
        osc.type = 'square'; osc.frequency.value = hz;
        gain.gain.setValueAtTime(0.04, at); gain.gain.exponentialRampToValueAtTime(0.001, at + length);
        osc.connect(gain); gain.connect(audio.destination); osc.start(at); osc.stop(at + length + 0.02);
        at += length * 0.9;
      }
    } catch (error) { /* no sound is fine */ }
  };
  const S = {
    act: 'idle', t: 0, d: 0, gx: 0, gy: 0, tgx: 0, tgy: 0, next: 0, blinkAt: 0, blinking: -1e9, down: null, lastTap: -1e9,
    pokes: 0, pokeAt: -1e9, taps: [], eyePokes: [], flings: [], corners: [], cornerAt: -1e9, groove: null, purrAt: 0,
    eye: { x: cx, y: cy, a: ew, b: eh }, px: cx, py: cy, game: null, thinkIcon: 0, flingDir: 1, dot: { x: cx, y: cy }, dotAt: 0,
    chimeKey: '', morningKey: '', shyDir: 1, shakes: [], worldSleep: false,
    pv: { shakeAt: WORLD.shakeAt, charging: WORLD.charging, orientation: WORLD.orientation, facedown: WORLD.facedown },
  };
  const setAct = (name, duration, now) => { if (S.act !== name) sfx(name); S.act = name; S.t = now; S.d = duration; if (name === 'purr') S.purrAt = now; };
  const quantize = info.pixel ? (v, step) => Math.round(v / step) * step : (v) => v;
  const step = Math.max(1, sw / 26);

  // --- Games -------------------------------------------------------------------------------
  const cell = (i) => { const cw = sw / 3, ch = sh / 2; return { x: p + (i % 3) * cw, y: p + Math.floor(i / 3) * ch, w: cw, h: ch }; };
  const scissors = (x, y, s) => ({ line: seg(x - s * 0.7, y - s * 0.8, x, y + s * 0.3) + seg(x + s * 0.7, y - s * 0.8, x, y + s * 0.3), solid: circ(x - s * 0.35, y + s * 0.75, s * 0.28) + circ(x + s * 0.35, y + s * 0.75, s * 0.28) });
  const hand = (kind, x, y, s) => kind === 0 ? { line: '', solid: circ(x, y, s * 0.7) }
    : kind === 1 ? { line: rr(x - s * 0.65, y - s * 0.8, s * 1.3, s * 1.6, s * 0.2) + seg(x - s * 0.25, y - s * 0.3, x + s * 0.25, y - s * 0.3) + seg(x - s * 0.25, y + s * 0.1, x + s * 0.25, y + s * 0.1), solid: '' }
      : scissors(x, y, s);
  const menuGlyph = [
    (x, y, s) => scissors(x, y, s),
    (x, y, s) => ({ line: circ(x, y, s * 0.8) + seg(x - s * 1.2, y, x - s * 0.4, y) + seg(x + s * 0.4, y, x + s * 1.2, y) + seg(x, y - s * 1.2, x, y - s * 0.4) + seg(x, y + s * 0.4, x, y + s * 1.2), solid: circ(x, y, s * 0.12) }),
    (x, y, s) => ({ line: circ(x, y, s * 0.85), solid: circ(x + s * 0.35, y - s * 0.2, s * 0.3) }),
    (x, y, s) => ({ line: `M${f1(x - s)},${f1(y + s * 0.3)}Q${f1(x)},${f1(y - s * 0.9)} ${f1(x + s)},${f1(y + s * 0.3)}${seg(x - s, y + s * 0.3, x + s, y + s * 0.3)}`, solid: circ(x, y + s * 0.05, s * 0.28) }),
    (x, y, s) => ({ line: '', solid: circ(x - s * 0.55, y, s * 0.4) + circ(x + s * 0.55, y, s * 0.4) }),
    (x, y, s) => ({ line: seg(x - s * 0.6, y - s * 0.6, x + s * 0.6, y + s * 0.6) + seg(x + s * 0.6, y - s * 0.6, x - s * 0.6, y + s * 0.6), solid: '' }),
  ];
  const glyphs = (E, parts, o = 1) => {
    const line = parts.map((g) => g.line).join(''), solid = parts.map((g) => g.solid).join('');
    if (line) E.out.push([line, o, false, lw]);
    if (solid) E.out.push([solid, o, true, lw]);
  };
  const startGame = (id, now) => { S.game = { id, t0: now, ph: 'a', t: now, n: 0, miss: 0, ax: cx, ay: cy, mine: 0, theirs: 0, dur: 0, still: 0, pounce: -1e9, pd: { x: cx, y: cy }, twitch: -1e9 }; S.act = 'idle'; S.d = 0; };
  const endGame = (now, act, dur) => { S.game = null; setAct(act || 'idle', dur || 0, now); };
  const phase = (g, ph, now) => { g.ph = ph; g.t = now; };
  const beats = (a, b) => (a - b + 3) % 3 === 1;

  // Runs one frame of the running game: sets what to draw in E and moves the game along.
  const gameStep = (g, now, dt, E) => {
    const age = now - g.t, down = S.down;
    if (g.id === 'menu') {
      E.hide = true;
      const parts = [];
      let outline = '';
      for (let i = 0; i < 6; i++) { const c = cell(i), m = Math.min(c.w, c.h) * 0.08; outline += rr(c.x + m, c.y + m, c.w - 2 * m, c.h - 2 * m, Math.min(c.w, c.h) * 0.14); parts.push(menuGlyph[i](c.x + c.w / 2, c.y + c.h / 2, Math.min(c.w, c.h) * 0.2)); }
      E.out.push([outline, 0.3, false, lw]);
      glyphs(E, parts);
      if (now - g.t0 > 7000) endGame(now, 'curious', 700);
    } else if (g.id === 'rps') {
      E.scale = 0.55; E.dy = -sh * 0.2; E.gaze = [0, 0.7];
      const s = Math.min(sw / 3, sh * 0.34) * 0.3, by = p + sh * 0.8;
      if (g.ph === 'a') {
        glyphs(E, [0, 1, 2].map((k) => hand(k, p + sw * (k + 0.5) / 3, by, s)));
        if (now - g.t0 > 9000) endGame(now, 'curious', 700);
      } else if (g.ph === 'shake') {
        const q = Math.sin(age / 233 * Math.PI);
        glyphs(E, [hand(0, cx, cy + sh * 0.12 + q * sh * 0.1, s * 1.7)]);
        glyphs(E, [hand(g.mine, p + sw * (g.mine + 0.5) / 3, by, s)], 0.5);
        if (age > 1400) phase(g, 'reveal', now);
      } else {
        glyphs(E, [hand(g.mine, cx - sw * 0.22, cy + sh * 0.14, s * 1.7), hand(g.theirs, cx + sw * 0.22, cy + sh * 0.14, s * 1.7)]);
        E.out.push([seg(cx - sw * 0.02, cy + sh * 0.14, cx + sw * 0.02, cy + sh * 0.14), 0.6, false, lw]);
        if (beats(g.theirs, g.mine)) { E.shapes = E.shapes.map(() => 'happy'); E.bob = -Math.abs(Math.sin(age / 90)) * sh * 0.03; }
        else if (beats(g.mine, g.theirs)) { E.shapes = E.shapes.map(() => 'x'); E.sway = Math.sin(age / 90) * sw * 0.02; }
        else if (one) E.open = 0.12; else E.shapes = ['round', 'happy'];
        if (age > 2400) {
          if (beats(g.theirs, g.mine)) { PET.joy = Math.min(1, PET.joy + 0.12); endGame(now, 'giggle', 1100); }
          else if (beats(g.mine, g.theirs)) { PET.joy = Math.max(0, PET.joy - 0.05); endGame(now, 'grumpy', 1100); }
          else endGame(now, 'wink', 800);
        }
      }
    } else if (g.id === 'bang') {
      const flash = (t) => { if (t < 170) E.out.push([rr(p, p, sw, sh, 0), 1 - t / 170, true, 1, '#ffffff']); };
      if (g.ph === 'a') {
        E.open = 1.15; E.wide = 1.1; E.gaze = [clamp((g.ax - cx) / (sw / 2), -1, 1), clamp((g.ay - cy) / (sh / 2), -1, 1)];
        const r = Math.min(sw, sh) * 0.1;
        E.out.push([circ(g.ax, g.ay, r) + seg(g.ax - r * 1.5, g.ay, g.ax - r * 0.5, g.ay) + seg(g.ax + r * 0.5, g.ay, g.ax + r * 1.5, g.ay) + seg(g.ax, g.ay - r * 1.5, g.ax, g.ay - r * 0.5) + seg(g.ax, g.ay + r * 0.5, g.ax, g.ay + r * 1.5), 0.9, false, lw]);
        if (age > 3000) E.out.push([drop(p + sw * 0.84, p + sh * 0.25, sh * 0.06), 0.9, true]);
        if (now - g.t0 > 9000) endGame(now, 'curious', 700);
      } else if (g.ph === 'dead') {
        const k = clamp(age / 380, 0, 1), ov = 1 + Math.sin(k * Math.PI) * 0.18;
        E.tilt = -85 * k * ov; E.dy = sh * 0.14 * k; E.shapes = E.shapes.map((_, i) => (now - g.twitch < 220 && i === 0 ? 'round' : 'x')); flash(age);
        if (now - g.twitch < 220) E.open = 0.7;
        if (age > 3600) phase(g, 'revive', now);
      } else if (g.ph === 'revive') {
        const k = clamp(age / 800, 0, 1);
        E.tilt = -85 * (1 - k); E.dy = sh * 0.14 * (1 - k); E.open = 1.2; E.wide = 0.9;
        if (age > 800) { PET.joy = Math.min(1, PET.joy + 0.08); endGame(now, 'giggle', 1200); }
      } else {
        E.tilt = 22 * Math.sin(clamp(age / 500, 0, 1) * Math.PI); E.sway = -sw * 0.08 * Math.sin(clamp(age / 500, 0, 1) * Math.PI); E.open = 1.3; flash(age);
        E.out.push([drop(p + sw * 0.84, p + sh * 0.25 + (age / 900) * sh * 0.2, sh * 0.06), 0.9, true]);
        if (age > 900) { PET.joy = Math.min(1, PET.joy + 0.1); endGame(now, 'wink', 900); }
      }
    } else if (g.id === 'chase') {
      const total = now - g.t0;
      const tx = down ? S.px : cx + Math.sin(now / 700) * sw * 0.3, ty = down ? S.py : cy + Math.sin(now / 530) * sh * 0.25;
      const px = S.dot.x, py = S.dot.y, k = 1 - Math.exp(-dt * (down ? 14 : 5));
      S.dot.x += (tx - px) * k; S.dot.y += (ty - py) * k;
      const speed = Math.hypot(S.dot.x - px, S.dot.y - py) / Math.max(dt, 0.001);
      g.still = down && speed < 40 ? g.still + dt : 0;
      if (g.still > 0.45 && now - g.pounce > 1500) { g.pounce = now; g.n++; g.still = 0; PET.joy = Math.min(1, PET.joy + 0.05); }
      E.gaze = [clamp((S.dot.x - cx) / (sw / 2), -1, 1), clamp((S.dot.y - cy) / (sh / 2), -1, 1)];
      const pa = now - g.pounce;
      if (pa < 550) { E.bob = -Math.abs(Math.sin(pa / 550 * Math.PI)) * sh * 0.12; E.open = 1.25; E.wide = 1.15; E.out.push([star(S.dot.x, S.dot.y, sh * (0.05 + pa / 550 * 0.1)), 1 - pa / 550, true]); }
      const r = Math.max(3, sh * 0.04);
      E.out.push([circ(S.dot.x, S.dot.y, r), 1, true, lw]);
      let pips = ''; for (let i = 0; i < g.n; i++) pips += circ(p + sw * 0.08 + i * sw * 0.05, p + sh * 0.1, Math.max(1.5, sh * 0.018));
      if (pips) E.out.push([pips, 0.8, true, 1]);
      if (g.n >= 5 || total > 16000) { endGame(now, g.n >= 3 ? 'dance' : 'giggle', g.n >= 3 ? 1800 : 900); }
    } else if (g.id === 'peek') {
      if (g.ph === 'a') { E.hide = true; if (age > g.dur) phase(g, 'peek', now); }
      else if (g.ph === 'peek') {
        E.dy = sh * 0.3; E.open = 0.55; E.gaze = [0, 0.3];
        if (age > 950) { g.miss++; if (g.miss >= 3) { endGame(now, 'startle', 550); return; } phase(g, 'a', now); g.dur = 1200 + Math.random() * 2000; }
      } else {
        E.shapes = E.shapes.map(() => 'happy'); E.bob = -Math.abs(Math.sin(age / 100)) * sh * 0.04;
        E.out.push([heart(cx - sw * 0.2, p + sh * 0.25 - age / 1000 * sh * 0.1, sh * 0.09) + heart(cx + sw * 0.2, p + sh * 0.25 - age / 1000 * sh * 0.1, sh * 0.09), clamp(1 - age / 1100, 0, 1), true]);
        if (age > 1100) { if (g.n >= 3) endGame(now, 'dance', 1800); else { phase(g, 'a', now); g.dur = 1200 + Math.random() * 2000; } }
      }
      if (now - g.t0 > 22000 && g.ph !== 'found') endGame(now, 'startle', 550);
    } else if (g.id === 'stare') {
      E.noBlink = true; E.gaze = [0, 0]; E.open = 1.15; E.wide = 1.12;
      if (g.ph === 'a') { if (now - g.t0 > 9000) endGame(now, 'curious', 700); }
      else if (g.ph === 'hold') {
        const k = clamp(age / g.dur, 0, 1);
        E.shake = Math.sin(now / 45) * sw * 0.008 * k;
        if (k > 0.35) E.out.push([drop(p + sw * 0.84, p + sh * (0.2 + 0.2 * k), sh * 0.06 * (0.5 + k)), 0.9, true]);
        if (!down) { PET.joy = Math.min(1, PET.joy + 0.1); endGame(now, 'giggle', 1400); }
        else if (age > g.dur) phase(g, 'blink', now);
      } else {
        E.shapes = E.shapes.map(() => 'sleep'); E.open = 0.1; E.noBlink = false;
        if (age > 900) { PET.joy = Math.max(0, PET.joy - 0.05); endGame(now, 'grumpy', 1400); }
      }
    }
  };

  const gameTouch = (kind, x, y, now, down) => {
    const g = S.game;
    if (g.id === 'menu') {
      if (kind === 'down' && now - g.t0 > 300) {
        const i = [0, 1, 2, 3, 4, 5].find((n) => { const c = cell(n); return x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h; });
        if (i === 5 || i === undefined) endGame(now, 'curious', 600); else { startGame(GAMES[i], now); if (GAMES[i] === 'peek') S.game.dur = 1500; if (GAMES[i] === 'chase') S.dot = { x: cx, y: cy }; }
      }
    } else if (g.id === 'rps') {
      if (kind === 'down' && g.ph === 'a' && y > p + sh * 0.55) { g.mine = clamp(Math.floor((x - p) / (sw / 3)), 0, 2); g.theirs = Math.floor(Math.random() * 3); phase(g, 'shake', now); }
    } else if (g.id === 'bang') {
      if (g.ph === 'a') {
        if (kind === 'down' || kind === 'move') { g.ax = x; g.ay = y; }
        else if (kind === 'up') { g.ax = x; g.ay = y; sfx('bang'); phase(g, Math.random() < 0.3 ? 'dodge' : 'dead', now); }
      } else if (g.ph === 'dead' && kind === 'down') g.twitch = now;
    } else if (g.id === 'peek') {
      if (kind === 'down' && g.ph === 'peek') { g.n++; phase(g, 'found', now); }
    } else if (g.id === 'stare') {
      if (kind === 'down' && g.ph === 'a') { phase(g, 'hold', now); g.dur = 3500 + Math.random() * 4500; }
    }
  };

  // --- One frame ---------------------------------------------------------------------------
  const frame = (now, dt) => {
    const D = new Date(), hour = D.getHours(), night = hour < 6 || hour >= 23;
    const E = { shapes: one ? ['round'] : ['round', 'round'], open: PET.joy < 0.25 ? 0.62 : 1, wide: 1, tall: 1, bob: 0, sway: 0, shake: 0, tilt: 0, dy: 0, scale: 1, dim: night ? 0.8 : 1, hide: false, noBlink: false, gaze: null, out: [] };
    const all = (shape) => E.shapes.map(() => shape);
    const idleFor = now - PET.touchAt;
    const g = S.game;
    const hushed = quiet(hour);
    // The phone's own senses: a shake, being plugged in, turned on its side or put face down, the room going dark.
    const W = WORLD, pv = S.pv;
    if (!g && !hushed) {
      if (W.shakeAt !== pv.shakeAt) {
        pv.shakeAt = W.shakeAt;
        if (W.shakeAt) { S.shakes = S.shakes.filter((t) => now - t < 5000); S.shakes.push(now); PET.touchAt = now; PET.joy = Math.max(0, PET.joy - 0.05); setAct(S.shakes.length >= 3 ? 'angry' : 'dizzy', S.shakes.length >= 3 ? 2200 : 2000, now); }
      }
      if (W.charging !== pv.charging) { pv.charging = W.charging; if (S.act !== 'sleep') setAct(W.charging ? 'charge' : 'startle', W.charging ? 2400 : 450, now); }
      if (W.orientation !== pv.orientation) { const was = pv.orientation; pv.orientation = W.orientation; if (was && W.orientation) { S.flingDir = W.orientation === 'landscape' ? 1 : -1; setAct('fling', 650, now); } }
      if (W.facedown !== pv.facedown) { pv.facedown = W.facedown; if (W.facedown && S.act !== 'sleep') { S.worldSleep = true; setAct('sleep', 0, now); } }
    }
    const dark = W.lux !== undefined && W.lux < 2, bright = W.lux !== undefined && W.lux > 10000;
    if (!g && S.act === 'idle' && !S.down && dark && idleFor > 60000) { S.worldSleep = true; setAct('sleep', 0, now); }
    else if (S.worldSleep && S.act === 'sleep' && !W.facedown && !dark) { S.worldSleep = false; setAct('startle', 550, now); }
    else if (S.act !== 'sleep') S.worldSleep = false;
    if (g) gameStep(g, now, dt, E);
    else {
      if (S.d && now - S.t > S.d) {
        const was = S.act, next = ENDS[was] ? ENDS[was](T) : null;
        setAct('idle', 0, now);
        if (next) setAct(next[0], next[1], now);
      }
      if (S.down && !S.down.moved && S.act !== 'purr' && now - S.down.t > 520) setAct('purr', 0, now);
      if (S.act === 'purr') PET.joy = Math.min(1, PET.joy + 0.12 * dt);
      if (S.act === 'sleep' && WORLD.game) setAct('startle', 550, now);
      if (S.act === 'sleep') PET.energy = Math.min(1, PET.energy + 0.03 * dt);
      else {
        PET.energy = Math.max(0.05, PET.energy - 0.002 * dt * T.sleepy);
        if (hushed && S.act === 'idle' && !S.down && idleFor > 15000) setAct('sleep', 0, now);
        else if (S.act === 'idle' && !S.down && !hushed && WORLD.game) setAct('watch', 0, now);
        else if (S.act === 'idle' && !S.down && !hushed && WORLD.music) setAct('listen', 0, now);
        else if (S.act === 'idle' && !S.down && !hushed && WORLD.battery !== undefined && WORLD.battery < 0.2 && !WORLD.charging) setAct('lowbat', 0, now);
        else if (S.act === 'lowbat' && (WORLD.charging || !(WORLD.battery < 0.2))) setAct('idle', 0, now);
        else if (S.act === 'watch' && !WORLD.game) setAct('idle', 0, now);
        else if (S.act === 'listen' && (WORLD.game || !WORLD.music)) setAct('idle', 0, now);
        if (S.act === 'idle' && !S.down) {
          const day = `${D.getFullYear()}-${D.getMonth()}-${D.getDate()}`, hourKey = `${day}-${hour}`;
          if (hushed) { /* quiet hours: no chime, no morning greeting */ }
          else if (D.getMinutes() === 0 && S.chimeKey !== hourKey) { S.chimeKey = hourKey; setAct('chime', 3200, now); }
          else if (hour >= 6 && hour < 10 && S.morningKey !== day) { S.morningKey = day; setAct('morning', 3400, now); }
          else if (now > S.next) {
            S.next = now + (2200 + Math.random() * 4200) / T.hyper;
            const r = Math.random();
            if (idleFor > 150000 && PET.joy < 0.45) setAct('bored', 4200, now);
            else if (idleFor > 90000 && PET.joy < 0.45) setAct('sad', 4200, now);
            else if (idleFor > (night ? 12000 : 35000) / T.sleepy && (PET.energy < 0.55 * T.sleepy || night)) setAct('yawn', 1600, now);
            else if (r < 0.3) { S.tgx = (Math.random() * 2 - 1) * 0.9; S.tgy = (Math.random() * 2 - 1) * 0.4; }
            else if (r < 0.4 && PET.joy > 0.55) setAct('wink', 800, now);
            else if (r < 0.48 && PET.joy > 0.7) setAct('hop', 700, now);
            else if (r < 0.55 && PET.energy < 0.6 * T.sleepy) setAct('yawn', 1600, now);
            else if (r < 0.61) { S.thinkIcon = Math.floor(Math.random() * 4); setAct('think', 2600, now); }
            else if (r < 0.66) { S.shyDir = Math.random() < 0.5 ? -1 : 1; setAct('side', 1500, now); }
            else if (r < 0.7) { S.shyDir = Math.random() < 0.5 ? -1 : 1; setAct('skeptic', 1300, now); }
            else if (r < 0.73) setAct('glitch', 480, now);
            else if (r < 0.78 && PET.joy > 0.4) { S.dotAt = now; setAct('dot', 3600, now); }
            else if (r < 0.82) setAct('stretch', 1800, now);
            else if (r < 0.88) { S.tgx = 0; S.tgy = 0; }
          }
        }
      }
    }
    PET.joy = Math.max(0, PET.joy - 0.004 * dt);

    // The action on screen (outside a game).
    const age = now - S.t, hh = hour % 12 || 12;
    if (!g) switch (S.act) {
      case 'startle': E.open = 1.3; E.wide = 0.85; E.out.push([`M${f1(p + sw * 0.84)},${f1(p + sh * 0.18)}L${f1(p + sw * 0.84)},${f1(p + sh * 0.36)}M${f1(p + sw * 0.84)},${f1(p + sh * 0.46)}L${f1(p + sw * 0.84)},${f1(p + sh * 0.47)}`, 1, false, sh * 0.036]); break;
      case 'giggle': E.shapes = all('happy'); E.bob = -Math.abs(Math.sin(age / 90)) * sh * 0.04; break;
      case 'grumpy': E.shapes = all('angry'); E.open = 0.9; E.shake = Math.sin(age / 60) * sw * 0.006; break;
      case 'wink': if (one) E.open = 0.12; else E.shapes = ['round', 'happy']; break;
      case 'yawn': E.open = 0.22; break;
      case 'hop': E.bob = -Math.abs(Math.sin(age / 700 * Math.PI)) * sh * 0.14; break;
      case 'dance': E.shapes = all('happy'); E.sway = Math.sin(age / 160) * sw * 0.06; E.bob = -Math.abs(Math.sin(age / 160)) * sh * 0.06; break;
      case 'dizzy': E.shapes = all('x'); E.sway = Math.sin(age / 90) * sw * 0.03; E.out.push([drop(p + sw * 0.84, p + sh * 0.2 + ((now / 1600) % 1) * sh * 0.22, sh * 0.07), 0.95 * (1 - ((now / 1600) % 1) * 0.6), true]); break;
      case 'angry': E.shapes = all('angry'); E.open = 1; E.shake = Math.sin(age / 35) * sw * 0.012; break;
      case 'purr': {
        E.shapes = all('happy'); E.sway = Math.sin(age / 400) * sw * 0.025;
        const deep = now - S.purrAt > 2500;
        for (let j = 0; j < (deep ? 4 : 2); j++) { const q = ((now / 1400) + j * (deep ? 0.25 : 0.5)) % 1; E.out.push([heart(cx + (j % 2 ? 0.24 : -0.24) * sw * (1 + (j > 1 ? 0.25 : 0)), p + sh * 0.26 - q * sh * 0.2, sh * 0.1), Math.sin(q * Math.PI), true]); }
        break;
      }
      case 'sleep': E.shapes = all('sleep'); E.open = 0.1; E.bob = Math.sin(now / 900) * sh * 0.012; for (let j = 0; j < 2; j++) { const q = ((now / 2200) + j * 0.5) % 1; E.out.push([zed(p + sw * 0.72 + q * sw * 0.06, p + sh * 0.42 - q * sh * 0.3, sh * (0.07 + 0.03 * j)), Math.sin(q * Math.PI), false, 1.6]); } break;
      case 'curious': E.open = 1.1; E.wide = 1.1; break;
      case 'fling': { const k = clamp(age / 650, 0, 1); E.sway = S.flingDir * sw * 0.1 * (1 - k); E.wide = 1.35; E.open = 0.75; E.gaze = [S.flingDir, 0]; E.out.push([seg(cx - S.flingDir * sw * 0.2, cy - sh * 0.12, cx - S.flingDir * sw * 0.42, cy - sh * 0.12) + seg(cx - S.flingDir * sw * 0.22, cy, cx - S.flingDir * sw * 0.46, cy) + seg(cx - S.flingDir * sw * 0.2, cy + sh * 0.12, cx - S.flingDir * sw * 0.42, cy + sh * 0.12), 1 - k, false, lw]); break; }
      case 'spin': E.shapes = all('spiral'); E.sway = Math.cos(age / 120) * sw * 0.06; E.bob = Math.sin(age / 120) * sh * 0.06; break;
      case 'poke': E.open = 0.08; E.shake = Math.sin(age / 40) * sw * 0.01; E.out.push([drop(p + sw * 0.84, p + sh * 0.25, sh * 0.06), 0.9, true]); break;
      case 'cry': {
        E.open = 0.7; E.dy = sh * 0.05; E.gaze = [0, 0.6]; E.sway = Math.sin(age / 90) * sw * 0.004;
        const q = (now / 700) % 1, ys = cy + eh * 0.35 * 1 + q * sh * 0.3;
        E.out.push([one ? drop(cx - ew * 0.2, ys, sh * 0.05) + drop(cx + ew * 0.2, ys, sh * 0.05) : drop(cx - offset, ys, sh * 0.05) + drop(cx + offset, ys, sh * 0.05), 0.9 * (1 - q * 0.5), true]);
        break;
      }
      case 'shy': {
        E.shapes = all('happy'); E.gaze = [-S.shyDir * 0.9, 0.2]; E.sway = -S.shyDir * sw * 0.02;
        const bx = one ? [cx - ew * 0.9, cx + ew * 0.9] : [cx - offset - ew * 0.8, cx + offset + ew * 0.8], by = cy + eh * 0.55, s = sh * 0.04;
        E.out.push([bx.map((x) => seg(x - s, by + s, x, by - s) + seg(x, by + s, x + s, by - s) + seg(x + s, by + s, x + 2 * s, by - s)).join(''), 0.7, false, lw]);
        break;
      }
      case 'groove': {
        const t0 = S.groove ? S.groove.t0 : S.t, beat = S.groove ? S.groove.beat : 500, c = (now - t0) / beat;
        E.shapes = all('happy'); E.bob = -Math.abs(Math.sin(Math.PI * c)) * sh * 0.06; E.sway = (Math.floor(c) % 2 ? 1 : -1) * sw * 0.03;
        break;
      }
      case 'excited': E.shapes = all('heart'); E.wide = 1.1 + Math.sin(age / 100) * 0.1; E.bob = -Math.abs(Math.sin(age / 160)) * sh * 0.08; E.out.push([star(cx - sw * 0.3, p + sh * 0.2 - ((age / 600) % 1) * sh * 0.06, sh * 0.06) + star(cx + sw * 0.3, p + sh * 0.25 - (((age + 300) / 600) % 1) * sh * 0.06, sh * 0.05), 0.9, true]); break;
      case 'love': E.shapes = all('heart'); E.wide = 1 + Math.sin(age / 120) * 0.12; E.open = E.wide; for (let j = 0; j < 3; j++) { const q = ((age / 900) + j / 3) % 1; E.out.push([heart(cx + (j - 1) * sw * 0.22, p + sh * 0.25 - q * sh * 0.18, sh * 0.08), Math.sin(q * Math.PI), true]); } break;
      case 'sad': E.open = 0.6; E.dy = sh * 0.06; E.gaze = [0, 0.7]; E.out.push([cloud(cx, p + sh * 0.16, sh * 0.09), 0.55, true], [[0, 1, 2].map((j) => { const q = ((now / 600) + j / 3) % 1; return seg(cx + (j - 1) * sh * 0.09, p + sh * 0.26 + q * sh * 0.12, cx + (j - 1) * sh * 0.09, p + sh * 0.3 + q * sh * 0.12); }).join(''), 0.6, false, lw]); break;
      case 'bored': E.open = 0.7; E.gaze = [Math.cos(now / 700) * 0.8, Math.sin(now / 700) * 0.4]; break;
      case 'think': {
        E.gaze = [0.7, -0.8]; E.open = 1.05;
        const bx = p + sw * 0.8, by = p + sh * 0.2, r = sh * 0.13;
        E.out.push([circ(p + sw * 0.62, p + sh * 0.3, sh * 0.025) + circ(p + sw * 0.68, p + sh * 0.26, sh * 0.04) + circ(bx, by, r), 0.8, false, lw], [icon(S.thinkIcon, bx, by, r * 0.55), 0.9, true, lw]);
        break;
      }
      case 'side': E.gaze = [S.shyDir, 0]; E.open = 0.6; break;
      case 'skeptic': if (one) { E.open = 0.55; E.gaze = [S.shyDir, 0]; } else E.open = 1.15; break;
      case 'glitch': E.shake = (Math.random() - 0.5) * sw * 0.06; E.wide = 0.8 + Math.random() * 0.5; E.dim = 0.3 + Math.random() * 0.7; E.out.push([seg(p, p + sh * Math.random(), p + sw, p + sh * Math.random()) + seg(p, p + sh * Math.random(), p + sw, p + sh * Math.random()), 0.5, false, lw]); break;
      case 'dot': {
        const tx = cx + Math.sin(now / 520) * sw * 0.3, ty = cy + Math.sin(now / 410) * sh * 0.22;
        E.gaze = [clamp((tx - cx) / (sw / 2), -1, 1), clamp((ty - cy) / (sh / 2), -1, 1)];
        E.out.push([circ(tx, ty, Math.max(3, sh * 0.035)), 0.9, true]);
        if (age > 3300) { E.bob = -Math.abs(Math.sin((age - 3300) / 300 * Math.PI)) * sh * 0.1; E.open = 1.25; }
        break;
      }
      case 'stretch': { const k = clamp(age / 1800, 0, 1); E.tall = k < 0.45 ? 1 + k * 0.8 : 1.36 - (k - 0.45) * 1.1; E.wide = k < 0.45 ? 1 - k * 0.5 : 0.78 + (k - 0.45) * 0.6; E.open = 1; E.shapes = all(k < 0.5 ? 'round' : 'happy'); break; }
      case 'morning': {
        E.open = age < 1500 ? 0.15 : Math.min(1.25, 0.15 + (age - 1500) / 900); E.wide = age < 1500 ? 1.15 : 1;
        E.out.push([sun(p + sw * 0.82, p + sh * 0.2, sh * 0.06, age / 1000), 0.9, false, lw]);
        break;
      }
      case 'chime': {
        E.sway = Math.sin(age / 180) * sw * 0.08 * clamp(1 - age / 3200, 0, 1) * 2; E.shapes = all(age < 2400 ? 'round' : 'happy');
        const lit = Math.min(hh, Math.floor(age / 220)), sp = Math.min(sh * 0.09, sw / 14);
        let dots = ''; for (let i = 0; i < lit; i++) dots += circ(cx + (i - (hh - 1) / 2) * sp, p + sh * 0.14, sp * 0.3);
        if (dots) E.out.push([dots, 0.9, true, 1]);
        break;
      }
      case 'listen': {
        const c = age / 520, phaseOpen = Math.floor(age / 3120) % 2;
        E.shapes = all(phaseOpen ? 'round' : 'happy'); E.bob = -Math.abs(Math.sin(Math.PI * c)) * sh * 0.05; E.sway = (Math.floor(c / 2) % 2 ? 1 : -1) * sw * 0.025;
        let notes = ''; for (let i = 0; i < 2; i++) { const q = ((age / 2400) + i / 2) % 1; notes += note(p + sw * (i ? 0.8 : 0.16) + Math.sin(q * 6) * sw * 0.02, p + sh * 0.5 - q * sh * 0.3, sh * 0.07); }
        E.out.push([notes, 0.85, true, lw]);
        break;
      }
      case 'watch': {
        const k = age % 7000, cheer = k < 800;
        E.gaze = [0.5 + Math.sin(age / 900) * 0.3, -0.4]; E.open = 1.15; E.wide = 1.05;
        if (cheer) { E.shapes = all('happy'); E.bob = -Math.abs(Math.sin(k / 800 * Math.PI * 2)) * sh * 0.08; } else E.shake = Math.sin(age / 55) * sw * 0.002;
        const gx = p + sw * 0.84, gy = p + sh * 0.82, gw = sw * 0.12, gh = sh * 0.09;
        E.out.push([rr(gx - gw / 2, gy - gh / 2, gw, gh, gh * 0.4) + circ(gx + gw * 0.22, gy, gh * 0.12) + seg(gx - gw * 0.3, gy, gx - gw * 0.1, gy), 0.8, false, lw]);
        break;
      }
      case 'lowbat': {
        E.open = 0.6; E.dy = sh * 0.04; E.shake = Math.sin(age / 70) * sw * 0.003; E.gaze = [0, 0.5];
        const bx = p + sw * 0.76, by = p + sh * 0.1, bw = sw * 0.15, bh = sh * 0.11, blink = Math.floor(age / 600) % 2;
        E.out.push([rr(bx, by, bw, bh, 2), 0.9, false, lw], [rr(bx + bw, by + bh * 0.3, bw * 0.08, bh * 0.4, 1) + (blink ? rr(bx + 2, by + 2, Math.max(1, bw * 0.15), Math.max(1, bh - 4), 1) : ''), 0.9, true, 1]);
        break;
      }
      case 'charge': {
        E.shapes = all('happy'); E.sway = Math.sin(age / 200) * sw * 0.03; E.bob = -Math.abs(Math.sin(age / 200)) * sh * 0.04;
        const s2 = sh * 0.12, bx = p + sw * 0.82, by = p + sh * 0.26;
        E.out.push([`M${f1(bx + s2 * 0.1)},${f1(by - s2)}L${f1(bx - s2 * 0.5)},${f1(by + s2 * 0.1)}L${f1(bx - s2 * 0.05)},${f1(by + s2 * 0.1)}L${f1(bx - s2 * 0.15)},${f1(by + s2)}L${f1(bx + s2 * 0.5)},${f1(by - s2 * 0.15)}L${f1(bx + s2 * 0.05)},${f1(by - s2 * 0.15)}Z`, Math.floor(age / 250) % 2 ? 1 : 0.5, true, lw]);
        break;
      }
      case 'party': E.shapes = all('happy'); E.sway = Math.sin(age / 140) * sw * 0.07; E.bob = -Math.abs(Math.sin(age / 140)) * sh * 0.07; {
        let confetti = ''; for (let i = 0; i < 9; i++) { const q = ((age / 1500) + i / 9) % 1; confetti += circ(p + sw * ((i * 0.37) % 1), p + sh * q, Math.max(1.5, sh * 0.016)); }
        E.out.push([confetti, 0.85, true, 1]);
      } break;
      case 'sing': {
        E.shapes = all('happy'); E.sway = Math.sin(age / 300) * sw * 0.04;
        let notes = ''; for (let i = 0; i < 3; i++) { const q = ((age / 1600) + i / 3) % 1; notes += note(p + sw * (0.2 + 0.3 * i) + Math.sin(q * 6) * sw * 0.03, p + sh * 0.5 - q * sh * 0.35, sh * 0.07); }
        E.out.push([notes, 0.9, true, lw]);
        break;
      }
      default: if (S.down) { E.open = 1.1; E.wide = 1.1; }
    }

    // The phone's senses shade the idle look: tilt slides the eyes to the low side, a dark room makes them droop, bright light squints them.
    if (!g && (S.act === 'idle' || S.act === 'lowbat')) {
      if (Math.abs(W.tiltX) > 0.15) { E.gaze = [clamp(W.tiltX * 1.6, -1, 1), 0.2]; E.sway += W.tiltX * sw * 0.03; }
      if (dark) { E.open *= 0.6; E.dim *= 0.7; }
      if (bright) E.open *= 0.45;
    }
    if (W.charging && !g && S.act !== 'charge') { const s3 = sh * 0.06, bx = p + sw * 0.08, by = p + sh * 0.14; E.out.push([`M${f1(bx + s3 * 0.1)},${f1(by - s3)}L${f1(bx - s3 * 0.5)},${f1(by + s3 * 0.1)}L${f1(bx - s3 * 0.05)},${f1(by + s3 * 0.1)}L${f1(bx - s3 * 0.15)},${f1(by + s3)}L${f1(bx + s3 * 0.5)},${f1(by - s3 * 0.15)}L${f1(bx + s3 * 0.05)},${f1(by - s3 * 0.15)}Z`, 0.7, true, 1]); }
    // Clothes: a hat on a few days of the year, a nightcap when it is late. Drawn at the top of the screen.
    const month = D.getMonth(), day = D.getDate();
    const hx = cx + (one ? 0 : offset * 0.5), hw = ew * 1.3, hb = p + sh * 0.27 + E.bob, ht = p + sh * 0.02 + E.bob;
    const dressed = outfit === 'auto';
    if (!dressed) {
      const y0 = cy + E.bob, xs = one ? [cx] : [cx - offset, cx + offset];
      const ring = (x) => (info.pixel ? rr(x - ew * 0.62, y0 - eh * 0.58, ew * 1.24, eh * 1.16, 0) : circ(x, y0, Math.max(ew, eh) * 0.62));
      if (outfit === 'glasses') E.out.push([xs.map(ring).join('') + (one ? '' : seg(xs[0] + ew * 0.62, y0, xs[1] - ew * 0.62, y0)), 0.95, false, lw]);
      else if (outfit === 'mustache') {
        const my = cy + eh * 0.78 + E.bob, mw = Math.max(ew * 1.1, sw * 0.12);
        E.out.push([`M${f1(cx)},${f1(my)}Q${f1(cx - mw * 0.5)},${f1(my - sh * 0.05)} ${f1(cx - mw)},${f1(my + sh * 0.02)}Q${f1(cx - mw * 0.5)},${f1(my + sh * 0.03)} ${f1(cx)},${f1(my + sh * 0.01)}Q${f1(cx + mw * 0.5)},${f1(my + sh * 0.03)} ${f1(cx + mw)},${f1(my + sh * 0.02)}Q${f1(cx + mw * 0.5)},${f1(my - sh * 0.05)} ${f1(cx)},${f1(my)}Z`, 0.95, true, lw]);
      } else if (outfit === 'crown') E.out.push([`M${f1(cx - hw * 0.6)},${f1(hb)}L${f1(cx - hw * 0.6)},${f1(ht + sh * 0.04)}L${f1(cx - hw * 0.3)},${f1(ht + sh * 0.12)}L${f1(cx)},${f1(ht)}L${f1(cx + hw * 0.3)},${f1(ht + sh * 0.12)}L${f1(cx + hw * 0.6)},${f1(ht + sh * 0.04)}L${f1(cx + hw * 0.6)},${f1(hb)}Z`, 0.95, true, lw]);
      else if (outfit === 'tophat') E.out.push([rr(cx - hw * 0.35, ht, hw * 0.7, Math.max(2, hb - ht - sh * 0.03), 1) + seg(cx - hw * 0.7, hb - sh * 0.02, cx + hw * 0.7, hb - sh * 0.02), 0.95, true, lw]);
      else if (outfit === 'bowtie') {
        const by = p + sh * 0.93 + E.bob * 0.3, bw = Math.max(sw * 0.07, 6);
        E.out.push([tri(cx, by, cx - bw, by - bw * 0.6, cx - bw, by + bw * 0.6) + tri(cx, by, cx + bw, by - bw * 0.6, cx + bw, by + bw * 0.6) + circ(cx, by, bw * 0.22), 0.95, true, lw]);
      }
    }
    if (!dressed) { /* a chosen outfit replaces the date hats and the nightcap */ }
    else if (month === 9 && day === 31) E.out.push([tri(hx - hw * 0.5, hb, hx + hw * 0.5, hb, hx + hw * 0.1, ht) + seg(hx - hw * 0.8, hb, hx + hw * 0.8, hb), 0.95, true, lw]);
    else if (month === 11 && day >= 24 && day <= 26) E.out.push([tri(hx - hw * 0.5, hb, hx + hw * 0.5, hb, hx + hw * 0.6, ht + sh * 0.1) + circ(hx + hw * 0.6, ht + sh * 0.1, sh * 0.04), 0.95, true, lw]);
    else if ((month === 11 && day === 31) || (month === 0 && day === 1)) E.out.push([tri(hx - hw * 0.4, hb, hx + hw * 0.4, hb, hx, ht) + circ(hx, ht, sh * 0.035), 0.95, true, lw]);
    else if (night && ['sleep', 'idle', 'yawn', 'bored'].includes(S.act) && !g) E.out.push([tri(hx - hw * 0.5, hb, hx + hw * 0.5, hb, hx + hw * 0.9, ht + sh * 0.14) + circ(hx + hw * 0.9, ht + sh * 0.16, sh * 0.04), 0.7, true, lw]);
    if (dressed && month === 1 && day === 14 && !g) for (let j = 0; j < 3; j++) { const q = ((now / 3000) + j / 3) % 1; E.out.push([heart(p + sw * (0.2 + 0.3 * j), p + sh * 0.9 - q * sh * 0.8, sh * 0.06), Math.sin(q * Math.PI) * 0.7, true]); }
    if (night && !g && S.act === 'idle') E.bob += Math.sin(now / 2500) * sh * 0.02;

    if (opt.mood) {
      const col = ['angry', 'grumpy'].includes(S.act) ? MOODS.red : ['love', 'excited', 'purr', 'party', 'sing'].includes(S.act) ? MOODS.pink : S.act === 'sleep' || PET.energy < 0.3 ? MOODS.purple : PET.joy < 0.25 || ['sad', 'cry'].includes(S.act) ? MOODS.blue : baseColor;
      if (col !== S.col) { S.col = col; if (root.style.setProperty) root.style.setProperty('--pet', col); else root.style['--pet'] = col; }
    }
    if (E.gaze) { S.tgx = E.gaze[0]; S.tgy = E.gaze[1]; }
    const ease = 1 - Math.exp(-dt * 10);
    S.gx += (S.tgx - S.gx) * ease; S.gy += (S.tgy - S.gy) * ease;
    if (now > S.blinkAt) { S.blinking = now; S.blinkAt = now + 2800 + Math.random() * 3500; }
    // A single eye has no inner and outer corner, so an angry one is a narrowed eye instead.
    if (one && E.shapes[0] === 'angry') { E.shapes = ['round']; E.open = 0.5; }
    if (E.hide) E.shapes = E.shapes.map(() => null);
    const lid = E.shapes[0] === 'round' && (S.act === 'idle' || g) && !E.noBlink && !E.hide ? 1 - Math.sin(clamp((now - S.blinking) / 160, 0, 1) * Math.PI) * 0.92 : 1;
    const a = ew * E.wide * E.scale, b = eh * E.open * lid * E.scale * E.tall;
    const y = quantize(cy + S.gy * sh * 0.08 + E.bob + E.dy, step), x = quantize(cx + S.gx * sw * 0.06 + E.sway + E.shake, step);
    const eo = offset * E.scale;
    eyes.forEach((node, i) => eye(node, E.shapes[i], x + (one ? 0 : (i ? 1 : -1) * eo), y, a, b, i ? 1 : -1, info));
    S.eye = { x, y, a, b };
    group.setAttribute('opacity', f1(E.hide ? 1 : E.dim));
    group.setAttribute('transform', E.tilt ? `rotate(${f1(E.tilt)} ${f1(cx)} ${f1(cy + sh * 0.15)})` : '');
    if (info.cat && !E.hide) {
      const slit = a * (S.act === 'startle' ? 0.34 : 0.14);
      if (E.shapes[0] === 'round' && b > 4) E.out.push([eyes.map((_, i) => rr(x + (one ? 0 : (i ? 1 : -1) * eo) - slit / 2, y - b * 0.4, slit, b * 0.8, slit / 2)).join(''), 1, true, 0.5, SCREEN]);
    }

    fx.forEach((node, i) => {
      const m = E.out[i];
      if (!m || !(m[1] > 0)) { node.setAttribute('opacity', '0'); return; }
      node.setAttribute('opacity', f1(clamp(m[1], 0, 1)));
      node.setAttribute('d', m[0]);
      node.style.fill = m[2] ? (m[4] || 'var(--pet)') : 'none';
      node.style.stroke = m[4] || 'var(--pet)';
      node.setAttribute('stroke-width', f1(m[3] || 1.5));
    });
  };

  // --- Touch -------------------------------------------------------------------------------
  const CORNER = { tl: 0, tr: 1, br: 2, bl: 3 };
  const COMBOS = [{ seq: [0, 1, 2, 3], act: 'party' }, { seq: [0, 2, 1, 3], act: 'sing' }];
  const touch = (kind, x, y) => {
    const now = performance.now();
    const look = () => { S.tgx = clamp((x - cx) / (sw / 2), -1, 1); S.tgy = clamp((y - cy) / (sh / 2), -1, 1); };
    S.px = x; S.py = y;
    if (kind === 'down') {
      const away = now - PET.touchAt;
      S.down = { t: now, x, y, moved: false, hist: [[now, x, y]], stroke: 0, fast: false, spin: 0, ang: Math.atan2(y - cy, x - cx), petting: false, greet: false };
      PET.touchAt = now;
      if (S.game) gameTouch('down', x, y, now, S.down);
      else {
        look();
        if (S.act === 'sleep') setAct(PET.energy < 0.3 ? 'grumpy' : 'startle', PET.energy < 0.3 ? 1100 : 550, now);
        else if (away > 120000) { setAct('excited', 1700, now); S.down.greet = true; }
      }
    } else if (kind === 'move' && S.down) {
      const down = S.down, h = down.hist, prev = h[h.length - 1], dist = Math.hypot(x - prev[1], y - prev[2]), dtm = Math.max(1, now - prev[0]);
      h.push([now, x, y]); if (h.length > 5) h.shift();
      PET.touchAt = now;
      if (S.game) { gameTouch('move', x, y, now, down); if (Math.hypot(x - down.x, y - down.y) > 14) down.moved = true; }
      else {
        if (dist / dtm > 0.8) down.fast = true;
        else if (dist / dtm < 0.35) down.stroke += dist;
        if (Math.hypot(x - down.x, y - down.y) > 14) { down.moved = true; if (S.act === 'purr' && !down.petting) setAct('idle', 0, now); }
        if (!down.petting && !down.fast && down.stroke > 50 && now - down.t > 600 && S.act !== 'purr') { down.petting = true; setAct('purr', 0, now); }
        const ang = Math.atan2(y - cy, x - cx); let da = ang - down.ang; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
        down.ang = ang; down.spin += da;
        if (Math.abs(down.spin) > Math.PI * 2.8 && Math.hypot(x - cx, y - cy) > Math.min(sw, sh) * 0.08) { down.spin = 0; setAct('spin', 1700, now); }
        look();
      }
    } else if (kind === 'up' || kind === 'cancel') {
      const down = S.down; S.down = null; PET.touchAt = now;
      if (!down) return;
      if (S.game) { gameTouch(kind, x, y, now, down); if (!raf) frame(now, 0.05); return; }
      const h = down.hist, first = h[0], lastS = h[h.length - 1], span = Math.max(1, lastS[0] - first[0]), speed = Math.hypot(lastS[1] - first[1], lastS[2] - first[2]) / span;
      if (down.greet) { /* the welcome back is the whole reaction */ }
      else if (S.act === 'purr') { if (now - S.purrAt > 2500) setAct('love', 1800, now); else setAct('giggle', 900, now); PET.joy = Math.min(1, PET.joy + 0.15); }
      else if (S.act === 'spin') { /* spinning carries on */ }
      else if (down.moved && kind === 'up' && speed > 1.3 && h.length > 1) {
        S.flingDir = lastS[1] >= first[1] ? 1 : -1;
        S.flings = S.flings.filter((t) => now - t < 5000); S.flings.push(now);
        if (S.flings.length >= 3) { S.flings = []; setAct('dizzy', 2200, now); } else setAct('fling', 650, now);
      } else if (down.moved) setAct('curious', 700, now);
      else if (kind === 'up' && now - down.t < 400) {
        const inCornerX = x < p + sw * 0.24 ? 0 : x > p + sw * 0.76 ? 1 : -1, inCornerY = y < p + sh * 0.24 ? 0 : y > p + sh * 0.76 ? 1 : -1;
        S.taps = S.taps.filter((t) => now - t < 1400); S.taps.push(now);
        const n = S.taps.length, gaps = S.taps.slice(1).map((t, i) => t - S.taps[i]);
        
        if (n >= 3 && gaps.slice(-2).every((gp) => gp < 350)) { S.taps = []; S.groove = null; S.game = { id: 'menu', t0: now, ph: 'a', t: now }; S.act = 'idle'; S.d = 0; }
        else if (n >= 4 && gaps.slice(-3).every((gp) => gp >= 350 && gp <= 1000) && Math.max(...gaps.slice(-3)) - Math.min(...gaps.slice(-3)) < 140) {
          const beat = gaps.slice(-3).reduce((s, v) => s + v, 0) / 3;
          S.groove = { beat, t0: now }; setAct('groove', beat * 2.4, now); PET.joy = Math.min(1, PET.joy + 0.04);
        } else if (S.act === 'groove') { S.groove.t0 = now; S.groove.beat = Math.max(350, Math.min(1000, now - S.lastTap)); S.t = now; S.d = S.groove.beat * 2.4; }
        else if (inCornerX >= 0 && inCornerY >= 0) {
          const id = inCornerY ? (inCornerX ? CORNER.br : CORNER.bl) : (inCornerX ? CORNER.tr : CORNER.tl);
          if (now - S.cornerAt > 2500) S.corners = [];
          S.cornerAt = now; S.corners.push(id);
          const combo = COMBOS.find((c) => c.seq.slice(0, S.corners.length).every((v, i) => v === S.corners[i]));
          if (!combo) S.corners = [id];
          else if (combo.seq.length === S.corners.length) { S.corners = []; setAct(combo.act, 4200, now); PET.joy = Math.min(1, PET.joy + 0.2); }
          if (S.act !== 'party' && S.act !== 'sing') setAct('startle', 450, now);
        } else if (now - S.lastTap < 420) { S.pokes = 0; PET.joy = Math.min(1, PET.joy + 0.15); setAct('dance', 2600, now); }
        else {
          const e = S.eye, onEye = (one ? [0] : [-1, 1]).some((s) => Math.abs(x - (e.x + s * offset)) < e.a / 2 + 4 && Math.abs(y - e.y) < Math.max(e.b, sh * 0.1) / 2 + 4);
          const em = 0.14 * T.shy, edge = x < p + sw * em || x > p + sw * (1 - em) || y < p + sh * em || y > p + sh * (1 - em);
          if (onEye) {
            S.eyePokes = S.eyePokes.filter((t) => now - t < 5000); S.eyePokes.push(now);
            if (S.eyePokes.length >= 3) { S.eyePokes = []; setAct('cry', 2800, now); PET.joy = Math.max(0, PET.joy - 0.15); } else setAct('poke', 800, now);
          } else if (edge) { S.shyDir = x < cx ? -1 : 1; setAct('shy', 1500, now); PET.joy = Math.min(1, PET.joy + 0.05); }
          else {
            S.pokes = now - S.pokeAt < 3000 ? S.pokes + 1 : 1; S.pokeAt = now; PET.energy = Math.max(0.05, PET.energy - 0.03);
            PET.joy = Math.max(0, Math.min(1, PET.joy + (S.pokes < 5 ? 0.06 * Math.max(0.3, 2 - T.grumpy) : -0.1 * T.grumpy)));
            if (S.pokes >= 8) setAct('angry', 1800, now); else if (S.pokes >= 5) setAct('dizzy', 2200, now); else if (T.shy > 1.05 && Math.random() < (T.shy - 1.05) * 0.8) { S.shyDir = x < cx ? -1 : 1; setAct('shy', 1500, now); } else setAct('startle', 550, now);
          }
        }
        S.lastTap = now;
      }
    }
    if (!raf) frame(now, 0.05);
  };

  const pet = { tick: (now, dt) => { if (!root.isConnected) { pets.delete(pet); return; } frame(now, dt); } };
  pets.add(pet);
  frame(performance.now(), 0);
  start();
  return { destroy() { pets.delete(pet); root.remove(); if (audio && audio.close) { try { audio.close(); } catch (error) { /* already closed */ } } }, touch, step: (now, dt) => frame(now, dt) };
}

globalThis.OpenDockPet = {
  faces: FACES.map(({ id, name, blurb }) => ({ id, name, blurb })),
  defaultColor: DEFAULT_COLOR,
  mount,
  // The phone pauses the page while the deck is hidden; pets stop animating until resumed.
  setWorld(world) {
    const w = world || {};
    const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
    WORLD.music = !!w.music; WORLD.game = typeof w.game === 'string' ? w.game : null;
    WORLD.battery = num(w.battery, 0, 1); WORLD.charging = !!w.charging; WORLD.tiltX = num(w.tiltX, -1, 1) || 0; WORLD.shakeAt = num(w.shakeAt, 0, Infinity) || 0;
    WORLD.facedown = !!w.facedown; WORLD.lux = num(w.lux, 0, 1e6); WORLD.orientation = w.orientation === 'portrait' || w.orientation === 'landscape' ? w.orientation : undefined;
  },
  setPaused(paused) { off = !!paused; if (!off) start(); },
};
})();
