import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Music, Pause, Play, SkipBack, SkipForward } from 'lucide-react-native';
import { useMediaState, usePcConnection } from './connection';
import { Pressable } from './motion';
import { useStyles, useTheme, type Colors } from './theme';

/**
 * The deck's resting screen: a big clock and date and what the PC is playing, in the chosen look's colours
 * and type. Tapping anywhere outside the media controls goes back to the deck.
 */
export function AmbientView({ onWake }: { onWake: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors, key: design } = useTheme();
  const { width, height } = useWindowDimensions();
  const media = useMediaState();
  const { sendMediaCommand, status } = usePcConnection();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Ticks on the minute, so the clock turns over on time without waking every second.
    let timer = setTimeout(function tick() { setNow(new Date()); timer = setTimeout(tick, 60_000 - (Date.now() % 60_000)); }, 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(timer);
  }, []);
  const wide = width > height;
  const short = Math.min(width, height);
  const clock = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const caps = (text: string) => design.caps ? text.toUpperCase() : text;
  const playing = media.playbackState === 'playing';
  const hasMedia = status === 'connected' && media.playbackState !== 'unavailable' && !!media.title;
  const art = short * (wide ? 0.32 : 0.42);
  const control = Math.max(44, short * 0.11);

  return (
    <Pressable style={[StyleSheet.absoluteFill, styles.root]} onPress={onWake} accessibilityRole="button" accessibilityLabel="Ambient screen. Tap to go back to the deck">
      <View style={[styles.layout, { flexDirection: wide ? 'row' : 'column', gap: short * 0.08 }]}>
        <View style={{ alignItems: wide && hasMedia ? 'flex-start' : 'center' }}>
          <Text allowFontScaling={false} style={[styles.clock, { fontSize: short * (wide ? 0.26 : 0.22), fontFamily: design.font, letterSpacing: design.tracking ?? -2 }]}>{clock}</Text>
          <Text allowFontScaling={false} style={[styles.date, { fontSize: Math.max(15, short * 0.045), fontFamily: design.font }]}>{caps(date)}</Text>
        </View>
        {hasMedia ? (
          <View style={[styles.media, { width: wide ? art * 1.5 : '100%', maxWidth: 440 }]}>
            {media.artworkDataUrl
              ? <Image source={{ uri: media.artworkDataUrl }} style={{ width: art, height: art, borderRadius: Math.min(design.radius ?? 12, art / 6) }} accessibilityIgnoresInvertColors />
              : <View style={[styles.artEmpty, { width: art, height: art, borderRadius: Math.min(design.radius ?? 12, art / 6) }]}><Music size={art * 0.35} color={colors.muted} strokeWidth={1.4} /></View>}
            <Text numberOfLines={1} style={[styles.title, { fontFamily: design.font }]}>{media.title}</Text>
            {media.artist ? <Text numberOfLines={1} style={[styles.artist, { fontFamily: design.font }]}>{media.artist}</Text> : null}
            <View style={styles.controls}>
              <Pressable onPress={() => sendMediaCommand('previous_track')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Previous track" style={[styles.control, { width: control, height: control }]}><SkipBack size={control * 0.42} color={colors.text} strokeWidth={1.8} /></Pressable>
              <Pressable onPress={() => sendMediaCommand('play_pause')} hitSlop={8} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'} style={[styles.control, styles.play, { width: control * 1.25, height: control * 1.25 }]}>
                {playing ? <Pause size={control * 0.5} color={colors.onAccent} strokeWidth={1.8} /> : <Play size={control * 0.5} color={colors.onAccent} strokeWidth={1.8} />}
              </Pressable>
              <Pressable onPress={() => sendMediaCommand('next_track')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Next track" style={[styles.control, { width: control, height: control }]}><SkipForward size={control * 0.42} color={colors.text} strokeWidth={1.8} /></Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  root: { backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  layout: { alignItems: 'center', justifyContent: 'center' },
  clock: { color: colors.text, fontWeight: '200', fontVariant: ['tabular-nums'], includeFontPadding: false },
  date: { color: colors.muted, marginTop: 4 },
  media: { alignItems: 'center', gap: 8 },
  artEmpty: { backgroundColor: colors.panel, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 17, fontWeight: '600', marginTop: 6, maxWidth: '100%' },
  artist: { color: colors.muted, fontSize: 14, maxWidth: '100%' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 8 },
  control: { borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panel },
  play: { backgroundColor: colors.accent },
});
