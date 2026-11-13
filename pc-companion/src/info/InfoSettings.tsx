import { useState } from 'react';
import { DeckSelect } from '../DeckSelect';
import { PanelSection } from '../SettingsPanel';
import { INFO_CITIES, INFO_DONE, INFO_LEAGUES, INFO_STOCK_PRESETS, infoStyles, type InfoOptions } from '.';

const CUSTOM = '__custom';

// Sidebar settings for a selected info widget: its design, plus what weather, stocks, sports and reminders show.
export function InfoSettings({ face, info = {}, busy, onChange }: { face?: string; info?: InfoOptions; busy: boolean; onChange: (info: InfoOptions) => void }) {
  const styles = infoStyles(face);
  const style = styles.find(([id]) => id === info.style) ?? styles[0];
  const set = (patch: Partial<InfoOptions>) => {
    const next: InfoOptions = { ...info, ...patch };
    // Leave unset fields out so the saved config stays small.
    for (const key of Object.keys(next) as (keyof InfoOptions)[]) if (next[key] === undefined || next[key] === '') delete next[key];
    onChange(next);
  };
  return <>
    <PanelSection title="Design">
      <div className="panel-field"><span className="clock-settings-label">Style</span>
        <DeckSelect value={style[0]} disabled={busy} options={styles.map(([id, name]) => ({ value: id, label: name }))} onChange={(value) => set({ style: value === styles[0][0] ? undefined : value })} />
        <small className="panel-note">{style[2]}.</small>
      </div>
    </PanelSection>
    {face === 'weather' ? <WeatherOptions info={info} busy={busy} set={set} /> : null}
    {face === 'stocks' ? <StockOptions info={info} busy={busy} set={set} /> : null}
    {face === 'sports' ? <PanelSection title="League">
      <div className="panel-field"><DeckSelect value={info.league ?? 'nba'} disabled={busy} options={INFO_LEAGUES.map(([value, label]) => ({ value, label }))} onChange={(value) => set({ league: value === 'nba' ? undefined : value })} /></div>
    </PanelSection> : null}
    {face === 'reminders' ? <ReminderOptions info={info} busy={busy} set={set} /> : null}
  </>;
}

type Part = { info: InfoOptions; busy: boolean; set: (patch: Partial<InfoOptions>) => void };

function WeatherOptions({ info, busy, set }: Part) {
  const known = !info.city || INFO_CITIES.includes(info.city);
  const [custom, setCustom] = useState(!known);
  const [text, setText] = useState(info.city ?? '');
  return <PanelSection title="City">
    <div className="panel-field">
      <DeckSelect value={custom ? CUSTOM : info.city ?? ''} disabled={busy} options={[{ value: '', label: 'Set on the phone' }, ...INFO_CITIES.map((city) => ({ value: city, label: city })), { value: CUSTOM, label: 'Other city…' }]} onChange={(value) => { setCustom(value === CUSTOM); if (value !== CUSTOM) set({ city: value || undefined }); }} />
      {custom ? <input className="panel-input" value={text} maxLength={60} disabled={busy} placeholder="City name" onChange={(event) => setText(event.target.value)} onBlur={() => set({ city: text.trim() || undefined })} onKeyDown={(event) => { if (event.key === 'Enter') set({ city: text.trim() || undefined }); }} /> : null}
      <small className="panel-note">Looked up by name. When set here, the phone uses this city.</small>
    </div>
  </PanelSection>;
}

function StockOptions({ info, busy, set }: Part) {
  const preset = INFO_STOCK_PRESETS.find(([, symbols]) => symbols === info.symbols);
  const [custom, setCustom] = useState(Boolean(info.symbols) && !preset);
  const [text, setText] = useState(info.symbols ?? '');
  const clean = (value: string) => value.toUpperCase().replace(/[^A-Z0-9.^=,\- ]/g, '').slice(0, 120).trim();
  return <PanelSection title="Symbols">
    <div className="panel-field">
      <DeckSelect value={custom ? CUSTOM : info.symbols ?? ''} disabled={busy} options={[{ value: '', label: 'Set on the phone' }, ...INFO_STOCK_PRESETS.map(([label, symbols]) => ({ value: symbols, label })), { value: CUSTOM, label: 'Custom…' }]} onChange={(value) => { setCustom(value === CUSTOM); if (value !== CUSTOM) { setText(value); set({ symbols: value || undefined }); } }} />
      {custom ? <input className="panel-input" value={text} disabled={busy} placeholder="AAPL, BTC-USD, ^GSPC" onChange={(event) => setText(event.target.value)} onBlur={() => set({ symbols: clean(text) || undefined })} onKeyDown={(event) => { if (event.key === 'Enter') set({ symbols: clean(text) || undefined }); }} /> : null}
      <small className="panel-note">{info.symbols ? info.symbols : 'Up to 8 Yahoo Finance symbols.'}</small>
    </div>
  </PanelSection>;
}

function ReminderOptions({ info, busy, set }: Part) {
  const [text, setText] = useState((info.items ?? []).join('\n'));
  const save = () => {
    const items = text.split('\n').map((line) => line.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)).filter(Boolean).slice(0, 20);
    set({ items: items.length ? items : undefined });
  };
  return <PanelSection title="Reminders">
    <div className="panel-field"><span className="clock-settings-label">From this PC, one per line</span>
      <textarea className="panel-input" rows={5} value={text} disabled={busy} placeholder={'Stand up and stretch\nDrink water'} onChange={(event) => setText(event.target.value)} onBlur={save} />
      <small className="panel-note">Shown with any you add on the phone. Up to 20.</small>
    </div>
    <div className="panel-field"><span className="clock-settings-label">Ticked reminders</span>
      <DeckSelect value={info.done ?? 'show'} disabled={busy} options={INFO_DONE.map(([value, label]) => ({ value, label }))} onChange={(value) => set({ done: value === 'show' ? undefined : value })} />
    </div>
  </PanelSection>;
}
