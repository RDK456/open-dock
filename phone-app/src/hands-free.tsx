import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Linking, PermissionsAndroid, Platform } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import * as Haptics from 'expo-haptics';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { askToRunUnrestricted, moveToBack, runsUnrestricted, startKeepAlive, stopKeepAlive } from '../modules/keep-alive';
import { usePcConnection } from './connection';

const PHRASE_KEY = 'opendock.wake-phrase';
const ENABLED_KEY = 'opendock.hands-free';
export const DEFAULT_PHRASE = 'hey dock';
// After the wake phrase alone, the next sentence is the command if it comes this soon.
const ARMED_MS = 8000;

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
  openSettings: () => void;
  setEnabled: (on: boolean) => Promise<void>;
  setPhrase: (phrase: string) => void;
  /** A tap on the mic: listens for one sentence (or, with hands-free on, takes the next one without the wake phrase). */
  listenOnce: () => Promise<void>;
  /** Listening for that one sentence. */
  hearing: boolean;
  report: (heard: Heard) => void;
};

const HandsFreeContext = createContext<HandsFree | null>(null);

const GREETINGS = new Set(['hey', 'hi', 'hay', 'a', 'ok', 'okay', 'hello', 'yo', 'he']);

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

const sameWord = (heard: string, wanted: string) =>
  heard === wanted || (GREETINGS.has(heard) && GREETINGS.has(wanted)) || (wanted.length >= 3 && distance(heard, wanted) <= 1);

/** The words after the wake phrase ("" when it was said alone), or null when the phrase is not in `text`. */
export function afterWakePhrase(text: string, phrase: string): string | null {
  const heard = words(text);
  const wanted = words(phrase);
  if (!wanted.length) return null;
  for (let start = 0; start + wanted.length <= heard.length; start += 1) {
    if (wanted.every((word, index) => sameWord(heard[start + index], word))) return heard.slice(start + wanted.length).join(' ');
  }
  return null;
}

export function HandsFreeProvider({ children }: PropsWithChildren) {
  const { status, connection, sendVoice } = usePcConnection();
  const [enabled, setEnabledState] = useState(false);
  const [phrase, setPhraseState] = useState(DEFAULT_PHRASE);
  const [armedAt, setArmedAt] = useState(0);
  const [last, setLast] = useState<Heard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = status === 'connected';
  const latest = useRef({ phrase, armedAt, sendVoice });
  useEffect(() => { latest.current = { ...latest.current, phrase, armedAt, sendVoice }; });

  useEffect(() => {
    void Promise.all([Storage.getItem(PHRASE_KEY), Storage.getItem(ENABLED_KEY)]).then(([savedPhrase, savedEnabled]) => {
      if (savedPhrase) setPhraseState(savedPhrase);
      if (savedEnabled === '1') setEnabledState(true);
    });
  }, []);

  const report = useCallback((heard: Heard) => setLast(heard), []);

  const run = useCallback(async (command: string) => {
    setArmedAt(0);
    const result = await latest.current.sendVoice(command);
    void Haptics.notificationAsync(result.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error);
    setLast({ said: command, ...result });
  }, []);

  // One recognizer serves both modes: "wake" listens all the time for the wake phrase (hands-free, also in the
  // background, where the keep-alive service holds the mic); "once" takes one sentence after a tap on the mic.
  const mode = useRef<'off' | 'wake' | 'once'>('off');
  const listening = useRef(false);
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
      // Partial results are what Android 12 and older send; see `pending`.
      interimResults: true,
      // Before Android 13 "continuous" only stretches the silence timeout, and the session then ends in a
      // no-speech error without a final result; plain one-sentence sessions, restarted on `end`, work there.
      continuous: !once && Platform.OS === 'android' && Number(Platform.Version) >= 33,
      addsPunctuation: false,
      androidIntentOptions: { EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: once ? 1500 : 1200 },
    });
  }, []);

  useEffect(() => {
    let restart: ReturnType<typeof setTimeout> | undefined;
    const heard = (text: string) => {
      if (mode.current === 'once') {
        mode.current = wakeWantedRef.current ? 'wake' : 'off';
        setHearing(false);
        void run(afterWakePhrase(text, latest.current.phrase) || text);
        return;
      }
      const rest = afterWakePhrase(text, latest.current.phrase);
      if (rest === null) {
        const armed = latest.current.armedAt;
        if (armed && Date.now() - armed < ARMED_MS) void run(text);
        return;
      }
      if (rest) {
        void run(rest);
      } else {
        setArmedAt(Date.now());
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    };
    const subscriptions = [
      ExpoSpeechRecognitionModule.addListener('result', (event) => {
        const text = (event.results[0]?.transcript ?? '').trim();
        if (!event.isFinal) {
          if (text) pending.current = text;
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
        if (mode.current === 'once') {
          // The tap's sentence never came (silence); go back to waiting for the wake phrase, if that is on.
          mode.current = wakeWantedRef.current ? 'wake' : 'off';
          setHearing(false);
        }
        // Android stops after each sentence (or a silence) on older versions; start again.
        if (mode.current === 'wake') restart = setTimeout(begin, 250);
      }),
      ExpoSpeechRecognitionModule.addListener('error', (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          mode.current = 'off';
          setHearing(false);
          setError('Open Dock needs the microphone. Allow it in Settings, under Permissions.');
        } else if (event.error === 'language-not-supported' || event.error === 'audio-capture') {
          setError(`Speech recognition is not available (${event.error}). Type the command instead.`);
        }
      }),
    ];
    return () => {
      clearTimeout(restart);
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [begin, run]);

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
    if (mode.current === 'wake') {
      setArmedAt(Date.now());
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setError('Open Dock needs the microphone. Allow it in Settings, under Permissions.');
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    mode.current = 'once';
    setHearing(true);
    if (listening.current) ExpoSpeechRecognitionModule.abort();
    else begin();
  }, [begin]);

  // The armed state wears off by itself.
  useEffect(() => {
    if (!armedAt) return;
    const timer = setTimeout(() => setArmedAt(0), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);

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
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') setUnrestricted(runsUnrestricted()); });
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
    <HandsFreeContext.Provider value={{ enabled, phrase, armed: armedAt > 0, last, error, unrestricted, allowBackground: askToRunUnrestricted, openSettings: () => void Linking.openSettings(), setEnabled, setPhrase, listenOnce, hearing, report }}>
      {children}
    </HandsFreeContext.Provider>
  );
}

export function useHandsFree() {
  const value = useContext(HandsFreeContext);
  if (!value) throw new Error('useHandsFree must be used inside HandsFreeProvider');
  return value;
}
