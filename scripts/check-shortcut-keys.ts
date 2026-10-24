// Run: node scripts/check-shortcut-keys.ts
// A recorded key press must come out as keys the PC accepts: modifiers first, one main key it can send.
import assert from 'node:assert/strict';
import { COMMON_SHORTCUTS, shortcutFromPress } from '../pc-companion/src/shortcut-keys.ts';

const press = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  shortcutFromPress({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

assert.deepEqual(press('KeyM', { shiftKey: true, ctrlKey: true }), ['CTRL', 'SHIFT', 'M']);
assert.deepEqual(press('Delete', { altKey: true, ctrlKey: true }), ['CTRL', 'ALT', 'DELETE']);
assert.deepEqual(press('ArrowRight', { metaKey: true, ctrlKey: true }), ['CTRL', 'META', 'RIGHT']);
assert.deepEqual(press('Numpad7', { altKey: true }), ['ALT', '7']);
// A key alone, a modifier alone, or a key the PC can't send records nothing.
assert.equal(press('KeyA'), null);
assert.equal(press('ControlLeft', { ctrlKey: true }), null);
assert.equal(press('Semicolon', { ctrlKey: true }), null);

// Every listed shortcut is one the PC accepts.
const MODS = new Set(['CTRL', 'ALT', 'SHIFT', 'META']);
const NAMED = new Set(['SPACE', 'ENTER', 'TAB', 'ESCAPE', 'BACKSPACE', 'DELETE', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'UP', 'DOWN', 'LEFT', 'RIGHT']);
for (const [, label, keys] of COMMON_SHORTCUTS) {
  const parts = keys.split('+');
  const key = parts.pop()!;
  assert.ok(parts.length >= 1 && parts.every((part) => MODS.has(part)) && new Set(parts).size === parts.length, `${label}: modifiers`);
  assert.ok(/^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-2])$/.test(key) || NAMED.has(key), `${label}: key ${key}`);
}
console.log(`check-shortcut-keys: ok (${COMMON_SHORTCUTS.length} shortcuts)`);
