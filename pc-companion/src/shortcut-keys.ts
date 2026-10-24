// Keyboard shortcuts for a key: the common ones to pick from, and turning a key press into the names the PC
// sends (see parse_key and validate_hotkey in lib.rs: modifiers first, then one letter, digit or named key).
const MODIFIERS = ['CTRL', 'ALT', 'SHIFT', 'META'] as const;

const NAMED: Record<string, string> = {
  Space: 'SPACE', Enter: 'ENTER', NumpadEnter: 'ENTER', Tab: 'TAB', Escape: 'ESCAPE', Backspace: 'BACKSPACE', Delete: 'DELETE',
  Home: 'HOME', End: 'END', PageUp: 'PAGE_UP', PageDown: 'PAGE_DOWN', ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
};

/** The main key of a press, by its position on the keyboard (`event.code`), or null for a modifier or a key the PC can't send. */
export function mainKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^(Digit|Numpad)[0-9]$/.test(code)) return code.slice(-1);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

/** A recorded press as the PC's key list: modifiers in a fixed order, then the key. Null without a modifier. */
export function shortcutFromPress(press: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string[] | null {
  const key = mainKey(press.code);
  const held = [press.ctrlKey, press.altKey, press.shiftKey, press.metaKey];
  const modifiers = MODIFIERS.filter((_, index) => held[index]);
  return key && modifiers.length ? [...modifiers, key] : null;
}

/** Shortcuts people reach for, grouped for the list. Ctrl+Alt+Delete is missing on purpose: Windows lets no app send it. */
export const COMMON_SHORTCUTS: [group: string, label: string, keys: string][] = [
  ['Edit', 'Copy', 'CTRL+C'], ['Edit', 'Paste', 'CTRL+V'], ['Edit', 'Cut', 'CTRL+X'], ['Edit', 'Undo', 'CTRL+Z'], ['Edit', 'Redo', 'CTRL+Y'],
  ['Edit', 'Select all', 'CTRL+A'], ['Edit', 'Save', 'CTRL+S'], ['Edit', 'Find', 'CTRL+F'], ['Edit', 'Print', 'CTRL+P'],
  ['Browser', 'New tab', 'CTRL+T'], ['Browser', 'Close tab', 'CTRL+W'], ['Browser', 'Reopen closed tab', 'CTRL+SHIFT+T'], ['Browser', 'Next tab', 'CTRL+TAB'],
  ['Browser', 'Previous tab', 'CTRL+SHIFT+TAB'], ['Browser', 'Reload', 'CTRL+R'], ['Browser', 'Private window', 'CTRL+SHIFT+N'],
  ['Windows', 'Switch app', 'ALT+TAB'], ['Windows', 'Close window', 'ALT+F4'], ['Windows', 'Task Manager', 'CTRL+SHIFT+ESCAPE'], ['Windows', 'Show desktop', 'META+D'],
  ['Windows', 'Lock PC', 'META+L'], ['Windows', 'File Explorer', 'META+E'], ['Windows', 'Run', 'META+R'], ['Windows', 'Settings', 'META+I'],
  ['Windows', 'Snip a screenshot', 'META+SHIFT+S'], ['Windows', 'Task view', 'META+TAB'], ['Windows', 'Next desktop', 'CTRL+META+RIGHT'],
  ['Windows', 'Previous desktop', 'CTRL+META+LEFT'], ['Windows', 'Maximize window', 'META+UP'], ['Windows', 'Snap left', 'META+LEFT'], ['Windows', 'Snap right', 'META+RIGHT'],
  ['Calls', 'Mute (Teams, Discord)', 'CTRL+SHIFT+M'], ['Calls', 'Camera on/off (Teams)', 'CTRL+SHIFT+O'], ['Calls', 'Mute (Zoom)', 'ALT+A'], ['Calls', 'Video on/off (Zoom)', 'ALT+V'],
];
