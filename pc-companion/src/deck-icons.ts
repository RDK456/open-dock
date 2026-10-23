// Whether an icon just read from the PC may still be put on a button. The button must still be there, still
// point at the same app or file, and still show an icon Open Dock chose (automatic, or a previous app icon),
// never one the user picked.
export type IconTarget = { id: string; icon: string; action: { type: string; app?: string; path?: string } };

export function canReceiveIcon(button: IconTarget, buttonId: string, kind: 'app' | 'file', target: string): boolean {
  if (button.id !== buttonId || (button.icon !== 'auto' && button.icon !== 'app-icon')) return false;
  return kind === 'app'
    ? button.action.type === 'launch_app' && button.action.app === target
    : button.action.type === 'launch_file' && button.action.path === target;
}
