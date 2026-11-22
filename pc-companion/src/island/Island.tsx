import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './island.css';

// The voice island's page (see island.rs): a pill that drops in at the top of the screen while a voice command is
// heard and run, then shows what happened and tucks away.
type Shown = { state: 'listening' | 'working' | 'done' | 'failed' | 'idle'; text: string };
const IDLE: Shown = { state: 'idle', text: '' };
// How long a result stays; and a listening the PC never hears the end of (a phone gone quiet) wears off too.
const HOLD_MS = { done: 2600, failed: 3600, listening: 15000, working: 15000 } as const;

export function Island() {
  const [shown, setShown] = useState<Shown>(IDLE);
  useEffect(() => {
    let heard = false;
    const off = listen<Shown>('island', (event) => { heard = true; setShown(event.payload); });
    // The window opens on the first voice command, after that event was sent.
    void invoke<Shown | null>('island_state').then((last) => { if (last && !heard) setShown(last); }).catch(() => {});
    return () => { void off.then((stop) => stop()); };
  }, []);
  useEffect(() => {
    if (shown.state === 'idle') return;
    const timer = setTimeout(() => setShown(IDLE), HOLD_MS[shown.state]);
    return () => clearTimeout(timer);
  }, [shown]);

  const label = shown.text || (shown.state === 'listening' ? 'Listening…' : shown.state === 'working' ? 'Working…' : '');
  return <div className={`island ${shown.state}${shown.state === 'idle' ? '' : ' open'}`} role="status" aria-live="polite">
    <div className="island-wave" aria-hidden="true">{[0, 1, 2, 3, 4].map((bar) => <span key={bar} />)}</div>
    <span className="island-text">{label}</span>
  </div>;
}
