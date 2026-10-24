// Finding the wake phrase ("hey dock") in what the recognizer heard. Plain functions with no React Native imports,
// so scripts/check-wake.ts can run them.

const GREETINGS = new Set(['hey', 'hi', 'hay', 'a', 'ok', 'okay', 'hello', 'yo', 'he']);

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

// Recognizers spell a short word the way it sounded: "dock" comes back as doc, docks, dog or duck.
const sound = (word: string) => word.replace(/ck|c|g$/g, 'k').replace(/ph/g, 'f').replace(/(.)s$/, '$1');

const sameWord = (heard: string, wanted: string) =>
  heard === wanted || (GREETINGS.has(heard) && GREETINGS.has(wanted)) || (wanted.length >= 3 && distance(sound(heard), sound(wanted)) <= 1);

/** The words after the wake phrase ("" when it was said alone), or null when the phrase is not in `text`. */
export function afterWakePhrase(text: string, phrase: string): string | null {
  const heard = words(text);
  const wanted = words(phrase);
  if (!wanted.length) return null;
  for (let start = 0; start + wanted.length <= heard.length; start += 1) {
    if (wanted.every((word, index) => sameWord(heard[start + index], word))) return heard.slice(start + wanted.length).join(' ');
  }
  // The recognizer restarts between sentences and can miss the first word: "dock, lights on" at the very start of
  // what it heard counts when the missing words were only a greeting.
  const core = wanted.filter((word) => !GREETINGS.has(word));
  if (core.length && core.length < wanted.length && core.every((word, index) => heard[index] !== undefined && sameWord(heard[index], word))) {
    return heard.slice(core.length).join(' ');
  }
  return null;
}

/** Which of the recognizer's guesses to use: its first one that holds the wake phrase, else its best one. Its best is
 * often a real word that sounds alike ("headache open brave"), with "hey dog open brave" further down. */
export const pickTranscript = (transcripts: string[], phrase: string) =>
  transcripts.find((text) => afterWakePhrase(text, phrase) !== null) ?? transcripts[0] ?? '';
