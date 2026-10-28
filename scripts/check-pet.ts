// Run: node scripts/check-pet.ts
// Fails when the phone copy of the pet is stale, the Rust list of pets drifts from the pets, or a pet draws badly:
// every pet is mounted at several sizes and touched every way, and its markup must hold no NaN or undefined.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const source = readFileSync(new URL('../pc-companion/src/pet/pet.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const phone = readFileSync(new URL('../phone-app/src/pet-source.ts', import.meta.url), 'utf8');
assert.ok(phone.includes(JSON.stringify(source)), 'phone-app/src/pet-source.ts is stale: run node scripts/sync-pet.ts');
assert.ok(!/color-mix|currentColor/.test(source), 'pet.js uses color-mix() or currentColor, which break on some Android WebViews');

// A page with just enough DOM for the pet: nodes keep their attributes, children and styles.
class Node {
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  children: Node[] = [];
  isConnected = true;
  html = '';
  classes: string[] = [];
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  remove() { this.isConnected = false; }
  set innerHTML(value: string) {
    this.html = value;
    this.children = [...value.matchAll(/<(?:path|g) class="(pe|pf|pg)"/g)].map((match) => { const node = new Node(); node.classes = [match[1]]; return node; });
  }
  querySelectorAll(selector: string) { return this.children.filter((node) => node.classes.includes(selector.slice(1))); }
}
const globals = globalThis as unknown as Record<string, unknown>;
let clock = 1000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true });
globals.document = { createElement: () => new Node() };
runInThisContext(source);
const api = globals.OpenDockPet as { setWorld(world: Record<string, unknown>): void; faces: { id: string }[]; mount(host: Node, options: Record<string, unknown>): { destroy(): void; touch(kind: string, x: number, y: number): void; step(now: number, dt: number): void } };

const ids = api.faces.map((face) => face.id).sort();
assert.equal(new Set(ids).size, ids.length, 'duplicate pet ids');
const rust = readFileSync(new URL('../pc-companion/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const match = rust.match(/const PET_FACES: &\[&str\] = &\[([^\]]*)\]/);
assert.ok(match, 'PET_FACES not found in lib.rs');
assert.deepEqual([...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort(), ids, 'PET_FACES in lib.rs does not match the pets');

const outfits = source.match(/const OUTFITS = \[([^\]]*)\]/);
const rustOutfits = rust.match(/const PET_OUTFITS: &\[&str\] = &\[([^\]]*)\]/);
assert.ok(outfits && rustOutfits, 'OUTFITS or PET_OUTFITS not found');
assert.deepEqual([...outfits[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...rustOutfits[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]), 'PET_OUTFITS in lib.rs does not match OUTFITS in pet.js');

let draws = 0;
for (const face of ids) for (const [width, height] of [[44, 44], [90, 90], [200, 100], [380, 700]]) {
  const host = new Node();
  const handle = api.mount(host, { face, color: '#2dd4bf', width, height });
  const root = host.children[0];
  const check = (when: string) => {
    const everything = JSON.stringify([root.html, root.children.map((node) => node.attributes)]);
    assert.ok(!/NaN|undefined|Infinity/.test(everything), `${face} ${width}x${height} ${when}: bad value in ${everything.match(/.{0,50}(NaN|undefined|Infinity).{0,30}/)?.[0]}`);
    draws++;
  };
  check('at rest');
  for (const [kind, x, y] of [['down', width / 2, height / 2], ['up', width / 2, height / 2], ['down', 1, 1], ['move', width - 1, height - 1], ['up', width - 1, height - 1], ['cancel', 0, 0]] as [string, number, number][]) {
    handle.touch(kind, x, y);
    check(kind);
  }
  for (let tap = 0; tap < 10; tap++) { handle.touch('down', 5, 5); handle.touch('up', 5, 5); }
  check('after ten taps');
  handle.destroy();
}
// Play every gesture and every game through on a fake clock; nothing may ever draw a NaN.
for (const face of ids) {
  const host = new Node(), width = 200, height = 100;
  const handle = api.mount(host, { face, color: '#2dd4bf', width, height });
  const root = host.children[0];
  const check = (when: string) => { const all = JSON.stringify([root.html, root.children.map((node) => node.attributes)]); assert.ok(!/NaN|undefined|Infinity/.test(all), `${face} ${when}: bad value ${all.match(/.{0,50}(NaN|undefined|Infinity).{0,30}/)?.[0]}`); draws++; };
  const wait = (ms: number) => { for (let t = 0; t < ms; t += 50) { clock += 50; handle.step(clock, 0.05); check(`waiting at ${clock}`); } };
  const tap = (x: number, y: number, hold = 60) => { handle.touch('down', x, y); wait(hold); handle.touch('up', x, y); };
  const drag = (points: [number, number][], gap: number) => { handle.touch('down', ...points[0]); for (const point of points.slice(1)) { clock += gap; handle.touch('move', ...point); check('drag'); } handle.touch('up', ...points[points.length - 1]); wait(100); };
  const menu = () => { wait(2000); tap(100, 50, 30); wait(100); tap(100, 50, 30); wait(100); tap(100, 50, 30); wait(500); };
  const cellAt = (i: number) => [6 + (i % 3) * 62.7 + 30, 6 + Math.floor(i / 3) * 44 + 22] as [number, number];
  wait(500);
  menu();
  tap(...cellAt(0)); wait(500); tap(30, 85); wait(3500);                            // rock paper scissors, rock
  menu(); tap(...cellAt(0)); wait(500); tap(100, 85); wait(3500);                   // paper
  menu(); tap(...cellAt(0)); wait(500); tap(170, 85); wait(3500);                   // scissors
  for (let round = 0; round < 3; round++) { menu(); tap(...cellAt(1)); wait(300); handle.touch('down', 60, 40); wait(200); handle.touch('move', 100, 50); wait(200); handle.touch('up', 100, 50); wait(500); tap(100, 50); wait(5000); }   // bang
  menu(); tap(...cellAt(2)); wait(300); handle.touch('down', 80, 40); wait(300); handle.touch('move', 120, 60); wait(100); handle.touch('move', 120, 60); wait(1500); handle.touch('up', 120, 60); wait(3000);   // chase
  menu(); tap(...cellAt(3)); for (let i = 0; i < 10; i++) { wait(700); tap(100, 50, 30); } wait(2000);   // peek-a-boo
  menu(); tap(...cellAt(4)); wait(200); handle.touch('down', 100, 50); wait(2000); handle.touch('up', 100, 50); wait(2500);   // stare, give up early
  menu(); tap(...cellAt(4)); wait(200); handle.touch('down', 100, 50); wait(9000); handle.touch('up', 100, 50); wait(2500);   // stare, hold it out
  menu(); tap(...cellAt(5)); wait(1000);                                            // close the menu
  menu(); wait(8000);                                                               // let the menu time out
  tap(10, 10, 30); wait(300); tap(190, 10, 30); wait(300); tap(190, 90, 30); wait(300); tap(10, 90, 30); wait(5000);   // clockwise corners: party
  tap(10, 10, 30); wait(300); tap(190, 90, 30); wait(300); tap(190, 10, 30); wait(300); tap(10, 90, 30); wait(5000);   // zigzag corners: sing
  tap(100, 50); wait(1000); tap(70, 50); wait(900); tap(70, 50); wait(900); tap(70, 50); wait(3000);   // eye pokes then crying
  tap(100, 6); wait(2000); tap(4, 50); wait(2000);                                  // shy
  drag([[20, 50], [60, 50], [110, 50], [160, 50]], 40); wait(500);                  // fast swipes, three of them
  drag([[160, 50], [110, 50], [60, 50], [20, 50]], 40); wait(500);
  drag([[20, 50], [60, 50], [110, 50], [160, 50]], 40); wait(3000);
  const circle: [number, number][] = []; for (let i = 0; i < 40; i++) circle.push([100 + Math.cos(i / 4) * 60, 50 + Math.sin(i / 4) * 30]); drag(circle, 25); wait(4000);   // circling
  handle.touch('down', 80, 50); for (let i = 0; i < 40; i++) { clock += 40; handle.touch('move', 80 + (i % 2) * 6, 50); handle.step(clock, 0.04); } handle.touch('up', 80, 50); wait(2500);   // petting
  handle.touch('down', 100, 50); wait(3500); handle.touch('up', 100, 50); wait(2500);   // held long enough to fall in love
  for (let i = 0; i < 5; i++) { tap(100, 50, 30); wait(600); } wait(4000);          // a steady beat
  wait(130000); tap(100, 50, 30); wait(2500);                                       // ignored a long time, then back
  wait(200000);                                                                     // sad, bored, asleep
  handle.destroy();
  for (const outfit of ['auto', 'none', 'glasses', 'mustache', 'crown', 'tophat', 'bowtie']) {
    const h2 = api.mount(new Node(), { face, color: '#2dd4bf', width, height, opacity: 40, pet: { outfit, mood: true, sound: true, sleepy: 0, hyper: 10, shy: 10, grumpy: 10, quietFrom: 23, quietTo: 7 } });
    for (let i = 0; i < 40; i++) { clock += 100; h2.touch(i % 7 === 0 ? 'down' : 'up', 100, 50); h2.step(clock, 0.1); }
    h2.destroy();
  }
  api.setWorld({ battery: 0.15, tiltX: 0.8, lux: 3, orientation: 'portrait' }); wait(30000); api.setWorld({ battery: 0.15, charging: true, tiltX: -0.6, lux: 20000, orientation: 'landscape', shakeAt: clock }); wait(3000);
  api.setWorld({ battery: 1, charging: true, facedown: true, shakeAt: clock + 1 }); wait(3000); api.setWorld({ shakeAt: clock + 2 }); wait(500); api.setWorld({ shakeAt: clock + 3 }); wait(3000); api.setWorld({ battery: 0.6, charging: false, facedown: false, lux: 300, tiltX: 0 }); wait(3000);   // the phone's senses
  api.setWorld({ music: true }); wait(4000); api.setWorld({ game: 'cs2', music: true }); wait(9000); api.setWorld({ music: false, game: null }); wait(1000);   // music, then a game on the PC
  handle.destroy();
}

console.log(`pet: ${ids.length} pets, ${draws} draws ok`);
