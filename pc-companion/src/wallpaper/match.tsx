import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// "Match PC wallpaper": both apps take their accent colour from the wallpaper on the main display, and the phone
// shows that wallpaper as its background. One setting, kept in the deck config so the phone gets it too.
type Current = { id: string | null; color: string | null; match: boolean };

const HEX = /^#[0-9a-f]{6}$/i;
const inkOn = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#09090b' : '#fafafa';
};

/** Polls the main display's wallpaper while matching is on, and tints this app's accent to its colour. */
export function useWallpaperMatch() {
  const [current, setCurrent] = useState<Current>({ id: null, color: null, match: false });
  const refresh = useCallback(() => invoke<Current>('current_wallpaper').then(setCurrent).catch(() => undefined), []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);
  const tint = current.match && current.color && HEX.test(current.color) ? current.color : null;
  useEffect(() => {
    const root = document.documentElement.style;
    const names = ['--accent', '--accent-hover', '--accent-text', '--wallpaper-tint'];
    if (!tint) { names.forEach((name) => root.removeProperty(name)); delete document.documentElement.dataset.match; return; }
    root.setProperty('--accent', tint);
    root.setProperty('--accent-hover', `color-mix(in srgb, ${tint} 82%, white)`);
    root.setProperty('--accent-text', inkOn(tint));
    root.setProperty('--wallpaper-tint', tint);
    document.documentElement.dataset.match = '';
  }, [tint]);
  const setMatch = (on: boolean) => {
    setCurrent((old) => ({ ...old, match: on }));
    void invoke('set_match_pc_wallpaper', { on }).finally(() => void refresh());
  };
  return { ...current, tint, setMatch };
}

/** Settings > Appearance: the switch, with a swatch of the colour it picked. */
export function WallpaperMatchSetting({ match, tint, color, setMatch }: ReturnType<typeof useWallpaperMatch>) {
  const swatch = tint ?? (color && HEX.test(color) ? color : null);
  return <section className="device-navigation-setting">
    <div className="device-navigation-copy">
      <h2>Match PC wallpaper</h2>
      <p>This app and the phone take their accent colour from the wallpaper on your main display, and the phone shows it as its background. Follows Wallpaper Engine.</p>
      {swatch ? <p className="wallpaper-match-swatch"><span style={{ background: swatch }} aria-hidden="true" />{match ? 'Using' : 'Would use'} {swatch}</p> : null}
    </div>
    <button className={`setting-switch ${match ? 'enabled' : ''}`} type="button" role="switch" aria-checked={match} aria-label="Match PC wallpaper" onClick={() => setMatch(!match)}><span /></button>
  </section>;
}
