import { ColorField } from '../clock-faces/ClockSettings';
import { DEFAULT_CLOCK_COLOR } from '../clock-faces';
import { DeckSelect } from '../DeckSelect';
import { PanelSection } from '../SettingsPanel';
import { ClipboardPreview } from './ClipboardPreview';
import { CLIPBOARD_FACES, CLIPBOARD_SCROLLS, DEFAULT_CLIPBOARD_FACE, DEFAULT_CLIPBOARD_SCROLL } from '.';

type Block = { width: number; height: number };
type Patch = { face?: string; scroll?: string; color?: string };

// Sidebar settings for a selected Clipboard widget: a preview, the look, how it scrolls, and the highlight colour.
export function ClipboardSettings({ face, scroll, color, block, busy, onChange }: { face?: string; scroll?: string; color?: string; block: Block; busy: boolean; onChange: (patch: Patch) => void }) {
  const look = face ?? DEFAULT_CLIPBOARD_FACE;
  const motion = scroll ?? DEFAULT_CLIPBOARD_SCROLL;
  const lookInfo = CLIPBOARD_FACES.find(([id]) => id === look) ?? CLIPBOARD_FACES[0];
  const scrollInfo = CLIPBOARD_SCROLLS.find(([id]) => id === motion) ?? CLIPBOARD_SCROLLS[0];
  return <>
    <div className="panel-preview"><ClipboardPreview face={look} scroll={motion} color={color} width={block.width} height={block.height} /></div>
    <PanelSection title="Appearance">
      <div className="panel-field"><span className="clock-settings-label">Look</span>
        <DeckSelect value={look} disabled={busy} options={CLIPBOARD_FACES.map(([id, name]) => ({ value: id, label: name }))} onChange={(value) => onChange({ face: value })} />
        <small className="panel-note">{lookInfo[2]}</small>
      </div>
      <div className="panel-field"><span className="clock-settings-label">Scrolling</span>
        <DeckSelect value={motion} disabled={busy} options={CLIPBOARD_SCROLLS.map(([id, name]) => ({ value: id, label: name }))} onChange={(value) => onChange({ scroll: value })} />
        <small className="panel-note">{look === 'focus' && motion !== 'auto' ? 'Focus always shows one clip at a time; swipe sideways.' : scrollInfo[2]}</small>
      </div>
      <ColorField color={color ?? DEFAULT_CLOCK_COLOR} busy={busy} onPick={(value) => onChange({ color: value })} />
    </PanelSection>
    <PanelSection title="Privacy">
      <p className="panel-note">Open Dock reads this PC’s clipboard only while a phone is showing this widget. Clips stay in memory (never saved), copies a password manager marks as private are skipped, and the list is cleared five minutes after the last phone looks away. Tap a clip on the phone to copy it back to this PC, or hold it to copy it to the phone. Text only, on Windows for now.</p>
    </PanelSection>
  </>;
}
