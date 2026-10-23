// Run: node scripts/check-clock-faces.ts
// Fails when the phone copy of the clock faces is stale or the Rust face allowlist drifts from the faces.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

// Line endings depend on the checkout (core.autocrlf), so the phone copy always uses LF.
const source = readFileSync(new URL('../pc-companion/src/clock-faces/clock-faces.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const phone = readFileSync(new URL('../phone-app/src/clock-faces-source.ts', import.meta.url), 'utf8');
assert.ok(phone.includes(JSON.stringify(source)), 'phone-app/src/clock-faces-source.ts is stale: run node scripts/sync-clock-faces.ts');

runInThisContext(source);
const faces = (globalThis as unknown as { OpenDockClock: { faces: { id: string; category: string }[] } }).OpenDockClock.faces;
const ids = faces.map((face) => face.id).sort();
assert.equal(new Set(ids).size, ids.length, 'duplicate face ids');
assert.ok(faces.every((face) => ['classic', 'retro', 'ambient', 'kinetic'].includes(face.category)), 'every face needs a category');

const rust = readFileSync(new URL('../pc-companion/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const list = rust.match(/const CLOCK_FACES: &\[&str\] = &\[([^\]]*)\]/);
assert.ok(list, 'CLOCK_FACES not found in lib.rs');
assert.deepEqual([...list[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort(), ids, 'CLOCK_FACES in lib.rs does not match the faces');
console.log(`clock faces: ${ids.length} faces ok`);
