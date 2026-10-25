// The phone's colors in both looks. Plain data with no React Native imports, so scripts/check-theme.ts can read
// it. Dark is the original look, value for value; light mirrors the desktop app's tokens (pc-companion/src/App.css).
export type ThemeMode = 'light' | 'dark' | 'system';
export type Scheme = 'light' | 'dark';

export type Colors = {
  bg: string;
  panel: string;
  panelRaised: string;
  pressed: string;
  border: string;
  borderStrong: string;
  borderActive: string;
  borderFocus: string;
  text: string;
  /** Text and icons on a `accent` button. */
  onAccent: string;
  muted: string;
  faint: string;
  accent: string;
  mint: string;
  /** Text on a `mint` fill. */
  onMint: string;
  red: string;
  blue: string;
  /** How much of the album art shows through behind the Now Playing card (under `tint`). */
  artOpacity: number;
  star: string;
  warn: string;
  /** The same warning as a dot or fill, where it can be as vivid as it likes. */
  warnFill: string;
  warnBorder: string;
  goodBg: string;
  goodBorder: string;
  playingBorder: string;
  /** Behind a sheet or dialog. */
  scrim: string;
  /** Over blurred album art. */
  tint: string;
  /** Floating controls over the deck. */
  float: string;
  floatSoft: string;
  /** Frosted surfaces on the Touch screen. */
  glass: string;
  glassBorder: string;
  /** The soft light under a finger on the touchpad. */
  glow: string;
};

export const darkColors: Colors = {
  bg: '#09090b',
  panel: '#111113',
  panelRaised: '#18181b',
  pressed: '#27272a',
  border: '#27272a',
  borderStrong: '#3f3f46',
  borderActive: '#52525b',
  borderFocus: '#71717a',
  text: '#fafafa',
  onAccent: '#18181b',
  muted: '#a1a1aa',
  faint: '#71717a',
  accent: '#e4e4e7',
  mint: '#4ade80',
  onMint: '#052e16',
  red: '#f87171',
  blue: '#93c5fd',
  artOpacity: 0.3,
  star: '#facc15',
  warn: '#eab308',
  warnFill: '#eab308',
  warnBorder: '#4a3f10',
  goodBg: '#111a14',
  goodBorder: '#28392d',
  playingBorder: '#14532d',
  scrim: 'rgba(0,0,0,0.6)',
  tint: 'rgba(9, 9, 11, 0.78)',
  float: 'rgba(24,24,27,0.93)',
  floatSoft: 'rgba(24, 24, 27, 0.7)',
  glass: 'rgba(255, 255, 255, 0.05)',
  glassBorder: 'rgba(255, 255, 255, 0.1)',
  glow: 'rgba(250, 250, 250, 0.14)',
};

export const lightColors: Colors = {
  bg: '#ffffff',
  panel: '#fafafa',
  panelRaised: '#f4f4f5',
  pressed: '#e4e4e7',
  border: '#e4e4e7',
  borderStrong: '#d4d4d8',
  borderActive: '#a1a1aa',
  borderFocus: '#8a8a94',
  text: '#18181b',
  onAccent: '#fafafa',
  muted: '#52525b',
  faint: '#686872',
  accent: '#27272a',
  mint: '#15803d',
  onMint: '#ffffff',
  red: '#b91c1c',
  blue: '#2b82ff',
  artOpacity: 0.38,
  star: '#f59e0b',
  warn: '#955a06',
  warnFill: '#f59e0b',
  warnBorder: '#e0b64a',
  goodBg: '#ecfdf3',
  goodBorder: '#b7e4c7',
  playingBorder: '#86d9a5',
  scrim: 'rgba(24,24,27,0.4)',
  tint: 'rgba(255, 255, 255, 0.66)',
  float: 'rgba(255,255,255,0.93)',
  floatSoft: 'rgba(255, 255, 255, 0.7)',
  glass: 'rgba(24, 24, 27, 0.04)',
  glassBorder: 'rgba(24, 24, 27, 0.1)',
  glow: 'rgba(24, 24, 27, 0.1)',
};

export function parseMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * The deck's look. Classic is the plain design above. The others are complete designs with their own palette and
 * key shape. Every look comes in light and dark and follows the light/dark choice.
 */
export type Look = 'classic' | 'studio' | 'atelier' | 'signal' | 'glass' | 'funk' | 'dock';
export const LOOKS: [Look, string][] = [['classic', 'Classic'], ['studio', 'Studio'], ['atelier', 'Atelier'], ['signal', 'Signal'], ['glass', 'Glass'], ['funk', 'Funk'], ['dock', 'Dock']];

// Looks that were retired move to the nearest design that replaced them.
const RETIRED: Record<string, Look> = { console: 'signal', bento: 'studio', desk: 'atelier' };

export function parseLook(value: unknown): Look {
  if (typeof value === 'string' && value in RETIRED) return RETIRED[value];
  return value === 'studio' || value === 'atelier' || value === 'signal' || value === 'glass' || value === 'funk' || value === 'dock' ? value : 'classic';
}

/** How a deck key is drawn in a look. */
export type KeyLook = {
  radius: number;
  borderWidth: number;
  bg: string;
  border: string;
  /** CSS box-shadow: an LED's glow, or a flat drawing's hard offset shadow. */
  shadow?: string;
  ink: string;
  labelSize: number;
  labelWeight: '500' | '600' | '700' | '800';
  /** The label's typeface ('serif', 'monospace'); the app's own when left out. */
  font?: string;
  /** Labels in capitals, spaced out by `tracking`. */
  caps?: boolean;
  tracking?: number;
  iconStroke: number;
  /** How keys arrive and answer a press: a bouncy spring, a quick glide, a slow fade, or hard steps like a display. */
  motion: 'spring' | 'glide' | 'slow' | 'step';
  /** Saturated blocks, one per key in turn, each with the ink that reads on it. */
  tiles?: [string, string][];
  /** A soft light that follows the finger across the key. */
  touchLight?: string;
  /** Bare, larger icons with no label, as in a phone's dock. */
  iconOnly?: boolean;
};

// Studio: a precise dark tool. Near-black with a cool tint, hairlines, one violet accent.
const studioColors: Colors = {
  bg: '#08090a', panel: '#0f1011', panelRaised: '#151618', pressed: '#1c1d20', border: '#1f2023', borderStrong: '#2e3035',
  borderActive: '#454850', borderFocus: '#7c84f5', text: '#f7f8f8', onAccent: '#08090a', muted: '#a3a6ad', faint: '#8a8f98',
  accent: '#7c84f5', mint: '#4ade80', onMint: '#052e16', red: '#ff7b7b', blue: '#8b93ff', artOpacity: 0.3, star: '#f5c451',
  warn: '#f5c451', warnFill: '#f5c451', warnBorder: '#4a3f10', goodBg: '#0f1a14', goodBorder: '#1e3326', playingBorder: '#1f6b45',
  scrim: 'rgba(0,0,0,0.6)', tint: 'rgba(8,9,10,0.8)', float: 'rgba(21,22,24,0.94)', floatSoft: 'rgba(21,22,24,0.72)',
  glass: '#0f1011', glassBorder: '#1f2023', glow: 'rgba(124,132,245,0.18)',
};

// Atelier: editorial and warm. Paper, ink and bronze, serif labels, hairline keys.
const atelierColors: Colors = {
  bg: '#f3eee5', panel: '#faf7f1', panelRaised: '#ece5d8', pressed: '#e4dccc', border: '#d9ceba', borderStrong: '#c9bba0',
  borderActive: '#a8987a', borderFocus: '#7a5a2c', text: '#1c1813', onAccent: '#ffffff', muted: '#4d4438', faint: '#5c5244',
  accent: '#5e4420', mint: '#2a6234', onMint: '#ffffff', red: '#9c2b1a', blue: '#2c5a8a', artOpacity: 0.38, star: '#a8781f',
  warn: '#7a4a00', warnFill: '#d9a441', warnBorder: '#d9b46a', goodBg: '#e6efe0', goodBorder: '#b9cfae', playingBorder: '#7fae86',
  scrim: 'rgba(28,24,19,0.4)', tint: 'rgba(250,247,241,0.72)', float: 'rgba(250,247,241,0.96)', floatSoft: 'rgba(250,247,241,0.78)',
  glass: '#faf7f1', glassBorder: '#d4c6ab', glow: 'rgba(122,90,44,0.12)',
};

// Signal: black and white like a device, on a dot grid, with monospace capitals.
const signalColors: Colors = {
  bg: '#000000', panel: '#0b0b0b', panelRaised: '#141414', pressed: '#1f1f1f', border: '#262626', borderStrong: '#333333',
  borderActive: '#555555', borderFocus: '#ffffff', text: '#ffffff', onAccent: '#000000', muted: '#b3b3b3', faint: '#8c8c8c',
  accent: '#ffffff', mint: '#4ade80', onMint: '#052e16', red: '#ff4d42', blue: '#9ec5ff', artOpacity: 0.3, star: '#ffffff',
  warn: '#ffd23f', warnFill: '#ffd23f', warnBorder: '#4a3f10', goodBg: '#0d140f', goodBorder: '#1f2e22', playingBorder: '#ffffff',
  scrim: 'rgba(0,0,0,0.7)', tint: 'rgba(0,0,0,0.78)', float: 'rgba(11,11,11,0.96)', floatSoft: 'rgba(11,11,11,0.75)',
  glass: '#0b0b0b', glassBorder: '#2a2a2a', glow: 'rgba(255,255,255,0.14)',
};

// Liquid glass dark: an aurora behind frosted glass, lit where the finger is.
const glassColors: Colors = {
  bg: '#05060b', panel: '#0e1019', panelRaised: '#151826', pressed: '#20253a', border: '#252a3e', borderStrong: '#343a56',
  borderActive: '#4d5579', borderFocus: '#7b84b1', text: '#f4f6ff', onAccent: '#0a0b12', muted: '#aab1cd', faint: '#7a819f',
  accent: '#cdd5ff', mint: '#5ef0b8', onMint: '#03261a', red: '#ff7a90', blue: '#8fb4ff', artOpacity: 0.35, star: '#ffd166',
  warn: '#ffd166', warnFill: '#ffd166', warnBorder: '#4d4020', goodBg: '#0f1c1a', goodBorder: '#1f3b35', playingBorder: '#1f6b55',
  scrim: 'rgba(0,0,0,0.6)', tint: 'rgba(5,6,11,0.7)', float: 'rgba(18,20,32,0.84)', floatSoft: 'rgba(18,20,32,0.62)',
  glass: 'rgba(255,255,255,0.08)', glassBorder: 'rgba(255,255,255,0.2)', glow: 'rgba(205,215,255,0.35)',
};

// Funk: neon keys with thick ink outlines and a hard drop shadow, on deep purple.
const funkColors: Colors = {
  bg: '#1a1033', panel: '#251845', panelRaised: '#2f2056', pressed: '#3a2a66', border: '#3d2d6b', borderStrong: '#4e3c85',
  borderActive: '#6a57a8', borderFocus: '#c6ff3d', text: '#fbf6ea', onAccent: '#16200a', muted: '#c4b8e6', faint: '#9d8fc7',
  accent: '#c6ff3d', mint: '#5cf2b0', onMint: '#04291a', red: '#ff7a9a', blue: '#4fd8ff', artOpacity: 0.32, star: '#ffb84d',
  warn: '#ffb84d', warnFill: '#ffb84d', warnBorder: '#5a3f1a', goodBg: '#14261f', goodBorder: '#24443a', playingBorder: '#2a8a62',
  scrim: 'rgba(8,4,20,0.65)', tint: 'rgba(26,16,51,0.8)', float: 'rgba(37,24,69,0.96)', floatSoft: 'rgba(37,24,69,0.75)',
  glass: '#251845', glassBorder: '#0b0618', glow: 'rgba(198,255,61,0.2)',
};

// Each look's other half, for the other light/dark choice (the PC's match is in App.css).
const studioLight: Colors = {
  bg: '#f7f7f8', panel: '#ffffff', panelRaised: '#f1f1f3', pressed: '#e6e7ea', border: '#e3e4e8', borderStrong: '#d2d4d9',
  borderActive: '#a9acb4', borderFocus: '#4f57e0', text: '#0e0f11', onAccent: '#ffffff', muted: '#4b4e56', faint: '#5b5f68',
  accent: '#3d44c4', mint: '#12703a', onMint: '#ffffff', red: '#b91c1c', blue: '#4b53d6', artOpacity: 0.38, star: '#d99a06',
  warn: '#8a5300', warnFill: '#f5c451', warnBorder: '#e0b64a', goodBg: '#ecfdf3', goodBorder: '#b7e4c7', playingBorder: '#86d9a5',
  scrim: 'rgba(14,15,17,0.4)', tint: 'rgba(247,247,248,0.72)', float: 'rgba(255,255,255,0.94)', floatSoft: 'rgba(255,255,255,0.74)',
  glass: '#ffffff', glassBorder: '#e3e4e8', glow: 'rgba(79,87,224,0.14)',
};
const atelierDark: Colors = {
  bg: '#16130f', panel: '#1e1a15', panelRaised: '#26211b', pressed: '#2e2820', border: '#3a3228', borderStrong: '#4a4034',
  borderActive: '#6b5d4a', borderFocus: '#d2a86a', text: '#f3ece0', onAccent: '#16130f', muted: '#c2b6a2', faint: '#a99c87',
  accent: '#d2a86a', mint: '#8cc79a', onMint: '#0f2416', red: '#f08a76', blue: '#8fb3d9', artOpacity: 0.3, star: '#d9a441',
  warn: '#e0b25a', warnFill: '#d9a441', warnBorder: '#4a3f10', goodBg: '#17201a', goodBorder: '#2b3a2f', playingBorder: '#3f6b4a',
  scrim: 'rgba(0,0,0,0.6)', tint: 'rgba(22,19,15,0.8)', float: 'rgba(30,26,21,0.96)', floatSoft: 'rgba(30,26,21,0.78)',
  glass: '#1e1a15', glassBorder: '#463c2f', glow: 'rgba(210,168,106,0.16)',
};
const signalLight: Colors = {
  bg: '#f2f2f2', panel: '#ffffff', panelRaised: '#ebebeb', pressed: '#e0e0e0', border: '#d6d6d6', borderStrong: '#c4c4c4',
  borderActive: '#9a9a9a', borderFocus: '#000000', text: '#000000', onAccent: '#ffffff', muted: '#474747', faint: '#5c5c5c',
  accent: '#000000', mint: '#12703a', onMint: '#ffffff', red: '#c8102e', blue: '#1f5fbf', artOpacity: 0.38, star: '#000000',
  warn: '#7a4a00', warnFill: '#ffd23f', warnBorder: '#e0b64a', goodBg: '#eef5ef', goodBorder: '#c9dccb', playingBorder: '#000000',
  scrim: 'rgba(0,0,0,0.35)', tint: 'rgba(242,242,242,0.8)', float: 'rgba(255,255,255,0.96)', floatSoft: 'rgba(255,255,255,0.78)',
  glass: '#ffffff', glassBorder: '#d0d0d0', glow: 'rgba(0,0,0,0.1)',
};
const glassLight: Colors = {
  bg: '#eef1f8', panel: '#ffffff', panelRaised: '#f0f2f8', pressed: '#e1e5f0', border: '#d9deea', borderStrong: '#c5cbdc',
  borderActive: '#9aa2bb', borderFocus: '#3b4aa8', text: '#10131f', onAccent: '#ffffff', muted: '#464c63', faint: '#575d75',
  accent: '#2f3c8e', mint: '#0f7a55', onMint: '#ffffff', red: '#b4234a', blue: '#3657c7', artOpacity: 0.38, star: '#c98a00',
  warn: '#855000', warnFill: '#ffd166', warnBorder: '#e0b64a', goodBg: '#e6f6ef', goodBorder: '#b6e0cc', playingBorder: '#6cc2a0',
  scrim: 'rgba(16,19,31,0.35)', tint: 'rgba(238,241,248,0.7)', float: 'rgba(255,255,255,0.8)', floatSoft: 'rgba(255,255,255,0.6)',
  glass: 'rgba(255,255,255,0.55)', glassBorder: 'rgba(255,255,255,0.85)', glow: 'rgba(59,74,168,0.22)',
};
const funkLight: Colors = {
  bg: '#fff6e0', panel: '#fffaf0', panelRaised: '#fdeecf', pressed: '#f6e4bd', border: '#e6d3a8', borderStrong: '#d4bd8a',
  borderActive: '#a8915e', borderFocus: '#6a2cf0', text: '#1a1033', onAccent: '#ffffff', muted: '#4a3d6b', faint: '#5a4c7a',
  accent: '#5a1fe0', mint: '#0f7a4f', onMint: '#ffffff', red: '#c2185b', blue: '#0067a3', artOpacity: 0.38, star: '#c77700',
  warn: '#8a4b00', warnFill: '#ffb84d', warnBorder: '#e0a64a', goodBg: '#e3f5e9', goodBorder: '#b5dfc3', playingBorder: '#2a8a62',
  scrim: 'rgba(26,16,51,0.4)', tint: 'rgba(255,246,224,0.78)', float: 'rgba(255,250,240,0.96)', floatSoft: 'rgba(255,250,240,0.78)',
  glass: '#fffaf0', glassBorder: '#1a1033', glow: 'rgba(106,44,240,0.16)',
};

// Dock: bare icons on a deep navy gradient with a soft green light, like a phone's dock.
const dockColors: Colors = {
  bg: '#06101a', panel: '#0c1826', panelRaised: '#12233a', pressed: '#1a2f4a', border: '#1d3047', borderStrong: '#2b4263',
  borderActive: '#456088', borderFocus: '#6fd3a8', text: '#f2f6fb', onAccent: '#06101a', muted: '#a9b6c8', faint: '#8795aa',
  accent: '#6fd3a8', mint: '#5ef0b8', onMint: '#03261a', red: '#ff7a90', blue: '#8fb4ff', artOpacity: 0.3, star: '#ffd166',
  warn: '#ffd166', warnFill: '#ffd166', warnBorder: '#4d4020', goodBg: '#0f1c1a', goodBorder: '#1f3b35', playingBorder: '#1f6b55',
  scrim: 'rgba(0,0,0,0.6)', tint: 'rgba(6,16,26,0.7)', float: 'rgba(12,24,38,0.9)', floatSoft: 'rgba(12,24,38,0.65)',
  glass: 'rgba(255,255,255,0.06)', glassBorder: 'rgba(255,255,255,0.14)', glow: 'rgba(111,211,168,0.3)',
};
const dockLight: Colors = {
  bg: '#eef2f8', panel: '#ffffff', panelRaised: '#f0f3f9', pressed: '#dfe6f1', border: '#d5dde9', borderStrong: '#c0cbdc',
  borderActive: '#8f9db5', borderFocus: '#0b5f43', text: '#0e1724', onAccent: '#ffffff', muted: '#44516a', faint: '#586680',
  accent: '#0b5f43', mint: '#0f7a55', onMint: '#ffffff', red: '#b4234a', blue: '#3657c7', artOpacity: 0.38, star: '#c98a00',
  warn: '#855000', warnFill: '#ffd166', warnBorder: '#e0b64a', goodBg: '#e6f6ef', goodBorder: '#b6e0cc', playingBorder: '#6cc2a0',
  scrim: 'rgba(14,23,36,0.35)', tint: 'rgba(238,242,248,0.7)', float: 'rgba(255,255,255,0.88)', floatSoft: 'rgba(255,255,255,0.65)',
  glass: 'rgba(255,255,255,0.55)', glassBorder: 'rgba(255,255,255,0.85)', glow: 'rgba(15,122,85,0.2)',
};

/** Each designed look's palette in light and in dark. */
export const LOOK_THEMES: Record<Exclude<Look, 'classic'>, Record<Scheme, Colors>> = {
  dock: { dark: dockColors, light: dockLight },
  studio: { dark: studioColors, light: studioLight },
  atelier: { dark: atelierDark, light: atelierColors },
  signal: { dark: signalColors, light: signalLight },
  glass: { dark: glassColors, light: glassLight },
  funk: { dark: funkColors, light: funkLight },
};

export function keyLook(look: Look, colors: Colors, scheme: Scheme): KeyLook {
  const light = scheme === 'light';
  switch (look) {
    case 'studio':
      return { radius: 12, borderWidth: 1, bg: colors.panel, border: light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)', shadow: light ? '0px 1px 2px rgba(0,0,0,0.06)' : 'inset 0px 1px 0px rgba(255,255,255,0.05)', ink: colors.text, labelSize: 13, labelWeight: '500', iconStroke: 1.5, motion: 'glide' };
    case 'atelier':
      return { radius: 3, borderWidth: 1, bg: colors.panel, border: colors.glassBorder, shadow: light ? '0px 1px 0px rgba(58,44,20,0.06)' : '0px 1px 0px rgba(0,0,0,0.3)', ink: colors.text, labelSize: 15, labelWeight: '500', font: 'serif', iconStroke: 1.2, motion: 'slow' };
    case 'signal':
      return { radius: 20, borderWidth: 1, bg: colors.panel, border: colors.glassBorder, ink: colors.text, labelSize: 11, labelWeight: '500', font: 'monospace', caps: true, tracking: 1.2, iconStroke: 2, motion: 'step' };
    case 'glass':
      return { radius: 20, borderWidth: 1, bg: colors.glass, border: colors.glassBorder, shadow: light ? '0px 8px 24px rgba(40, 50, 90, 0.12)' : '0px 8px 24px rgba(0, 0, 0, 0.35)', ink: colors.text, labelSize: 13, labelWeight: '600', iconStroke: 1.7, motion: 'spring', touchLight: light ? 'rgba(120, 140, 255, 0.35)' : 'rgba(205, 215, 255, 0.55)' };
    case 'dock':
      return { radius: 20, borderWidth: 0, bg: 'transparent', border: 'transparent', ink: colors.text, labelSize: 12, labelWeight: '500', iconStroke: 1.6, motion: 'spring', iconOnly: true };
    case 'funk':
      return { radius: 16, borderWidth: 3, bg: colors.panel, border: colors.glassBorder, shadow: `0px 5px 0px ${colors.glassBorder}`, ink: colors.text, labelSize: 13, labelWeight: '800', iconStroke: 2.2, motion: 'spring',
        tiles: [['#c6ff3d', '#16200a'], ['#3fd9ff', '#04202b'], ['#ff4fd8', '#2b0024'], ['#ffa53d', '#2a1500'], ['#d9ccff', '#1a1033']] };
    default:
      return { radius: 16, borderWidth: 1, bg: colors.glass, border: colors.glassBorder, ink: colors.text, labelSize: 13, labelWeight: '500', iconStroke: 1.7, motion: 'spring' };
  }
}

/** A screen title's type in a look, as on the PC: tight sans, serif display, or spaced monospace capitals. */
export type HeadingLook = { fontFamily?: string; fontSize: number; fontWeight: '400' | '500' | '600' | '700' | '800'; letterSpacing: number; textTransform?: 'uppercase' };

/** The deck's page card and media rail in a look: their corners, edges, lift, the page title's type and the page pips. */
export type SurfaceLook = {
  radius: number;
  border: number;
  /** A thicker bottom edge, Funk's hard drop shadow (Android draws no offset shadows). */
  base?: number;
  /** A soft shadow under the top card. */
  lift: boolean;
  title: HeadingLook;
  chipRadius: number;
  pip: { size: number; on: number; radius: number };
  railRadius: number;
  /** Media pucks' corner as a share of their size: 0.5 is round. */
  puck: number;
};

export function surfaceLook(look: Look): SurfaceLook {
  switch (look) {
    case 'studio':
      return { radius: 14, border: 1, lift: false, title: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 }, chipRadius: 6, pip: { size: 5, on: 14, radius: 3 }, railRadius: 14, puck: 0.26 };
    case 'atelier':
      return { radius: 4, border: 1, lift: false, title: { fontFamily: 'serif', fontSize: 24, fontWeight: '400', letterSpacing: -0.3 }, chipRadius: 2, pip: { size: 2, on: 22, radius: 0 }, railRadius: 4, puck: 0.08 };
    case 'signal':
      return { radius: 20, border: 1, lift: false, title: { fontFamily: 'monospace', fontSize: 12, fontWeight: '500', letterSpacing: 2.2, textTransform: 'uppercase' }, chipRadius: 999, pip: { size: 4, on: 4, radius: 0 }, railRadius: 999, puck: 0.5 };
    case 'funk':
      return { radius: 22, border: 3, base: 7, lift: false, title: { fontSize: 20, fontWeight: '800', letterSpacing: -0.4 }, chipRadius: 10, pip: { size: 9, on: 22, radius: 5 }, railRadius: 24, puck: 0.32 };
    case 'dock':
      return { radius: 28, border: 0, lift: false, title: { fontSize: 17, fontWeight: '600', letterSpacing: -0.2 }, chipRadius: 11, pip: { size: 6, on: 18, radius: 3 }, railRadius: 999, puck: 0.5 };
    case 'glass':
      return { radius: 28, border: 1, lift: true, title: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 }, chipRadius: 11, pip: { size: 6, on: 18, radius: 3 }, railRadius: 999, puck: 0.5 };
    default:
      return { radius: 28, border: 1, lift: true, title: { fontSize: 17, fontWeight: '700', letterSpacing: 0 }, chipRadius: 11, pip: { size: 6, on: 18, radius: 3 }, railRadius: 999, puck: 0.5 };
  }
}

export function headingLook(look: Look): HeadingLook {
  switch (look) {
    case 'studio': return { fontSize: 22, fontWeight: '600', letterSpacing: -0.5 };
    case 'atelier': return { fontFamily: 'serif', fontSize: 30, fontWeight: '400', letterSpacing: -0.4 };
    case 'signal': return { fontFamily: 'monospace', fontSize: 16, fontWeight: '500', letterSpacing: 2.4, textTransform: 'uppercase' };
    case 'glass': return { fontSize: 26, fontWeight: '700', letterSpacing: -0.6 };
    case 'funk': return { fontSize: 28, fontWeight: '800', letterSpacing: -0.6 };
    default: return { fontSize: 23, fontWeight: '600', letterSpacing: -0.3 };
  }
}

/** A button icon the PC saved as SVG was saved in the dark deck's light ink: it takes the theme's ink. */
export function inkIcon(svg: string, scheme: Scheme): string {
  return scheme === 'light' ? inkIconAs(svg, '#18181b') : svg;
}

/** The same icon in any ink, for a key whose surface is its own color. */
export const inkIconAs = (svg: string, ink: string) => svg.replace(/stroke="#f4f4f5"/gi, `stroke="${ink}"`);

/** Signal's dot grid (see wallpaper.tsx). */
export const backdrops: { signalDot: Record<Scheme, string>; dock: Record<Scheme, [string, string, string]> } = {
  signalDot: { dark: '#ffffff', light: '#000000' },
  // The dock's gradient: from, to and the corner glow.
  dock: { dark: ['#06101a', '#13233a', '#3f9c78'], light: ['#f2f5fa', '#d9e3f2', '#7fcfa8'] },
};

/** The phone wallpapers: three soft glows each, as color and where it sits (fractions of the screen). */
export const wallpaperGlows: Record<'aurora' | 'ember' | 'ocean' | 'forest', [string, number, number][]> = {
  aurora: [['#7c3aed', 0.15, 0.2], ['#06b6d4', 0.85, 0.45], ['#ec4899', 0.35, 0.9]],
  ember: [['#f97316', 0.2, 0.15], ['#e11d48', 0.8, 0.55], ['#facc15', 0.3, 0.95]],
  ocean: [['#2563eb', 0.2, 0.25], ['#14b8a6', 0.8, 0.6], ['#6366f1', 0.4, 0.95]],
  forest: [['#16a34a', 0.2, 0.2], ['#84cc16', 0.85, 0.5], ['#0d9488', 0.3, 0.9]],
};
