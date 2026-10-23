// Shared with pc-companion/src/lyrics.ts. Keep the two files identical:
// scripts/check-lyrics.ts fails when they differ.

export type LyricLine = { timeMs: number; text: string };
// Entries that share one timing: when their first and last sung lines fall. LRCLIB often holds several,
// e.g. the album's timing and a music video's, which starts later by the video's intro.
export type TimingVersion = { lines: LyricLine[]; firstMs: number; lastMs: number; entries: number };
// Synced and plain results carry the timing versions found, so the widget can offer the others;
// `reason` says why these lines were chosen.
export type Lyrics =
  | { kind: 'synced'; lines: LyricLine[]; versions?: TimingVersion[]; reason?: string }
  | { kind: 'plain'; text: string; versions?: TimingVersion[] }
  | { kind: 'instrumental' }
  | { kind: 'none' }
  | { kind: 'error' };
export type LyricsTrack = { title?: string; artist?: string; album?: string; durationMs?: number };
// What a lookup tried, step by step, for the widget's debug readout.
export type LyricsTrace = { key: string | null; steps: string[] };

type LrclibRecord = { id?: unknown; trackName?: unknown; artistName?: unknown; albumName?: unknown; duration?: unknown; instrumental?: unknown; plainLyrics?: unknown; syncedLyrics?: unknown };

const API = 'https://lrclib.net/api';
// LRCLIB asks clients to identify themselves. Browsers can't set User-Agent, so use its alternative header.
const HEADERS = { 'Lrclib-Client': 'Open Dock (https://github.com/naveen-devang/Open Dock)' };
let lrclibUserAgent: string | undefined;
// Android opts in at app startup: LRCLIB rejects OkHttp's generic User-Agent.
// Other platforms retain their existing headers; this never changes global fetch.
export function setLyricsUserAgent(userAgent: string | undefined) {
  lrclibUserAgent = userAgent;
}
const TIMEOUT_MS = 8000;
// Waits before the 2nd and 3rd attempt. A Retry-After from LRCLIB wins, up to MAX_RETRY_WAIT_MS.
const RETRY_DELAYS_MS = [1000, 3000];
const MAX_RETRY_WAIT_MS = 10_000;
const DURATION_TOLERANCE_S = 3;
// The same title and artist this far off in length can supply a fallback (music videos run long).
const LOOSE_DURATION_TOLERANCE_S = 90;
// Relax the duration match only when enough matching entries agree overwhelmingly.
const DOMINANT_MIN_ENTRIES = 5;
const DOMINANT_SHARE = 0.8;
const DOMINANT_RATIO = 4;
const CACHE_SIZE = 20;
// LRCLIB is crowd-sourced and holds test entries (e.g. one line of "probe"); fewer real lines than this is junk.
const MIN_LYRIC_LINES = 3;
const cache = new Map<string, Promise<Lyrics>>();
const traces = new Map<string, string[]>();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Sizes for a lyrics widget block in px. The phone widget and the desktop preview both use it, so they match.
// Short blocks (about one grid row) pin the active line to the top, showing it and the next line only.
export function lyricsLayout(width: number, height: number) {
  const compact = height < 150;
  const fontSize = compact ? clamp(Math.min(width * 0.09, height * 0.17), 11, 20) : clamp(Math.min(width * 0.075, height * 0.11), 14, 30);
  const padding = fontSize * 0.6;
  return {
    compact,
    fontSize,
    padding,
    lineGap: fontSize * 0.55,
    // Where the active line's top sits.
    anchorY: compact ? padding : height * 0.32,
    messageSize: clamp(Math.min(width * 0.06, height * 0.12), 11, 18),
  };
}

// Apple Music-style falloff: the active line is solid, neighbours fade with distance.
// Near lines stay readable and far ones fade. Dark ink on a light screen fades to a pale grey long before light ink on a
// dark screen fades to a dim one, so the light look keeps its lines stronger.
export const lyricLineOpacity = (distance: number, light = false) => (light ? [1, 0.55, 0.45, 0.36][distance] ?? 0.28 : [1, 0.35, 0.27, 0.21][distance] ?? 0.15);

// Unicode clean-up: one form for accents and full-width characters, no invisible characters, single spaces.
export function normalizeText(text: string): string {
  let value = text;
  try {
    value = value.normalize('NFKC');
  } catch {
    // Engines without normalization data keep the text as it came.
  }
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

// One key per track; null when a lookup can't succeed (no title, clips, long streams).
// The duration is optional: some players never publish one, and the lookup then matches by name.
export function lyricsTrackKey(track: LyricsTrack): string | null {
  const title = normalizeText(track.title ?? '');
  const duration = track.durationMs;
  if (!title || (duration !== undefined && (duration < 30_000 || duration > 15 * 60_000))) return null;
  return [title, normalizeText(track.artist ?? ''), normalizeText(track.album ?? ''), duration ? Math.round(duration / 1000) : ''].join('\u0000');
}

// A line with no words (LRCLIB writes instrumental breaks as "♪") shows as the gap dots.
export const isGapLine = (line: LyricLine) => line.text.replace(/[♪♫♩♬\s]/g, '') === '';

export function parseLrc(source: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (stamps.length === 0) continue;
    // Word-sync tags (<mm:ss.xx>) are dropped; v1 is line-synced.
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').replace(/\s+/g, ' ').trim();
    for (const [, minutes, seconds] of stamps) {
      lines.push({ timeMs: Math.round((Number(minutes) * 60 + Number(seconds.replace(':', '.'))) * 1000), text });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

// A long wait before the first line gets its own gap, so the intro shows the dots too.
export function withIntroGap(lines: LyricLine[]): LyricLine[] {
  return lines.length > 0 && lines[0].timeMs >= 5000 && !isGapLine(lines[0]) ? [{ timeMs: 0, text: '' }, ...lines] : lines;
}

// Index of the line playing at `positionMs`, or -1 before the first line.
export function activeLineAt(lines: LyricLine[], positionMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].timeMs <= positionMs) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

// Words are bounded by spaces, brackets or the ends, so a letter of any script next to "ft" is never a boundary.
const TITLE_NOISE = /\s*[([](?:[^)\]]*?[\s,/&+-])?(?:official|video|audio|lyrics?|lyrical|visuali[sz]er|mv|hd|hq|4k|explicit|clean|full song)(?=$|[\s)\].,:/&+-])[^)\]]*[)\]]/gi;
const FROM_FILM = /\s*[([]\s*from\s[^)\]]*[)\]]/gi;
const FEATURING = /(?:^|[\s([])(?:feat\.?|ft\.?|featuring)\s.*$/i;
// Label words in front of the song name: "Full Video: X", "Lyrical - X", and with a colon only (so a song
// that starts with one of these words keeps it) "Official: X", "Exclusive: X", "Latest: X", "New: X", "HD: X".
const VIDEO_PREFIX = /^(?:(?:full\s+(?:video|song|audio)|lyrical(?:\s+video)?|video\s+song|official\s+(?:music\s+)?(?:video|audio))\s*[:|\-–—]|(?:official|exclusive|latest|new|hd)\s*:)\s*/i;
const HASHTAGS = /(?:^|\s)#[^\s#]+/g;
const EMOJI = /[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}\u{fe0f}\u{200d}]/gu;
const FIRST_ARTIST = /\s*(?:,|&|;|\/|\sx\s|\sand\s|\swith\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s).*$/i;
// Unbracketed video words at the end: "Song M/V", "Song Official MV", "Song Performance Video".
const TRAILING_NOISE = /\s+(?:official\s+)?(?:m\/v|mv|music\s+video|lyrics?\s+video|performance\s+video|special\s+video|visuali[sz]er|full\s+video\s+song|video\s+song|full\s+song|audio\s+song|lyrical(?:\s+video)?|video|audio)$/i;
// Indian label uploads end the song name with "Song" ("Jhoome Jo Pathaan Song"), but so do real titles
// ("Love Song", "Any Song"), so it is only ever tried as an extra reading, and only when 2+ words remain.
const TRAILING_SONG = /^(\S+\s+\S.*?)\s+song$/i;

// The title without a trailing "Song", or null when there is none to drop.
export const withoutSong = (title: string) => title.match(TRAILING_SONG)?.[1] ?? null;
// A quoted song name inside a video title, as K-pop and J-pop uploads write it: ARTIST 'Song' MV, ARTIST「Song」.
// An ASCII or curly quote opens after a space, bracket or dash and closes before one, so apostrophes
// inside words ("Don't", "It's Me") neither open nor close it. Corner brackets are always quotes.
const QUOTED = /(?:^|[\s([\-–—:])['‘"“](.{2,}?)['’"”](?=$|[\s)\].,:!?\-–—])|[「『](.+?)[」』]/;
// A native-script name in brackets after an artist: "MEOVV(미야오)" -> "MEOVV".
const BRACKETED = /\s*[([][^)\]]*[)\]]/g;

// Strips video-style decoration: 'Full Video: Song (From "Film") | Actor | #tag [4K] ft. X' -> "Song".
export function cleanTitle(title: string): string {
  const firstSegment = normalizeText(title).replace(EMOJI, '').replace(HASHTAGS, ' ').split('|').map((part) => part.trim()).find(Boolean) ?? '';
  // " _ " separates artist and song like " - " does ("[MV] IU(아이유) _ 좋은 날").
  return firstSegment.replace(/\s+_\s+/g, ' - ').replace(VIDEO_PREFIX, '').replace(TITLE_NOISE, '').replace(FROM_FILM, '').replace(FEATURING, '').replace(/\s+/g, ' ').trim().replace(TRAILING_NOISE, '').trim();
}

// "ArtistVEVO", "Artist - Topic" and "Artist Official" are channel names, not artists.
export function cleanArtist(artist: string): string {
  return normalizeText(artist).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s+Official$/i, '').replace(FEATURING, '').trim();
}

// "MEOVV(미야오) - 'In my hands' M/V" -> { title: "In my hands", artist: "MEOVV" }.
export function quotedSong(title: string): { title: string; artist: string } | null {
  // Matched before the feat./noise clean-up, which would cut "'Song (Feat. X)' MV" off at "Feat.".
  const segment = normalizeText(title).replace(EMOJI, '').replace(HASHTAGS, ' ').split('|').map((part) => part.trim()).find(Boolean) ?? '';
  const text = segment.replace(VIDEO_PREFIX, '');
  const match = text.match(QUOTED);
  if (!match || match.index === undefined) return null;
  const artist = text.slice(0, match.index).replace(BRACKETED, '').replace(/[\s\-–—:]+$/, '').trim();
  return { title: cleanTitle(match[1] ?? match[2]), artist: cleanArtist(artist) };
}

export type SearchQuery = { label: string; params: Record<string, string> };

// The searches tried after an exact miss, most specific first, without duplicates.
// Every result is checked against the track before it is used (see pickSearchResult), so broad searches are safe.
export function searchQueries(track: LyricsTrack): SearchQuery[] {
  const title = cleanTitle(track.title ?? '');
  const artist = cleanArtist(track.artist ?? '');
  const firstArtist = artist.replace(FIRST_ARTIST, '').trim();
  const queries: SearchQuery[] = [];
  const add = (label: string, trackName: string, artistName: string | null) => {
    if (!trackName || artistName === '') return;
    queries.push({ label, params: artistName === null ? { track_name: trackName } : { track_name: trackName, artist_name: artistName } });
  };
  add('title + artist', title, artist);
  const songless = withoutSong(title);
  if (songless) add('title without "Song" + artist', songless, artist);
  // A quoted song name is the strongest hint a video title carries, so it goes next.
  const quoted = quotedSong(track.title ?? '');
  if (quoted) {
    add('quoted title + artist before it', quoted.title, quoted.artist);
    // "aespa エスパ" -> "aespa": uploads often follow the artist with its name in another script.
    add('quoted title + artist before it, Latin part', quoted.title, quoted.artist.replace(/(?:\s+[^\s\x00-\x7f]+)+$/, ''));
    add('quoted title + artist', quoted.title, artist);
    add('quoted title only', quoted.title, null);
  }
  add('title + first artist', title, firstArtist);
  // "Artist - Song" (most uploads) or "Song - Film" (soundtracks): try the halves both ways.
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    add('right half + left half as artist', cleanTitle(dash[2]), cleanArtist(dash[1]));
    add('left half only', cleanTitle(dash[1]), null);
    add('right half only', cleanTitle(dash[2]), null);
  }
  add('title only', title, null);
  if (songless) add('title without "Song" only', songless, null);
  if (title) queries.push({ label: 'free text', params: { q: `${title} ${firstArtist}`.trim() } });
  return queries.filter((query, index) => queries.findIndex((other) => JSON.stringify(other.params) === JSON.stringify(query.params)) === index);
}

function fromRecord(record: LrclibRecord): Lyrics | null {
  if (typeof record.syncedLyrics === 'string') {
    const lines = parseLrc(record.syncedLyrics);
    if (lines.filter((line) => !isGapLine(line)).length >= MIN_LYRIC_LINES) return { kind: 'synced', lines };
  }
  if (record.instrumental === true) return { kind: 'instrumental' };
  if (typeof record.plainLyrics === 'string' && record.plainLyrics.split(/\r?\n/).filter((line) => line.trim()).length >= MIN_LYRIC_LINES) return { kind: 'plain', text: record.plainLyrics.trim() };
  return null;
}

// Lyrics shown without timing, for matches that can't be trusted to sync.
function asPlain(lyrics: Lyrics | null): Extract<Lyrics, { kind: 'plain' }> | null {
  if (lyrics?.kind === 'synced') return { kind: 'plain', text: lyrics.lines.filter((line) => !isGapLine(line)).map((line) => line.text).join('\n') };
  return lyrics?.kind === 'plain' ? lyrics : null;
}

// Lower-case with ASCII and CJK punctuation as spaces; letters of every script are kept.
const comparable = (text: string) => normalizeText(text).toLowerCase().replace(/[\s!-/:-@[-`{-~\u2010-\u205e\u3000-\u303f]+/g, ' ').trim();

const squash = (text: string) => comparable(text).replace(/ /g, '');
const ARTIST_SEPARATOR = /\s*(?:,|&|;|\/|×|、|및|\sx\s|\sand\s|\swith\s|\svs\.?\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s)\s*/i;

// Letters of the scripts a song name can arrive in instead of its Latin title: Hangul (and its jamo),
// kana, CJK ideographs and Devanagari.
const NATIVE_LETTER = /[가-힣ㄱ-ㆎぁ-ヿ㐀-鿿ऄ-ॿ]/;
const NATIVE_LETTERS = /[가-힣ㄱ-ㆎぁ-ヿ㐀-鿿ऄ-ॿ]+/g;

export const hasNativeScript = (text: string) => NATIVE_LETTER.test(text);

// The Latin half of a title written in two scripts: "해야 (HEYA)" -> "HEYA", "YENA(최예나)" -> "YENA".
export function latinPart(text: string): string {
  const latin = normalizeText(text).replace(NATIVE_LETTERS, ' ').replace(/[_|]/g, ' ').replace(/[([]\s*[)\]]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s\-–—:.,/]+|[\s\-–—:.,/]+$/g, '').trim()
    // "좋은 날(Good Day)" leaves "(Good Day)": brackets around the whole half go too.
    .replace(/^[([]\s*([^()[\]]*?)\s*[)\]]$/, '$1');
  return /[a-z]{2}/i.test(latin) ? latin : '';
}

// The native-script half: "해야 (HEYA)" -> "해야".
export function nativePart(text: string): string {
  return (normalizeText(text).match(NATIVE_LETTERS) ?? []).join(' ');
}

// Hangul syllables are an initial, a vowel and a final consonant, encoded arithmetically from U+AC00.
const HANGUL_INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const HANGUL_VOWELS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const HANGUL_FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
// Hiragana; katakana is mapped onto it first. Small っ doubles the next consonant, which the sound key ignores anyway.
const KANA: Record<string, string> = Object.fromEntries(('あa いi うu えe おo かka きki くku けke こko がga ぎgi ぐgu げge ごgo ' +
  'さsa しshi すsu せse そso ざza じji ずzu ぜze ぞzo たta ちchi つtsu てte とto だda ぢji づzu でde どdo ' +
  'なna にni ぬnu ねne のno はha ひhi ふfu へhe ほho ばba びbi ぶbu べbe ぼbo ぱpa ぴpi ぷpu ぺpe ぽpo ' +
  'まma みmi むmu めme もmo やya ゆyu よyo らra りri るru れre ろro わwa ゐi ゑe をo んn ゔvu ' +
  'ぁa ぃi ぅu ぇe ぉo ゃya ゅyu ょyo ゎwa っ').split(' ').map((pair) => [pair[0], pair.slice(1)]));
const DEVANAGARI: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l',
};

// Spells Hangul, kana and Devanagari out in Latin letters by sound, so loanword titles can be compared
// with their English names ("캐치 캐치" -> "kaechi kaechi"). Null when the text holds ideographs, whose
// readings need a dictionary.
export function romanize(text: string): string | null {
  let out = '';
  for (const ch of normalizeText(text)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xac00 && code <= 0xd7a3) {
      const index = code - 0xac00;
      out += HANGUL_INITIALS[Math.floor(index / 588)] + HANGUL_VOWELS[Math.floor((index % 588) / 28)] + HANGUL_FINALS[index % 28];
    } else if (code >= 0x3041 && code <= 0x30ff) {
      // Katakana sits 0x60 above hiragana; the long-vowel mark adds no consonant.
      const hiragana = code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
      out += KANA[hiragana] ?? '';
    } else if (code >= 0x0900 && code <= 0x097f) {
      // Vowel letters and signs carry no consonant; anusvara and chandrabindu are nasal.
      out += DEVANAGARI[ch] ?? (code === 0x0901 || code === 0x0902 ? 'n' : (code >= 0x0904 && code <= 0x0914) || (code >= 0x093e && code <= 0x094c) ? 'a' : '');
    } else if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3131 && code <= 0x318e)) {
      return null;
    } else out += ch;
  }
  return out;
}

// A loose sound key: consonants only, with the ones scripts swap for each other merged (c/k/g/q, b/p/f/v,
// d/t/th, l/r, ch/j/sh/z), vowels and h/w/y dropped, repeats collapsed. "Catch Catch" and "kaechi kaechi"
// both give KCKC; "Good Day" (KT) and "joteun nal" (CTnR) do not meet.
export function soundKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, '')
    .replace(/tch|ch|sh|zh|j|z/g, 'C')
    .replace(/ck|q|g|k|c(?![eiy])/g, 'K').replace(/c/g, 's')
    .replace(/ph|f|v|b|p/g, 'P')
    .replace(/th|d|t/g, 'T')
    .replace(/l|r/g, 'R')
    .replace(/x/g, 'Ks')
    .replace(/[aeiouyhw]/g, '')
    .replace(/(.)\1+/g, '$1');
}

export type AliasCandidate = { title: string; durationS?: number };
export type Alias = { title: string; how: string };

// Keys this short ("해야" -> "", "하입보이" -> "P") are too common to trust on sound alone.
const MIN_SOUND_KEY = 3;
const SAME_LENGTH_S = 2;

// Whether a song this long can be the track playing: the same length, or a video up to 90 s longer.
function fitsTrack(durationS: number | undefined, durationMs: number | undefined) {
  if (durationS === undefined || !durationMs) return false;
  const gap = durationMs / 1000 - durationS;
  return Math.abs(gap) <= DURATION_TOLERANCE_S || (gap > 0 && gap <= LOOSE_DURATION_TOLERANCE_S);
}

// Finds the Latin title a native-script song name stands for among the artist's songs, strongest evidence
// first, and only when exactly one song fits:
// 1. a title written in both scripts ("해야 (HEYA)");
// 2. the same sound ("캐치 캐치" ~ "Catch Catch"), with short sound keys also needing a fitting length;
// 3. the same length as a recording catalogued under the native title, for real translations ("좋은 날" = "Good Day").
export function matchAlias(native: string, candidates: AliasCandidate[], durationMs?: number, nativeLengthsS: number[] = []): Alias | null {
  const wanted = comparable(native);
  const latinOf = (candidate: AliasCandidate) => cleanTitle(latinPart(candidate.title));
  const only = (list: AliasCandidate[]) => {
    const titles = [...new Map(list.map((candidate) => [comparable(latinOf(candidate)), latinOf(candidate)])).values()].filter(Boolean);
    return titles.length === 1 ? titles[0] : null;
  };
  const bilingual = only(candidates.filter((candidate) => latinOf(candidate) && comparable(nativePart(candidate.title)) === wanted));
  if (bilingual) return { title: bilingual, how: 'title in both scripts' };
  const spelled = romanize(native);
  if (spelled) {
    const key = soundKey(spelled);
    const sounding = candidates.filter((candidate) => latinOf(candidate) && !hasNativeScript(candidate.title) && soundKey(latinOf(candidate)) === key);
    const title = only(key.length >= MIN_SOUND_KEY ? sounding : sounding.filter((candidate) => fitsTrack(candidate.durationS, durationMs)));
    if (title) return { title, how: `sounds the same (${spelled.trim()})` };
  }
  const sameLength = candidates.filter((candidate) => latinOf(candidate) && candidate.durationS !== undefined &&
    nativeLengthsS.some((length) => Math.abs(length - (candidate.durationS ?? 0)) <= SAME_LENGTH_S));
  const title = only(sameLength);
  return title ? { title, how: 'same length as the recording under its native title' } : null;
}

// What a result is checked against: everything the PC reported about the track.
// `titles` are every reading of the song name; `strongTitles` leave out the left half of "A - B", which is
// as often the artist ("아이유 - 좋은 날") as the song ("Kesariya - Brahmāstra").
export type MatchContext = { durationMs?: number; titles: string[]; strongTitles: string[]; text: string; artists: string[]; videoTitle: boolean };

// Words that mark a music video upload rather than the song itself.
const VIDEO_MARKERS = /(?:^|[\s([\-–—:|])(?:m\/v|mv|music video|official video|performance video|special video|lyrics? video|visuali[sz]er|dance practice)(?=$|[\s)\].,:|!\-–—])/i;

// `alias` is the song's Latin title and artist when the PC reported them in another script.
export function matchContext(track: LyricsTrack, alias?: { title: string; artist?: string }): MatchContext {
  const quoted = quotedSong(track.title ?? '');
  const title = cleanTitle(track.title ?? '');
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const artist = cleanArtist(track.artist ?? '');
  return {
    durationMs: track.durationMs,
    titles: [title, withoutSong(title), quoted?.title, dash?.[1], dash?.[2], alias?.title].filter((value): value is string => Boolean(value)).map((value) => comparable(cleanTitle(value))),
    strongTitles: [title, withoutSong(title), quoted?.title, dash?.[2], alias?.title].filter((value): value is string => Boolean(value)).map((value) => comparable(cleanTitle(value))),
    // Title, channel and album together: an artist named anywhere in them counts ("Song | Arijit Singh" on a label's channel).
    text: ` ${comparable([track.title, track.artist, track.album, alias?.title, alias?.artist].filter(Boolean).join(' '))} `,
    artists: [artist, quoted?.artist, dash?.[1], alias?.artist].filter((value): value is string => Boolean(value)).map(squash).filter((value) => value.length >= 2),
    videoTitle: VIDEO_MARKERS.test(normalizeText(track.title ?? '')),
  };
}

// The result's title once both are cleaned up: 'Song (From "Film")' is "Song", but "Song (Dance Mix)" is
// another version. A title of 3+ characters found whole inside a video title counts too.
// A title in both scripts ("해야 (HEYA)") matches either half. `strong` accepts only the song name's
// firm readings, for matches no length backs up.
export function titleMatches(record: LrclibRecord, context: MatchContext, strong = false) {
  const raw = typeof record.trackName === 'string' ? record.trackName : '';
  const found = comparable(cleanTitle(raw));
  const titles = strong ? context.strongTitles : context.titles;
  const halves = [comparable(cleanTitle(latinPart(raw))), comparable(nativePart(raw))].filter((half) => half && half !== found);
  return Boolean(found) && (titles.includes(found) || halves.some((half) => titles.includes(half)) || (!strong && found.length >= 3 && context.text.includes(` ${found} `)));
}

// Any of the result's artists is named in what the PC reported. Latin names must match whole words;
// names in other scripts are found anywhere, and "TheWeekndVEVO" matches "The Weeknd" with spaces ignored.
export function artistMatches(record: LrclibRecord, context: MatchContext) {
  if (typeof record.artistName !== 'string') return false;
  return normalizeText(record.artistName).split(ARTIST_SEPARATOR).some((part) => {
    const name = comparable(part);
    if (name.length < 2) return false;
    if (context.artists.includes(squash(part))) return true;
    return /^[ -~]+$/.test(name) ? context.text.includes(` ${name} `) : context.text.includes(name);
  });
}

const durationGap = (record: LrclibRecord, durationMs?: number) => !durationMs ? 0 : typeof record.duration === 'number' ? Math.abs(record.duration - durationMs / 1000) : Infinity;
const KIND_RANK: Record<Lyrics['kind'], number> = { synced: 0, instrumental: 1, plain: 2, none: 3, error: 3 };

// `overruns`: synced lines running past the end of the track. Its timing belongs to a longer cut and is
// never used automatically, but its words still serve as unsynced text and its timing is offered to pick.
type Rated = { lyrics: Lyrics; gap: number; listedS?: number; title: boolean; strongTitle: boolean; artist: boolean; overruns: boolean };

function rate(results: LrclibRecord[], context: MatchContext): Rated[] {
  return results.flatMap((record) => {
    const lyrics = fromRecord(record);
    if (!lyrics) return [];
    const overruns = lyrics.kind === 'synced' && Boolean(context.durationMs) && lyrics.lines[lyrics.lines.length - 1].timeMs > (context.durationMs ?? 0) + 5000;
    const listedS = typeof record.duration === 'number' ? record.duration : undefined;
    return [{ lyrics, gap: durationGap(record, context.durationMs), listedS, title: titleMatches(record, context), strongTitle: titleMatches(record, context, true), artist: artistMatches(record, context), overruns }];
  }).sort((a, b) => Number(b.artist) - Number(a.artist) || Number(b.title) - Number(a.title) || KIND_RANK[a.lyrics.kind] - KIND_RANK[b.lyrics.kind] || a.gap - b.gap);
}

// Two entries share a timing when their first and last sung lines are this close.
const VERSION_TOLERANCE_MS = 400;
// Video intros only ever push lyrics later, and not by more than this; a later start is someone's mistake.
const MAX_INTRO_MS = 60_000;
// A track this much longer than the song's usual length is a video with extras.
const VIDEO_EXTRA_S = 8;

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)} s`;

export function sungSpan(lines: LyricLine[]) {
  const sung = lines.filter((line) => !isGapLine(line));
  return { firstMs: sung[0]?.timeMs ?? 0, lastMs: sung[sung.length - 1]?.timeMs ?? 0 };
}

// Groups synced lyrics by timing, most entries first: copies of the same timing count once with their tally.
export function timingVersions(all: LyricLine[][]): TimingVersion[] {
  const versions: TimingVersion[] = [];
  for (const lines of all) {
    const { firstMs, lastMs } = sungSpan(lines);
    const same = versions.find((version) => Math.abs(version.firstMs - firstMs) <= VERSION_TOLERANCE_MS && Math.abs(version.lastMs - lastMs) <= VERSION_TOLERANCE_MS);
    if (same) same.entries += 1;
    else versions.push({ lines, firstMs, lastMs, entries: 1 });
  }
  return versions.sort((a, b) => b.entries - a.entries || a.firstMs - b.firstMs);
}

// The timing version nearest to a first and last sung line (the last only when known), or none within the
// grouping tolerance. Two versions can open together and differ by seconds at the end, so both lines count.
export function nearestVersion(versions: TimingVersion[], firstMs: number, lastMs?: number): TimingVersion | undefined {
  let nearest: TimingVersion | undefined;
  let nearestGap = Infinity;
  for (const version of versions) {
    const firstGap = Math.abs(version.firstMs - firstMs);
    const lastGap = lastMs === undefined ? 0 : Math.abs(version.lastMs - lastMs);
    if (firstGap > VERSION_TOLERANCE_MS || lastGap > VERSION_TOLERANCE_MS || firstGap + lastGap >= nearestGap) continue;
    nearest = version;
    nearestGap = firstGap + lastGap;
  }
  return nearest;
}

const syncedLines = (rated: Rated[]) => rated.flatMap((entry) => entry.lyrics.kind === 'synced' ? [entry.lyrics.lines] : []);

// A music video: its title says so, or it runs well past the length the song's entries list.
function isVideo(context: MatchContext, matching: Rated[]) {
  if (context.videoTitle) return true;
  const listed = matching.flatMap((entry) => entry.listedS === undefined ? [] : [entry.listedS]).sort((a, b) => a - b);
  const duration = context.durationMs;
  return Boolean(duration && listed.length > 0) && listed[Math.floor(listed.length / 2)] <= (duration ?? 0) / 1000 - VIDEO_EXTRA_S;
}

// A result to show in sync.
// - Accepted entries: with a duration, within 3 s and the right title or artist (the right artist ranking
//   first); without one, title and artist must both match.
// - A music video with several timings takes the latest-starting one: its intro delays the singing, and
//   listed lengths can't tell (people upload the album's timing under the video's length).
// - Otherwise the timing most accepted entries share wins, so one odd entry can't outvote the rest.
// - If no timing was accepted, a dominant group of nearby title-and-artist matches can supply one.
export function pickSearchResult(results: LrclibRecord[], context: MatchContext, options: { allowDominant?: boolean } = {}): Lyrics | null {
  const rated = rate(results, context);
  const strict = rated.filter((entry) => !entry.overruns && (context.durationMs
    ? entry.gap <= DURATION_TOLERANCE_S && (entry.title || entry.artist)
    : entry.strongTitle && entry.artist));
  const strong = rated.filter((entry) => entry.strongTitle && entry.artist);
  const pool = [...new Set([...strict, ...strong])];
  // Every timing found is offered in the widget; only the ones that fit the track are chosen automatically.
  const versions = timingVersions(syncedLines(pool));
  const fitting = timingVersions(syncedLines(pool.filter((entry) => !entry.overruns)));
  if (fitting.length > 1 && isVideo(context, strong)) {
    const usual = fitting[0];
    const later = fitting
      .filter((version) => version.firstMs > usual.firstMs + VERSION_TOLERANCE_MS && version.firstMs - usual.firstMs <= MAX_INTRO_MS)
      .sort((a, b) => b.firstMs - a.firstMs)[0];
    if (later) return { kind: 'synced', lines: later.lines, versions, reason: `music video: starts ${seconds(later.firstMs - usual.firstMs)} after the usual timing` };
  }
  const strictVersions = timingVersions(syncedLines(strict));
  if (strictVersions.length > 0) {
    const chosen = strictVersions[0];
    const reason = strictVersions.length > 1 ? `most matching entries (${chosen.entries} of ${strictVersions.reduce((total, version) => total + version.entries, 0)})` : 'length and name match';
    return { kind: 'synced', lines: chosen.lines, versions, reason };
  }
  const best = strict[0]?.lyrics;
  if (best?.kind === 'instrumental') return best;
  // Lookup defers consensus until all search queries have had a chance to find a stronger match.
  if (options.allowDominant === false) return best?.kind === 'plain' && versions.length > 0 ? { ...best, versions } : best ?? null;
  // Existing matches win. For a fallback, require both names, a nearby listed length, and all
  // timestamps within playback; the usual 5 s overrun allowance does not apply to this guess.
  const eligible = strong.filter((entry) => entry.gap <= LOOSE_DURATION_TOLERANCE_S &&
    entry.lyrics.kind === 'synced' && !entry.overruns &&
    (!context.durationMs || entry.lyrics.lines[entry.lyrics.lines.length - 1].timeMs <= context.durationMs));
  const dominantVersions = timingVersions(syncedLines(eligible));
  const dominant = dominantVersions[0];
  const total = dominantVersions.reduce((count, version) => count + version.entries, 0);
  if (dominant && dominant.entries >= DOMINANT_MIN_ENTRIES && dominant.entries >= total * DOMINANT_SHARE &&
    dominant.entries >= (dominantVersions[1]?.entries ?? 0) * DOMINANT_RATIO) {
    return { kind: 'synced', lines: dominant.lines, versions, reason: `dominant matching entries (${dominant.entries} of ${total})` };
  }
  if (!best) return null;
  return best.kind === 'plain' && versions.length > 0 ? { ...best, versions } : best;
}

// The same song at another length (a music video with an intro, a radio edit): title and artist both
// match within 90 s, shown unsynced because its timing would be off. Its timing versions come along,
// so the widget can still offer them.
export function pickLooseResult(results: LrclibRecord[], context: MatchContext): Lyrics | null {
  const matching = rate(results, context).filter((entry) => entry.strongTitle && entry.artist);
  const versions = timingVersions(syncedLines(matching));
  const near = matching.filter((entry) => entry.gap <= LOOSE_DURATION_TOLERANCE_S).sort((a, b) => a.gap - b.gap);
  for (const entry of near) {
    const plain = asPlain(entry.lyrics);
    if (plain) return versions.length > 0 ? { ...plain, versions } : plain;
  }
  return null;
}

class RetriableError extends Error {
  waitMs?: number;
  constructor(message: string, waitMs?: number) {
    super(message);
    this.waitMs = waitMs;
  }
}

const DEEZER = 'https://api.deezer.com';
const MUSICBRAINZ = 'https://musicbrainz.org/ws/2';
// MusicBrainz asks for an identifying User-Agent. Browsers (the desktop preview) don't allow setting one.
const IS_REACT_NATIVE = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
const MUSICBRAINZ_HEADERS: Record<string, string> = IS_REACT_NATIVE ? { 'User-Agent': 'Open Dock/1.0 (https://github.com/naveen-devang/Open Dock)', Accept: 'application/json' } : { Accept: 'application/json' };

// Built by hand: React Native's URLSearchParams has been incomplete across versions.
const queryString = (params: Record<string, string>) => Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');

// These services answer an error now and then: up to three attempts, waiting 1 s then 3 s, or as long as asked.
async function getJson(url: string, steps: string[], headers: Record<string, string> = HEADERS): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getJsonOnce(url, headers);
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !(error instanceof RetriableError)) throw error;
      const wait = Math.min(MAX_RETRY_WAIT_MS, error.waitMs ?? delay);
      steps.push(`  ${error.message}; retrying in ${wait} ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function getJsonOnce(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const host = url.split('/')[2];
  try {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: controller.signal });
    } catch {
      throw new RetriableError(`${host} ${controller.signal.aborted ? 'timed out' : 'could not be reached'}`);
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new RetriableError(`${host} responded ${response.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
    }
    // 404 is "no match"; any other 4xx means the service can't answer this request, which counts the same.
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const lrclib = (path: string, params: Record<string, string>, steps: string[]) => getJson(
  `${API}${path}${Object.keys(params).length > 0 ? `?${queryString(params)}` : ''}`,
  steps,
  lrclibUserAgent ? { ...HEADERS, 'User-Agent': lrclibUserAgent } : HEADERS,
);
const describe = (params: Record<string, string>) => Object.entries(params).map(([key, value]) => `${key}="${value}"`).join(' ');
const records = (value: unknown) => Array.isArray(value) ? value as LrclibRecord[] : [];
// Deezer reports errors (quota, unknown query) inside a 200 response, so anything without `data` is empty.
const deezerItems = (value: unknown) => value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data) ? (value as { data: Record<string, unknown>[] }).data : [];

// The song name as the PC reported it, when it is in another script: the quoted name of a video title,
// else whichever half of "A - B" carries the script, else the whole cleaned title.
export function nativeSongTitle(track: LyricsTrack): string | null {
  const title = cleanTitle(track.title ?? '');
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const options = [quotedSong(track.title ?? '')?.title, dash?.[2], dash?.[1], title];
  return options.find((option): option is string => Boolean(option) && hasNativeScript(option ?? '') && nativePart(option ?? '') !== '') ?? null;
}

// The artist's Latin name, from the video title before the channel (a label's channel names no artist):
// "YENA(최예나)" -> "YENA", "[MV] IU(아이유) _ 좋은 날" on 1theK -> "IU".
export function latinArtist(track: LyricsTrack): string | null {
  const title = cleanTitle(track.title ?? '');
  const options = [quotedSong(track.title ?? '')?.artist, title.match(/^(.+?)\s+[-–—]\s+/)?.[1], track.artist];
  for (const option of options) {
    const latin = option ? cleanArtist(latinPart(option)) : '';
    if (latin) return latin;
  }
  return null;
}

// Finds the Latin title of a song the PC reported in another script, from the artist's songs on LRCLIB
// and Deezer, and lengths catalogued on MusicBrainz. Each source that fails is skipped.
async function findAlias(track: LyricsTrack, native: string, artist: string, steps: string[]): Promise<Alias | null> {
  const artistContext = matchContext({ artist });
  const candidates: AliasCandidate[] = [];
  const add = (title: unknown, durationS: unknown) => {
    if (typeof title === 'string' && title) candidates.push({ title, durationS: typeof durationS === 'number' ? durationS : undefined });
  };
  const sources: [string, () => Promise<void>][] = [
    ['LRCLIB', async () => {
      for (const record of records(await lrclib('/search', { q: artist }, steps))) if (artistMatches(record, artistContext)) add(record.trackName, record.duration);
    }],
    ['Deezer', async () => {
      // Titles stored in both scripts turn up when searching with the native one.
      for (const item of deezerItems(await getJson(`${DEEZER}/search?${queryString({ q: `${artist} ${native}` })}`, steps, {}))) {
        const name = (item.artist as { name?: unknown } | undefined)?.name;
        if (typeof name === 'string' && artistMatches({ artistName: name }, artistContext)) add(item.title, item.duration);
      }
      const found = deezerItems(await getJson(`${DEEZER}/search/artist?${queryString({ q: artist })}`, steps, {}))
        .find((item) => typeof item.name === 'string' && comparable(item.name) === comparable(artist));
      if (found && (typeof found.id === 'number' || typeof found.id === 'string')) {
        for (const item of deezerItems(await getJson(`${DEEZER}/artist/${found.id}/top?limit=100`, steps, {}))) add(item.title, item.duration);
      }
    }],
  ];
  for (const [name, load] of sources) {
    try {
      await load();
    } catch (error) {
      steps.push(`  ${name} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let alias = matchAlias(native, candidates, track.durationMs);
  if (!alias) {
    // MusicBrainz sometimes lists a song's other names on its work: 밤편지 is "Through the Night".
    try {
      const result = await getJson(`${MUSICBRAINZ}/work?${queryString({ query: `work:"${native.replace(/"/g, '')}"`, fmt: 'json', limit: '5' })}`, steps, MUSICBRAINZ_HEADERS);
      const works = result && typeof result === 'object' && Array.isArray((result as { works?: unknown }).works) ? (result as { works: { title?: unknown; aliases?: { name?: unknown }[] }[] }).works : [];
      const names = works.filter((work) => typeof work.title === 'string' && comparable(work.title) === comparable(native))
        .flatMap((work) => (work.aliases ?? []).flatMap((entry) => typeof entry.name === 'string' && latinPart(entry.name) ? [cleanTitle(latinPart(entry.name))] : []));
      // Only a name the artist actually has a song under: works are shared by every cover and namesake.
      const known = candidates.filter((candidate) => names.some((name) => comparable(name) === comparable(cleanTitle(latinPart(candidate.title)))));
      const distinct = [...new Set(known.map((candidate) => cleanTitle(latinPart(candidate.title))))];
      if (distinct.length === 1) alias = { title: distinct[0], how: 'another name for it on MusicBrainz' };
    } catch (error) {
      steps.push(`  MusicBrainz names skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!alias) {
    // Translated titles share no sound with their English names; the song's catalogued length can still tie them.
    // MusicBrainz allows one request a second.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    try {
      const search = `recording:"${native.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
      const result = await getJson(`${MUSICBRAINZ}/recording?${queryString({ query: search, fmt: 'json', limit: '10' })}`, steps, MUSICBRAINZ_HEADERS);
      const recordings = result && typeof result === 'object' && Array.isArray((result as { recordings?: unknown }).recordings) ? (result as { recordings: { title?: unknown; length?: unknown }[] }).recordings : [];
      const lengths = recordings.flatMap((recording) => typeof recording.title === 'string' && comparable(recording.title) === comparable(native) && typeof recording.length === 'number' ? [recording.length / 1000] : []);
      alias = matchAlias(native, candidates, track.durationMs, lengths);
    } catch (error) {
      steps.push(`  MusicBrainz skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  steps.push(`title in another script: ${candidates.length} songs by ${artist} -> ${alias ? `"${native}" is "${alias.title}" (${alias.how})` : `no Latin title found for "${native}"`}`);
  return alias;
}

async function lookup(track: LyricsTrack, steps: string[], typedTitle?: string): Promise<Lyrics> {
  const durationMs = track.durationMs;
  const title = normalizeText(track.title ?? '');
  const artist = normalizeText(track.artist ?? '');
  // Fallbacks, best first: plain lyrics from a close match, then unsynced text from a looser one.
  let plain: Lyrics | null = null;
  let loosePlain: Lyrics | null = null;
  let dominant: Lyrics | null = null;
  const accept = (label: string, lyrics: Lyrics | null): Lyrics | null => {
    if (lyrics && lyrics.kind !== 'plain') {
      steps.push(`matched: ${label} (${lyrics.kind})`);
      if (lyrics.kind === 'synced' && lyrics.versions && lyrics.versions.length > 0) {
        steps.push(`timings: ${lyrics.versions.map((version) => `starts ${seconds(version.firstMs)} x${version.entries}`).join(', ')} -> ${lyrics.reason ?? ''}`);
      }
      return lyrics;
    }
    plain ??= lyrics;
    return null;
  };
  // Runs the searches, the first of them together with an exact match when there is one.
  const searchAll = async (queries: SearchQuery[], context: MatchContext, exact: LrclibRecord | null) => {
    for (const [index, query] of queries.entries()) {
      const found = records(await lrclib('/search', query.params, steps));
      const list = exact && index === 0 ? [exact, ...found.filter((record) => record.id === undefined || record.id !== exact.id)] : found;
      const lyrics = pickSearchResult(list, context, { allowDominant: false });
      steps.push(`search ${query.label}: ${describe(query.params)} -> ${found.length} results${list === found ? '' : ' + the exact match'}, ${lyrics?.kind ?? 'none usable'}`);
      const accepted = accept(query.label, lyrics);
      if (accepted) return accepted;
      // Keep a consensus candidate private while later queries (including aliases) look for
      // the actual duration. Do not publish a provisional timing and then replace it.
      if (!dominant) {
        const candidate = pickSearchResult(list, context);
        if (candidate?.kind === 'synced') dominant = candidate;
      }
      loosePlain ??= pickLooseResult(list, context);
    }
    return null;
  };

  if (!typedTitle) {
    // Title + artist + length first (LRCLIB allows the length to be off by 2 s), then title + artist alone.
    const exactAttempts: Record<string, string>[] = [];
    if (artist && durationMs) exactAttempts.push({ track_name: title, artist_name: artist, duration: String(Math.round(durationMs / 1000)) });
    if (artist) exactAttempts.push({ track_name: title, artist_name: artist });
    // An exact match is one entry, and can be the odd one out (a video's timing filed under the song),
    // so it joins the first search's entries and is weighed with them rather than taken on its own.
    let exact: LrclibRecord | null = null;
    for (const params of exactAttempts) {
      const record = await lrclib('/get', params, steps);
      const lyrics = record && typeof record === 'object' && !Array.isArray(record) ? fromRecord(record as LrclibRecord) : null;
      steps.push(`get ${describe(params)} -> ${lyrics?.kind ?? 'no match'}`);
      if (lyrics) {
        exact = record as LrclibRecord;
        break;
      }
    }
    const found = await searchAll(searchQueries(track), matchContext(track), exact);
    if (found) return found;
  }

  // A song name in another script ("캐치 캐치") is often filed under its Latin title ("Catch Catch"):
  // find that title (or take the one typed in the widget) and search again with it.
  const latinName = latinArtist(track) ?? cleanArtist(artist);
  const native = typedTitle ? null : nativeSongTitle(track);
  // A song name already written in both scripts ("좋은 날(Good Day)") carries its own Latin title.
  const inline = native ? cleanTitle(latinPart(native)) : '';
  const alias: Alias | null = typedTitle ? { title: typedTitle, how: 'typed in the widget' }
    : inline ? { title: inline, how: 'given in the video title' }
    : native && latinName ? await findAlias(track, native, latinName, steps) : null;
  if (inline && !typedTitle) steps.push(`title in another script: "${native}" is "${inline}" (given in the video title)`);
  if (alias) {
    if (typedTitle) steps.push(`searching with the typed title "${typedTitle}"`);
    const aliasTrack = { title: alias.title, artist: latinName, album: track.album, durationMs };
    const found = await searchAll(searchQueries(aliasTrack), matchContext(track, { title: alias.title, artist: latinName }), null);
    if (found) return found;
  }
  if (dominant) return accept('dominant fallback after all searches', dominant) ?? dominant;
  const fallback: Lyrics = plain ?? loosePlain ?? { kind: 'none' };
  steps.push(`result: ${fallback.kind}${fallback === loosePlain ? ' (unsynced: length or version uncertain)' : ''}`);
  return fallback;
}

// Cache and trace key: the track, plus the title typed for it when there is one.
const lookupKey = (track: LyricsTrack, typedTitle?: string) => {
  const key = lyricsTrackKey(track);
  return key && typedTitle ? `${key}|typed:${normalizeText(typedTitle)}` : key;
};

// Looks a track up on LRCLIB, or with a title typed in the widget. Results stay in memory for the last
// few tracks; failures are retried next time.
export function fetchLyrics(track: LyricsTrack, typedTitle?: string): Promise<Lyrics> {
  const key = lookupKey(track, typedTitle);
  if (!key) return Promise.resolve({ kind: 'none' });
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const steps: string[] = [];
  traces.set(key, steps);
  const pending = lookup(track, steps, typedTitle ? normalizeText(typedTitle) : undefined).catch((error: unknown): Lyrics => {
    steps.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
    cache.delete(key);
    return { kind: 'error' };
  });
  cache.set(key, pending);
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    traces.delete(oldest);
  }
  return pending;
}

// The steps the latest lookup for this track took, for the widget's debug readout.
export function lyricsTrace(track: LyricsTrack, typedTitle?: string): LyricsTrace {
  const key = lookupKey(track, typedTitle);
  return { key, steps: key ? [...(traces.get(key) ?? [])] : [] };
}


// ── Find lyrics: search LRCLIB and list its entries so one can be picked ──────────────────────────────

// The song and artist typed into the Find lyrics screen.
export type EntryFields = { song: string; artist: string };

// What the screen's two fields start with, and one-tap suggestions for each, from what the PC reported.
export type FieldGuess = { song: string; artist: string; songs: string[]; artists: string[] };

const MAX_SUGGESTION = 80;
const MAX_SUGGESTIONS = 4;

const distinct = (values: (string | null | undefined)[], skip: string) => {
  const seen = new Set([comparable(skip)]);
  const result: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text || text.length > MAX_SUGGESTION || seen.has(comparable(text))) continue;
    seen.add(comparable(text));
    result.push(text);
  }
  return result.slice(0, MAX_SUGGESTIONS);
};

// A video title is a poor search term, so the fields start with the song and artist found inside it:
// the quoted name of "ARTIST 'Song' MV", else the right half of "Artist - Song", or the left half of
// "Song - Film | Cast | Singer" (film uploads list people after bars). The other readings and the PC's
// own artist are offered as suggestions.
export function guessFields(track: LyricsTrack): FieldGuess {
  const title = cleanTitle(track.title ?? '');
  const quoted = quotedSong(track.title ?? '');
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const right = dash ? cleanTitle(dash[2]) : null;
  const left = dash ? cleanTitle(dash[1]) : null;
  const filmStyle = dash !== null && (track.title ?? '').includes('|');
  const reported = cleanArtist(track.artist ?? '');
  const chosenSong = quoted?.title || (filmStyle ? left : right) || title;
  const chosenArtist = quoted?.artist || (dash && !filmStyle ? cleanArtist(dash[1]) : '') || reported;
  // A name written in two scripts ("좋은 날(Good Day)", "IU(아이유)") starts as its Latin half, which LRCLIB
  // matches best; the native half and the whole name are offered as suggestions.
  const latinFirst = (name: string, clean: (text: string) => string) => hasNativeScript(name) && latinPart(name) ? clean(latinPart(name)) : name;
  const song = latinFirst(chosenSong, cleanTitle);
  const artist = latinFirst(chosenArtist, cleanArtist);
  const halves = (name: string) => hasNativeScript(name) && latinPart(name) ? [nativePart(name), name] : [];
  return {
    song,
    artist,
    // The whole cleaned title is only a useful reading when no quoted name was found inside it.
    songs: distinct([...halves(chosenSong), quoted?.title, filmStyle ? right : left, filmStyle ? left : right, quoted ? null : title, withoutSong(title)], song),
    artists: distinct([...halves(chosenArtist), quoted?.artist, dash ? cleanArtist(dash[1]) : null, latinArtist(track), reported], artist),
  };
}

// Another version of the song, named in the entry's title: its lyrics or timing may belong to a different cut.
const VARIANT_WORDS: [RegExp, string][] = [
  [/\binst(?:rumental)?\b\.?/i, 'Instrumental version'],
  [/\b(?:live|concert|unplugged)\b/i, 'Live'],
  [/\b(?:remix|rmx|radio mix|extended mix)\b/i, 'Remix'],
  [/\bacoustic\b/i, 'Acoustic'],
  [/\bkaraoke\b/i, 'Karaoke'],
  [/\b(?:sped\s*up|slowed|nightcore|8d)\b/i, 'Sped up or slowed'],
  [/\bcover\b/i, 'Cover'],
];

// A version label for an entry's title, unless the song being played carries the same word.
function variantOf(trackName: string, context: MatchContext): string | undefined {
  for (const [pattern, label] of VARIANT_WORDS) {
    const word = trackName.match(pattern)?.[0];
    if (word && !context.text.includes(` ${comparable(word)} `)) return label;
  }
  return undefined;
}

// The title without its version words, so "Song (Inst.)" can still be recognised as the song.
function withoutVariant(trackName: string): string {
  let name = trackName;
  for (const [pattern] of VARIANT_WORDS) {
    name = name.replace(new RegExp(`\\s*[([][^)\\]]*${pattern.source}[^)\\]]*[)\\]]`, 'gi'), '').replace(new RegExp(`\\s+[-–—]?\\s*${pattern.source}`, 'gi'), '');
  }
  return name.trim();
}

export type EntryPreviewLine = { timeMs?: number; text: string };

// One row of the pick list: one LRCLIB entry, or several that carry exactly the same timing (or text).
export type LyricsEntry = {
  // The LRCLIB entry to use, and every entry this row stands for.
  id: number;
  ids: number[];
  title: string;
  artist: string;
  album: string;
  kind: 'synced' | 'plain' | 'instrumental';
  // Set when the title names another version of the song ("Instrumental version", "Live", ...).
  variant?: string;
  durationS?: number;
  // The entry's length minus the playing song's, in seconds; known when both are.
  lengthGapS?: number;
  fitsLength?: boolean;
  // Synced lyrics run past the end of the playing song, so their timing belongs to a longer cut.
  overruns: boolean;
  firstMs?: number;
  lastMs?: number;
  lineCount: number;
  preview: EntryPreviewLine[];
};

export type EntryList = {
  // Entries for this song, best first, and entries for other songs that share the name.
  entries: LyricsEntry[];
  others: LyricsEntry[];
  // The entry to use if you have no preference, with why; absent when nothing fits the song.
  recommendedId?: number;
  reason?: string;
  // Without a recommendation, the entry nearest to fitting.
  closestId?: number;
  // How many LRCLIB entries with usable lyrics the searches found.
  total: number;
  lengthKnown: boolean;
};

type Draft = LyricsEntry & { titleMatch: boolean; strongTitle: boolean; artistMatch: boolean; related: boolean; text: string };

const PREVIEW_LINES = 4;
const MAX_OTHERS = 20;
const OVERRUN_ALLOWANCE_MS = 5000;

function toDraft(record: LrclibRecord, context: MatchContext): Draft | null {
  const lyrics = fromRecord(record);
  if (!lyrics || lyrics.kind === 'none' || lyrics.kind === 'error' || typeof record.id !== 'number') return null;
  const title = typeof record.trackName === 'string' ? record.trackName : '';
  const artist = typeof record.artistName === 'string' ? record.artistName : '';
  const album = typeof record.albumName === 'string' ? record.albumName : '';
  const durationS = typeof record.duration === 'number' && Number.isFinite(record.duration) ? record.duration : undefined;
  const lengthGapS = durationS !== undefined && context.durationMs ? durationS - context.durationMs / 1000 : undefined;
  const variant = variantOf(title, context);
  const artistMatch = artistMatches(record, context);
  const titleMatch = titleMatches(record, context) || (variant !== undefined && titleMatches({ ...record, trackName: withoutVariant(title) }, context));
  const sung = lyrics.kind === 'synced' ? lyrics.lines.filter((line) => !isGapLine(line)) : [];
  const text = lyrics.kind === 'plain' ? lyrics.text : '';
  return {
    id: record.id, ids: [record.id], title, artist, album, kind: lyrics.kind, variant, durationS, lengthGapS,
    fitsLength: lengthGapS === undefined ? undefined : Math.abs(lengthGapS) <= DURATION_TOLERANCE_S,
    overruns: lyrics.kind === 'synced' && Boolean(context.durationMs) && lyrics.lines[lyrics.lines.length - 1].timeMs > (context.durationMs ?? 0) + OVERRUN_ALLOWANCE_MS,
    firstMs: sung[0]?.timeMs, lastMs: sung[sung.length - 1]?.timeMs, lineCount: lyrics.kind === 'synced' ? sung.length : text.split(/\r?\n/).filter((line) => line.trim()).length,
    preview: lyrics.kind === 'synced' ? sung.slice(0, PREVIEW_LINES).map((line) => ({ timeMs: line.timeMs, text: line.text })) : text.split(/\r?\n/).filter((line) => line.trim()).slice(0, PREVIEW_LINES).map((line) => ({ text: line.trim() })),
    titleMatch, strongTitle: titleMatches(record, context, true), artistMatch, related: false,
    text,
  };
}

// Merges drafts that carry the same thing: synced entries with the same first and last line, plain ones
// with the same text. Versions of the song are kept apart from the song itself. Entries with identical
// lyrics can list different lengths (one of "Good Day" says 930 s), so the row shows, and uses, the entry
// whose length is closest to the song playing.
function groupDrafts(drafts: Draft[]): Draft[] {
  const groups: Draft[][] = [];
  for (const draft of drafts) {
    const same = groups.find(([first]) => first.related === draft.related && first.kind === draft.kind && first.variant === draft.variant && (
      draft.kind === 'synced'
        ? Math.abs((first.firstMs ?? 0) - (draft.firstMs ?? 0)) <= VERSION_TOLERANCE_MS && Math.abs((first.lastMs ?? 0) - (draft.lastMs ?? 0)) <= VERSION_TOLERANCE_MS
        : draft.kind === 'plain' ? first.text === draft.text : true));
    if (same) same.push(draft);
    else groups.push([draft]);
  }
  return groups.map((members) => {
    const nearer = (a: Draft, b: Draft) => Math.abs(b.lengthGapS ?? Infinity) < Math.abs(a.lengthGapS ?? Infinity) ? b : a;
    const best = members.reduce(nearer);
    return { ...best, ids: [best.id, ...members.filter((member) => member !== best).map((member) => member.id)] };
  });
}

const KIND_ORDER = { synced: 0, plain: 1, instrumental: 2 };

// Best first: the song itself before its other versions, entries that fit the song's length and don't run
// past its end, synced before unsynced, then the timing most entries share, then the nearest length.
function ranked(drafts: Draft[]): Draft[] {
  return drafts.map((draft, index) => ({ draft, index })).sort((a, b) =>
    Number(a.draft.variant !== undefined) - Number(b.draft.variant !== undefined) ||
    Number(a.draft.fitsLength === false) - Number(b.draft.fitsLength === false) ||
    Number(a.draft.overruns) - Number(b.draft.overruns) ||
    KIND_ORDER[a.draft.kind] - KIND_ORDER[b.draft.kind] ||
    b.draft.ids.length - a.draft.ids.length ||
    Math.abs(a.draft.lengthGapS ?? 0) - Math.abs(b.draft.lengthGapS ?? 0) ||
    a.index - b.index).map(({ draft }) => draft);
}

const publicEntry = (draft: Draft): LyricsEntry => ({
  id: draft.id, ids: draft.ids, title: draft.title, artist: draft.artist, album: draft.album, kind: draft.kind, variant: draft.variant,
  durationS: draft.durationS, lengthGapS: draft.lengthGapS, fitsLength: draft.fitsLength, overruns: draft.overruns,
  firstMs: draft.firstMs, lastMs: draft.lastMs, lineCount: draft.lineCount, preview: draft.preview,
});

function whyRecommended(entry: Draft, lengthKnown: boolean, video: boolean): string {
  const parts: string[] = [];
  if (!lengthKnown) parts.push('song length unknown, so matched on name and artist');
  else {
    if (entry.lengthGapS !== undefined) parts.push(Math.abs(entry.lengthGapS) <= 1 ? 'same length' : `length within ${Math.round(Math.abs(entry.lengthGapS))} s`);
    if (entry.artistMatch) parts.push('same artist');
  }
  if (video) parts.push('music video timing');
  if (entry.ids.length > 1) parts.push(`${entry.ids.length} entries share this timing`);
  if (entry.kind === 'plain') parts.push('only unsynced lyrics fit');
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Sorts LRCLIB's results into the pick list for a song: rows for entries of this song, rows for other songs
// that share its name, and the entry Open Dock recommends, chosen from the rows on the list by the same
// principles as the automatic lookup (see pickSearchResult).
export function buildEntryList(found: LrclibRecord[], track: LyricsTrack, fields: EntryFields): EntryList {
  const song = fields.song.trim();
  const artist = fields.artist.trim();
  const context = matchContext(track, song ? { title: song, artist: artist || undefined } : undefined);
  const seen = new Set<unknown>();
  const unique = found.filter((record) => record.id === undefined || !seen.has(record.id) && seen.add(record.id));
  const drafts = unique.flatMap((record) => toDraft(record, context) ?? []);
  // With no artist typed, any artist's entry of this name is the song; with one, the artist must match.
  const groups = groupDrafts(drafts.map((draft) => ({ ...draft, related: draft.titleMatch && (artist ? draft.artistMatch : true) })));
  const lengthKnown = Boolean(context.durationMs);
  const related = ranked(groups.filter((group) => group.related));
  const others = ranked(groups.filter((group) => !group.related)).slice(0, MAX_OTHERS);

  // Rows of the song itself (not its other versions) that fit: the length within the tolerance and no lyrics
  // running past the end of the song; without a length, only a firm name and artist match counts. The best
  // ranked row is recommended: the timing most entries share, the nearest length, synced before unsynced.
  const candidates = related.filter((group) => group.variant === undefined);
  const fitting = candidates.filter((group) => lengthKnown ? group.fitsLength === true && !group.overruns : group.strongTitle && group.artistMatch);
  let recommended: Draft | undefined = fitting[0];
  let video = false;
  // A music video's intro delays the singing, so among several fitting timings the later one that starts
  // within a minute of the usual one is used, as in the automatic lookup (see pickSearchResult).
  const synced = fitting.filter((group) => group.kind === 'synced');
  if (context.videoTitle && synced.length > 1 && synced[0] === recommended) {
    const usual = synced[0];
    const later = synced
      .filter((group) => (group.firstMs ?? 0) > (usual.firstMs ?? 0) + VERSION_TOLERANCE_MS && (group.firstMs ?? 0) - (usual.firstMs ?? 0) <= MAX_INTRO_MS)
      .sort((a, b) => (b.firstMs ?? 0) - (a.firstMs ?? 0))[0];
    if (later) {
      recommended = later;
      video = true;
    }
  }
  const closest = recommended ? undefined : candidates[0];
  // The recommended row leads the list.
  const entries = recommended ? [recommended, ...related.filter((group) => group !== recommended)] : related;
  return {
    entries: entries.map(publicEntry),
    others: others.map(publicEntry),
    recommendedId: recommended?.id,
    reason: recommended ? whyRecommended(recommended, lengthKnown, video) : undefined,
    closestId: closest?.id,
    total: drafts.length,
    lengthKnown,
  };
}

// Entries picked from a list are kept so showing one needs no second request.
const entryCache = new Map<number, Promise<Lyrics>>();
const MAX_ENTRY_CACHE = 100;
const keepEntry = (id: number, lyrics: Promise<Lyrics>) => {
  entryCache.delete(id);
  entryCache.set(id, lyrics);
  while (entryCache.size > MAX_ENTRY_CACHE) entryCache.delete(entryCache.keys().next().value as number);
};

// Searches LRCLIB for what was typed and builds the pick list. Song and artist first; the song alone when
// that finds fewer than three entries of it (the artist may be written differently on LRCLIB); free text
// when it still finds none. Failures to reach LRCLIB are thrown so the screen can say so.
export async function searchEntries(fields: EntryFields, track: LyricsTrack): Promise<EntryList> {
  const song = normalizeText(fields.song).trim();
  const artist = normalizeText(fields.artist).trim();
  const steps: string[] = [];
  if (!song) return buildEntryList([], track, { song, artist });
  const found: LrclibRecord[] = [];
  const attempts: Record<string, string>[] = [
    ...(artist ? [{ track_name: song, artist_name: artist }] : []),
    { track_name: song },
    { q: `${song} ${artist}`.trim() },
  ];
  let list = buildEntryList(found, track, { song, artist });
  for (const [index, params] of attempts.entries()) {
    const widen = index === 0 || (list.entries.length < 3 && (params.q === undefined || list.entries.length === 0));
    if (!widen) continue;
    found.push(...records(await lrclib('/search', params, steps)));
    list = buildEntryList(found, track, { song, artist });
  }
  for (const record of found) {
    const lyrics = fromRecord(record);
    if (lyrics && typeof record.id === 'number') keepEntry(record.id, Promise.resolve(lyrics));
  }
  return list;
}

// One LRCLIB entry's lyrics by its number, for a pick that was saved earlier.
export function fetchLyricsById(id: number): Promise<Lyrics> {
  const cached = entryCache.get(id);
  if (cached) return cached;
  const pending = lrclib(`/get/${id}`, {}, []).then((record): Lyrics => (record && typeof record === 'object' && !Array.isArray(record) ? fromRecord(record as LrclibRecord) : null) ?? { kind: 'none' })
    .catch((): Lyrics => {
      entryCache.delete(id);
      return { kind: 'error' };
    });
  keepEntry(id, pending);
  return pending;
}
