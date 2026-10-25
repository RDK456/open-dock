import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View, type PressableProps, type View as ViewType } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';
import { usePathname, useRouter } from 'expo-router';
import { TabList, Tabs, TabSlot, TabTrigger, type TabTriggerSlotProps } from 'expo-router/ui';
import { useTheme, type Colors, type Look } from '../theme';

// Each look's own navigation, floating over the screens as on the PC: Studio's icon rail, Atelier's serif tabs,
// Signal's mono pill, Glass's frosted dock, Funk's chunky tiles, Classic's plain dock. Sideways, where height is
// short and width spare, every look stands its bar up as a rail on the left so the deck keeps its height.
const TABS = [
  { name: 'index', href: '/', label: 'Deck' },
  { name: 'touch', href: '/touch', label: 'Touch' },
  { name: 'voice', href: '/voice', label: 'Voice' },
  { name: 'connect', href: '/connect', label: 'Connect' },
] as const;
type TabName = (typeof TABS)[number]['name'];

const TAB_PATHS = TABS.map((tab) => tab.href as string);
/** Which tab a path is on (the Deck tab is '/'). */
const tabIndexOf = (path: string) => Math.max(0, TAB_PATHS.findIndex((href) => (href === '/' ? path === '/' || path === '/index' : path.startsWith(href))));

const RAIL = 64;
const GAP = 12;
/** The tallest dock (Funk's) plus the gap under it. */
export const DOCK_ROOM = 62 + GAP;

/** Whether the bar is a rail on the left: always in Studio, and in every look when the screen is sideways. */
export function useRail(look: Look): boolean {
  const { width, height } = useWindowDimensions();
  return look === 'studio' || width > height;
}

function Icon({ name, color, stroke, size = 22 }: { name: TabName; color: string; stroke: number; size?: number }) {
  const line = { stroke: color, strokeWidth: stroke, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'index' ? <>
        <Rect x={3} y={3} width={7} height={7} rx={1.5} {...line} /><Rect x={14} y={3} width={7} height={7} rx={1.5} {...line} />
        <Rect x={3} y={14} width={7} height={7} rx={1.5} {...line} /><Rect x={14} y={14} width={7} height={7} rx={1.5} {...line} />
      </> : name === 'touch' ? <>
        <Path d="M10 9.5V4a2 2 0 0 0-4 0v10" {...line} /><Path d="M14 10V9a2 2 0 0 0-4 0v1" {...line} /><Path d="M18 11v-1a2 2 0 0 0-4 0" {...line} />
        <Path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" {...line} />
      </> : name === 'voice' ? <>
        <Path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" {...line} /><Path d="M19 10v2a7 7 0 0 1-14 0v-2" {...line} /><Path d="M12 19v3" {...line} />
      </> : <>
        <Path d="M12 20h.01" {...line} /><Path d="M2 8.82a15 15 0 0 1 20 0" {...line} /><Path d="M5 12.86a10 10 0 0 1 14 0" {...line} /><Path d="M8.5 16.43a5 5 0 0 1 7 0" {...line} />
      </>}
    </Svg>
  );
}

type ItemProps = TabTriggerSlotProps & { tab: (typeof TABS)[number]; look: Look; badge: boolean; rail: boolean };

// TabTrigger hands its press handlers and focus to this through `asChild`.
const Item = forwardRef<ViewType, ItemProps>(function Item({ tab, look, badge, rail, isFocused, ...press }, ref) {
  const { colors, key } = useTheme();
  const s = itemStyles(look, colors, !!isFocused, rail);
  const ink = s.ink;
  // A tab springs when pressed and pops when it becomes the current one.
  const [scale] = useState(() => new Animated.Value(1));
  const wasFocused = useRef(!!isFocused);
  useEffect(() => {
    if (isFocused && !wasFocused.current) {
      scale.setValue(0.82);
      Animated.spring(scale, { toValue: 1, speed: 16, bounciness: 14, useNativeDriver: true }).start();
    }
    wasFocused.current = !!isFocused;
  }, [isFocused, scale]);
  const squash = (to: number) => Animated.spring(scale, { toValue: to, speed: 40, bounciness: 8, useNativeDriver: true }).start();
  let body: ReactNode;
  switch (rail ? 'rail' : look) {
    case 'rail':
      body = <Icon name={tab.name} color={ink} stroke={key.iconStroke} />;
      break;
    case 'atelier':
      body = <Text style={[styles.atelierLabel, { color: ink }]}>{tab.label}</Text>;
      break;
    case 'signal':
      body = <Text style={[styles.signalLabel, { color: ink }]}>{tab.label.toUpperCase()}</Text>;
      break;
    default:
      body = <><Icon name={tab.name} color={ink} stroke={key.iconStroke} size={20} /><Text style={[look === 'funk' ? styles.funkLabel : styles.dockLabel, { color: ink }]}>{tab.label}</Text></>;
  }
  return (
    <Pressable ref={ref} {...(press as PressableProps)} onPressIn={(event) => { squash(0.88); (press as PressableProps).onPressIn?.(event); }} onPressOut={(event) => { squash(1); (press as PressableProps).onPressOut?.(event); }} style={s.item} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected: !!isFocused }}>
      <Animated.View style={[styles.itemInner, { transform: [{ scale }] }]}>{body}</Animated.View>
      {badge ? <View style={[styles.badge, { backgroundColor: colors.red }]} /> : null}
    </Pressable>
  );
});

function itemStyles(look: Look, colors: Colors, on: boolean, rail: boolean) {
  // On a rail every look shows icons only, in its own square: Studio's tinted tile, Atelier's bronze side rule,
  // Signal's white disc, Funk's inked block, Glass's and Classic's soft disc.
  if (rail) {
    switch (look) {
      case 'studio':
        return { ink: on ? colors.accent : colors.faint, item: [styles.railItem, on && { backgroundColor: colors.glow }] };
      case 'atelier':
        return { ink: on ? colors.text : colors.faint, item: [styles.railItem, styles.atelierRailItem, { borderLeftColor: on ? colors.accent : 'transparent' }] };
      case 'signal':
        return { ink: on ? colors.onAccent : colors.muted, item: [styles.railItem, styles.round, on && { backgroundColor: colors.accent }] };
      case 'funk':
        return { ink: on ? colors.onAccent : colors.text, item: [styles.railItem, styles.funkRailItem, { borderColor: colors.glassBorder, backgroundColor: on ? colors.accent : colors.panelRaised }] };
      default:
        return { ink: on ? colors.text : colors.muted, item: [styles.railItem, styles.round, on && { backgroundColor: look === 'glass' ? colors.glass : colors.pressed }] };
    }
  }
  switch (look) {
    case 'atelier':
      return { ink: on ? colors.text : colors.faint, item: [styles.atelierItem, { borderBottomColor: on ? colors.accent : 'transparent' }] };
    case 'signal':
      return { ink: on ? colors.onAccent : colors.muted, item: [styles.signalItem, on && { backgroundColor: colors.accent }] };
    case 'funk':
      return { ink: on ? colors.onAccent : colors.text, item: [styles.funkItem, { borderColor: colors.glassBorder, backgroundColor: on ? colors.accent : colors.panelRaised }] };
    default:
      return { ink: on ? colors.text : colors.muted, item: [styles.dockItem, on && { backgroundColor: look === 'glass' ? colors.glass : colors.pressed, borderColor: colors.glassBorder }] };
  }
}

/** The tabs in the current look. `hidden` puts the bar away for immersive mode. */
export function LookTabs({ hidden, badge }: { hidden: boolean; badge: boolean }) {
  const { colors, look } = useTheme();
  const insets = useSafeAreaInsets();
  const rail = useRail(look);
  const pathname = usePathname();
  const router = useRouter();
  const index = tabIndexOf(pathname);

  // Changing tab zooms the new screen in, from the side the tab sits on: forward grows into place, back shrinks into it.
  const [zoom] = useState(() => new Animated.Value(1));
  const from = useRef(index);
  const [offset] = useState(() => new Animated.Value(-0.08));
  useEffect(() => {
    if (from.current === index) return;
    offset.setValue(index > from.current ? -0.08 : 0.08);
    from.current = index;
    zoom.setValue(0);
    Animated.spring(zoom, { toValue: 1, speed: 14, bounciness: 6, useNativeDriver: true }).start();
  }, [index, zoom, offset]);

  // A sideways swipe anywhere moves to the next or previous tab. Screens that use sideways drags themselves
  // (the deck's pages, scrolling chips, the touchpad) claim the gesture first, so this only gets the rest.
  const { height } = useWindowDimensions();
  const latest = useRef({ index, router, hidden, height });
  useEffect(() => { latest.current = { index, router, hidden, height }; });
  // PanResponder calls these after render, when the ref holds the live tab.
  // eslint-disable-next-line react-hooks/refs
  const [swipe] = useState(() => PanResponder.create({
    // Only a swipe that starts in the strip along the bottom edge (where the dock floats) changes tab, and never in
    // immersive mode, so the deck's own swipes (pages, profiles) are never taken over.
    onMoveShouldSetPanResponder: (_, g) => !latest.current.hidden && g.y0 > latest.current.height - 150 && Math.abs(g.dx) > 28 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
    onPanResponderRelease: (_, g) => {
      const { index: now, router: nav } = latest.current;
      const next = now + (g.dx < -60 || g.vx < -0.6 ? 1 : g.dx > 60 || g.vx > 0.6 ? -1 : 0);
      if (next !== now && next >= 0 && next < TABS.length) nav.navigate(TABS[next].href);
    },
  }));

  const barStyle = (() => {
    if (rail) {
      const edge = { left: insets.left + GAP, backgroundColor: look === 'glass' || look === 'classic' ? colors.float : colors.panel, borderColor: look === 'funk' ? colors.glassBorder : colors.border };
      switch (look) {
        case 'atelier': return [styles.rail, styles.atelierRail, edge];
        case 'signal': return [styles.rail, styles.signalRail, edge];
        case 'funk': return [styles.rail, styles.funkRail, edge];
        default: return [styles.rail, edge];
      }
    }
    switch (look) {
      case 'atelier':
        return [styles.dock, styles.atelierDock, { backgroundColor: colors.panel, borderColor: colors.borderStrong, bottom: insets.bottom + GAP }];
      case 'signal':
        return [styles.dock, styles.signalDock, { backgroundColor: colors.panel, borderColor: colors.borderStrong, bottom: insets.bottom + GAP }];
      case 'funk':
        return [styles.dock, styles.funkDock, { backgroundColor: colors.panel, borderColor: colors.glassBorder, bottom: insets.bottom + GAP }];
      default:
        return [styles.dock, styles.softDock, { backgroundColor: colors.float, borderColor: colors.glassBorder, shadowColor: colors.scrim, bottom: insets.bottom + GAP }];
    }
  })();

  // The rail floats clear of the edge but keeps its own lane, so nothing hides under it; a bottom dock floats over
  // the screens, which leave room under their last row (see tab-inset.ts).
  const lane = hidden || !rail ? null : { paddingLeft: insets.left + GAP + RAIL };

  return (
    <Tabs style={[styles.fill, { backgroundColor: colors.bg }]}>
      {/* TabSlot ignores padding, so the lane is a View around it. */}
      <View style={[styles.fill, lane]} {...swipe.panHandlers}>
        <Animated.View style={[styles.fill, {
          opacity: zoom.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
          transform: [{ scale: Animated.add(1, Animated.multiply(Animated.subtract(1, zoom), offset)) }],
        }]}><TabSlot style={styles.fill} /></Animated.View>
      </View>
      <TabList style={[barStyle, hidden && styles.gone]}>
        {TABS.map((tab) => (
          <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
            <Item tab={tab} look={look} rail={rail} badge={badge && tab.name === 'connect'} />
          </TabTrigger>
        ))}
      </TabList>
    </Tabs>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  itemInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  gone: { display: 'none' },
  badge: { position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: 4 },

  // TabList lays its triggers out in a row unless told otherwise.
  rail: { position: 'absolute', top: '50%', width: RAIL - GAP, transform: [{ translateY: '-50%' }], flexDirection: 'column', alignItems: 'center', gap: 6, paddingVertical: 8, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  railItem: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  round: { borderRadius: 20 },
  atelierRail: { borderRadius: 3 },
  atelierRailItem: { borderRadius: 0, borderLeftWidth: 2 },
  signalRail: { borderRadius: 999 },
  funkRail: { borderRadius: 18, borderWidth: 3, borderBottomWidth: 7, gap: 8 },
  funkRailItem: { borderRadius: 12, borderWidth: 3 },

  dock: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', borderWidth: 1 },
  atelierDock: { height: 48, alignItems: 'stretch', gap: 26, paddingHorizontal: 24, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  atelierItem: { justifyContent: 'center', borderBottomWidth: 2 },
  atelierLabel: { fontFamily: 'serif', fontSize: 16, letterSpacing: 0.2 },
  signalDock: { borderRadius: 999, padding: 5, gap: 4 },
  signalItem: { borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10 },
  signalLabel: { fontFamily: 'monospace', fontSize: 11, fontWeight: '500', letterSpacing: 1.6 },
  softDock: { borderRadius: 28, padding: 6, gap: 4, shadowOpacity: 0.4, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12 },
  dockItem: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 22, borderWidth: 1, borderColor: 'transparent', paddingHorizontal: 16, paddingVertical: 10 },
  dockLabel: { fontSize: 13, fontWeight: '600' },

  funkDock: { borderRadius: 20, padding: 6, gap: 8, borderWidth: 3, borderBottomWidth: 7 },
  funkItem: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 16, borderRadius: 14, borderWidth: 3 },
  funkLabel: { fontSize: 14, fontWeight: '800' },
});
