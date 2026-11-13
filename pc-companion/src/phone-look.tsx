import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Settings > Phone appearance: the phone's own look, set from here. It is one setting shared with the phone (kept in
// the deck config), so a change on either side shows on both. The lists match the phone's Appearance section.
type PhoneLook = { look?: string; mode?: string; accent?: string; corners?: string; wallpaper?: string; motion?: boolean; keyOpacity?: number; imageOpacity?: number; gradient?: number };
type Option<T> = [T, string];

const LOOKS: Option<string>[] = [['classic', 'Classic'], ['studio', 'Studio'], ['atelier', 'Atelier'], ['signal', 'Signal'], ['glass', 'Glass'], ['funk', 'Funk'], ['dock', 'Dock']];
const MODES: Option<string>[] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const ACCENTS: Option<string>[] = [['', 'Look'], ['#7c84f5', 'Violet'], ['#38bdf8', 'Sky'], ['#34d399', 'Mint'], ['#fb923c', 'Orange'], ['#f472b6', 'Pink']];
const CORNERS: Option<string>[] = [['sharp', 'Sharp'], ['default', 'Default'], ['round', 'Round']];
const WALLPAPERS: Option<string>[] = [['none', 'None'], ['aurora', 'Aurora'], ['ember', 'Ember'], ['ocean', 'Ocean'], ['forest', 'Forest']];
const MOTION: Option<boolean>[] = [[false, 'Still'], [true, 'Drift']];
const KEYS: Option<number>[] = [[1, 'Solid'], [0.55, 'Glass'], [0.25, 'Clear'], [0, 'Hidden']];
const IMAGE: Option<number>[] = [[0.25, '25%'], [0.5, '50%'], [0.75, '75%'], [1, '100%']];
const GRADIENT: Option<number>[] = [[0, 'Off'], [0.35, 'Low'], [0.65, 'Medium'], [1, 'High']];
// The phone's own defaults, shown until the phone has shared its settings.
const DEFAULTS: Required<PhoneLook> = { look: 'classic', mode: 'system', accent: '', corners: 'default', wallpaper: 'aurora', motion: true, keyOpacity: 0.55, imageOpacity: 1, gradient: 0.5 };

function Row<T extends string | number | boolean>({ title, note, options, value, onChange }: { title: string; note?: string; options: Option<T>[]; value: T; onChange: (value: T) => void }) {
  return <section className="device-navigation-setting appearance-setting">
    <div className="device-navigation-copy"><h2>{title}</h2>{note ? <p>{note}</p> : null}</div>
    <div className="transport-tabs" role="radiogroup" aria-label={title}>
      {options.map(([option, label]) => <button key={String(option)} type="button" role="radio" aria-checked={value === option} className={value === option ? 'transport-tab selected' : 'transport-tab'} onClick={() => onChange(option)}>{label}</button>)}
    </div>
  </section>;
}

export function PhoneLookSetting() {
  const [look, setLookState] = useState<PhoneLook | null>(null);
  const refresh = useCallback(() => invoke<PhoneLook | null>('get_phone_look').then(setLookState).catch(() => undefined), []);
  useEffect(() => {
    void refresh();
    // Picks up changes made on the phone.
    const id = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(id);
  }, [refresh]);
  const now = { ...DEFAULTS, ...look };
  const set = (patch: PhoneLook) => {
    setLookState((old) => ({ ...old, ...patch }));
    void invoke('set_phone_look', { patch }).finally(() => void refresh());
  };
  const accents = ACCENTS.some(([hex]) => hex === now.accent) ? ACCENTS : [...ACCENTS, [now.accent, 'Custom'] as Option<string>];
  return <>
    {look ? null : <p className="panel-note">Connect your phone once to load its current settings.</p>}
    <Row title="Look" note="The phone's design. Each comes in light and dark." options={LOOKS} value={now.look} onChange={(value) => set({ look: value })} />
    <Row title="Light or dark" note="System follows the phone's own setting." options={MODES} value={now.mode} onChange={(value) => set({ mode: value })} />
    <Row title="Accent colour" note="Match PC wallpaper, when on, uses the wallpaper's colour instead." options={accents} value={now.accent} onChange={(value) => set({ accent: value })} />
    <Row title="Corners" options={CORNERS} value={now.corners} onChange={(value) => set({ corners: value })} />
    <Row title="Wallpaper" note="Behind the Deck and Touch screens, in the Classic look." options={WALLPAPERS} value={now.wallpaper} onChange={(value) => set({ wallpaper: value })} />
    <Row title="Wallpaper motion" options={MOTION} value={now.motion} onChange={(value) => set({ motion: value })} />
    <Row title="Key transparency" options={KEYS} value={now.keyOpacity} onChange={(value) => set({ keyOpacity: value })} />
    <Row title="Background image opacity" note="For a picture chosen on the phone, or the PC wallpaper." options={IMAGE} value={now.imageOpacity} onChange={(value) => set({ imageOpacity: value })} />
    <Row title="Gradient over image" options={GRADIENT} value={now.gradient} onChange={(value) => set({ gradient: value })} />
  </>;
}
