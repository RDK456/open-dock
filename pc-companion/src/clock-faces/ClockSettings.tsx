import { useEffect, useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { ClockFacePreview } from './ClockFacePreview';
import { PanelSection } from '../SettingsPanel';
import { useTheme } from '../theme';
import { CLOCK_CATEGORIES, CLOCK_COLOR_PRESETS, ClockCategory, clockFace, DEFAULT_CLOCK_COLOR, OpenDockClock } from '.';

const RECENT_KEY = 'opendock.recent-clock-colors';
const HEX = /^#[0-9a-f]{6}$/i;
function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && HEX.test(item)).slice(0, 6) : [];
  } catch {
    return [];
  }
}

type Block = { width: number; height: number };

// Sidebar settings for a selected clock widget: a live preview, the face, and its colour.
export function ClockWidgetSettings({ face, color, block, busy, onChange }: { face?: string; color?: string; block: Block; busy: boolean; onChange: (patch: { face?: string; color?: string }) => void }) {
  const info = clockFace(face);
  const current = color ?? DEFAULT_CLOCK_COLOR;
  const [browsing, setBrowsing] = useState(false);
  return <>
    <div className="panel-preview"><ClockFacePreview face={info.id} color={current} width={block.width} height={block.height} /></div>
    <PanelSection title="Appearance">
      <div className="panel-tile">
        <div><strong>{info.name}</strong><small>{CLOCK_CATEGORIES.find(([id]) => id === info.category)?.[1]}</small></div>
        <button type="button" className="secondary-button" onClick={() => setBrowsing(true)} disabled={busy}>Change</button>
      </div>
      {info.color ? <ColorField color={current} busy={busy} onPick={(value) => onChange({ color: value })} /> : <p className="panel-note">This face uses its own fixed colors.</p>}
    </PanelSection>
    {browsing ? <ClockFaceBrowser selected={info.id} color={current} block={block} onClose={() => setBrowsing(false)} onChoose={(id) => { onChange({ face: id }); setBrowsing(false); }} /> : null}
  </>;
}

// Preset swatches, a custom picker with hex entry, and recently used custom colours. Shared with the PC stats widget.
export function ColorField({ color, busy, onPick }: { color: string; busy: boolean; onPick: (color: string) => void }) {
  const [hex, setHex] = useState(color);
  const [recent, setRecent] = useState(readRecent);
  useTheme(); // swatches show the color as drawn in this theme, so they redraw when it changes
  useEffect(() => setHex(color), [color]);
  const pick = (next: string, remember = false) => {
    const value = next.toLowerCase();
    if (!HEX.test(value)) return;
    onPick(value);
    if (remember && !CLOCK_COLOR_PRESETS.includes(value)) {
      const updated = [value, ...recent.filter((item) => item !== value)].slice(0, 6);
      setRecent(updated);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(updated)); } catch { /* recent colours are a convenience */ }
    }
  };
  return <div className="clock-settings-color">
    <span className="clock-settings-label">Color</span>
    <div className="clock-swatches">{CLOCK_COLOR_PRESETS.map((swatch) => <button key={swatch} type="button" className={`clock-swatch ${swatch === color ? 'selected' : ''}`} style={{ background: OpenDockClock.tint(swatch) }} aria-label={`Use ${swatch}`} aria-pressed={swatch === color} disabled={busy} onClick={() => pick(swatch)} />)}</div>
    <div className="clock-custom-color">
      <input type="color" aria-label="Custom color" value={color} disabled={busy} onChange={(event) => pick(event.target.value)} onBlur={(event) => pick(event.target.value, true)} />
      <input className="clock-hex" aria-label="Hex color" value={hex} spellCheck={false} disabled={busy} onChange={(event) => setHex(event.target.value)} onBlur={() => HEX.test(hex) ? pick(hex, true) : setHex(color)} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
    </div>
    {recent.length ? <div className="clock-recent"><span>Recent</span>{recent.map((swatch) => <button key={swatch} type="button" className={`clock-swatch small ${swatch === color ? 'selected' : ''}`} style={{ background: OpenDockClock.tint(swatch) }} aria-label={`Use ${swatch}`} disabled={busy} onClick={() => pick(swatch)} />)}</div> : null}
  </div>;
}

// Full-size dialog listing every face, each drawn live at the widget's real size on the phone.
function ClockFaceBrowser({ selected, color, block, onClose, onChoose }: { selected: string; color: string; block: Block; onClose: () => void; onChoose: (face: string) => void }) {
  const [category, setCategory] = useState<ClockCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState(selected);
  const [hovered, setHovered] = useState<string | null>(null);
  // The editor's own faces sit behind this dialog, so they stop drawing while it is open.
  useEffect(() => {
    OpenDockClock.setBackgroundPaused(true);
    return () => OpenDockClock.setBackgroundPaused(false);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const faces = useMemo(() => OpenDockClock.faces.filter((face) => (category === 'all' || face.category === category)
    && `${face.name} ${face.blurb}`.toLowerCase().includes(query.trim().toLowerCase())), [category, query]);
  // Tiles keep the widget's shape, capped so tall widgets don't make giant tiles.
  const tileHeight = Math.min(150, Math.max(70, 220 * block.height / block.width));
  return <div className="clock-browser-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="clock-browser" role="dialog" aria-modal="true" aria-label="Choose a clock face">
      <header>
        <div><h2>Choose a clock face</h2><p>Shown at this widget's size on your phone ({Math.round(block.width)} × {Math.round(block.height)}).</p></div>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="clock-browser-tools">
        <div className="page-switcher">
          {([['all', 'All'], ...CLOCK_CATEGORIES] as [ClockCategory | 'all', string][]).map(([id, label]) => <button key={id} type="button" className={`transport-tab ${category === id ? 'selected' : ''}`} onClick={() => setCategory(id)}>{label}</button>)}
        </div>
        <label className="clock-browser-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search faces" aria-label="Search faces" /></label>
      </div>
      <div className="clock-browser-grid">
        {faces.map((face) => <button key={face.id} type="button" className={`clock-browser-tile ${face.id === choice ? 'selected' : ''}`} aria-pressed={face.id === choice} onClick={() => setChoice(face.id)} onDoubleClick={() => onChoose(face.id)} onMouseEnter={() => setHovered(face.id)} onMouseLeave={() => setHovered((id) => id === face.id ? null : id)} onFocus={() => setHovered(face.id)} onBlur={() => setHovered((id) => id === face.id ? null : id)}>
          {/* Only the hovered tile animates; the rest are still frames at 1x resolution. */}
          <span className="clock-browser-preview" style={{ height: tileHeight }}><ClockFacePreview face={face.id} color={color} width={block.width} height={block.height} live={face.id === hovered} pixelRatio={1} background={false} /></span>
          <span className="clock-browser-name"><strong>{face.name}</strong>{face.color ? <small>Your color</small> : null}{face.id === choice ? <Check size={14} /> : null}</span>
        </button>)}
        {!faces.length ? <p className="clock-browser-empty">No faces match “{query}”.</p> : null}
      </div>
      <footer>
        <span>{clockFace(choice).blurb}</span>
        <div><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" onClick={() => onChoose(choice)}>Use face</button></div>
      </footer>
    </div>
  </div>;
}
