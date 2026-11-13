import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, GalleryHorizontal, LayoutGrid, Monitor, RectangleVertical } from 'lucide-react-native';
import Storage from 'expo-sqlite/kv-store';
import { Pressable } from './motion';
import { applyPcWallpaper, loadWallpaperThumb, loadWallpapers, useDesktopWallpapers, type PcWallpaper } from './desktop-wallpaper-feed';
import { haptic } from './prefs';
import { useStyles, useTheme, type Colors } from './theme';

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
  const shown = items;
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
      <Pressable style={styles.menuButton} hitSlop={7} onPress={() => { haptic.select(); setMenu(!menu); }} accessibilityRole="button" accessibilityState={{ expanded: menu }} accessibilityLabel={`Display: ${displayLabel}. Choose a display`}>
        <Monitor size={13} color={colors.muted} /><Text style={styles.menuText} numberOfLines={1}>{displayLabel}</Text><ChevronDown size={13} color={colors.muted} />
      </Pressable>
      <View style={styles.layouts}>
        {LAYOUTS.map(([id, Icon, name]) => <Pressable key={id} hitSlop={{ top: 7, bottom: 7 }} style={[styles.layoutButton, layout === id && { backgroundColor: colors.pressed }]} onPress={() => { haptic.select(); change({ layout: id }); }} accessibilityRole="button" accessibilityState={{ selected: layout === id }} accessibilityLabel={`${name} layout`}>
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
      {/* Lists, not plain scroll views: only the previews on screen are loaded and kept, so hundreds fit in memory. */}
      {pager.width > 0 ? <FlatList horizontal pagingEnabled showsHorizontalScrollIndicator={false} nestedScrollEnabled data={shown} keyExtractor={(item) => item.id} windowSize={3} initialNumToRender={2} maxToRenderPerBatch={2}
        getItemLayout={(_, index) => ({ length: pager.width, offset: pager.width * index, index })}
        renderItem={({ item, index }) => <View style={{ width: pager.width, height: pager.height, paddingHorizontal: 2 }}>
          <View style={styles.widgetScroll}>{tile(item, true)}</View>
          <Text style={styles.count}>{index + 1} / {shown.length}</Text>
        </View>} /> : null}
    </View> : <FlatList style={styles.widgetScroll} contentContainerStyle={[styles.widgetContent, { gap: 8 }]} showsVerticalScrollIndicator={false} nestedScrollEnabled data={rows} keyExtractor={(row) => row[0].id} windowSize={5} initialNumToRender={4}
      renderItem={({ item: row }) => <View style={styles.rowTight}>{row.map((item) => tile(item))}</View>} />}
    {result && !pending && !result.ok ? <Text style={[styles.hint, { color: colors.red }]} accessibilityLiveRegion="polite">{result.error ?? 'Could not change the wallpaper.'}</Text> : null}
  </View>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  hint: { color: colors.faint, fontSize: 12, marginTop: 9, lineHeight: 15 },
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
  menuItem: { minHeight: 40, paddingHorizontal: 8, justifyContent: 'center' },
  layouts: { flexDirection: 'row', gap: 2, flexShrink: 0 },
  layoutButton: { width: 30, height: 30, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  count: { position: 'absolute', right: 8, top: 6, color: colors.text, fontSize: 10, backgroundColor: colors.panelRaised, paddingHorizontal: 5, borderRadius: 4, overflow: 'hidden' },
  widgetCenter: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  widgetScroll: { flex: 1, width: '100%' },
  widgetContent: { paddingBottom: 6 },
});
