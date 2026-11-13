import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ChevronDown, GalleryHorizontal, LayoutGrid, Monitor, RectangleVertical } from 'lucide-react-native';
import Storage from 'expo-sqlite/kv-store';
import { Pressable } from './motion';
import { usePcConnection } from './connection';
import { applyPcWallpaper, loadWallpaperThumb, loadWallpapers, useDesktopWallpapers, type PcWallpaper } from './desktop-wallpaper-feed';
import { haptic } from './prefs';
import { useStyles, useTheme, type Colors } from './theme';

const COLUMNS = 3;
const SHOWN = 60;

function Tile({ item, preview, busy, chosen, fill, width, onPick }: { item: PcWallpaper; preview: string | null | undefined; busy: boolean; chosen?: boolean; fill?: boolean; width?: number; onPick: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  // Ask for the picture when the tile first shows; a tile with no preview stays plain.
  useEffect(() => { if (item.preview) loadWallpaperThumb(item.id); }, [item.id, item.preview]);
  return <Pressable style={width ? { width } : fill ? styles.tileFill : styles.tile} onPress={onPick} disabled={busy} accessibilityRole="button" accessibilityLabel={`Set ${item.title} as the PC wallpaper`}>
    <View style={[styles.thumb, fill && styles.thumbFill, chosen && { borderColor: colors.accent, borderWidth: 2 }]}>
      {preview ? <Image source={{ uri: preview }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors /> : <Text style={styles.kind}>{item.kind || 'wallpaper'}</Text>}
    </View>
    <Text style={styles.name} numberOfLines={1}>{item.title}</Text>
  </Pressable>;
}

/** The "Desktop wallpaper" card: lists the PC's Wallpaper Engine wallpapers and sets the one you tap. */
export function DesktopWallpaperCard() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { status } = usePcConnection();
  const { loaded, supported, installed, items, thumbs, result, seq } = useDesktopWallpapers();
  const [query, setQuery] = useState('');
  // The feed's counter when a wallpaper was tapped; the PC's answer, or a dropped connection, moves it on and ends the wait.
  const [waitingAfter, setWaitingAfter] = useState<number | null>(null);
  const pending = waitingAfter !== null && seq === waitingAfter;
  const connected = status === 'connected';

  useEffect(() => { if (connected) loadWallpapers(); }, [connected]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (needle ? items.filter((item) => item.title.toLowerCase().includes(needle)) : items).slice(0, SHOWN);
  }, [items, query]);
  const rows = useMemo(() => Array.from({ length: Math.ceil(shown.length / COLUMNS) }, (_, row) => shown.slice(row * COLUMNS, row * COLUMNS + COLUMNS)), [shown]);

  const pick = (item: PcWallpaper) => {
    haptic.select();
    if (applyPcWallpaper(item.id)) setWaitingAfter(seq);
  };

  let body;
  if (!connected) body = <Text style={styles.hint}>Connect to your PC to choose its wallpaper.</Text>;
  else if (!loaded) body = <View style={styles.center}><ActivityIndicator color={colors.muted} /></View>;
  else if (!supported) body = <Text style={styles.hint}>Wallpaper Engine control works on Windows PCs only.</Text>;
  else if (!installed) body = <Text style={styles.hint}>Wallpaper Engine was not found on this PC. Install it from Steam, then refresh.</Text>;
  else if (items.length === 0) body = <Text style={styles.hint}>No wallpapers yet. Subscribe to some in the Steam Workshop, then refresh.</Text>;
  else body = <>
    <TextInput value={query} onChangeText={setQuery} placeholder="Search wallpapers" placeholderTextColor={colors.faint} style={styles.search} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Search wallpapers" />
    {shown.length === 0 ? <Text style={styles.hint}>Nothing matches that search.</Text> : rows.map((row, index) => <View key={index} style={styles.row}>
      {row.map((item) => <Tile key={item.id} item={item} preview={thumbs[item.id]} busy={pending} onPick={() => pick(item)} />)}
      {Array.from({ length: COLUMNS - row.length }, (_, fill) => <View key={`fill-${fill}`} style={styles.tile} />)}
    </View>)}
    {items.length > SHOWN && !query ? <Text style={styles.hint}>Showing {SHOWN} of {items.length}. Search to find the rest.</Text> : null}
  </>;

  return <View style={styles.card}>
    <View style={styles.head}>
      <Text style={styles.title}>Desktop wallpaper</Text>
      {connected && loaded && supported ? <Pressable style={styles.refresh} onPress={() => { haptic.select(); loadWallpapers(true); }} accessibilityRole="button" accessibilityLabel="Rescan wallpapers"><Text style={styles.refreshText}>Refresh</Text></Pressable> : null}
    </View>
    {body}
    {pending ? <Text style={styles.hint}>Changing wallpaper…</Text> : result ? <Text style={[styles.hint, !result.ok && { color: colors.red }]} accessibilityLiveRegion="polite">{result.ok ? 'Wallpaper changed.' : result.error ?? 'Could not change the wallpaper.'}</Text> : null}
  </View>;
}

type Layout = 'grid' | 'cards' | 'carousel';
const LAYOUTS: [Layout, typeof LayoutGrid, string][] = [['grid', LayoutGrid, 'Grid'], ['cards', RectangleVertical, 'Cards'], ['carousel', GalleryHorizontal, 'Carousel']];
const asLayout = (value: unknown): Layout | undefined => (value === 'grid' || value === 'cards' || value === 'carousel' ? value : undefined);

// What this phone last chose in the widget: its layout (over the one set on the PC) and which display.
type Choice = { layout?: Layout; display?: number };
const CHOICE_KEY = 'opendock.wallpaperWidget';
function readChoice(): Choice {
  try {
    const saved = JSON.parse(Storage.getItemSync(CHOICE_KEY) ?? '{}') as { layout?: unknown; display?: unknown };
    return { layout: asLayout(saved.layout), display: Number.isInteger(saved.display) ? (saved.display as number) : undefined };
  } catch { return {}; }
}

/** The deck widget: a top bar (which display, and the layout) over the PC's wallpapers; a tap sets one. */
export function WallpaperWidget({ connected, focused, face }: { connected: boolean; focused: boolean; face?: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { loaded, supported, installed, items, displays, thumbs, result, seq } = useDesktopWallpapers();
  const [choice, setChoice] = useState(readChoice);
  const [menu, setMenu] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [pager, setPager] = useState({ width: 0, height: 0 });
  const [waitingAfter, setWaitingAfter] = useState<number | null>(null);
  const pending = waitingAfter !== null && seq === waitingAfter;
  useEffect(() => { if (connected && focused) loadWallpapers(); }, [connected, focused]);

  const layout = choice.layout ?? asLayout(face) ?? 'grid';
  // A display that has been unplugged falls back to all displays.
  const display = displays.some((entry) => entry.index === choice.display) ? choice.display : undefined;
  const change = (patch: Choice) => {
    const next = { ...choice, ...patch };
    setChoice(next);
    try { Storage.setItemSync(CHOICE_KEY, JSON.stringify(next)); } catch { /* lasts until the app closes */ }
  };
  // A gallery: as many columns as fit ~150 px previews; cards are one wide column.
  const columns = layout === 'grid' ? Math.max(2, Math.round(size.width / 150)) : 1;
  const shown = useMemo(() => items.slice(0, SHOWN), [items]);
  const rows = useMemo(() => Array.from({ length: Math.ceil(shown.length / columns) }, (_, row) => shown.slice(row * columns, row * columns + columns)), [shown, columns]);
  const chosenId = result?.ok ? result.id : undefined;
  const pick = (item: PcWallpaper) => { haptic.select(); if (applyPcWallpaper(item.id, display)) setWaitingAfter(seq); };
  const tileWidth = size.width > 0 ? Math.floor((size.width - 8 * (columns - 1)) / columns) : undefined;
  const tile = (item: PcWallpaper, fill?: boolean) => <Tile key={item.id} item={item} preview={thumbs[item.id]} busy={pending} chosen={item.id === chosenId} fill={fill} width={fill ? undefined : tileWidth} onPick={() => pick(item)} />;

  const note = !connected ? 'Connect to your PC' : !loaded ? null : !supported ? 'Windows only' : !installed ? 'Wallpaper Engine not found' : items.length === 0 ? 'No wallpapers found' : undefined;
  if (note !== undefined) return <View style={styles.widgetCenter}>{note === null ? <ActivityIndicator color={colors.muted} /> : <Text style={styles.hint}>{note}</Text>}</View>;

  const displayLabel = displays.find((entry) => entry.index === display)?.label ?? 'All displays';
  const options: { index: number | undefined; label: string }[] = [{ index: undefined, label: 'All displays' }, ...displays];
  return <View style={styles.widgetScroll} onLayout={(event) => setSize(event.nativeEvent.layout)}>
    <View style={styles.bar}>
      <Pressable style={styles.menuButton} onPress={() => { haptic.select(); setMenu(!menu); }} accessibilityRole="button" accessibilityState={{ expanded: menu }} accessibilityLabel={`Display: ${displayLabel}. Choose a display`}>
        <Monitor size={13} color={colors.muted} /><Text style={styles.menuText} numberOfLines={1}>{displayLabel}</Text><ChevronDown size={13} color={colors.muted} />
      </Pressable>
      <View style={styles.layouts}>
        {LAYOUTS.map(([id, Icon, name]) => <Pressable key={id} style={[styles.layoutButton, layout === id && { backgroundColor: colors.pressed }]} onPress={() => { haptic.select(); change({ layout: id }); }} accessibilityRole="button" accessibilityState={{ selected: layout === id }} accessibilityLabel={`${name} layout`}>
          <Icon size={14} color={layout === id ? colors.text : colors.muted} />
        </Pressable>)}
      </View>
    </View>
    {menu ? <ScrollView style={styles.menu} nestedScrollEnabled>
      {options.map((entry) => <Pressable key={entry.label} style={styles.menuItem} onPress={() => { haptic.select(); change({ display: entry.index }); setMenu(false); }} accessibilityRole="button" accessibilityState={{ selected: entry.index === display }}>
        <Text style={[styles.menuText, entry.index === display && { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{entry.label}</Text>
      </Pressable>)}
    </ScrollView> : null}
    {layout === 'carousel' ? <View style={styles.widgetScroll} onLayout={(event) => setPager(event.nativeEvent.layout)}>
      {pager.width > 0 ? <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        {shown.map((item, index) => <View key={item.id} style={{ width: pager.width, height: pager.height, paddingHorizontal: 2 }}>
          <View style={styles.widgetScroll}>{tile(item, true)}</View>
          <Text style={styles.count}>{index + 1} / {shown.length}</Text>
        </View>)}
      </ScrollView> : null}
    </View> : <ScrollView style={styles.widgetScroll} contentContainerStyle={[styles.widgetContent, { gap: 8 }]} showsVerticalScrollIndicator={false} nestedScrollEnabled>
      {rows.map((row, index) => <View key={index} style={styles.rowTight}>
        {row.map((item) => tile(item))}
        </View>)}
    </ScrollView>}
    {result && !pending && !result.ok ? <Text style={[styles.hint, { color: colors.red }]} accessibilityLiveRegion="polite">{result.error ?? 'Could not change the wallpaper.'}</Text> : null}
  </View>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { marginTop: 14, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.panel },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 13, fontWeight: '500' },
  refresh: { paddingHorizontal: 10, minHeight: 32, borderRadius: 5, justifyContent: 'center', backgroundColor: colors.bg },
  refreshText: { color: colors.muted, fontSize: 12 },
  hint: { color: colors.faint, fontSize: 12, marginTop: 9, lineHeight: 15 },
  center: { paddingVertical: 18 },
  search: { marginTop: 10, minHeight: 38, paddingHorizontal: 10, borderRadius: 5, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, color: colors.text, fontSize: 13 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  tile: { flex: 1, minWidth: 0 },
  tileFill: { flex: 1, minWidth: 0 },
  rowTight: { flexDirection: 'row', gap: 8 },
  thumbFill: { flex: 1, aspectRatio: undefined },
  thumb: { aspectRatio: 16 / 10, borderRadius: 5, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panelRaised, borderWidth: 1, borderColor: colors.border },
  kind: { color: colors.faint, fontSize: 11, textTransform: 'capitalize' },
  name: { color: colors.muted, fontSize: 11, marginTop: 4 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 4 },
  menuButton: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 30, paddingHorizontal: 6, borderRadius: 5 },
  menuText: { color: colors.muted, fontSize: 11, flexShrink: 1 },
  menu: { position: 'absolute', top: 34, left: 0, zIndex: 10, elevation: 8, maxHeight: 160, minWidth: 180, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  menuItem: { minHeight: 32, paddingHorizontal: 8, justifyContent: 'center' },
  layouts: { flexDirection: 'row', gap: 2, flexShrink: 0 },
  layoutButton: { width: 30, height: 30, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  count: { position: 'absolute', right: 8, top: 6, color: '#fff', fontSize: 10, backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 5, borderRadius: 4, overflow: 'hidden' },
  widgetCenter: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  widgetScroll: { flex: 1, width: '100%' },
  widgetContent: { paddingBottom: 6 },
});
