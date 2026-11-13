import { getAppearance, setAccent, setCorners, setLook, setThemeMode, ACCENTS, CORNERS, LOOKS, type Corners, type Look, type ThemeMode } from './theme';
import { getWallpaperSettings, setWallpaperSettings, WALLPAPERS, type WallpaperId } from './wallpaper';

// The phone's look is one setting shared with the PC (kept in its deck config), so it can be changed from either.
// Changes made here are sent to the PC; each deck that arrives brings the PC's copy, applied here.
export type PhoneLook = { look?: Look; mode?: ThemeMode; accent?: string; corners?: Corners; wallpaper?: WallpaperId; motion?: boolean; keyOpacity?: number; imageOpacity?: number; gradient?: number };

type Send = (message: Record<string, unknown>) => void;
let sender: Send | null = null;
/** Called by the connection: `send` once it's ready, null when it closes. */
export function setLookSender(send: Send | null) { sender = send; }

const unit = (value: unknown) => typeof value === 'number' && value >= 0 && value <= 1;

/** Everything as it is on this phone now. */
export function currentLook(): PhoneLook {
  const { mode, look, accent, corners } = getAppearance();
  const { wallpaper, motion, keyOpacity, imageOpacity, gradient } = getWallpaperSettings();
  return { look, mode, accent, corners, wallpaper, motion, keyOpacity, imageOpacity, gradient };
}

/** Tells the PC what changed here. */
export function shareLook(patch: PhoneLook) { sender?.({ type: 'phone_look', look: patch }); }

/** Applies the PC's copy: only valid values, and only what differs, so nothing is redrawn for nothing. */
export function applyLook(remote: unknown) {
  if (!remote || typeof remote !== 'object') return;
  const next = remote as Record<string, unknown>;
  const now = currentLook();
  if (LOOKS.some(([id]) => id === next.look) && next.look !== now.look) setLook(next.look as Look);
  if ((next.mode === 'light' || next.mode === 'dark' || next.mode === 'system') && next.mode !== now.mode) setThemeMode(next.mode);
  // Any #rrggbb works (the PC may pick one the phone's list lacks); '' is the look's own.
  if (typeof next.accent === 'string' && (next.accent === '' || /^#[0-9a-f]{6}$/i.test(next.accent) || ACCENTS.some(([hex]) => hex === next.accent)) && next.accent !== now.accent) setAccent(next.accent);
  if (CORNERS.some(([id]) => id === next.corners) && next.corners !== now.corners) setCorners(next.corners as Corners);
  const wallpaper: Partial<ReturnType<typeof getWallpaperSettings>> = {};
  if (WALLPAPERS.some(([id]) => id === next.wallpaper) && next.wallpaper !== now.wallpaper) wallpaper.wallpaper = next.wallpaper as WallpaperId;
  if (typeof next.motion === 'boolean' && next.motion !== now.motion) wallpaper.motion = next.motion;
  if (unit(next.keyOpacity) && next.keyOpacity !== now.keyOpacity) wallpaper.keyOpacity = next.keyOpacity as number;
  if (unit(next.imageOpacity) && next.imageOpacity !== now.imageOpacity) wallpaper.imageOpacity = next.imageOpacity as number;
  if (unit(next.gradient) && next.gradient !== now.gradient) wallpaper.gradient = next.gradient as number;
  if (Object.keys(wallpaper).length) setWallpaperSettings(wallpaper);
}
