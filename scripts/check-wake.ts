// Run: node scripts/check-wake.ts
// The wake phrase is found in what the phone's recognizer actually sends back.
import assert from 'node:assert/strict';
import { afterWakePhrase } from '../phone-app/src/wake-phrase.ts';

const phrase = 'hey dock';
assert.equal(afterWakePhrase('hey dock open spotify', phrase), 'open spotify');
assert.equal(afterWakePhrase('Hey, Dock.', phrase), '');
assert.equal(afterWakePhrase('hi doc volume up', phrase), 'volume up');
assert.equal(afterWakePhrase('hey dog mute', phrase), 'mute');
assert.equal(afterWakePhrase('a duck next track', phrase), 'next track');
assert.equal(afterWakePhrase('okay docks lock pc', phrase), 'lock pc');
// The greeting was lost in the gap between two recognizer sessions.
assert.equal(afterWakePhrase('dock open chrome', phrase), 'open chrome');
// Not the phrase.
assert.equal(afterWakePhrase('the dog is barking', phrase), null);
assert.equal(afterWakePhrase('open spotify', phrase), null);
assert.equal(afterWakePhrase('hey there', phrase), null);
console.log('check-wake: ok');
