import { useEffect, useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { ColorField } from '../clock-faces/ClockSettings';
import { PanelSection } from '../SettingsPanel';
import { DeckSelect } from '../DeckSelect';
import { DEFAULT_CLOCK_COLOR } from '../clock-faces';
import { PcStatsPreview } from './PcStatsPreview';
import { OpenDockStats, PC_STATS_SIZES, pcStatsStyle, usePcStatsSample, type PcGpu, type PcStatsSample, type PcStatsSize } from '.';

type Block = { width: number; height: number };
type Patch = { face?: string; metric?: string; color?: string; gpu?: string };
type Props = { style?: string; metric?: string; color?: string; gpu?: string; block: Block; columns: number; rows: number; busy: boolean; onChange: (patch: Patch) => void };

// Sidebar settings for a selected PC stats widget: live preview, style, reading, GPU, colour, and
// where each reading comes from.
export function PcStatsSettings({ style, metric, color, gpu, block, columns, rows, busy, onChange }: Props) {
  const info = pcStatsStyle(style);
  const shown = pcStatsStyle(OpenDockStats.resolve(info.id, columns, rows));
  const current = color ?? DEFAULT_CLOCK_COLOR;
  const [browsing, setBrowsing] = useState(false);
  // The Sensor sources panel and the GPU picker need GPU and CPU temperature readings.
  const sample = usePcStatsSample(['cputemp', 'gpu']);
  const gpus = sample?.gpus ?? [];
  const usesGpu = shown.dashboard || !!OpenDockStats.metrics.find((item) => item.id === (metric ?? 'cpu'))?.gpu;
  return <>
    <div className="panel-preview"><PcStatsPreview style={info.id} metric={metric} color={current} gpu={gpu} width={block.width} height={block.height} columns={columns} rows={rows} /></div>
    <PanelSection title="Appearance">
      <div className="panel-tile">
        <div><strong>{info.name}</strong><small>{shown.id === info.id ? PC_STATS_SIZES.find(([id]) => id === info.size)?.[1] : `Needs ${info.span.join(' × ')}. Showing ${shown.name} for now.`}</small></div>
        <button type="button" className="secondary-button" onClick={() => setBrowsing(true)} disabled={busy}>Change</button>
      </div>
      <ColorField color={current} busy={busy} onPick={(value) => onChange({ color: value })} />
    </PanelSection>
    <PanelSection title="Data">
      {shown.dashboard ? <p className="panel-note">Dashboards show CPU, GPU, memory and temperatures together. On a PC with two GPUs, Overview shows both.</p> : <div className="panel-field"><span className="clock-settings-label">Reading</span>
        <DeckSelect value={metric ?? 'cpu'} disabled={busy} options={OpenDockStats.metrics.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => onChange({ metric: value })} />
      </div>}
      {usesGpu && (gpus.length > 1 || (gpu && !gpus.some((item) => item.id === gpu))) ? <div className="panel-field"><span className="clock-settings-label">GPU</span>
        <DeckSelect value={gpu ?? 'auto'} disabled={busy} options={[{ value: 'auto', label: 'Automatic' }, ...gpus.map((item) => ({ value: item.id, label: gpuLabel(item) })), ...(gpu && !gpus.some((item) => item.id === gpu) ? [{ value: gpu, label: 'A GPU that isn’t in this PC now' }] : [])]} onChange={(value) => onChange({ gpu: value === 'auto' ? undefined : value })} />
        {gpu === undefined ? <small className="panel-note">Uses the discrete GPU while it’s in use.</small> : null}
      </div> : null}
      <p className="panel-note">Temperatures turn amber at 70 °C and red at 85 °C. “≈” marks an estimate.</p>
    </PanelSection>
    <SensorSources sample={sample} />
    {browsing ? <PcStatsBrowser selected={info.id} metric={metric} color={current} gpu={gpu} block={block} columns={columns} rows={rows} onClose={() => setBrowsing(false)} onChoose={(id) => { onChange({ face: id }); setBrowsing(false); }} /> : null}
  </>;
}

const VENDORS: Record<PcGpu['vendor'], string> = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', other: 'GPU' };
const STATES: Record<PcGpu['state'], string> = { ok: '', sleeping: ' · asleep', 'no-driver': ' · driver missing' };
const gpuLabel = (item: PcGpu) => `${item.name.replace(/\((R|TM)\)/g, '')}${item.kind === 'unknown' ? '' : ` (${item.kind})`}${STATES[item.state]}`;

// Where each reading comes from, in words a person recognises.
const SOURCES: Record<string, string> = {
  'gpu-engine-counter': 'Windows GPU counters',
  'd3dkmt-statistics': 'Windows GPU scheduler',
  'gpu-memory-counter': 'Windows GPU memory counters',
  dxgi: 'DirectX adapter info',
  d3dkmt: 'Windows GPU telemetry',
  nvml: 'NVIDIA driver (NVML)',
  adlx: 'AMD driver (ADLX)',
  adl: 'AMD driver (ADL)',
  igcl: 'Intel driver (IGCL)',
  'cpu-die': 'CPU temperature, same chip (estimate)',
  'thermal-zone': 'ACPI thermal zone (estimate)',
  sensors: 'CPU die sensors',
  ioaccelerator: 'macOS GPU statistics',
  ioregistry: 'macOS device registry',
  'unified-memory': 'Unified memory size',
  'die-sensors': 'Apple die sensors',
  smc: 'System Management Controller',
};
const READINGS: [string, string[]][] = [['Load', ['load']], ['Temperature', ['temp']], ['Hotspot', ['hotspot']], ['Power', ['power', 'power_percent']], ['Fan', ['fan', 'fan_rpm']], ['Memory used', ['mem_used']], ['Memory size', ['mem_total']]];

function missing(item: PcGpu) {
  if (item.state === 'no-driver') return `Driver missing. Install the ${VENDORS[item.vendor]} driver.`;
  if (item.state === 'sleeping') return 'GPU asleep; read when it’s in use';
  return 'Not reported by this GPU';
}

function SensorSources({ sample }: { sample: PcStatsSample | null }) {
  return <details className="pc-sources">
    <summary>Sensor sources</summary>
    {!sample ? <p className="clock-settings-note">Waiting for the first reading…</p> : <>
      <dl><dt>CPU temperature</dt><dd>{sample.cputempSource ? SOURCES[sample.cputempSource] ?? sample.cputempSource : 'Not reported on this PC'}</dd></dl>
      {sample.gpus?.length ? sample.gpus.map((item) => <div key={item.id} className="pc-sources-gpu">
        <strong>{gpuLabel(item)}</strong>
        <dl>{READINGS.map(([label, keys]) => {
          const key = keys.find((name) => item.sources?.[name]);
          return <div key={label}><dt>{label}</dt><dd className={key ? '' : 'missing'}>{key ? SOURCES[item.sources![key]] ?? item.sources![key] : missing(item)}</dd></div>;
        })}</dl>
      </div>) : <p className="clock-settings-note">No GPU found.</p>}
    </>}
  </details>;
}

// Dialog listing every style with live readings. Styles that fit the widget are drawn at its real size;
// bigger ones are drawn at their own size and marked with what they need.
function PcStatsBrowser({ selected, metric, color, gpu, block, columns, rows, onClose, onChoose }: { selected: string; metric?: string; color: string; gpu?: string; block: Block; columns: number; rows: number; onClose: () => void; onChoose: (style: string) => void }) {
  const [size, setSize] = useState<PcStatsSize | 'all'>('all');
  const [choice, setChoice] = useState(selected);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const styles = useMemo(() => OpenDockStats.styles.filter((style) => size === 'all' || style.size === size), [size]);
  const cell = { width: block.width / columns, height: block.height / rows };
  return <div className="clock-browser-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="clock-browser" role="dialog" aria-modal="true" aria-label="Choose a PC stats style">
      <header>
        <div><h2>Choose a PC stats style</h2><p>This widget is {columns} × {rows}. Bigger styles show a simpler fallback until you resize it.</p></div>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="clock-browser-tools">
        <div className="page-switcher">
          {([['all', 'All'], ...PC_STATS_SIZES] as [PcStatsSize | 'all', string][]).map(([id, label]) => <button key={id} type="button" className={`transport-tab ${size === id ? 'selected' : ''}`} onClick={() => setSize(id)}>{label}</button>)}
        </div>
      </div>
      <div className="clock-browser-grid">
        {styles.map((style) => {
          const fits = style.span[0] <= columns && style.span[1] <= rows;
          const [c, r] = fits ? [columns, rows] : style.span;
          const width = fits ? block.width : cell.width * c, height = fits ? block.height : cell.height * r;
          return <button key={style.id} type="button" className={`clock-browser-tile ${style.id === choice ? 'selected' : ''}`} aria-pressed={style.id === choice} onClick={() => setChoice(style.id)} onDoubleClick={() => onChoose(style.id)}>
            <span className="clock-browser-preview" style={{ height: Math.min(150, Math.max(70, 220 * height / width)) }}><PcStatsPreview style={style.id} metric={metric} color={color} gpu={gpu} width={width} height={height} columns={c} rows={r} /></span>
            <span className="clock-browser-name"><strong>{style.name}</strong>{fits ? null : <small>Needs {style.span.join(' × ')}</small>}{style.id === choice ? <Check size={14} /> : null}</span>
          </button>;
        })}
      </div>
      <footer>
        <span>{pcStatsStyle(choice).blurb}</span>
        <div><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" onClick={() => onChoose(choice)}>Use style</button></div>
      </footer>
    </div>
  </div>;
}
