// The Clipboard widget's looks and scroll styles. The ids match CLIPBOARD_FACES and CLIPBOARD_SCROLL on the PC side
// (src-tauri/src/lib.rs) and the phone's clipboard-widget.tsx.
export const CLIPBOARD_FACES: [id: string, name: string, detail: string][] = [
  ['list', 'List', 'One line per clip, with how long ago'],
  ['cards', 'Cards', 'Up to three lines of each clip'],
  ['chips', 'Chips', 'Short pills that wrap across the tile'],
  ['focus', 'Focus', 'One clip at a time, large'],
];
export const CLIPBOARD_SCROLLS: [id: string, name: string, detail: string][] = [
  ['swipe', 'Free swipe', 'Drag and let it glide'],
  ['snap', 'Snap', 'Stops on one clip at a time'],
  ['auto', 'Auto-scroll', 'Drifts down on its own; touching pauses it'],
];
export const DEFAULT_CLIPBOARD_FACE = 'list';
export const DEFAULT_CLIPBOARD_SCROLL = 'swipe';

/** Made-up clips so the preview shows what each look does with short, long and multi-line text. */
export const SAMPLE_CLIPS = [
  { text: 'npm run build -- --release', ago: 'now' },
  { text: 'https://github.com/RDK456/open-dock/releases/latest', ago: '2m' },
  { text: 'Meeting at 3pm: bring the deck, the budget sheet and the updated roadmap for next quarter.', ago: '9m' },
  { text: 'C:\\Users\\me\\Pictures\\Open Dock\\screenshot.png', ago: '14m' },
  { text: 'Thanks, that works for me.', ago: '31m' },
  { text: 'SELECT id, name FROM profiles ORDER BY name;', ago: '1h' },
];
