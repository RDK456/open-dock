import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import * as Haptics from 'expo-haptics';
import { useStyles, type Colors } from './theme';

const PEEK = 12;
const STYLES = ['Fling', 'Slide', 'Flip', 'Zoom'] as const;
type SwipeStyle = (typeof STYLES)[number];

/**
 * Pages drawn as a stack of glass cards: the page on top, the next ones peeking out behind it by name.
 * Swipe the top card sideways to deal the next page, in one of four styles (tap the style chip to change it).
 * Any other page change, like opening a folder, zooms the new card in.
 */
export function DeckStack({ pages, index, onChange, children }: { pages: { id: string; name: string }[]; index: number; onChange: (next: number) => void; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  const [x] = useState(() => new Animated.Value(0));
  const [rise] = useState(() => new Animated.Value(1));
  const [enterFrom] = useState(() => new Animated.Value(0));
  const [zoomIn] = useState(() => new Animated.Value(1));
  const [swipe, setSwipe] = useState<SwipeStyle>('Fling');
  const width = useRef(1);
  const [cardWidth, setCardWidth] = useState(1);
  const state = useRef({ index, count: pages.length, onChange, reduce: false, swipe, dealing: false });
  useEffect(() => { state.current = { ...state.current, index, count: pages.length, onChange, swipe }; });

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => { state.current.reduce = reduce; });
    void Storage.getItem('opendock.swipe').then((saved) => { if (STYLES.includes(saved as SwipeStyle)) setSwipe(saved as SwipeStyle); });
  }, []);

  const cycle = () => {
    const next = STYLES[(STYLES.indexOf(swipe) + 1) % STYLES.length];
    setSwipe(next);
    void Haptics.selectionAsync();
    void Storage.setItem('opendock.swipe', next);
  };

  // A page change that didn't come from a swipe (a folder, a pip, the PC) zooms the card in.
  const currentId = pages[index]?.id;
  useEffect(() => {
    if (state.current.dealing) { state.current.dealing = false; return; }
    if (state.current.reduce) return;
    zoomIn.setValue(0);
    Animated.timing(zoomIn, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [currentId, zoomIn]);

  // The responder is made once; it reads the current page through the ref inside touch handlers only.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
    onPanResponderMove: (_, g) => {
      const { count } = state.current;
      // Pages loop: past the last comes the first again, so only a single page resists the swipe.
      x.setValue(count < 2 ? g.dx * 0.25 : g.dx);
    },
    onPanResponderRelease: (_, g) => {
      const { index: at, count, onChange: change, reduce } = state.current;
      const direction = g.dx < 0 ? 1 : -1;
      const next = (at + direction + count) % count;
      const flung = Math.abs(g.dx) > width.current * 0.22 || Math.abs(g.vx) > 0.55;
      if (!flung || count < 2) {
        Animated.spring(x, { toValue: 0, useNativeDriver: true, speed: 18, bounciness: 8 }).start();
        return;
      }
      const deal = () => {
        state.current.dealing = true;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        change(next);
        x.setValue(0);
        enterFrom.setValue(direction * width.current);
        rise.setValue(reduce ? 1 : 0);
        Animated.spring(rise, { toValue: 1, useNativeDriver: true, speed: 16, bounciness: state.current.swipe === 'Flip' ? 2 : 6 }).start();
      };
      if (reduce) return deal();
      Animated.timing(x, { toValue: -direction * width.current * 1.25, duration: 170, useNativeDriver: true }).start(deal);
    },
    onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(),
  }));

  // The cards stacked behind are the next pages round the loop.
  const behind = pages.length > 1 ? [1, 2].filter((step) => step < pages.length).map((step) => pages[(index + step) % pages.length]) : [];
  const span = Math.max(1, cardWidth);
  const leaving = x.interpolate({ inputRange: [-span, 0, span], outputRange: [1, 0, 1], extrapolate: 'clamp' });
  const zoomScale = zoomIn.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });
  // Each style has its own exit (driven by the drag) and entrance (driven by `rise`).
  const motion: Record<SwipeStyle, object[]> = {
    Fling: [
      { translateX: x },
      { rotate: x.interpolate({ inputRange: [-400, 0, 400], outputRange: ['-7deg', '0deg', '7deg'], extrapolate: 'clamp' }) },
      { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [PEEK * 2, 0] }) },
      { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [0.93, 1] }) },
    ],
    Slide: [{ translateX: Animated.add(x, Animated.multiply(Animated.subtract(1, rise), enterFrom)) }],
    Flip: [
      { perspective: 900 },
      { translateX: Animated.multiply(x, 0.35) },
      { rotateY: x.interpolate({ inputRange: [-span, 0, span], outputRange: ['70deg', '0deg', '-70deg'], extrapolate: 'clamp' }) },
      { rotateY: rise.interpolate({ inputRange: [0, 1], outputRange: ['-80deg', '0deg'] }) },
    ],
    Zoom: [
      { translateX: Animated.multiply(x, 0.4) },
      { scale: Animated.multiply(leaving.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }), rise.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] })) },
    ],
  };
  const fade = swipe === 'Zoom' || swipe === 'Flip' ? Animated.multiply(leaving.interpolate({ inputRange: [0, 1], outputRange: [1, 0.2] }), rise.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] })) : 1;

  return (
    <View style={[styles.wrap, { paddingTop: PEEK * behind.length + 4 }]} onLayout={(event) => { width.current = event.nativeEvent.layout.width; setCardWidth(width.current); }}>
      {behind.map((page, depth) => <View key={page.id} pointerEvents="none" style={[styles.card, styles.ghost, { top: PEEK * (behind.length - 1 - depth), transform: [{ scale: 1 - 0.035 * (depth + 1) }], opacity: 0.55 - depth * 0.18 }]}>
        <Text style={styles.ghostName} numberOfLines={1}>{page.name}</Text>
      </View>).reverse()}
      <Animated.View style={[styles.card, styles.top, { opacity: Animated.multiply(fade, zoomIn), transform: [...motion[swipe], { scale: zoomScale }] as never }]} {...responder.panHandlers}>
        <View style={styles.cardHead}>
          <Text style={styles.pageName} numberOfLines={1}>{pages[index]?.name}</Text>
          {pages.length > 1 ? <Pressable style={styles.styleChip} onPress={cycle} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Swipe animation: ${swipe}. Tap to change.`}>
            <Text style={styles.styleChipText}>{swipe}</Text>
          </Pressable> : null}
          {pages.length > 1 ? <View style={styles.pips} accessibilityLabel={`Page ${index + 1} of ${pages.length}`}>
            {pages.map((page, at) => <View key={page.id} style={[styles.pip, at === index && styles.pipOn]} />)}
          </View> : null}
        </View>
        <View style={styles.body}>{children}</View>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { flex: 1 },
  card: { borderRadius: 28, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  ghost: { position: 'absolute', left: 0, right: 0, height: 80, paddingHorizontal: 18, paddingTop: 2 },
  ghostName: { color: colors.muted, fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
  top: { flex: 1, padding: 12, backgroundColor: colors.panelRaised, shadowColor: colors.text, shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, paddingBottom: 10, gap: 12 },
  pageName: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  styleChip: { paddingHorizontal: 9, height: 22, borderRadius: 11, justifyContent: 'center', borderWidth: 1, borderColor: colors.glassBorder },
  styleChipText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  pips: { flexDirection: 'row', gap: 5 },
  pip: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderStrong },
  pipOn: { width: 18, backgroundColor: colors.accent },
  body: { flex: 1 },
});
