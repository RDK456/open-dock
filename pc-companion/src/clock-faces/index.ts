import './clock-faces.js';
import { currentTheme, onThemeChange } from '../theme';

export type ClockCategory = 'classic' | 'retro' | 'ambient' | 'kinetic';
export type ClockFaceInfo = { id: string; name: string; category: ClockCategory; color: boolean; blurb: string };
type OpenDockClockApi = {
  faces: ClockFaceInfo[];
  mount(host: HTMLElement, options: { face: string; color?: string | null; width: number; height: number; hour12?: boolean; live?: boolean; pixelRatio?: number; background?: boolean }): { destroy(): void; setLive(live: boolean): void; setVisible(visible: boolean): void };
  setPaused(paused: boolean): void;
  setBackgroundPaused(paused: boolean): void;
  setFrameRate(fps: number): void;
  setTheme(theme: 'light' | 'dark'): void;
  tint(hex: string): string;
};

export const OpenDockClock = (globalThis as unknown as { OpenDockClock: OpenDockClockApi }).OpenDockClock;
// Editor previews are thumbnails: 15 fps keeps motion readable at a quarter of the work of 60 fps.
// The phone draws the real widget at 30.
OpenDockClock.setFrameRate(15);
// Faces follow the app's light or dark look; the ones on screen are drawn again when it changes.
OpenDockClock.setTheme(currentTheme());
onThemeChange(() => OpenDockClock.setTheme(currentTheme()));
// Nothing animates while the Open Dock window is hidden or minimised.
document.addEventListener('visibilitychange', () => OpenDockClock.setPaused(document.hidden));
export const CLOCK_CATEGORIES: [ClockCategory, string][] = [['classic', 'Classic'], ['retro', 'Retro'], ['ambient', 'Ambient'], ['kinetic', 'Kinetic']];
export const CLOCK_COLOR_PRESETS = ['#93c5fd', '#f472b6', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#a78bfa', '#f4f4f5'];
export const DEFAULT_CLOCK_COLOR = '#93c5fd';
// The desktop can't see the phone's 12/24-hour setting, so the preview follows this PC's locale.
export const HOUR12 = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 ?? true;

export function clockFace(id?: string): ClockFaceInfo {
  return OpenDockClock.faces.find((face) => face.id === id) ?? OpenDockClock.faces.find((face) => face.id === 'digital')!;
}
