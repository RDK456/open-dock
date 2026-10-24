// Run: node scripts/check-lyrics.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeLineAt, buildEntryList, fetchLyricsById, guessFields, nearestVersion, searchEntries, withoutSong, artistMatches, cleanArtist, cleanTitle, isGapLine, latinArtist, latinPart, lyricsTrackKey, matchAlias, matchContext, nativePart, nativeSongTitle, normalizeText, parseLrc, pickLooseResult, pickSearchResult, quotedSong, romanize, searchQueries, soundKey, timingVersions, titleMatches, withIntroGap } from '../phone-app/src/lyrics.ts';
import { fetchLyrics, lyricsTrace, setLyricsUserAgent } from '../phone-app/src/lyrics.ts';

assert.equal(
  readFileSync(new URL('../phone-app/src/lyrics.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../pc-companion/src/lyrics.ts', import.meta.url), 'utf8'),
  'phone-app and pc-companion copies of lyrics.ts differ',
);

// LRC parsing: fractions of any length, repeated stamps, metadata tags, word-sync tags, gap lines.
const lines = parseLrc('[ar:The Weeknd]\n[00:13.13] Yeah\r\n[00:16.56] ♪\n[00:27.1]I\'ve been <00:27.50>tryna call\n[01:02.123][00:20.00] Twice\nno stamp\n[00:30:50] Colon fraction');
assert.deepEqual(lines, [
  { timeMs: 13130, text: 'Yeah' },
  { timeMs: 16560, text: '♪' },
  { timeMs: 20000, text: 'Twice' },
  { timeMs: 27100, text: 'I\'ve been tryna call' },
  { timeMs: 30500, text: 'Colon fraction' },
  { timeMs: 62123, text: 'Twice' },
]);
assert.ok(isGapLine(lines[1]));
assert.ok(isGapLine({ timeMs: 0, text: '' }));
assert.ok(!isGapLine(lines[0]));

// The active line is the last one that has started.
assert.equal(activeLineAt(lines, 0), -1);
assert.equal(activeLineAt(lines, 13129), -1);
assert.equal(activeLineAt(lines, 13130), 0);
assert.equal(activeLineAt(lines, 26000), 2);
assert.equal(activeLineAt(lines, 999_999), lines.length - 1);
assert.equal(activeLineAt([], 1000), -1);

// A late first line gets an intro gap; an early one doesn't.
assert.equal(withIntroGap(lines)[0].timeMs, 0);
assert.equal(withIntroGap(lines).length, lines.length + 1);
assert.equal(withIntroGap([{ timeMs: 4000, text: 'Hi' }]).length, 1);

// Unicode clean-up: decomposed accents, full-width letters, invisible characters, odd spacing.
assert.equal(normalizeText('Beyonce\u0301'), 'Beyoncé');
assert.equal(normalizeText('ＹＯＡＳＯＢＩ'), 'YOASOBI');
assert.equal(normalizeText('Ha\u200blo\ufeff \u00a0 Song\u00ad'), 'Halo Song');
assert.equal(normalizeText('夜に駆ける'), '夜に駆ける');

// Video-style titles from real uploads.
const titles: [string, string][] = [
  ['Blinding Lights (Official Video)', 'Blinding Lights'],
  ['Song [4K] (Lyric Video) ft. Someone', 'Song'],
  ['Song (feat. Someone)', 'Song'],
  ['Song (Official)', 'Song'],
  ['Song (Remastered 2011)', 'Song (Remastered 2011)'],
  ['Song (Remix)', 'Song (Remix)'],
  ['Craft. Beer', 'Craft. Beer'],
  ['Kesariya - Brahmāstra | Ranbir Kapoor | Alia Bhatt | Pritam | Arijit Singh', 'Kesariya - Brahmāstra'],
  ['Full Video: Kesariya | Brahmāstra', 'Kesariya'],
  ['Lyrical: Tum Hi Ho | Aashiqui 2', 'Tum Hi Ho'],
  ['Kesariya (From "Brahmastra")', 'Kesariya'],
  ['Apna Bana Le - Bhediya | Varun Dhawan, Kriti Sanon | Sachin-Jigar, Arijit Singh', 'Apna Bana Le - Bhediya'],
  ['NewJeans (뉴진스) \'Super Shy\' Official MV', 'NewJeans (뉴진스) \'Super Shy\''],
  ['夜に駆ける (Official Music Video)', '夜に駆ける'],
  ['🔥 Song Name 🔥 #shorts #trending', 'Song Name'],
  ['Ｓｏｎｇ\u200b (Ｏｆｆｉｃｉａｌ Ｖｉｄｅｏ)', 'Song'],
];
for (const [raw, expected] of titles) assert.equal(cleanTitle(raw), expected, raw);
assert.equal(cleanTitle('Song M/V'), 'Song');
assert.equal(cleanTitle('Song Official MV'), 'Song');
assert.equal(cleanTitle('Video Killed the Radio Star'), 'Video Killed the Radio Star');

// Quoted song names in K-pop / J-pop uploads; apostrophes inside words never count as quotes.
const quoted: [string, ReturnType<typeof quotedSong>][] = [
  ["MEOVV(미야오) - 'In my hands' M/V", { title: 'In my hands', artist: 'MEOVV' }],
  ["aespa エスパ 'KISS N TELL' MV", { title: 'KISS N TELL', artist: 'aespa エスパ' }],
  ["aespa 에스파 'Switchblade (Feat. Ty Dolla $ign)' MV", { title: 'Switchblade', artist: 'aespa 에스파' }],
  ["ILLIT (아일릿) 'It's Me' Official MV", { title: "It's Me", artist: 'ILLIT' }],
  ['YOASOBI「アイドル」Official Music Video', { title: 'アイドル', artist: 'YOASOBI' }],
  ['NewJeans (뉴진스) ‘Super Shy’ Official MV', { title: 'Super Shy', artist: 'NewJeans' }],
  ["Don't Start Now", null],
  ["Rock 'n' Roll Song", null],
];
for (const [raw, expected] of quoted) assert.deepEqual(quotedSong(raw), expected, raw);
assert.deepEqual(searchQueries({ title: "aespa エスパ 'KISS N TELL' MV", artist: 'SMTOWN' }).slice(1, 5).map((query) => query.params), [
  { track_name: 'KISS N TELL', artist_name: 'aespa エスパ' },
  { track_name: 'KISS N TELL', artist_name: 'aespa' },
  { track_name: 'KISS N TELL', artist_name: 'SMTOWN' },
  { track_name: 'KISS N TELL' },
]);
assert.equal(cleanArtist('The Weeknd - Topic'), 'The Weeknd');
assert.equal(cleanArtist('TheWeekndVEVO'), 'TheWeeknd');
assert.equal(cleanArtist('Arijit Singh feat. Someone'), 'Arijit Singh');

// Search steps, most specific first.
const steps = (title: string, artist: string) => searchQueries({ title, artist }).map((query) => [query.label, query.params]);
assert.deepEqual(steps('Song', 'Artist'), [
  ['title + artist', { track_name: 'Song', artist_name: 'Artist' }],
  ['title only', { track_name: 'Song' }],
  ['free text', { q: 'Song Artist' }],
]);
assert.deepEqual(steps('Starboy', 'The Weeknd, Daft Punk'), [
  ['title + artist', { track_name: 'Starboy', artist_name: 'The Weeknd, Daft Punk' }],
  ['title + first artist', { track_name: 'Starboy', artist_name: 'The Weeknd' }],
  ['title only', { track_name: 'Starboy' }],
  ['free text', { q: 'Starboy The Weeknd' }],
]);
assert.deepEqual(steps('Kesariya - Brahmāstra | Ranbir Kapoor', 'Sony Music India').map(([label]) => label), [
  'title + artist', 'right half + left half as artist', 'left half only', 'right half only', 'title only', 'free text',
]);
assert.deepEqual(searchQueries({ title: 'Kesariya - Brahmāstra | Ranbir Kapoor', artist: 'Sony Music India' })[2].params, { track_name: 'Kesariya' });
assert.deepEqual(steps('The Weeknd - Blinding Lights (Official Audio)', 'TheWeekndVEVO').slice(0, 2), [
  ['title + artist', { track_name: 'The Weeknd - Blinding Lights', artist_name: 'TheWeeknd' }],
  ['right half + left half as artist', { track_name: 'Blinding Lights', artist_name: 'The Weeknd' }],
]);
assert.deepEqual(steps('Song', '').map(([label]) => label), ['title only', 'free text']);

// Track keys: a missing duration still allows a lookup; clips, long streams and untitled media don't.
assert.ok(lyricsTrackKey({ title: 'Song', artist: 'A' }));
assert.ok(lyricsTrackKey({ title: 'Song' }));
assert.notEqual(lyricsTrackKey({ title: 'Song', artist: 'A' }), lyricsTrackKey({ title: 'Song', artist: 'A', durationMs: 200_000 }));
assert.equal(lyricsTrackKey({ title: 'Clip', artist: 'A', durationMs: 20_000 }), null);
assert.equal(lyricsTrackKey({ title: 'Stream', artist: 'A', durationMs: 3_600_000 }), null);
assert.equal(lyricsTrackKey({ artist: 'A', durationMs: 200_000 }), null);
assert.equal(lyricsTrackKey({ title: 'Beyonce\u0301', durationMs: 200_000 }), lyricsTrackKey({ title: 'Beyoncé', durationMs: 200_000 }));

const asLines = (lyrics: ReturnType<typeof pickSearchResult>) => lyrics?.kind === 'synced' ? lyrics.lines.map((line) => line.text) : null;
// Search results are checked against the track: duration, title and artist.
const record = (trackName: string, artistName: string, duration: number | null, text = 'Line') =>
  ({ trackName, artistName, duration, syncedLyrics: `[00:01.00] ${text}\n[00:02.00] Two\n[00:03.00] Three`, plainLyrics: `${text}\nTwo\nThree` });
const pick = (results: object[], track: Parameters<typeof matchContext>[0]) => pickSearchResult(results, matchContext(track));
const loosePick = (results: object[], track: Parameters<typeof matchContext>[0]) => pickLooseResult(results, matchContext(track));
const song = { title: 'Song', artist: 'Artist', durationMs: 200_400 };

// Nearest duration within 3 s wins, synced before plain.
assert.deepEqual(asLines(pick([record('Song', 'Artist', 248, 'far'), record('Song', 'Artist', 202, 'near'), record('Song', 'Artist', 200, 'exact')], song)), ['exact', 'Two', 'Three']);
assert.equal(pick([record('Song', 'Artist', 210)], song), null);
assert.equal(pick([record('Song', 'Artist', null)], song), null);
assert.equal(pick([{ trackName: 'Song', artistName: 'Artist', duration: 200, plainLyrics: 'A\nB\nC' }, record('Song', 'Artist', 201, 'sync')], song)?.kind, 'synced');
assert.deepEqual(pick([{ trackName: 'Song', artistName: 'Artist', duration: 200, plainLyrics: 'A\r\n\r\nB\nC', syncedLyrics: null }], song), { kind: 'plain', text: 'A\r\n\r\nB\nC' });
assert.deepEqual(pick([{ trackName: 'Song', artistName: 'Artist', duration: 200, instrumental: true, syncedLyrics: null, plainLyrics: null }], song), { kind: 'instrumental' });
// Junk test entries and gap-only lyrics are not lyrics.
assert.equal(pick([{ trackName: 'Song', artistName: 'Artist', duration: 200, syncedLyrics: '[00:00.00]probe', plainLyrics: 'probe' }], song), null);
assert.equal(pick([{ trackName: 'Song', artistName: 'Artist', duration: 200, syncedLyrics: '[00:00.00]probe', plainLyrics: 'probe' }, record('Song', 'Artist', 200, 'real')], song)?.kind, 'synced');
assert.equal(pick([{ trackName: 'Song', artistName: 'Artist', duration: 200, syncedLyrics: '[00:01.00] ♪' }], song), null);
// Synced lines running past the end of the track are a longer version.
assert.equal(pick([{ trackName: 'Song', artistName: 'Artist', duration: 200, syncedLyrics: '[00:01.00] A\n[00:02.00] B\n[03:40.00] C' }], song), null);

// Within 3 s a result needs the right title or artist; the right artist ranks first.
assert.equal(pick([record('Other Song', 'Someone Else', 200)], song), null);
assert.equal(pick([record('Switchblade', 'Some Rock Band', 200, 'wrong'), record('Switchblade', 'aespa', 201, 'right')], { title: "aespa 에스파 'Switchblade' MV", artist: 'SMTOWN', durationMs: 200_000 })?.kind, 'synced');
assert.deepEqual(asLines(pick([record('Switchblade', 'Some Rock Band', 200, 'wrong'), record('Switchblade', 'aespa', 201, 'right')], { title: "aespa 에스파 'Switchblade' MV", artist: 'SMTOWN', durationMs: 200_000 })), ['right', 'Two', 'Three']);
// A label channel: the artist is only named in the video title.
assert.equal(pick([record('Kesariya', 'Arijit Singh', 268)], { title: 'Kesariya - Brahmāstra | Ranbir Kapoor | Pritam | Arijit Singh', artist: 'Sony Music India', durationMs: 268_000 })?.kind, 'synced');
// A channel name with the spaces dropped still names the artist.
assert.equal(pick([record('Blinding Lights', 'The Weeknd', 400)], { title: 'Blinding Lights (Official Video)', artist: 'TheWeekndVEVO' })?.kind, 'synced');

// Without a duration, title and artist must both match.
assert.equal(pick([record('Song', 'Someone Else', 200)], { title: 'Song', artist: 'Artist' }), null);
assert.equal(pick([record('song', 'artist', null)], { title: 'Song', artist: 'Artist' })?.kind, 'synced');
assert.equal(pick([record('Kesariya (From "Brahmastra")', 'Arijit Singh', 270)], { title: 'Kesariya', artist: 'Arijit Singh' })?.kind, 'synced');
assert.equal(pick([record('Kesariya (Dance Mix)', 'Arijit Singh', 197)], { title: 'Kesariya', artist: 'Arijit Singh' }), null);
assert.equal(pick([record('Kesariyaa', 'Arijit Singh', 270)], { title: 'Kesariya', artist: 'Arijit Singh' }), null);
assert.equal(pick([record('Kesariya', 'Arijit Singh', 270)], { title: 'Full Video: Kesariya | Brahmāstra', artist: 'Sony Music India' }), null);

// The same song at another length (a music video with an intro) is shown unsynced, only with title and artist both matching.
const switchbladeVideo = { title: "aespa 에스파 'Switchblade (Feat. Ty Dolla $ign)' MV", artist: 'SMTOWN', durationMs: 200_000 };
const otherSwitchblade = record('Switchblade', 'Some Rock Band', 214, 'You are no victim');
const aespaSwitchblade = record('Switchblade (feat. Ty Dolla $ign)', 'aespa & Ty Dolla $ign', 182, 'Take it back');
assert.equal(pick([otherSwitchblade, aespaSwitchblade], switchbladeVideo), null);
const switchbladePlain = loosePick([otherSwitchblade, aespaSwitchblade], switchbladeVideo);
assert.equal(switchbladePlain?.kind === 'plain' && switchbladePlain.text, 'Take it back\nTwo\nThree');
// Its synced timing still comes along, for the widget to offer.
assert.equal(switchbladePlain?.kind === 'plain' && switchbladePlain.versions?.length, 1);
assert.equal(loosePick([otherSwitchblade], switchbladeVideo), null);
assert.equal(loosePick([record('Song', 'Artist', 300)], { title: 'Song', artist: 'Artist', durationMs: 200_000 }), null);
const nearest = loosePick([record('Song', 'Artist', 280, 'far'), record('Song', 'Artist', 230, 'near')], { title: 'Song', artist: 'Artist', durationMs: 200_000 });
assert.equal(nearest?.kind === 'plain' && nearest.text, 'near\nTwo\nThree');

// Artist names: whole words for Latin names, anywhere for other scripts, any of several artists.
const artistOf = (artistName: string, track: Parameters<typeof matchContext>[0]) => artistMatches({ artistName }, matchContext(track));
assert.ok(artistOf('aespa 및 Ty Dolla $ign', { title: "aespa 'Switchblade' MV", artist: 'SMTOWN' }));
assert.ok(artistOf('Pritam, Arijit Singh', { title: 'Kesariya | Arijit Singh', artist: 'Sony Music India' }));
assert.ok(artistOf('미야오', { title: 'MEOVV(미야오) - In my hands', artist: 'THEBLACKLABEL' }));
assert.ok(!artistOf('Rain', { title: 'Brainstorm', artist: 'Someone' }));
assert.ok(!artistOf('A', { title: 'A Song', artist: 'B' }));
assert.ok(titleMatches({ trackName: 'In My Hands' }, matchContext({ title: "MEOVV(미야오) - 'In my hands' M/V" })));
assert.ok(!titleMatches({ trackName: 'Me' }, matchContext({ title: "ILLIT 'It's Me' MV" })));

// Timing versions, from aespa 'KISS N TELL' as LRCLIB holds it: eleven entries with the album's timing
// (first line 8.0 s) under all sorts of listed lengths, two of them the music video's 190 s, and one
// entry timed to the video (first line 17.1 s) listed at the album's 166 s.
const stamp = (totalS: number) => `[${String(Math.floor(totalS / 60)).padStart(2, '0')}:${(totalS % 60).toFixed(2).padStart(5, '0')}]`;
// Four lines spread evenly from the first to the last sung line.
const timed = (firstS: number, lastS: number) => [0, 1, 2, 3].map((step) => `${stamp(firstS + (lastS - firstS) * step / 3)} line ${step}`).join('\n');
assert.equal(stamp(160.28), '[02:40.28]');
const kissNTell = (duration: number | null, firstS: number, lastS: number) => ({ trackName: 'KISS N TELL', artistName: 'aespa', duration, syncedLyrics: timed(firstS, lastS), plainLyrics: 'line 0\nline 1\nline 2\nline 3' });
const kissEntries = [
  ...[166, 166, 166, 190, 190, 218, 75, 230, 160, 154, null].map((duration) => kissNTell(duration, 8, 160.28)),
  kissNTell(166, 17.1, 161.16),
];
const firstLine = (lyrics: ReturnType<typeof pickSearchResult>) => lyrics?.kind === 'synced' ? lyrics.lines[0].timeMs : null;
assert.deepEqual(timingVersions(kissEntries.map((entry) => parseLrc(entry.syncedLyrics))).map((version) => [version.firstMs, version.entries]), [[8000, 11], [17100, 1]]);

// Two timings can open together and differ by seconds at the end (LRCLIB's "Kesariya": first lines 50 ms
// apart, last lines 14 s apart). They stay two versions, and each line set maps to exactly one of them,
// so the details panel ticks one timing, and picking one selects its own lines rather than the other's.
{
  const lyric = (first: number, last: number) => [{ timeMs: first, text: 'a' }, { timeMs: (first + last) / 2, text: 'b' }, { timeMs: last, text: 'c' }];
  const album = lyric(9490, 244_100);
  const video = lyric(9440, 258_000);
  const versions = timingVersions([album, album, video]);
  assert.deepEqual(versions.map((version) => [version.firstMs, version.lastMs, version.entries]), [[9490, 244_100, 2], [9440, 258_000, 1]]);
  for (const version of versions) {
    const owners = versions.filter((candidate) => candidate === nearestVersion(versions, version.firstMs, version.lastMs));
    assert.deepEqual(owners, [version], 'a timing maps to exactly one version');
  }
  assert.equal(nearestVersion(versions, 9440, 258_000)?.lines, video, 'the later-ending timing is not mistaken for the other');
  assert.equal(nearestVersion(versions, 9490, 244_100)?.lines, album);
  // A choice saved before last lines were stored has only a first line: the nearest first line wins.
  assert.equal(nearestVersion(versions, 9440)?.lines, video);
  assert.equal(nearestVersion(versions, 9490)?.lines, album);
  // Nothing within the grouping tolerance matches no version.
  assert.equal(nearestVersion(versions, 12_000, 244_100), undefined);
  assert.equal(nearestVersion(versions, 9490, 250_000), undefined);
  assert.equal(nearestVersion([], 9490, 244_100), undefined);
}
// The music video (its title says MV) takes the timing that starts later, by its intro.
const kissVideo = pick(kissEntries, { title: "aespa エスパ 'KISS N TELL' MV", artist: 'SMTOWN', durationMs: 190_000 });
assert.equal(firstLine(kissVideo), 17100);
assert.match(kissVideo?.kind === 'synced' ? kissVideo.reason ?? '' : '', /music video/);
assert.equal(kissVideo?.kind === 'synced' && kissVideo.versions?.length, 2);
// The song itself (Spotify, 166 s) takes the timing most matching entries share.
assert.equal(firstLine(pick(kissEntries, { title: 'KISS N TELL', artist: 'aespa', durationMs: 166_000 })), 8000);
// No video words in the title, but 24 s longer than the length the entries list: still a video.
assert.equal(firstLine(pick(kissEntries, { title: 'KISS N TELL', artist: 'aespa', durationMs: 190_000 })), 17100);
// A video whose extras are only at the end has one timing, and keeps it.
assert.equal(firstLine(pick(kissEntries.slice(0, 11), { title: "aespa 'KISS N TELL' MV", artist: 'SMTOWN', durationMs: 190_000 })), 8000);
// A timing starting over a minute late is someone's mistake, not an intro.
assert.equal(firstLine(pick([...kissEntries.slice(0, 11), kissNTell(166, 75, 100)], { title: "aespa 'KISS N TELL' MV", artist: 'SMTOWN', durationMs: 190_000 })), 8000);

// A large consensus can sync a track even when the listed durations differ.
const consensusTrack = { title: 'Song', artist: 'Artist', durationMs: 200_000 };
const consensusEntry = (firstS: number, lastS = 180, duration = 210) =>
  ({ trackName: 'Song', artistName: 'Artist', duration, syncedLyrics: timed(firstS, lastS) });
const consensusEntries = (count: number, firstS: number) =>
  Array.from({ length: count }, () => consensusEntry(firstS));
const dominantEntries = [...consensusEntries(19, 8), consensusEntry(2)];
const dominant = pick(dominantEntries, consensusTrack);
assert.equal(firstLine(dominant), 8000, '19 matching entries should sync automatically instead of requiring a manual pick');
assert.equal(dominant?.kind === 'synced' && dominant.reason, 'dominant matching entries (19 of 20)');
assert.deepEqual(dominant?.kind === 'synced' && dominant.versions?.map(({ firstMs, entries }) => [firstMs, entries]), [[8000, 19], [2000, 1]]);
assert.equal(firstLine(pick([...dominantEntries].reverse(), consensusTrack)), 8000);
assert.equal(firstLine(pick([...consensusEntries(5, 8), consensusEntry(2)], consensusTrack)), 8000);
assert.equal(firstLine(pick([...consensusEntries(20, 8), ...consensusEntries(5, 2)], consensusTrack)), 8000);
for (const entries of [
  consensusEntries(4, 8), // not enough supporting entries, even with no rival
  [...consensusEntries(19, 8), ...consensusEntries(5, 2)], // below 80% and 4x
  [...consensusEntries(20, 8), ...consensusEntries(5, 2), consensusEntry(4)], // 4x the runner-up, but below 80% overall
  [...consensusEntries(10, 8), ...consensusEntries(10, 2)], // tied
]) {
  assert.equal(pick(entries, consensusTrack), null, 'weak consensus must retain the unsynced fallback');
  assert.equal(loosePick(entries, consensusTrack)?.kind, 'plain');
}
// Strict synced and instrumental matches retain priority over this fallback.
assert.equal(firstLine(pick([...dominantEntries, consensusEntry(2, 180, 200)], consensusTrack)), 2000);
assert.equal(pick([...dominantEntries, { trackName: 'Song', artistName: 'Artist', duration: 200, instrumental: true }], consensusTrack)?.kind, 'instrumental');
const invalidConsensus = [
  consensusEntries(19, 8).map((entry) => ({ ...entry, artistName: 'Someone Else' })),
  consensusEntries(19, 8).map((entry) => ({ ...entry, trackName: 'Other Song' })),
  consensusEntries(19, 8).map((entry) => ({ ...entry, syncedLyrics: '[00:01.00] probe' })),
  consensusEntries(19, 8).map((entry) => ({ ...entry, duration: 291 })), // outside the 90 s bound
  consensusEntries(19, 8).map((entry) => ({ ...entry, duration: null })), // unknown listed length
  consensusEntries(19, 8).map((entry) => ({ ...entry, syncedLyrics: timed(8, 201) })), // even a 1 s overrun is excluded
  consensusEntries(19, 8).map((entry) => ({ ...entry, syncedLyrics: timed(8, 220) })),
];
for (const entries of invalidConsensus) {
  assert.equal(pick([...entries, consensusEntry(2)], consensusTrack), null, 'invalid or unrelated records must not supply consensus votes');
}
assert.equal(firstLine(pick(consensusEntries(5, 8).map((entry) => ({ ...entry, duration: 290 })), consensusTrack)), 8000);
assert.equal(firstLine(pick(consensusEntries(5, 8).map((entry) => ({ ...entry, syncedLyrics: timed(8, 200) })), consensusTrack)), 8000);

// Song names in another script. Loanword titles are compared by sound: Hangul, kana and Devanagari are
// spelled out in Latin letters, then reduced to a consonant key both sides share.
assert.equal(romanize('캐치 캐치'), 'kaechi kaechi');
assert.equal(romanize('アイドル'), 'aidoru');
assert.equal(romanize('केसरिया'), 'kasraya');
assert.equal(romanize('夜に駆ける'), null);
for (const [native, english] of [['캐치 캐치', 'Catch Catch'], ['하입보이', 'Hype Boy'], ['해야', 'HEYA'], ['뚜두뚜두', 'DDU-DU DDU-DU'], ['넥스트 레벨', 'Next Level'], ['러브 다이브', 'LOVE DIVE'], ['アイドル', 'Idol'], ['केसरिया', 'Kesariya']]) {
  assert.equal(soundKey(romanize(native) ?? ''), soundKey(english), `${native} ~ ${english}`);
}
for (const [native, other] of [['좋은 날', 'Good Day'], ['캐치 캐치', 'SMILEY'], ['넥스트 레벨', 'Lucid Dream']]) {
  assert.notEqual(soundKey(romanize(native) ?? ''), soundKey(other), `${native} !~ ${other}`);
}
// Titles in two scripts split into halves.
assert.equal(latinPart('좋은 날(Good Day)'), 'Good Day');
assert.equal(latinPart('해야 (HEYA)'), 'HEYA');
assert.equal(latinPart('뚜두뚜두_DDU-DU DDU-DU'), 'DDU-DU DDU-DU');
assert.equal(latinPart('YENA(최예나)'), 'YENA');
assert.equal(latinPart('캐치 캐치'), '');
assert.equal(nativePart('해야 (HEYA)'), '해야');
// The song name and the artist's Latin name, from the video title before the channel.
assert.equal(nativeSongTitle({ title: "YENA(최예나) - '캐치 캐치' M/V" }), '캐치 캐치');
assert.equal(nativeSongTitle({ title: '[MV] IU(아이유) _ 좋은 날(Good Day)' }), '좋은 날(Good Day)');
assert.equal(nativeSongTitle({ title: 'Blinding Lights' }), null);
assert.equal(latinArtist({ title: "YENA(최예나) - '캐치 캐치' M/V", artist: 'YENA(최예나)' }), 'YENA');
assert.equal(latinArtist({ title: '[MV] IU(아이유) _ 좋은 날(Good Day)', artist: '1theK (원더케이)' }), 'IU');
assert.equal(latinArtist({ title: '좋은 날', artist: 'IU' }), 'IU');

// Finding the Latin title among the artist's songs, only when exactly one fits.
const yenaSongs = [{ title: 'SMILEY (feat. BIBI)', durationS: 174 }, { title: 'Catch Catch', durationS: 180 }, { title: 'Catch Catch', durationS: 189 }, { title: 'NEMONEMO', durationS: 178 }];
assert.deepEqual(matchAlias('캐치 캐치', yenaSongs, 205_000), { title: 'Catch Catch', how: 'sounds the same (kaechi kaechi)' });
assert.deepEqual(matchAlias('해야', [{ title: '해야 (HEYA)', durationS: 189 }, { title: 'LOVE DIVE', durationS: 177 }]), { title: 'HEYA', how: 'title in both scripts' });
// A short sound key ("해야" has none) needs a fitting length too, and a unique one.
assert.equal(matchAlias('해야', [{ title: 'HEYA', durationS: 189 }, { title: 'After LIKE', durationS: 177 }]), null);
assert.equal(matchAlias('해야', [{ title: 'HEYA', durationS: 189 }, { title: 'After LIKE', durationS: 177 }], 190_000)?.title, 'HEYA');
assert.equal(matchAlias('해야', [{ title: 'HEYA', durationS: 189 }, { title: 'Aye', durationS: 190 }], 190_000), null);
// A real translation only by a unique catalogued length.
const iuSongs = [{ title: 'Good Day', durationS: 234 }, { title: 'BBIBBI', durationS: 208 }, { title: 'Love wins all', durationS: 271 }];
assert.equal(matchAlias('좋은 날', iuSongs, 236_000), null);
assert.deepEqual(matchAlias('좋은 날', iuSongs, 236_000, [233.52]), { title: 'Good Day', how: 'same length as the recording under its native title' });
assert.equal(matchAlias('좋은 날', [...iuSongs, { title: 'Ending Scene', durationS: 233 }], 236_000, [233.52]), null);

// "A - B" where A is the artist in another script: a song named like A must not stand in, unsynced, for B.
const iuWrong = { trackName: '아이유', artistName: 'IU', duration: 200, syncedLyrics: '[00:01.00] Woogie on and on\n[00:02.00] Two\n[00:03.00] Three', plainLyrics: 'Woogie on and on\nTwo\nThree' };
assert.equal(loosePick([iuWrong], { title: '아이유 - 좋은 날', artist: 'IU', durationMs: 234_000 }), null);
assert.equal(pick([iuWrong], { title: '아이유 - 좋은 날', artist: 'IU' }), null);
// The found Latin title counts as the song's title when checking results.
assert.ok(titleMatches({ trackName: 'Catch Catch' }, matchContext({ title: "YENA(최예나) - '캐치 캐치' M/V" }, { title: 'Catch Catch', artist: 'YENA' }), true));
assert.equal(cleanTitle('[MV] IU(아이유) _ 좋은 날(Good Day)'), 'IU(아이유) - 좋은 날(Good Day)');

// Indian label uploads: unambiguous "... Song" endings go; a bare trailing "Song" is only an extra reading.
assert.equal(cleanTitle('Tum Hi Ho Full Video Song'), 'Tum Hi Ho');
assert.equal(cleanTitle('Kesariya Video Song'), 'Kesariya');
assert.equal(cleanTitle('Love Song'), 'Love Song');
assert.equal(cleanTitle('Official: Desi Kalakaar Full VIDEO Song | Yo Yo Honey Singh | Honey Singh New Songs 2014'), 'Desi Kalakaar');
assert.equal(cleanTitle('Exclusive: LOVE DOSE Full Video Song | Yo Yo Honey Singh'), 'LOVE DOSE');
assert.equal(cleanTitle('Chaar Botal Vodka Full Song Feat. Yo Yo Honey Singh'), 'Chaar Botal Vodka');
assert.equal(cleanTitle('New Rules'), 'New Rules');
assert.equal(cleanTitle('Official Love'), 'Official Love');
assert.equal(withoutSong('Jhoome Jo Pathaan Song'), 'Jhoome Jo Pathaan');
assert.equal(withoutSong('Love Song'), null);
assert.equal(withoutSong('Any Song'), null);
assert.equal(withoutSong('Songbird'), null);
assert.deepEqual(steps('Jhoome Jo Pathaan Song | Shah Rukh Khan', 'YRF').map(([label]) => label), [
  'title + artist', 'title without "Song" + artist', 'title only', 'title without "Song" only', 'free text',
]);
// Its entries run 6 s longer than the 202 s video, past its end: their timing isn't used automatically,
// but their words are, and their timing is offered.
const pathaan = (artistName: string) => ({ trackName: 'Jhoome Jo Pathaan', artistName, duration: 208, syncedLyrics: '[00:26.59] Tumne mohabbat karni hai\n[01:30.00] Two\n[03:27.21] Three', plainLyrics: 'Tumne mohabbat karni hai\nTwo\nThree' });
const pathaanVideo = { title: 'Jhoome Jo Pathaan Song | Shah Rukh Khan, Deepika | Vishal & Sheykhar, Arijit Singh, Sukriti, Kumaar', artist: 'YRF', durationMs: 202_000 };
assert.equal(pick([pathaan('Arijit Singh'), pathaan('Kumaar')], pathaanVideo), null);
const pathaanText = loosePick([pathaan('Arijit Singh'), pathaan('Kumaar')], pathaanVideo);
assert.equal(pathaanText?.kind === 'plain' && pathaanText.text.split('\n')[0], 'Tumne mohabbat karni hai');
assert.equal(pathaanText?.kind === 'plain' && pathaanText.versions?.[0].entries, 2);

// Reproduce LRCLIB rejecting Android's generic OkHttp identity, through the real lookup and retries.
const originalFetch = globalThis.fetch;
const clientUserAgent = 'Open Dock/1.0 (https://github.com/RDK456/open-dock)';
let transportUserAgent = 'okhttp/4.9.2';
const requests: { path: string; headers: Headers }[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://lrclib.net');
  const headers = new Headers(init?.headers);
  requests.push({ path: url.pathname, headers });
  if ((headers.get('User-Agent') ?? transportUserAgent).startsWith('okhttp/')) {
    return new Response('Upstream request rejected', { status: 520, headers: { 'Retry-After': '0.001' } });
  }
  const record = {
    id: 1,
    trackName: url.searchParams.get('track_name'),
    artistName: url.searchParams.get('artist_name'),
    duration: 200,
    syncedLyrics: '[00:13.00] First line\n[00:30.00] Second line\n[01:00.00] Third line\n[02:00.00] Fourth line',
  };
  return new Response(JSON.stringify(url.pathname === '/api/search' ? [record] : record), {
    headers: { 'Content-Type': 'application/json' },
  });
};
try {
  const track = { title: 'Android request regression', artist: 'Open Dock test', durationMs: 200_000 };
  const rejected = await fetchLyrics(track);
  assert.equal(rejected.kind, 'error');
  assert.equal(requests.length, 3, 'the generic Android identity must reproduce the three failed attempts');

  requests.length = 0;
  setLyricsUserAgent(clientUserAgent);
  const recovered = await fetchLyrics(track);
  assert.equal(recovered.kind, 'synced', 'identifying Open Dock must recover the failed Android lookup');
  assert.deepEqual(requests.map((request) => request.path), ['/api/get', '/api/search']);
  for (const { headers } of requests) {
    assert.equal(headers.get('User-Agent'), clientUserAgent);
    assert.equal(headers.get('Lrclib-Client'), 'Open Dock (https://github.com/RDK456/open-dock)');
  }

  // Without the Android opt-in, iOS and browser requests retain their transport's own User-Agent.
  setLyricsUserAgent(undefined);
  for (const platform of ['ios', 'desktop']) {
    requests.length = 0;
    transportUserAgent = platform === 'ios' ? 'CFNetwork' : 'Mozilla/5.0';
    const result = await fetchLyrics({ ...track, title: `${platform} request regression` });
    assert.equal(result.kind, 'synced');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ headers }) => !headers.has('User-Agent')));
  }
} finally {
  setLyricsUserAgent(undefined);
  globalThis.fetch = originalFetch;
}

// Exercise the real lookup path: exact-match miss, search consensus, trace, and manual alternatives.
const consensusRequests: string[] = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://lrclib.net');
  consensusRequests.push(url.pathname);
  if (url.pathname === '/api/get') return new Response('', { status: 404 });
  assert.equal(url.pathname, '/api/search');
  return new Response(JSON.stringify(dominantEntries), { headers: { 'Content-Type': 'application/json' } });
};
try {
  const result = await fetchLyrics(consensusTrack);
  assert.equal(firstLine(result), 8000, 'lookup must return the dominant timing without asking for a manual selection');
  assert.equal(result.kind === 'synced' && result.versions?.length, 2, 'long-press must still have both alternatives');
  assert.ok(lyricsTrace(consensusTrack).steps.some((step) => step.includes('dominant matching entries (19 of 20)')));
  assert.deepEqual(consensusRequests, ['/api/get', '/api/get', '/api/search', '/api/search', '/api/search']);
} finally {
  globalThis.fetch = originalFetch;
}

// A first-search consensus must not hide a duration match returned by a later query.
let laterSearches = 0;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://lrclib.net');
  if (url.pathname === '/api/get') return new Response('', { status: 404 });
  laterSearches += 1;
  const records = laterSearches === 1 ? dominantEntries : [consensusEntry(2, 180, 200)];
  return new Response(JSON.stringify(records), { headers: { 'Content-Type': 'application/json' } });
};
try {
  const result = await fetchLyrics({ ...consensusTrack, album: 'later duration match regression' });
  assert.equal(firstLine(result), 2000, 'a later correct-duration match must beat the earlier loose consensus');
  assert.equal(laterSearches, 2);
} finally {
  globalThis.fetch = originalFetch;
}

// Find lyrics: the pick list built from real LRCLIB responses (scripts/fixtures, trimmed to the lines the
// logic reads). "Summer Rain SAM KIM" holds 7 entries: four copies of one timing (one titled in two
// scripts), one that opens 0.5 s earlier and ends 0.6 s earlier, one unsynced, and an instrumental version.
{
  const samKim = JSON.parse(readFileSync(new URL('./fixtures/lrclib-summer-rain.json', import.meta.url), 'utf8'));
  const nameOnly = JSON.parse(readFileSync(new URL('./fixtures/lrclib-summer-rain-name-only.json', import.meta.url), 'utf8'));
  const video = { title: "SAM KIM (샘김) 'Summer Rain' MV", artist: '1theK', durationMs: 202_000 };
  const typed = { song: 'Summer Rain', artist: 'Sam Kim' };

  // The fields start with the song and artist inside the video title, not the noisy title itself.
  assert.deepEqual(guessFields(video), { song: 'Summer Rain', artist: 'SAM KIM', songs: [], artists: ['1theK'] });
  assert.deepEqual(guessFields({ title: 'Arijit Singh - Kesariya (Official Video)', artist: 'T-Series' }), { song: 'Kesariya', artist: 'Arijit Singh', songs: ['Arijit Singh', 'Arijit Singh - Kesariya'], artists: ['T-Series'] });
  assert.deepEqual(guessFields({ title: 'Blinding Lights', artist: 'The Weeknd' }), { song: 'Blinding Lights', artist: 'The Weeknd', songs: [], artists: [] });
  // Film uploads ("Song - Film | Cast | Singer") put the song on the left.
  assert.equal(guessFields({ title: 'Kesariya - Brahmāstra | Ranbir Kapoor | Arijit Singh', artist: 'Sony Music India' }).song, 'Kesariya');

  // Fitting length: the timing four entries share is recommended, with the reason.
  const list = buildEntryList(samKim, video, typed);
  assert.equal(list.total, 7);
  assert.equal(list.recommendedId, 34467573);
  assert.equal(list.reason, 'Same length, same artist, 4 entries share this timing');
  assert.equal(list.closestId, undefined);
  assert.deepEqual(list.entries.map((entry) => [entry.id, entry.ids.length, entry.kind, entry.variant]), [
    [34467573, 4, 'synced', undefined], [10270491, 1, 'synced', undefined], [2171244, 1, 'plain', undefined], [14527123, 1, 'synced', 'Instrumental version'],
  ], 'recommended first, then the other timing, unsynced, and the instrumental version last');
  assert.equal(list.entries[0].fitsLength, true);
  assert.deepEqual(list.entries[0].preview[0], { timeMs: 650, text: '우리 같이 걷던 곳' });
  assert.deepEqual(list.others, []);
  // The recommendation is the timing the automatic lookup would use for the same song.
  const auto = pickSearchResult(samKim, matchContext(video, { title: typed.song, artist: typed.artist }), { allowDominant: false });
  assert.equal(auto?.kind, 'synced');
  assert.equal(auto?.kind === 'synced' ? auto.lines[0].timeMs : -1, list.entries[0].firstMs);

  // A length 20 s off fits nothing: no recommendation, the nearest is marked instead.
  const off = buildEntryList(samKim, { ...video, durationMs: 222_000 }, typed);
  assert.equal(off.recommendedId, undefined);
  assert.equal(off.reason, undefined);
  assert.equal(off.closestId, 34467573);
  assert.ok(off.entries.every((entry) => entry.fitsLength === false));

  // An unknown length falls back to name and artist, and says so.
  const unknown = buildEntryList(samKim, { ...video, durationMs: undefined }, typed);
  assert.equal(unknown.recommendedId, 34467573);
  assert.equal(unknown.reason, 'Song length unknown, so matched on name and artist, 4 entries share this timing');
  assert.equal(unknown.lengthKnown, false);

  // Entries with identical lyrics can list different lengths (a real "Good Day" entry says 930 s): the row
  // shows, and uses, the entry whose length is closest to the song, so it never contradicts itself.
  const stamp = (ms: number) => `[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(2).padStart(5, '0')}]`;
  const entry = (id: number, durationS: number, firstMs: number, lastMs: number, name = 'Good Day', artistName = 'IU') => ({
    id, trackName: name, artistName, albumName: 'Album', duration: durationS, instrumental: false, plainLyrics: 'a\nb\nc\nd',
    syncedLyrics: [firstMs, firstMs + 10_000, firstMs + 20_000, lastMs].map((time, index) => `${stamp(time)} line ${index}`).join('\n'),
  });
  const goodDay = { title: '[MV] IU(아이유) _ 좋은 날(Good Day)', artist: '1theK', durationMs: 235_000 };
  const bogus = buildEntryList([entry(1, 930, 9000, 200_000), entry(2, 235, 9100, 200_100), entry(3, 234, 9000, 200_000)], goodDay, { song: 'Good Day', artist: 'IU' });
  assert.equal(bogus.entries.length, 1);
  assert.deepEqual([bogus.entries[0].id, bogus.entries[0].ids, bogus.entries[0].durationS, bogus.entries[0].fitsLength], [2, [2, 1, 3], 235, true]);
  assert.equal(bogus.recommendedId, 2);
  assert.equal(bogus.reason, 'Same length, same artist, 3 entries share this timing');

  // A music video's intro delays the singing: of two fitting timings, the one starting a few seconds
  // later is recommended for a video title, and the one most entries share for a plain title.
  const timings = [entry(10, 200, 5000, 190_000), entry(11, 200, 5100, 190_100), entry(12, 200, 4900, 189_900), entry(13, 200, 12_300, 197_000)];
  const videoList = buildEntryList(timings, { title: 'IU - Good Day (Official MV)', artist: 'IU', durationMs: 200_000 }, { song: 'Good Day', artist: 'IU' });
  assert.equal(videoList.recommendedId, 13);
  assert.equal(videoList.reason, 'Same length, same artist, music video timing');
  const audioList = buildEntryList(timings, { title: 'Good Day', artist: 'IU', durationMs: 200_000 }, { song: 'Good Day', artist: 'IU' });
  assert.equal(audioList.recommendedId, 10);
  assert.equal(audioList.reason, 'Same length, same artist, 3 entries share this timing');
  assert.equal(audioList.entries.length, 2);

  // A name written in two scripts starts as its Latin half, which LRCLIB matches best; the native half and
  // the whole name are suggestions.
  const twoScripts = guessFields({ title: '[MV] IU(아이유) _ 좋은 날(Good Day)', artist: '1theK' });
  assert.deepEqual([twoScripts.song, twoScripts.artist], ['Good Day', 'IU']);
  assert.ok(twoScripts.songs.includes('좋은 날') && twoScripts.songs.includes('좋은 날(Good Day)'));
  assert.ok(twoScripts.artists.includes('아이유'));

  // Songs by other artists that share the name go to "other songs", and nothing is recommended among them.
  const wrongArtists = buildEntryList(nameOnly, video, typed);
  assert.deepEqual(wrongArtists.entries, []);
  assert.equal(wrongArtists.recommendedId, undefined);
  assert.ok(wrongArtists.others.length > 10 && wrongArtists.others.every((entry) => !/sam kim/i.test(entry.artist)));
  // With no artist typed every artist's entry of this name is a candidate, and the length decides.
  const anyArtist = buildEntryList(nameOnly, { title: 'Summer Rain', durationMs: 220_000 }, { song: 'Summer Rain', artist: '' });
  assert.equal(anyArtist.others.length, 0);
  assert.ok(anyArtist.entries.length > 10);
  assert.equal(anyArtist.recommendedId, 36963849);

  // Searching: song + artist first, widening to the song alone only when that finds fewer than three
  // entries of it, and free text only when nothing is found. Entries seen twice are listed once.
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  const respond = (handler: (url: URL) => unknown) => {
    globalThis.fetch = async (input) => {
      asked.push(String(input).replace('https://lrclib.net', ''));
      return new Response(JSON.stringify(handler(new URL(String(input)))), { headers: { 'Content-Type': 'application/json' } });
    };
  };
  const queryNames = () => asked.map((request) => request.split('?')[1]?.split('=')[0]);
  try {
    // Song + artist finds enough entries (four rows): nothing more is asked.
    asked.length = 0;
    respond(() => samKim);
    const enough = await searchEntries({ song: 'Summer Rain', artist: 'Sam Kim' }, video);
    assert.equal(enough.recommendedId, 34467573);
    assert.deepEqual(asked, ['/api/search?track_name=Summer%20Rain&artist_name=Sam%20Kim']);

    // Too few (the artist is written differently on LRCLIB): the song alone is searched too, and an
    // entry that both searches return is listed once.
    asked.length = 0;
    respond((url) => url.searchParams.has('artist_name') ? samKim.slice(0, 2) : samKim);
    const widened = await searchEntries({ song: 'Summer Rain', artist: 'Sam Kim' }, video);
    assert.deepEqual(asked, ['/api/search?track_name=Summer%20Rain&artist_name=Sam%20Kim', '/api/search?track_name=Summer%20Rain']);
    assert.equal(widened.total, 7, 'seven entries, not nine');
    assert.equal(widened.entries.length, 4);

    // Free text is the last resort, tried only when nothing was found.
    asked.length = 0;
    respond((url) => url.searchParams.has('q') ? samKim : []);
    const viaText = await searchEntries({ song: 'Summer Rain', artist: 'Sam Kim' }, video);
    assert.equal(viaText.recommendedId, 34467573);
    assert.deepEqual(queryNames(), ['track_name', 'track_name', 'q']);

    asked.length = 0;
    respond(() => []);
    const none = await searchEntries({ song: 'Summer Rain Official MV', artist: '' }, video);
    assert.deepEqual([none.entries.length, none.others.length, none.total], [0, 0, 0]);
    assert.deepEqual(queryNames(), ['track_name', 'q']);
    asked.length = 0;
    assert.deepEqual((await searchEntries({ song: '  ', artist: 'Sam Kim' }, video)).entries, [], 'an empty song asks nothing');
    assert.deepEqual(asked, []);

    // A picked entry is shown from the search that found it, or fetched by its number.
    respond(() => samKim);
    await searchEntries({ song: 'Summer Rain', artist: 'Sam Kim' }, video);
    asked.length = 0;
    assert.equal((await fetchLyricsById(34467573)).kind, 'synced');
    assert.deepEqual(asked, [], 'an entry from the list needs no second request');
    respond(() => samKim[0]);
    assert.equal((await fetchLyricsById(99_999_001)).kind, 'synced');
    assert.deepEqual(asked, ['/api/get/99999001'], 'fetched by number');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('lyrics checks passed (including dominant timing fallback, Android request recovery and unchanged iOS/desktop headers)');
