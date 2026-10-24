// Run: node scripts/check-wake.ts
// The wake phrase is found in what the phone's recognizer actually sends back.
import assert from 'node:assert/strict';
import { afterWakePhrase, pickTranscript } from '../phone-app/src/wake-phrase.ts';

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
// Guesses as the phone sent them (2026-10-24): the phrase only in a lower one.
assert.equal(pickTranscript(['headache open Brave', 'hey dog open Brave'], phrase), 'hey dog open Brave');
assert.equal(pickTranscript(['headache lights on', 'headache light on', 'dog lights on'], phrase), 'dog lights on');
assert.equal(pickTranscript(['open spotify', 'open spotif'], phrase), 'open spotify');
assert.equal(pickTranscript([], phrase), '');
console.log('check-wake: ok');
