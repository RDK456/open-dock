import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Pressable } from './motion';
import { ChevronDown, Info } from 'lucide-react-native';
import { usePcConnection } from './connection';
import { canChoosePlayer, offerSwitch, otherPlayersOpen, playerColor, playerInitial, type MediaPlayer, type PlayersState } from './media-players';
import { useStyles, useTheme, type Colors } from './theme';

const TOAST_MS = 5000;
const DONE_MS = 3000;

export type MediaToast = { kind: 'offer'; player: MediaPlayer } | { kind: 'done'; text: string } | { kind: 'lost'; text: string };

// Everything the Deck screen needs for choosing a media player: the sheet, and the toast that offers a switch
// when another player starts.
export function useMediaSource() {
  const { mediaPlayers, selectMediaPlayer } = usePcConnection();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, setToast] = useState<MediaToast | null>(null);
  const previous = useRef<PlayersState | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const lostShown = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((next: MediaToast, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(next);
    timer.current = setTimeout(() => { timer.current = null; setToast(null); }, ms);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!mediaPlayers) {
      previous.current = null;
      seen.current = new Set();
      return;
    }
    const result = offerSwitch(previous.current, mediaPlayers, seen.current);
    seen.current = result.seen;
    previous.current = mediaPlayers;
    if (result.player) showToast({ kind: 'offer', player: result.player }, TOAST_MS);
    // A pinned player closed: say so once, however many reports repeat it.
    if (mediaPlayers.lost && mediaPlayers.lost !== lostShown.current) {
      lostShown.current = mediaPlayers.lost;
      showToast({ kind: 'lost', text: `${mediaPlayers.lost} closed. Switched to Auto.` }, TOAST_MS);
    } else if (!mediaPlayers.lost) lostShown.current = null;
  }, [mediaPlayers, showToast]);

  const choose = useCallback((playerId: string | null, name?: string) => {
    const sent = selectMediaPlayer(playerId);
    setSheetOpen(false);
    if (sent) showToast({ kind: 'done', text: playerId ? `Now controlling ${name ?? 'that player'}` : 'Following whatever is playing' }, DONE_MS);
  }, [selectMediaPlayer, showToast]);

  return {
    players: mediaPlayers,
    // Where the PC can only report one app (macOS) there is nothing to choose, so none of the choosing is shown.
    canSwitch: canChoosePlayer(mediaPlayers),
    multiple: otherPlayersOpen(mediaPlayers),
    sheetOpen: sheetOpen && canChoosePlayer(mediaPlayers),
    openSheet: () => { if (canChoosePlayer(mediaPlayers)) setSheetOpen(true); },
    closeSheet: () => setSheetOpen(false),
    toast,
    dismissToast: () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setToast(null); },
    choose,
  };
}

export function PlayerBadge({ id, name, size = 34 }: { id: string; name: string; size?: number }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.badge, { width: size, height: size, borderRadius: size * 0.27, backgroundColor: playerColor(id) }]}>
    <Text style={[styles.badgeLetter, { fontSize: size * 0.46 }]} allowFontScaling={false}>{playerInitial(name)}</Text>
  </View>;
}

// "● Spotify ▾", on the Now Playing widget. An amber dot says another player is open too. Where there is nothing to
// choose, it is only a label.
export function SourceChip({ name, color, multiple, interactive = true, onPress }: { name: string; color: string; multiple: boolean; interactive?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const inner = <>
    <View style={[styles.chipDot, { backgroundColor: color }]} />
    <Text style={styles.chipText} numberOfLines={1} allowFontScaling={false}>{name}</Text>
    {interactive && multiple ? <View style={styles.chipMore} /> : null}
    {interactive ? <ChevronDown size={11} color={colors.faint} /> : null}
  </>;
  return interactive
    ? <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Controlling ${name}. Choose a player`} style={styles.chip}>{inner}</Pressable>
    : <View accessible accessibilityLabel={`Controlling ${name}`} style={styles.chip}>{inner}</View>;
}

const STATE_LABEL: Record<MediaPlayer['state'], string> = { playing: 'Playing', paused: 'Paused', stopped: 'Stopped', unavailable: 'Not available' };

// The list of players. Portrait: a sheet from the bottom. Landscape: a panel from the right, so the deck stays visible.
export function PlayerSheet({ visible, landscape, state, controllingName, onChoose, onClose }: { visible: boolean; landscape: boolean; state: PlayersState | null; controllingName?: string; onChoose: (playerId: string | null, name?: string) => void; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const players = state?.players ?? [];
  const auto = !state?.pinned;
  const controlling = players.find((player) => player.id === state?.controlling);
  const body = <>
    <Text style={styles.sheetTitle}>Controlling</Text>
    <Text style={styles.sheetHint}>Pick which player the buttons and the widget use.</Text>
    <ScrollView style={styles.sheetList} contentContainerStyle={styles.sheetListContent}>
      <Pressable onPress={() => onChoose(null)} accessibilityRole="radio" accessibilityState={{ selected: auto }} style={[styles.row, auto && styles.rowSelected]}>
        <View style={[styles.badge, styles.autoBadge, { width: 34, height: 34, borderRadius: 9 }]}><Text style={styles.badgeLetter}>✦</Text></View>
        <View style={styles.rowText}><Text style={styles.rowName}>Auto</Text><Text style={styles.rowSub} numberOfLines={1}>{controlling ? `Following ${controlling.name}${controlling.title ? ` · ${controlling.title}` : ''}` : controllingName ? `Following ${controllingName}` : 'Follows whatever is playing'}</Text></View>
        <View style={[styles.radio, auto && styles.radioOn]} />
      </Pressable>
      {players.map((player) => {
        const selected = state?.pinned === player.id;
        return <Pressable key={player.id} onPress={() => onChoose(player.id, player.name)} accessibilityRole="radio" accessibilityState={{ selected }} style={[styles.row, selected && styles.rowSelected]}>
          <PlayerBadge id={player.id} name={player.name} />
          <View style={styles.rowText}><Text style={styles.rowName} numberOfLines={1}>{player.name}</Text><Text style={styles.rowSub} numberOfLines={1}>{[player.title, player.artist].filter(Boolean).join(' · ') || STATE_LABEL[player.state]}</Text></View>
          <View style={styles.rowEnd}><Text style={[styles.pillText, player.state === 'playing' && styles.pillPlaying]}>{STATE_LABEL[player.state]}</Text><View style={[styles.radio, selected && styles.radioOn]} /></View>
        </Pressable>;
      })}
      {players.length === 0 ? <Text style={styles.sheetHint}>No players are open on the PC.</Text> : null}
    </ScrollView>
    <View style={styles.tip}><Info size={14} color={colors.faint} /><Text style={styles.tipText}>Don’t see your player? Players can only be listed if they offer media controls to the system. Look for “media controls” or “media keys” in its settings.</Text></View>
  </>;
  return <Modal visible={visible} transparent animationType={landscape ? 'fade' : 'slide'} onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
    <View style={[styles.scrim, landscape && styles.scrimLandscape]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      <View style={landscape ? styles.panel : styles.sheet} accessibilityViewIsModal>
        {landscape ? null : <View style={styles.grab} />}
        {body}
      </View>
    </View>
  </Modal>;
}

export function MediaToastView({ toast, bottom, onSwitch, onDismiss }: { toast: MediaToast | null; bottom: number; onSwitch: (player: MediaPlayer) => void; onDismiss: () => void }) {
  const styles = useStyles(makeStyles);
  if (!toast) return null;
  return <View pointerEvents="box-none" style={[styles.toastWrap, { bottom }]}>
    <View style={styles.toast} accessibilityRole="alert" accessibilityLiveRegion="polite">
      {toast.kind === 'offer'
        ? <>
          <Text style={styles.toastText} numberOfLines={1}>{toast.player.name} is also playing</Text>
          <Pressable onPress={() => onSwitch(toast.player)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Switch to ${toast.player.name}`}><Text style={styles.toastAction}>Switch</Text></Pressable>
        </>
        : <>
          <Text style={styles.toastText} numberOfLines={2}>{toast.text}</Text>
          <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss"><Text style={styles.toastDismiss}>OK</Text></Pressable>
        </>}
    </View>
  </View>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center' },
  autoBadge: { backgroundColor: colors.pressed, borderWidth: 1, borderColor: colors.border },
  badgeLetter: { color: '#09090b', fontWeight: '700', fontSize: 15 },
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, maxWidth: 160, minHeight: 24, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.float },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { flexShrink: 1, color: colors.text, fontSize: 11, fontWeight: '500' },
  chipMore: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.star },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim },
  scrimLandscape: { flexDirection: 'row', justifyContent: 'flex-end' },
  sheet: { maxHeight: '82%', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 26, gap: 10, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.panelRaised },
  panel: { width: 320, maxWidth: '55%', height: '100%', paddingHorizontal: 14, paddingTop: 16, paddingBottom: 14, gap: 8, borderLeftWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.panelRaised },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  sheetHint: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  sheetList: { flexGrow: 0 },
  sheetListContent: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  rowSelected: { borderColor: colors.borderFocus, backgroundColor: colors.pressed },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowSub: { color: colors.faint, fontSize: 12, marginTop: 1 },
  rowEnd: { alignItems: 'flex-end', gap: 6 },
  pillText: { color: colors.muted, fontSize: 11, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1, borderColor: colors.borderStrong, overflow: 'hidden' },
  pillPlaying: { color: colors.mint, borderColor: colors.playingBorder },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.borderStrong },
  radioOn: { borderWidth: 5, borderColor: colors.text },
  tip: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderStrong },
  tipText: { flex: 1, color: colors.muted, fontSize: 12, lineHeight: 16 },
  toastWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center', zIndex: 50 },
  toast: { width: '100%', maxWidth: 420, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.panelRaised },
  toastText: { flex: 1, color: colors.text, fontSize: 13 },
  toastAction: { color: colors.text, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  toastDismiss: { color: colors.muted, fontSize: 13, fontWeight: '500' },
});
