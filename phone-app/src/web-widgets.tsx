import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useCalendars } from 'expo-localization';
import { CLOCK_FACES_SOURCE } from './clock-faces-source';
import { PC_STATS_SOURCE } from './pc-stats-source';
import { PET_SOURCE } from './pet-source';
import type { PetOptions } from './connection';
import { startPetSensors } from './pet-sensors';
import { getPetWorld, subscribePetWorld } from './pet-world';
import { pcStatsHistory, setLayerNeeds, subscribePcStats, validNeeds } from './pc-stats-feed';
import { countWakes, WAKE_COUNTER_JS } from './perf-overlay';
import { useTheme } from './theme';
import { darkColors } from './theme-colors';
import { WEB_FONT_LOADS, WEB_FONTS_CSS } from './web-fonts-source';
import { initialState, step, type Event, type State, type TimerKind } from './web-widget-lifecycle';
import { widgetPageHtml } from './web-widgets-page';

/** A clock or PC stats widget, and the rectangle (px, in the layer) of its tile's content area. */
export type WebWidget = { id: string; x: number; y: number; width: number; height: number } & (
  | { kind: 'clock'; face?: string; color?: string; opacity?: number }
  | { kind: 'pet'; face?: string; color?: string; opacity?: number; pet?: PetOptions }
  | { kind: 'stats'; face?: string; metric?: string; color?: string; gpu?: string; opacity?: number; columns: number; rows: number }
);

// The page is built once; a stable source object keeps the WebView from reloading on re-render.
const SOURCE = { html: widgetPageHtml({ wakeCounterJs: WAKE_COUNTER_JS, background: darkColors.panel, clockFaces: CLOCK_FACES_SOURCE, pcStats: PC_STATS_SOURCE, pet: PET_SOURCE, fontsCss: WEB_FONTS_CSS, fontLoads: WEB_FONT_LOADS }) };

let nextLayer = 0;

/** A finger on a widget's tile (x, y in the widget's own px). The tile is native and keeps every touch; layers pass it on to the page. */
export type WidgetTouch = { id: string; kind: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number };
const touchListeners = new Set<(touch: WidgetTouch) => void>();
export const sendWidgetTouch = (touch: WidgetTouch) => touchListeners.forEach((listener) => listener(touch));

type LayerView = { mounted: boolean; instance: number; ready: boolean; visible: boolean };
const viewOf = (s: State): LayerView => ({ mounted: s.mounted, instance: s.instance, ready: s.ready, visible: s.focused && s.appActive });

/**
 * Draws the widgets of one widget area in one WebView. web-widget-lifecycle.ts decides when to create, fill,
 * pause, reload and free the WebView; this component only runs what it asks for. `focused` is whether the
 * screen holding the area is the one on show.
 */
export function WebWidgetLayer({ widgets, focused = true }: { widgets: WebWidget[]; focused?: boolean }) {
  const webView = useRef<WebView>(null);
  const layer = useRef(nextLayer++).current;
  const state = useRef<State>(initialState());
  const timers = useRef<Partial<Record<TimerKind, ReturnType<typeof setTimeout>>>>({});
  const [view, setView] = useState<LayerView>(() => viewOf(initialState()));
  const [{ uses24hourClock }] = useCalendars();
  const hour12 = uses24hourClock !== true;
  const list = JSON.stringify(widgets);
  const hasWidgets = widgets.length > 0;
  const hasStats = widgets.some((widget) => widget.kind === 'stats');
  const { colors, scheme } = useTheme();
  // The page is told the look before its first widgets, and again when it changes (`openDockTheme` in web-widgets-page.ts).
  const themeCall = `window.openDockTheme(${JSON.stringify(scheme)}, ${JSON.stringify(colors.panel)});`;
  const themeCallRef = useRef(themeCall);
  // Declared before the effects that send, so a send always carries the latest look.
  useEffect(() => { themeCallRef.current = themeCall; }, [themeCall]);

  const dispatchRef = useRef<(event: Event) => void>(() => {});
  const dispatch = useCallback((event: Event) => {
    const { state: next, commands } = step(state.current, event, Date.now());
    state.current = next;
    for (const command of commands) {
      switch (command.type) {
        case 'send':
          webView.current?.injectJavaScript(`${themeCallRef.current}window.openDockWidgets(${command.list}, ${command.hour12}, ${command.force}, ${command.seq});true;`);
          break;
        case 'pause':
          webView.current?.injectJavaScript(`OpenDockClock.setPaused(${command.paused});OpenDockPet.setPaused(${command.paused});true;`);
          break;
        case 'needs':
          setLayerNeeds(layer, command.needs);
          break;
        case 'schedule':
          clearTimeout(timers.current[command.timer]);
          timers.current[command.timer] = setTimeout(() => dispatchRef.current({ type: 'timer', kind: command.timer, token: command.token }), command.ms);
          break;
        case 'cancel':
          clearTimeout(timers.current[command.timer]);
          delete timers.current[command.timer];
          break;
      }
    }
    const nextView = viewOf(next);
    setView((old) => (old.mounted === nextView.mounted && old.instance === nextView.instance && old.ready === nextView.ready && old.visible === nextView.visible ? old : nextView));
  }, [layer]);
  useEffect(() => { dispatchRef.current = dispatch; }, [dispatch]);

  useEffect(() => { dispatch({ type: 'props', props: { list, hasWidgets, hour12 } }); }, [dispatch, list, hasWidgets, hour12]);
  useEffect(() => { dispatch({ type: 'focus', focused }); }, [dispatch, focused]);
  useEffect(() => {
    dispatch({ type: 'app', active: AppState.currentState === 'active' });
    const subscription = AppState.addEventListener('change', (next) => dispatch({ type: 'app', active: next === 'active' }));
    return () => subscription.remove();
  }, [dispatch]);
  useEffect(() => { if (view.mounted && view.ready) webView.current?.injectJavaScript(`${themeCall}true;`); }, [themeCall, view.mounted, view.ready]);
  // Leaving the screen frees the WebView and withdraws this layer's stats needs.
  useEffect(() => () => dispatch({ type: 'unmount' }), [dispatch]);

  // Touches on this layer's widgets go to the page once it can take them.
  const touchable = useRef(new Set<string>());
  touchable.current = new Set(widgets.map((widget) => widget.id));
  const ready = view.mounted && view.ready;
  useEffect(() => {
    if (!ready) return;
    const listener = ({ id, kind, x, y }: WidgetTouch) => {
      if (touchable.current.has(id)) webView.current?.injectJavaScript(`window.openDockTouch(${JSON.stringify(id)},${JSON.stringify(kind)},${Math.round(x)},${Math.round(y)});true;`);
    };
    touchListeners.add(listener);
    return () => { touchListeners.delete(listener); };
  }, [ready, view.instance]);

  // What the pet should know about the world (music, a game on the PC) goes to the page when it is ready, and on every change.
  const hasPet = widgets.some((widget) => widget.kind === 'pet');
  useEffect(() => {
    if (!ready || !hasPet) return;
    const send = (world: unknown) => webView.current?.injectJavaScript(`OpenDockPet.setWorld(${JSON.stringify(world)});true;`);
    send(getPetWorld());
    return subscribePetWorld(send);
  }, [ready, hasPet, view.instance]);
  // The phone's senses run only while a pet is on screen.
  useEffect(() => (ready && hasPet && view.visible ? startPetSensors() : undefined), [ready, hasPet, view.visible, view.instance]);

  // Samples go to the page while it shows stats and is on screen.
  const feeding = view.mounted && view.ready && view.visible && hasStats;
  useEffect(() => {
    if (!feeding) return;
    const send = (sample: Record<string, unknown> | null) => {
      webView.current?.injectJavaScript(sample ? `OpenDockStats.push(${JSON.stringify(sample)});true;` : `OpenDockStats.setHistory(${JSON.stringify(pcStatsHistory())});true;`);
    };
    send(null);
    return subscribePcStats(send);
  }, [feeding, view.instance]);

  const { instance } = view;
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { ready?: unknown; ack?: unknown; needs?: unknown; wakes?: unknown };
      if (typeof message.ready === 'number') dispatch({ type: 'ready', instance });
      else if (typeof message.ack === 'number') dispatch({ type: 'ack', instance, seq: message.ack, needs: validNeeds(message.needs) ? message.needs : [] });
      if (typeof message.wakes === 'number') countWakes('web widgets', message.wakes);
    } catch { /* not a message from the page */ }
  }, [dispatch, instance]);
  const fail = useCallback((reason: string) => dispatch({ type: 'failure', instance, reason }), [dispatch, instance]);

  // A page without widgets, or one nobody is looking at, runs no web engine once the idle time is up.
  if (!view.mounted) return null;
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <WebView key={instance} ref={webView} originWhitelist={['*']} source={SOURCE} onMessage={onMessage} onError={() => fail('error')} onHttpError={() => fail('http')} onRenderProcessGone={() => fail('render process gone')} onContentProcessDidTerminate={() => fail('content process terminated')} textZoom={100} scrollEnabled={false} bounces={false} overScrollMode="never" showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} setSupportMultipleWindows={false} style={styles.webView} containerStyle={styles.webView} />
  </View>;
}

const styles = StyleSheet.create({
  webView: { flex: 1, backgroundColor: 'transparent' },
});
