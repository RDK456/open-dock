import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import * as Haptics from 'expo-haptics';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { startKeepAlive, stopKeepAlive } from '../modules/keep-alive';
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
  setEnabled: (on: boolean) => Promise<void>;
  setPhrase: (phrase: string) => void;
  /** Skip the wake phrase once: the next sentence is the command. */
  arm: () => void;
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
  const latest = useRef({ phrase, armedAt, sendVoice, listening: false, wanted: false });
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

  // Listening runs while hands-free is on and the PC is connected, in the background too (the keep-alive service holds the mic).
  const listen = enabled && connected && Platform.OS === 'android';
  useEffect(() => {
    const state = latest.current;
    state.wanted = listen;
    if (!listen) {
      if (state.listening) ExpoSpeechRecognitionModule.abort();
      return;
    }
    let restart: ReturnType<typeof setTimeout> | undefined;
    const begin = () => {
      if (!state.wanted || state.listening) return;
      state.listening = true;
      ExpoSpeechRecognitionModule.start({
        interimResults: false,
        continuous: true,
        addsPunctuation: false,
        androidIntentOptions: { EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 1200 },
      });
    };
    const subscriptions = [
      ExpoSpeechRecognitionModule.addListener('result', (event) => {
        if (!event.isFinal) return;
        const text = event.results[0]?.transcript ?? '';
        const rest = afterWakePhrase(text, latest.current.phrase);
        if (rest === null) {
          const armed = latest.current.armedAt;
          if (armed && Date.now() - armed < ARMED_MS && text.trim()) void run(text.trim());
          return;
        }
        if (rest) {
          void run(rest);
        } else {
          setArmedAt(Date.now());
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
      }),
      ExpoSpeechRecognitionModule.addListener('end', () => {
        state.listening = false;
        // Android stops after each sentence (or a silence) on older versions; start again.
        restart = setTimeout(begin, 250);
      }),
      ExpoSpeechRecognitionModule.addListener('error', (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          state.wanted = false;
          setError('Open Dock needs the microphone for hands-free. Allow it in Android settings.');
        }
      }),
    ];
    begin();
    return () => {
      clearTimeout(restart);
      subscriptions.forEach((subscription) => subscription.remove());
      state.wanted = false;
      if (state.listening) ExpoSpeechRecognitionModule.abort();
      state.listening = false;
    };
  }, [listen, run]);

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
  useEffect(() => () => stopKeepAlive(), []);

  const setEnabled = useCallback(async (on: boolean) => {
    setError(null);
    if (on) {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        setError('Open Dock needs the microphone for hands-free.');
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

  const arm = useCallback(() => {
    setArmedAt(Date.now());
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  return (
    <HandsFreeContext.Provider value={{ enabled, phrase, armed: armedAt > 0, last, error, setEnabled, setPhrase, arm, report }}>
      {children}
    </HandsFreeContext.Provider>
  );
}

export function useHandsFree() {
  const value = useContext(HandsFreeContext);
  if (!value) throw new Error('useHandsFree must be used inside HandsFreeProvider');
  return value;
}
