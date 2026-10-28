import { PanelSection } from './SettingsPanel';

// How solid a clock, PC stats or pet widget's own background is. Lower it to see the wallpaper through the tile.
export function WidgetOpacity({ opacity, busy, onChange }: { opacity?: number; busy: boolean; onChange: (opacity: number | undefined) => void }) {
  const value = opacity ?? 100;
  return <PanelSection title="Background">
    <label>Solid: {value}%<input type="range" min={0} max={100} step={5} value={value} disabled={busy} onChange={(event) => { const next = Number(event.target.value); onChange(next >= 100 ? undefined : next); }} /></label>
    <p className="panel-note">0% makes the tile see-through, so the widget floats over your wallpaper.</p>
  </PanelSection>;
}
