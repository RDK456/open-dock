import { DeckSelect } from '../DeckSelect';
import { PanelSection } from '../SettingsPanel';
import { WALLPAPER_FACES, DEFAULT_WALLPAPER_FACE } from '.';

// Sidebar settings for a selected Wallpapers widget: how its wallpapers are laid out.
export function WallpaperSettings({ face, busy, onChange }: { face?: string; busy: boolean; onChange: (patch: { face?: string }) => void }) {
  const look = face ?? DEFAULT_WALLPAPER_FACE;
  const info = WALLPAPER_FACES.find(([id]) => id === look) ?? WALLPAPER_FACES[0];
  return <>
    <PanelSection title="Appearance">
      <div className="panel-field"><span className="clock-settings-label">Layout</span>
        <DeckSelect value={look} disabled={busy} options={WALLPAPER_FACES.map(([id, name]) => ({ value: id, label: name }))} onChange={(value) => onChange({ face: value })} />
        <small className="panel-note">{info[2]}. The phone can switch layout from the widget&apos;s top bar.</small>
      </div>
    </PanelSection>
    <PanelSection title="Wallpaper Engine">
      <p className="panel-note">Lists the wallpapers Wallpaper Engine has on this PC. Tapping one on the phone sets it on the display chosen in the widget&apos;s top bar. Windows only, and Wallpaper Engine must be running.</p>
    </PanelSection>
  </>;
}
