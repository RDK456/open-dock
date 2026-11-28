import { DeckSelect } from './DeckSelect';
import { PanelSection } from './SettingsPanel';
import { ColorField } from './clock-faces/ClockSettings';

/** Slider designs; phone-app/src/slider-widget.tsx draws them and lib.rs SLIDER_LOOKS lists the same ids. */
export const SLIDER_LOOKS: [string, string, string][] = [
  ['bar', 'Bar', 'A thin track with a knob'],
  ['pill', 'Pill', 'One wide capsule that fills up'],
  ['vertical', 'Tower', 'A tall capsule that fills from the bottom'],
  ['ring', 'Ring', 'A round gauge; drag up or down to turn it'],
  ['notch', 'Meter', 'Ten blocks that light up'],
];

export function SliderSettings({ look, color, busy, onChange }: { look?: string; color?: string; busy: boolean; onChange: (patch: { look?: string; color?: string }) => void }) {
  const current = look ?? 'bar';
  const info = SLIDER_LOOKS.find(([id]) => id === current) ?? SLIDER_LOOKS[0];
  return <PanelSection title="Appearance">
    <div className="panel-field"><span className="clock-settings-label">Design</span>
      <DeckSelect value={current} disabled={busy} options={SLIDER_LOOKS.map(([id, name]) => ({ value: id, label: name }))} onChange={(value) => onChange({ look: value === 'bar' ? undefined : value })} />
      <small className="panel-note">{info[2]}.</small>
    </div>
    <div className="panel-field"><span className="clock-settings-label">Colour</span>
      <ColorField color={color ?? '#3b82f6'} busy={busy} onPick={(next) => onChange({ color: next })} />
    </div>
  </PanelSection>;
}

/** The editor grid's picture of a slider: its design at about 60%. */
export function SliderPreview({ look, color, label }: { look?: string; color?: string; label: string }) {
  const accent = color ?? 'var(--accent, #3b82f6)';
  const kind = look ?? 'bar';
  const fill = 0.6;
  const track = 'color-mix(in srgb, currentColor 18%, transparent)';
  let art;
  if (kind === 'pill' || kind === 'vertical') {
    const tall = kind === 'vertical';
    art = <div style={{ position: 'relative', width: tall ? 26 : '80%', height: tall ? '80%' : 22, borderRadius: 999, overflow: 'hidden', background: track }}>
      <div style={{ position: 'absolute', left: 0, bottom: 0, background: accent, ...(tall ? { right: 0, height: `${fill * 100}%` } : { top: 0, width: `${fill * 100}%` }) }} />
    </div>;
  } else if (kind === 'ring') {
    const r = 15, arc = 2 * Math.PI * r * 0.75;
    art = <svg width="40" height="40" viewBox="0 0 40 40" style={{ transform: 'rotate(135deg)' }} aria-hidden>
      <circle cx="20" cy="20" r={r} fill="none" stroke={track} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${arc} 999`} />
      <circle cx="20" cy="20" r={r} fill="none" stroke={accent} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${arc * fill} 999`} />
    </svg>;
  } else if (kind === 'notch') {
    art = <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 18, width: '80%' }}>
      {Array.from({ length: 10 }, (_, index) => <span key={index} style={{ flex: 1, height: `${40 + index * 6.6}%`, borderRadius: 2, background: index < fill * 10 ? accent : track }} />)}
    </div>;
  } else {
    art = <div style={{ position: 'relative', width: '80%', height: 4, borderRadius: 2, background: track }}>
      <div style={{ width: `${fill * 100}%`, height: '100%', borderRadius: 2, background: accent }} />
      <span style={{ position: 'absolute', left: `${fill * 100}%`, top: -5, width: 14, height: 14, marginLeft: -7, borderRadius: 7, background: accent, border: '2px solid currentColor' }} />
    </div>;
  }
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', height: '100%' }}>
    {art}
    <small>{label}</small>
  </div>;
}
