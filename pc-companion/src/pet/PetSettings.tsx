import { PanelSection } from '../SettingsPanel';
import { ColorField } from '../clock-faces/ClockSettings';
import { OpenDockPet, PET_OUTFITS, petFace, type PetOptions } from '.';
import { PetPreview } from './PetPreview';

type Block = { width: number; height: number };
type Patch = { face?: string; color?: string; opacity?: number; pet?: PetOptions };

const OUTFIT_NAMES: Record<string, string> = { auto: 'Seasonal', none: 'None', glasses: 'Glasses', mustache: 'Mustache', crown: 'Crown', tophat: 'Top hat', bowtie: 'Bow tie' };
const PERSONALITY = [['sleepy', 'Sleepy'], ['hyper', 'Hyper'], ['shy', 'Shy'], ['grumpy', 'Grumpy']] as const;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

// Sidebar settings for a selected pet widget: a live preview you can play with, which pet it is, its colour, outfit,
// personality, sounds and quiet hours.
export function PetSettings({ face, color, options, opacity, block, busy, onChange }: { face?: string; color?: string; options?: PetOptions; opacity?: number; block: Block; busy: boolean; onChange: (patch: Patch) => void }) {
  const info = petFace(face);
  const current = color ?? OpenDockPet.defaultColor;
  const set = (patch: Partial<PetOptions>) => {
    const next: PetOptions = { ...options, ...patch };
    // Anything back at its default is left out, so the saved widget stays small.
    for (const key of Object.keys(next) as (keyof PetOptions)[]) if (next[key] === undefined || next[key] === false || (['sleepy', 'hyper', 'shy', 'grumpy'].includes(key) && next[key] === 5) || (key === 'outfit' && next[key] === 'auto')) delete next[key];
    if (next.quietFrom === undefined || next.quietTo === undefined) { delete next.quietFrom; delete next.quietTo; }
    onChange({ pet: Object.keys(next).length ? next : undefined });
  };
  const quiet = options?.quietFrom !== undefined && options?.quietTo !== undefined;
  return <>
    <div className="panel-preview"><PetPreview face={info.id} color={current} opacity={opacity} pet={options} width={block.width} height={block.height} /></div>
    <PanelSection title="Appearance">
      <div className="page-switcher">
        {OpenDockPet.faces.map((item) => <button key={item.id} type="button" className={`transport-tab ${item.id === info.id ? 'selected' : ''}`} aria-pressed={item.id === info.id} disabled={busy} onClick={() => onChange({ face: item.id })}>{item.name}</button>)}
      </div>
      <p className="panel-note">{info.blurb}</p>
      <ColorField color={current} busy={busy} onPick={(value) => onChange({ color: value })} />
      <label className="widget-screen-toggle"><input type="checkbox" checked={Boolean(options?.mood)} disabled={busy} onChange={(event) => set({ mood: event.target.checked })} /> Mood ring: the colour shifts with its mood</label>
    </PanelSection>
    <PanelSection title="Outfit">
      <div className="page-switcher">
        {PET_OUTFITS.map((item) => <button key={item} type="button" className={`transport-tab ${(options?.outfit ?? 'auto') === item ? 'selected' : ''}`} aria-pressed={(options?.outfit ?? 'auto') === item} disabled={busy} onClick={() => set({ outfit: item })}>{OUTFIT_NAMES[item]}</button>)}
      </div>
      <p className="panel-note">Seasonal puts on a hat for Halloween, Christmas and New Year, and a nightcap at night.</p>
    </PanelSection>
    <PanelSection title="Personality">
      {PERSONALITY.map(([key, label]) => <label key={key}>{label}: {options?.[key] ?? 5}<input type="range" min={0} max={10} step={1} value={options?.[key] ?? 5} disabled={busy} onChange={(event) => set({ [key]: Number(event.target.value) })} /></label>)}
    </PanelSection>
    <PanelSection title="Sound and quiet hours">
      <label className="widget-screen-toggle"><input type="checkbox" checked={Boolean(options?.sound)} disabled={busy} onChange={(event) => set({ sound: event.target.checked })} /> Little beeps when it reacts</label>
      <label className="widget-screen-toggle"><input type="checkbox" checked={quiet} disabled={busy} onChange={(event) => set(event.target.checked ? { quietFrom: 23, quietTo: 7 } : { quietFrom: undefined, quietTo: undefined })} /> Quiet hours: it sleeps and stays silent</label>
      {quiet ? <div className="page-switcher">
        <label>From<select value={options?.quietFrom} disabled={busy} onChange={(event) => set({ quietFrom: Number(event.target.value) })}>{HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}</select></label>
        <label>Until<select value={options?.quietTo} disabled={busy} onChange={(event) => set({ quietTo: Number(event.target.value) })}>{HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}</select></label>
      </div> : null}
    </PanelSection>
    <PanelSection title="Play with it">
      <p className="panel-note">Tap it, double-tap it, hold or stroke it, swipe it, poke an eye, tap the edges or corners. Tap it three times fast for games: rock paper scissors, bang, chase the dot, peek-a-boo and a staring contest. On your phone it dances to the music playing on this PC and cheers when you play a game. Leave it alone and it lives its own life.</p>
    </PanelSection>
  </>;
}
