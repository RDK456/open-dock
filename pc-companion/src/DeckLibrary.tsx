import { useState } from 'react';
import { AppWindow, Bot, Clock, File, FolderClosed, FolderOpen, Gauge, Globe, Keyboard, Layers, Layers2, ListOrdered, MicVocal, Music, Package, Play, Search, Terminal, TextCursorInput } from 'lucide-react';

export type WidgetChoice = { kind: 'clock' } | { kind: 'now_playing' } | { kind: 'lyrics' } | { kind: 'pc_stats' } | { kind: 'pet' } | { kind: 'plugin'; pluginId: string; widgetId: string };
export type ButtonPreset = 'hotkey' | 'media' | 'launch_app' | 'launch_file' | 'launch_folder' | 'type_text' | 'open_url' | 'run_script' | 'sequence' | 'select_page' | 'select_profile';
export type LibraryChoice = WidgetChoice | { kind: 'button'; preset: ButtonPreset } | { kind: 'plugin_action'; pluginId: string; actionId: string } | { kind: 'folder' };

type Entry = { key: string; icon: React.ReactNode; title: string; detail: string; choice: LibraryChoice; disabled?: string };

// What the right-hand panel shows when nothing is selected: every kind of button in one searchable list. The
// widgets are a shelf under the grid (`shelf`), in reach without scrolling.
export function DeckLibrary({ shelf = false, pluginActions, pluginWidgets, targetLabel, inFolder, canSwitchPage, canSwitchProfile, busy, drag, onKeyPick, onClearTarget }: {
  shelf?: boolean;
  pluginActions: { pluginId: string; actionId: string; label: string }[];
  pluginWidgets: { pluginId: string; widgetId: string; label: string }[];
  targetLabel: string | null;
  inFolder: boolean;
  canSwitchPage: boolean;
  canSwitchProfile: boolean;
  busy: boolean;
  // Items are dragged onto the grid with the pointer; a plain click (or Enter) places the item where the page says.
  drag: { start: (event: React.PointerEvent<HTMLButtonElement>, choice: LibraryChoice, label: string) => void; move: (event: React.PointerEvent<HTMLButtonElement>) => void; end: (event: React.PointerEvent<HTMLButtonElement>) => void; cancel: (event: React.PointerEvent<HTMLButtonElement>) => void };
  onKeyPick: (choice: LibraryChoice) => void;
  onClearTarget: () => void;
}) {
  const [query, setQuery] = useState('');
  const buttons: Entry[] = [
    { key: 'hotkey', icon: <Keyboard size={16} />, title: 'Keyboard shortcut', detail: 'Press keys on this PC', choice: { kind: 'button', preset: 'hotkey' } },
    { key: 'media', icon: <Play size={16} />, title: 'Media control', detail: 'Play, pause, skip, volume', choice: { kind: 'button', preset: 'media' } },
    { key: 'launch_app', icon: <AppWindow size={16} />, title: 'Open app', detail: 'Choose an application', choice: { kind: 'button', preset: 'launch_app' } },
    { key: 'launch_file', icon: <File size={16} />, title: 'Open file', detail: 'Choose a file', choice: { kind: 'button', preset: 'launch_file' } },
    { key: 'launch_folder', icon: <FolderOpen size={16} />, title: 'Open folder', detail: 'Choose a folder on this PC', choice: { kind: 'button', preset: 'launch_folder' } },
    { key: 'type_text', icon: <TextCursorInput size={16} />, title: 'Type text', detail: 'A snippet, signature or reply', choice: { kind: 'button', preset: 'type_text' } },
    { key: 'open_url', icon: <Globe size={16} />, title: 'Open website', detail: 'A page in your browser', choice: { kind: 'button', preset: 'open_url' } },
    { key: 'run_script', icon: <Terminal size={16} />, title: 'Run script', detail: 'A local script on this PC', choice: { kind: 'button', preset: 'run_script' } },
    { key: 'sequence', icon: <ListOrdered size={16} />, title: 'Sequence', detail: 'Several steps in a row', choice: { kind: 'button', preset: 'sequence' } },
    { key: 'select_page', icon: <Layers size={16} />, title: 'Switch page', detail: 'Jump to another page', choice: { kind: 'button', preset: 'select_page' }, disabled: canSwitchPage ? undefined : 'Needs a second page' },
    { key: 'select_profile', icon: <Layers2 size={16} />, title: 'Switch profile', detail: 'Jump to another profile', choice: { kind: 'button', preset: 'select_profile' }, disabled: canSwitchProfile ? undefined : 'Needs a second profile' },
    { key: 'folder', icon: <FolderClosed size={16} />, title: 'Folder', detail: 'Opens its own grid', choice: { kind: 'folder' }, disabled: inFolder ? 'Folders cannot hold folders' : undefined },
    ...pluginActions.map((item) => ({ key: `${item.pluginId}::${item.actionId}`, icon: <Package size={16} />, title: item.label, detail: 'Plugin action', choice: { kind: 'plugin_action', pluginId: item.pluginId, actionId: item.actionId } as LibraryChoice })),
  ];
  const widgets: Entry[] = [
    { key: 'clock', icon: <Clock size={16} />, title: 'Clock', detail: '26 faces, many with your own color', choice: { kind: 'clock' } },
    { key: 'now_playing', icon: <Music size={16} />, title: 'Now Playing', detail: 'Artwork, controls and volume for this PC', choice: { kind: 'now_playing' } },
    { key: 'pc_stats', icon: <Gauge size={16} />, title: 'PC stats', detail: 'CPU, GPU, RAM and temperatures', choice: { kind: 'pc_stats' } },
    { key: 'pet', icon: <Bot size={16} />, title: 'Pet', detail: 'A little companion that plays and reacts to touch', choice: { kind: 'pet' } },
    { key: 'lyrics', icon: <MicVocal size={16} />, title: 'Lyrics', detail: 'Synced lyrics for what this PC is playing', choice: { kind: 'lyrics' } },
    ...pluginWidgets.map((item) => ({ key: `${item.pluginId}::${item.widgetId}`, icon: <Package size={16} />, title: item.label, detail: 'Plugin widget', choice: { kind: 'plugin', pluginId: item.pluginId, widgetId: item.widgetId } as LibraryChoice })),
  ];
  const needle = query.trim().toLowerCase();
  const match = (entry: Entry) => !needle || `${entry.title} ${entry.detail}`.toLowerCase().includes(needle);
  const group = (title: string, entries: Entry[]) => {
    const shown = entries.filter(match);
    if (!shown.length) return null;
    return <div className="deck-library-group" key={title}>
      <h3>{title}</h3>
      {shown.map((entry) => <button key={entry.key} type="button" className="deck-library-item" disabled={busy || Boolean(entry.disabled)} title={entry.disabled} onPointerDown={(event) => drag.start(event, entry.choice, entry.title)} onPointerMove={drag.move} onPointerUp={drag.end} onPointerCancel={drag.cancel} onClick={(event) => { if (event.detail === 0) onKeyPick(entry.choice); }}>
        <span className="deck-library-icon">{entry.icon}</span>
        <span><strong>{entry.title}</strong><small>{entry.disabled ?? entry.detail}</small></span>
      </button>)}
    </div>;
  };
  if (shelf) return <section className="deck-library deck-widget-shelf" aria-label="Widgets">{group('Widgets', widgets)}</section>;
  const groups = [group('Buttons', buttons)].filter(Boolean);
  return <div className="deck-library">
    <div className="properties-heading"><div><h2>Add to {inFolder ? 'folder' : 'page'}</h2><p>{targetLabel ? `Placing in ${targetLabel}` : 'Drag an item onto a cell, or click it to use the first free cell. Widgets are under the grid.'}</p></div>{targetLabel ? <button type="button" className="secondary-button" onClick={onClearTarget}>Clear</button> : null}</div>
    <label className="deck-library-search"><Search size={14} /><input value={query} placeholder="Search buttons" aria-label="Search buttons" onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="deck-library-list">
      {groups.length ? groups : <p className="deck-library-empty">Nothing matches “{query}”.</p>}
    </div>
  </div>;
}
