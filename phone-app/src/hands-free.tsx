import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Linking, PermissionsAndroid, Platform } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import * as Haptics from 'expo-haptics';
import { haptic } from './prefs';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { askToRunUnrestricted, askToShowIsland, canShowIsland, moveToBack, runsUnrestricted, setIsland, startKeepAlive, stopKeepAlive, type IslandState } from '../modules/keep-alive';
import { usePcConnection } from './connection';
import { afterWakePhrase, pickTranscript } from './wake-phrase';

const PHRASE_KEY = 'opendock.wake-phrase';
const ENABLED_KEY = 'opendock.hands-free';
export const DEFAULT_PHRASE = 'hey dock';
// After the wake phrase alone, the next sentence is the command if it comes this soon.
const ARMED_MS = 8000;
// How long the island shows what a command did.
const RESULT_MS = 2600;

export type Heard = { said: string; ok: boolean; text: string };

type HandsFree = {
  enabled: boolean;
  phrase: string;
  /** Waiting for the command right after the wake phrase. */
  armed: boolean;
  last: Heard | null;
  error: string | null;
  /** False while Android may stop Open Dock in the background to save battery. */
  unrestricted: boolean;
  allowBackground: () => void;
  /** False until Android lets the voice island show over other apps. */
  islandAllowed: boolean;
  allowIsland: () => void;
  openSettings: () => void;
  setEnabled: (on: boolean) => Promise<void>;
  setPhrase: (phrase: string) => void;
  /** A tap on the mic: takes commands one after another until tapped again (or, with hands-free on, takes the next
   * one without the wake phrase). */
  listenOnce: () => Promise<void>;
  /** In that conversation. */
  hearing: boolean;
  report: (heard: Heard) => void;
};

const HandsFreeContext = createContext<HandsFree | null>(null);

export function HandsFreeProvider({ children }: PropsWithChildren) {
  const { status, connection, sendVoice, sendVoiceState } = usePcConnection();
  const [enabled, setEnabledState] = useState(false);
  const [phrase, setPhraseState] = useState(DEFAULT_PHRASE);
  const [armedAt, setArmedAt] = useState(0);
  const [last, setLast] = useState<Heard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = status === 'connected';
  const latest = useRef({ phrase, armedAt, sendVoice, sendVoiceState });
  useEffect(() => { latest.current = { ...latest.current, phrase, armedAt, sendVoice, sendVoiceState }; });

  // The voice island, on this phone (over every app) and on the PC: up from the moment a command is being heard
  // until a moment after it ran. The PC is only told about listening; it sees the command and its result itself.
  const island = useRef<{ state: IslandState; text: string }>({ state: 'idle', text: '' });
  const showIsland = useCallback((state: IslandState, text = '') => {
    const was = island.current;
    if (was.state === state && was.text === text) return;
    island.current = { state, text };
    setIsland(state, text);
    if (state === 'listening' || (state === 'idle' && was.state === 'listening')) latest.current.sendVoiceState(state === 'listening', text);
  }, []);
  const quietIsland = useCallback(() => { if (island.current.state === 'listening') showIsland('idle'); }, [showIsland]);

  useEffect(() => {
    void Promise.all([Storage.getItem(PHRASE_KEY), Storage.getItem(ENABLED_KEY)]).then(([savedPhrase, savedEnabled]) => {
      if (savedPhrase) setPhraseState(savedPhrase);
      if (savedEnabled === '1') setEnabledState(true);
    });
  }, []);

  const report = useCallback((heard: Heard) => setLast(heard), []);

  // One recognizer serves both modes: "wake" listens all the time for the wake phrase (hands-free, also in the
  // background, where the keep-alive service holds the mic); "once" takes command after command after a tap on the
  // mic, until it is tapped again.
  const mode = useRef<'off' | 'wake' | 'once'>('off');

  const run = useCallback(async (command: string) => {
    setArmedAt(0);
    showIsland('working', command);
    const result = await latest.current.sendVoice(command);
    haptic.notify(result.ok);
    setLast({ said: command, ...result });
    showIsland(result.ok ? 'done' : 'failed', result.text);
    setTimeout(() => {
      if (island.current.state === 'done' || island.current.state === 'failed') showIsland(mode.current === 'once' ? 'listening' : 'idle');
    }, RESULT_MS);
  }, [showIsland]);

  const listening = useRef(false);
  // Until the recognizer says it has no Indian English; then the phone's own language.
  const lang = useRef<string | undefined>('en-IN');
  // The latest partial transcript; some recognizers end the session without ever sending it as final.
  const pending = useRef('');
  const [hearing, setHearing] = useState(false);
  const wakeWanted = enabled && connected && Platform.OS === 'android';
  const wakeWantedRef = useRef(wakeWanted);
  useEffect(() => { wakeWantedRef.current = wakeWanted; });

  const begin = useCallback(() => {
    if (listening.current || mode.current === 'off') return;
    listening.current = true;
    const once = mode.current === 'once';
    pending.current = '';
    ExpoSpeechRecognitionModule.start({
      // Indian English hears Indian accents far better than the phone's default (US) English.
      lang: lang.current,
      // Partial results are what Android 12 and older send; see `pending`.
      interimResults: true,
      // Before Android 13 "continuous" only stretches the silence timeout, and the session then ends in a
      // no-speech error without a final result; plain one-sentence sessions, restarted on `end`, work there.
      continuous: !once && Platform.OS === 'android' && Number(Platform.Version) >= 33,
      addsPunctuation: false,
      // No silence limit: Google's offline recognizer counts it from the start of the session, so a short
      // one closed the mic before anyone spoke. Its own default waits several seconds for speech.
    });
  }, []);

  useEffect(() => {
    let restart: ReturnType<typeof setTimeout> | undefined;
    const heard = (text: string) => {
      if (mode.current === 'once') {
        void run(afterWakePhrase(text, latest.current.phrase) || text);
        return;
      }
      const rest = afterWakePhrase(text, latest.current.phrase);
      if (rest === null) {
        const armed = latest.current.armedAt;
        if (armed && Date.now() - armed < ARMED_MS) void run(text);
        else quietIsland();
        return;
      }
      if (rest) {
        void run(rest);
      } else {
        setArmedAt(Date.now());
        showIsland('listening');
        haptic.impact(Haptics.ImpactFeedbackStyle.Medium);
      }
    };
    // The island follows the words as they come, once they are a command (after a tap, or after the wake phrase).
    const follow = (text: string) => {
      if (mode.current === 'once') return showIsland('listening', text);
      const rest = afterWakePhrase(text, latest.current.phrase);
      const armed = latest.current.armedAt;
      if (rest !== null) showIsland('listening', rest);
      else if (armed && Date.now() - armed < ARMED_MS) showIsland('listening', text);
    };
    const subscriptions = [
      ExpoSpeechRecognitionModule.addListener('result', (event) => {
        const text = pickTranscript(event.results.map((result) => result.transcript.trim()), latest.current.phrase);
        if (!event.isFinal) {
          if (text) {
            pending.current = text;
            follow(text);
          }
          return;
        }
        // Google's offline recognizer on Android 11 sends an empty final result after real partial ones.
        const final = text || pending.current;
        pending.current = '';
        if (final) heard(final);
      }),
      ExpoSpeechRecognitionModule.addListener('end', () => {
        listening.current = false;
        const unfinished = pending.current;
        pending.current = '';
        if (unfinished) heard(unfinished);
        if (mode.current !== 'once' && !latest.current.armedAt) quietIsland();
        // Android stops after each sentence (or a silence); start again. After a tap that is a conversation: the
        // next command, and the next, until the mic is tapped again.
        // Quickly: the phrase is short, and words said in the gap are lost.
        if (mode.current === 'wake' || mode.current === 'once') restart = setTimeout(begin, 50);
      }),
      ExpoSpeechRecognitionModule.addListener('error', (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          mode.current = 'off';
          setHearing(false);
          setError('Open Dock needs the microphone. Allow it in Settings, under Permissions.');
        } else if (event.error === 'language-not-supported' && lang.current) {
          // `end` follows and starts the next session in the phone's own language.
          lang.current = undefined;
        } else if (event.error === 'language-not-supported' || event.error === 'audio-capture') {
          setError(`Speech recognition is not available (${event.error}). Type the command instead.`);
        }
      }),
    ];
    return () => {
      clearTimeout(restart);
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [begin, run, showIsland, quietIsland]);

  useEffect(() => {
    if (wakeWanted && mode.current === 'off') {
      mode.current = 'wake';
      begin();
    } else if (!wakeWanted && mode.current === 'wake') {
      mode.current = 'off';
      if (listening.current) ExpoSpeechRecognitionModule.abort();
    }
  }, [wakeWanted, begin]);
  useEffect(() => () => {
    mode.current = 'off';
    if (listening.current) ExpoSpeechRecognitionModule.abort();
  }, []);

  /** A tap on the mic: the next sentence is the command. */
  const listenOnce = useCallback(async () => {
    setError(null);
    if (mode.current === 'once') {
      mode.current = wakeWantedRef.current ? 'wake' : 'off';
      setHearing(false);
      showIsland('idle');
      if (listening.current) ExpoSpeechRecognitionModule.abort();
      return;
    }
    if (mode.current === 'wake') {
      setArmedAt(Date.now());
      showIsland('listening');
      haptic.impact(Haptics.ImpactFeedbackStyle.Medium);
      return;
    }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setError('Open Dock needs the microphone. Allow it in Settings, under Permissions.');
      return;
    }
    haptic.impact(Haptics.ImpactFeedbackStyle.Medium);
    mode.current = 'once';
    setHearing(true);
    showIsland('listening');
    if (listening.current) ExpoSpeechRecognitionModule.abort();
    else begin();
  }, [begin, showIsland]);

  // The armed state wears off by itself.
  useEffect(() => {
    if (!armedAt) return;
    const timer = setTimeout(() => { setArmedAt(0); quietIsland(); }, ARMED_MS);
    return () => clearTimeout(timer);
  }, [armedAt, quietIsland]);

  // The notification keeps the connection (and the mic) alive in the background; it goes when the PC is forgotten.
  const deviceName = connection?.deviceName ?? connection?.host;
  const hasConnection = Boolean(connection);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!hasConnection || status === 'disconnected' || status === 'error') {
      stopKeepAlive();
      return;
    }
    // Android only lets the app start (or change) the service while it is in front.
    if (AppState.currentState !== 'active') return;
    const where = status === 'connected' ? `Connected to ${deviceName}` : `Reconnecting to ${deviceName}…`;
    startKeepAlive('Open Dock', enabled ? `${where}. Say “${phrase}” and a command.` : where, enabled);
  }, [hasConnection, deviceName, enabled, phrase, status]);

  // On the last screen, Back would close the app (and its connection); send it behind other apps instead, like Home.
  useEffect(() => {
    if (Platform.OS !== 'android' || !hasConnection) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', moveToBack);
    return () => subscription.remove();
  }, [hasConnection]);

  // Phone makers' battery savers stop background apps unless Open Dock is let off battery limits.
  const [unrestricted, setUnrestricted] = useState(runsUnrestricted);
  const [islandAllowed, setIslandAllowed] = useState(canShowIsland);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      setUnrestricted(runsUnrestricted());
      setIslandAllowed(canShowIsland());
    });
    return () => subscription.remove();
  }, []);

  const setEnabled = useCallback(async (on: boolean) => {
    setError(null);
    if (on) {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        setError('Open Dock needs the microphone for hands-free. Allow it in Settings, under Permissions.');
        return;
      }
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS').catch(() => undefined);
      }
    }
    setEnabledState(on);
    void Storage.setItem(ENABLED_KEY, on ? '1' : '0');
  }, []);

  const setPhrase = useCallback((next: string) => {
    const clean = next.trim().replace(/\s+/g, ' ').slice(0, 40);
    const value = clean.length >= 2 ? clean : DEFAULT_PHRASE;
    setPhraseState(value);
    void Storage.setItem(PHRASE_KEY, value);
  }, []);


  return (
    <HandsFreeContext.Provider value={{ enabled, phrase, armed: armedAt > 0, last, error, unrestricted, allowBackground: askToRunUnrestricted, islandAllowed, allowIsland: askToShowIsland, openSettings: () => void Linking.openSettings(), setEnabled, setPhrase, listenOnce, hearing, report }}>
      {children}
    </HandsFreeContext.Provider>
  );
}

export function useHandsFree() {
  const value = useContext(HandsFreeContext);
  if (!value) throw new Error('useHandsFree must be used inside HandsFreeProvider');
  return value;
}
