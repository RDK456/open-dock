import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Pressable } from './motion';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react-native';
import type { SystemMediaState } from './connection';
import { guessFields, searchEntries, type EntryFields, type EntryList, type LyricsEntry } from './lyrics';
import { useStyles, useTheme, type Colors } from './theme';

// The Find lyrics screen, shown in the lyrics details modal: search LRCLIB for a song, see every matching
// entry with its length and timing, preview one, and use it for this song. The entry Open Dock would pick is
// tagged Recommended, with the reason.
export type FinderProps = {
  media: SystemMediaState;
  // The entry saved for this song, when one was picked.
  pickedId?: number;
  // The first and last sung line of the lyrics on screen when none was picked, to mark the entry in use.
  shown?: { firstMs: number; lastMs: number };
  onUse: (entry: LyricsEntry) => void;
  onAutomatic: () => void;
};

const SAME_TIMING_MS = 400;
const MAX_FIELD = 120;

// "3:22" for a song's length, "0:06.9" for a line's time.
const length = (milliseconds: number) => `${Math.floor(milliseconds / 60000)}:${String(Math.round((milliseconds % 60000) / 1000)).padStart(2, '0')}`;
const clock = (milliseconds: number) => `${Math.floor(milliseconds / 60000)}:${((milliseconds % 60000) / 1000).toFixed(1).padStart(4, '0')}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function lengthTag(entry: LyricsEntry): { text: string; good: boolean } | null {
  if (entry.lengthGapS === undefined) return null;
  const gap = Math.abs(entry.lengthGapS);
  return { text: gap <= 1 ? 'Same length' : `${entry.lengthGapS > 0 ? '+' : '−'}${Math.round(gap)} s`, good: entry.fitsLength === true };
}

export function LyricsFinder({ media, pickedId, shown, onUse, onAutomatic }: FinderProps) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const guess = useMemo(() => guessFields({ title: media.title, artist: media.artist }), [media.title, media.artist]);
  const [fields, setFields] = useState<EntryFields>({ song: guess.song, artist: guess.artist });
  const [status, setStatus] = useState<'form' | 'loading' | 'results' | 'error'>('form');
  const [list, setList] = useState<EntryList | null>(null);
  const [searched, setSearched] = useState<EntryFields | null>(null);
  const [preview, setPreview] = useState<LyricsEntry | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const scroller = useRef<ScrollView>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current = -1; }, []);
  useEffect(() => scroller.current?.scrollTo({ y: 0, animated: false }), [status, preview]);

  const search = useCallback(async (next: EntryFields) => {
    const song = next.song.trim();
    if (!song) return;
    const id = ++request.current;
    setFields(next);
    setSearched({ song, artist: next.artist.trim() });
    setStatus('loading');
    setShowOthers(false);
    try {
      const result = await searchEntries({ song, artist: next.artist.trim() }, media);
      if (request.current !== id) return;
      setList(result);
      setStatus('results');
    } catch {
      if (request.current === id) setStatus('error');
    }
  }, [media]);

  const inUse = (entry: LyricsEntry) => pickedId !== undefined
    ? entry.ids.includes(pickedId)
    : entry.kind === 'synced' && shown !== undefined && entry.firstMs !== undefined && entry.lastMs !== undefined &&
      Math.abs(entry.firstMs - shown.firstMs) <= SAME_TIMING_MS && Math.abs(entry.lastMs - shown.lastMs) <= SAME_TIMING_MS;

  const renderRow = (entry: LyricsEntry) => <EntryRow key={entry.id} entry={entry} recommended={list?.recommendedId === entry.id} closest={list?.closestId === entry.id}
    reason={list?.recommendedId === entry.id ? list.reason : undefined} inUse={inUse(entry)} onPress={() => setPreview(entry)} />;

  const editing = status === 'form' || status === 'error';
  return <ScrollView ref={scroller} style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentInsetAdjustmentBehavior="never" bounces={false} overScrollMode="never" indicatorStyle="white">
    {preview ? <Preview entry={preview} media={media} inUse={inUse(preview)} onBack={() => setPreview(null)} onUse={() => onUse(preview)} /> : <>
      <Text style={styles.playing} numberOfLines={2}>Playing: <Text style={styles.playingTitle}>{media.title ?? 'unknown'}</Text>{media.durationMs ? ` · ${length(media.durationMs)}` : ''}</Text>

      {editing ? <View style={styles.card}>
        <Text style={styles.label}>Song</Text>
        <TextInput value={fields.song} onChangeText={(song) => setFields({ ...fields, song })} onSubmitEditing={() => void search(fields)} returnKeyType="search" autoCorrect={false} spellCheck={false} maxLength={MAX_FIELD} placeholder="Song name" placeholderTextColor={colors.faint} accessibilityLabel="Song name" style={styles.input} />
        <Suggestions values={guess.songs} onPick={(song) => setFields({ ...fields, song })} />
        <Text style={styles.label}>Artist <Text style={styles.optional}>(optional)</Text></Text>
        <TextInput value={fields.artist} onChangeText={(artist) => setFields({ ...fields, artist })} onSubmitEditing={() => void search(fields)} returnKeyType="search" autoCorrect={false} spellCheck={false} maxLength={MAX_FIELD} placeholder="Artist" placeholderTextColor={colors.faint} accessibilityLabel="Artist" style={styles.input} />
        <Suggestions values={guess.artists} onPick={(artist) => setFields({ ...fields, artist })} />
        <Pressable onPress={() => void search(fields)} disabled={!fields.song.trim()} accessibilityRole="button" accessibilityLabel="Search LRCLIB" style={({ pressed }) => [styles.primary, pressed && styles.pressed, !fields.song.trim() && styles.disabled]}>
          <Search size={15} color={colors.onAccent} /><Text style={styles.primaryText}>Search LRCLIB</Text>
        </Pressable>
        <Text style={styles.hint}>Searches for the song and artist, then widens if too little is found.</Text>
        {status === 'error' ? <Text accessibilityRole="alert" style={styles.error}>Can’t reach LRCLIB. Check your internet connection, then try again.</Text> : null}
        {list && status === 'form' ? <Pressable onPress={() => setStatus('results')} accessibilityRole="button" style={styles.textButton}><Text style={styles.textButtonText}>Back to results</Text></Pressable> : null}
      </View> : null}

      {status === 'loading' ? <View style={styles.card}><View style={styles.loading}><ActivityIndicator color={colors.muted} /><Text style={styles.cardText}>Searching LRCLIB for {searched?.song}{searched?.artist ? ` · ${searched.artist}` : ''}…</Text></View></View> : null}

      {status === 'results' && list && searched ? <>
        <View style={[styles.card, styles.queryCard]}>
          <View style={styles.queryCopy}>
            <Text style={styles.queryTitle} numberOfLines={1}>{searched.song}{searched.artist ? ` · ${searched.artist}` : ''}</Text>
            <Text style={styles.cardText}>{plural(list.total, 'entry', 'entries')} found on LRCLIB</Text>
          </View>
          <Pressable onPress={() => setStatus('form')} accessibilityRole="button" accessibilityLabel="Edit the search" style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}><Text style={styles.smallButtonText}>Edit</Text></Pressable>
        </View>

        {list.entries.length > 0 ? <>
          <Text style={styles.heading}>Lyrics for this song</Text>
          {list.entries.map(renderRow)}
        </> : list.others.length > 0 ? <View style={styles.card}><Text style={styles.cardText}>LRCLIB has no entry of “{searched.song}”{searched.artist ? ` by ${searched.artist}` : ''}. These are other songs with that name.</Text></View> : null}

        {list.entries.length === 0 && list.others.length === 0 ? <View style={styles.card}>
          <Text style={styles.cardText}>LRCLIB has nothing for “{searched.song}”{searched.artist ? ` by ${searched.artist}` : ''}. Try a shorter name:</Text>
          <Suggestions values={[...new Set([guess.song, ...guess.songs])].filter((song) => song && song !== searched.song)} onPick={(song) => void search({ song, artist: searched.artist })} />
          {searched.artist ? <Pressable onPress={() => void search({ song: searched.song, artist: '' })} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Search “{searched.song}” without the artist</Text></Pressable> : null}
        </View> : null}

        {list.others.length > 0 ? <>
          {list.entries.length > 0 ? <Pressable onPress={() => setShowOthers((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded: showOthers }} style={styles.textButton}>
            <Text style={styles.textButtonText}>{showOthers ? 'Hide' : 'Show'} other songs named {searched.song} ({list.others.length})</Text>
          </Pressable> : null}
          {showOthers || list.entries.length === 0 ? list.others.map(renderRow) : null}
        </> : null}
      </> : null}

      {pickedId !== undefined ? <Pressable onPress={onAutomatic} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Back to automatic lyrics</Text></Pressable> : null}
    </>}
  </ScrollView>;
}

function Suggestions({ values, onPick }: { values: string[]; onPick: (value: string) => void }) {
  const styles = useStyles(makeStyles);
  if (values.length === 0) return null;
  return <View style={styles.chips}>
    {values.map((value) => <Pressable key={value} onPress={() => onPick(value)} accessibilityRole="button" accessibilityLabel={`Use ${value}`} style={({ pressed }) => [styles.chip, pressed && styles.pressed]}><Text style={styles.chipText} numberOfLines={1}>{value}</Text></Pressable>)}
  </View>;
}

// Everything known about an entry, as tags: what it is, how it fits the song, and what it shares.
// `plain` leaves out the length and shared-timing tags, for a row whose reason line already says them.
function Tags({ entry, recommended, closest, inUse, plain }: { entry: LyricsEntry; recommended?: boolean; closest?: boolean; inUse?: boolean; plain?: boolean }) {
  const styles = useStyles(makeStyles);
  const fit = plain ? null : lengthTag(entry);
  return <View style={styles.tags}>
    {recommended ? <Text style={[styles.tag, styles.tagRecommended]}>Recommended</Text> : null}
    {closest ? <Text style={[styles.tag, styles.tagGood]}>Closest</Text> : null}
    {inUse ? <Text style={[styles.tag, styles.tagInUse]}>In use</Text> : null}
    {entry.kind === 'plain' ? <Text style={[styles.tag, styles.tagWarn]}>Unsynced</Text> : entry.kind === 'instrumental' ? <Text style={styles.tag}>Instrumental</Text> : <Text style={styles.tag}>Synced</Text>}
    {entry.variant ? <Text style={[styles.tag, styles.tagWarn]}>{entry.variant}</Text> : null}
    {fit ? <Text style={[styles.tag, fit.good ? styles.tagGood : styles.tagWarn]}>{fit.text}</Text> : null}
    {entry.overruns ? <Text style={[styles.tag, styles.tagWarn]}>Too long for this song</Text> : null}
    {entry.ids.length > 1 && !plain ? <Text style={styles.tag}>{entry.ids.length} entries share this timing</Text> : null}
  </View>;
}

function EntryRow({ entry, recommended, closest, reason, inUse, onPress }: { entry: LyricsEntry; recommended: boolean; closest: boolean; reason?: string; inUse: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const subtitle = [entry.artist, entry.album].filter(Boolean).join(' · ');
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${entry.title}, ${subtitle}${recommended ? ', recommended' : ''}${inUse ? ', in use' : ''}`} style={({ pressed }) => [styles.row, recommended && styles.rowRecommended, pressed && styles.pressed]}>
    <View style={styles.rowTitle}>
      <Text style={styles.rowName} numberOfLines={1}>{entry.title}</Text>
      <ChevronRight size={16} color={colors.faint} />
    </View>
    {subtitle ? <Text style={styles.rowSub} numberOfLines={1}>{subtitle}</Text> : null}
    <Tags entry={entry} recommended={recommended} closest={closest} inUse={inUse} plain={Boolean(reason)} />
    {reason ? <Text style={styles.reason}>{reason}</Text> : null}
  </Pressable>;
}

// The entry's first lines and where it starts and ends, before it is used.
function Preview({ entry, media, inUse, onBack, onUse }: { entry: LyricsEntry; media: SystemMediaState; inUse: boolean; onBack: () => void; onUse: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const gap = entry.lengthGapS === undefined ? null : Math.round(Math.abs(entry.lengthGapS));
  const fit = !media.durationMs ? null
    : entry.overruns ? 'These lyrics run past the end of your song, so their timing belongs to a longer cut.'
    : entry.fitsLength ? 'The length matches your song.'
    : gap !== null ? `This entry is ${gap} s ${entry.lengthGapS !== undefined && entry.lengthGapS > 0 ? 'longer' : 'shorter'} than your song, so its timing may drift.`
    : null;
  return <>
    <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to results" style={styles.back}><ChevronLeft size={16} color={colors.muted} /><Text style={styles.backText}>Results</Text></Pressable>
    <View style={styles.card}>
      <Text style={styles.rowName}>{entry.title}</Text>
      <Text style={styles.rowSub}>{[entry.artist, entry.album].filter(Boolean).join(' · ')}</Text>
      <Tags entry={entry} inUse={inUse} />
    </View>
    <View style={styles.card}>
      {entry.preview.length > 0 ? entry.preview.map((line, index) => <View key={index} style={styles.lyricRow}>
        {line.timeMs !== undefined ? <Text style={styles.lyricTime}>{clock(line.timeMs)}</Text> : null}
        <Text style={styles.lyric}>{line.text}</Text>
      </View>) : <Text style={styles.cardText}>This entry is marked instrumental, so it has no lyrics.</Text>}
      {entry.lineCount > entry.preview.length ? <Text style={styles.cardText}>…</Text> : null}
    </View>
    <View style={styles.facts}>
      {entry.kind === 'synced' && entry.firstMs !== undefined && entry.lastMs !== undefined ? <Text style={styles.cardText}>Starts <Text style={styles.strong}>{clock(entry.firstMs)}</Text> · ends <Text style={styles.strong}>{clock(entry.lastMs)}</Text> · {plural(entry.lineCount, 'line', 'lines')}</Text>
        : entry.kind === 'plain' ? <Text style={styles.cardText}>Unsynced: the text scrolls, but doesn’t follow the song.</Text> : null}
      {media.durationMs ? <Text style={styles.cardText}>Your song is <Text style={styles.strong}>{length(media.durationMs)}</Text>. {fit}</Text> : null}
      {entry.ids.length > 1 ? <Text style={styles.cardText}>{plural(entry.ids.length - 1, 'other entry', 'other entries')} on LRCLIB carry this exact timing.</Text> : null}
    </View>
    <Pressable onPress={onUse} accessibilityRole="button" accessibilityLabel="Use these lyrics for this song" style={({ pressed }) => [styles.primary, pressed && styles.pressed]}><Text style={styles.primaryText}>{inUse ? 'Use these lyrics again' : 'Use these lyrics'}</Text></Pressable>
    <Pressable onPress={onBack} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>Back to results</Text></Pressable>
  </>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { padding: 16, gap: 10 },
  playing: { color: colors.faint, fontSize: 12, lineHeight: 16 },
  playingTitle: { color: colors.muted },
  card: { padding: 13, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.panel },
  cardText: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  strong: { color: colors.text, fontWeight: '600' },
  heading: { color: colors.muted, fontSize: 11, fontWeight: '700', marginTop: 4, textTransform: 'uppercase' },
  label: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  optional: { color: colors.faint, fontWeight: '400' },
  input: { height: 42, borderWidth: 1, borderColor: colors.border, borderRadius: 5, backgroundColor: colors.bg, paddingHorizontal: 10, color: colors.text, fontSize: 14 },
  hint: { color: colors.faint, fontSize: 12, lineHeight: 14 },
  error: { color: colors.red, fontSize: 13, lineHeight: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { maxWidth: '100%', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  chipText: { color: colors.text, fontSize: 12, fontWeight: '500' },
  primary: { height: 41, borderRadius: 5, backgroundColor: colors.accent, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  primaryText: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
  secondary: { height: 38, borderRadius: 5, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: colors.text, fontSize: 13, fontWeight: '500' },
  textButton: { minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  textButtonText: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  smallButton: { minWidth: 56, alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderRadius: 4, borderColor: colors.border, backgroundColor: colors.bg },
  smallButtonText: { color: colors.text, fontSize: 12, fontWeight: '500' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  queryCard: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  queryCopy: { flex: 1, minWidth: 0, gap: 3 },
  queryTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  row: { padding: 12, gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.panel },
  rowRecommended: { backgroundColor: colors.goodBg, borderColor: colors.goodBorder },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  rowSub: { color: colors.muted, fontSize: 12 },
  reason: { color: colors.mint, fontSize: 12, lineHeight: 15 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, borderWidth: 1, borderColor: colors.border, color: colors.muted, fontSize: 11, fontWeight: '500' },
  tagRecommended: { backgroundColor: colors.mint, borderColor: colors.mint, color: colors.onMint, fontWeight: '700' },
  tagInUse: { backgroundColor: colors.accent, borderColor: colors.accent, color: colors.onAccent, fontWeight: '700' },
  tagGood: { borderColor: colors.goodBorder, color: colors.mint },
  tagWarn: { borderColor: colors.warnBorder, color: colors.warn },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', minHeight: 32 },
  backText: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  lyricRow: { flexDirection: 'row', gap: 10, alignItems: 'baseline' },
  lyricTime: { width: 44, color: colors.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  lyric: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
  facts: { gap: 4 },
  pressed: { opacity: 0.76 },
  disabled: { opacity: 0.5 },
});
