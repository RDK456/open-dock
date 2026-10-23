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
 * The deck's look. Classic is the plain light or dark design above. The others are complete designs with their
 * own palette and key shape, each either light or dark by nature, so they ignore the light/dark choice.
 */
export type Look = 'classic' | 'console' | 'bento' | 'desk' | 'glass' | 'funk';
export const LOOKS: [Look, string][] = [['classic', 'Classic'], ['console', 'Console'], ['bento', 'Bento'], ['desk', 'Desk'], ['glass', 'Glass'], ['funk', 'Funk']];

export function parseLook(value: unknown): Look {
  return value === 'console' || value === 'bento' || value === 'desk' || value === 'glass' || value === 'funk' ? value : 'classic';
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
  /** Labels on a small backlit LCD strip, in monospace capitals. */
  lcd?: { bg: string; ink: string; edge: string; halo: string };
  /** Saturated blocks, one per key in turn, each with the ink that reads on it. */
  tiles?: [string, string][];
  /** A soft light that follows the finger across the key. */
  touchLight?: string;
};

// Hardware console: dark anodised metal, keys lit from behind with an amber LED edge, labels on green LCDs.
const consoleColors: Colors = {
  bg: '#141619', panel: '#1c1f23', panelRaised: '#24282d', pressed: '#2f343a', border: '#2c3136', borderStrong: '#3b4148',
  borderActive: '#56606a', borderFocus: '#6c7680', text: '#e9edf0', onAccent: '#1a1206', muted: '#9ba4ac', faint: '#727b84',
  accent: '#ffb547', mint: '#5cf2b0', onMint: '#04291a', red: '#ff6b5e', blue: '#5cc8ff', artOpacity: 0.3, star: '#ffb547',
  warn: '#ffb547', warnFill: '#ffb547', warnBorder: '#5a4316', goodBg: '#122019', goodBorder: '#1f3a2c', playingBorder: '#1d6b47',
  scrim: 'rgba(0,0,0,0.65)', tint: 'rgba(20,22,25,0.8)', float: 'rgba(28,31,35,0.95)', floatSoft: 'rgba(28,31,35,0.72)',
  glass: '#1f2327', glassBorder: '#33393f', glow: 'rgba(255,181,71,0.2)',
};

// Bold bento: saturated blocks and huge type on a cool off-white.
const bentoColors: Colors = {
  bg: '#ececf0', panel: '#ffffff', panelRaised: '#f6f6f8', pressed: '#e0e0e7', border: '#d9d9e1', borderStrong: '#c5c5d0',
  borderActive: '#9898a6', borderFocus: '#7d7d8a', text: '#111114', onAccent: '#ffffff', muted: '#474752', faint: '#686874',
  accent: '#1f3fd1', mint: '#00704a', onMint: '#ffffff', red: '#b8241a', blue: '#2f5bff', artOpacity: 0.38, star: '#d98f00',
  warn: '#8a5300', warnFill: '#ffb020', warnBorder: '#e8b54a', goodBg: '#e6f7ee', goodBorder: '#b0e4c8', playingBorder: '#7cd2a4',
  scrim: 'rgba(17,17,20,0.4)', tint: 'rgba(255,255,255,0.7)', float: 'rgba(255,255,255,0.95)', floatSoft: 'rgba(255,255,255,0.75)',
  glass: '#ffffff', glassBorder: '#d9d9e1', glow: 'rgba(47,91,255,0.12)',
};

// Brand desk: the app icon's world. Yellow ground, blue screen, red-striped desk, flat shapes with thick ink outlines.
const deskColors: Colors = {
  bg: '#ffd24a', panel: '#fff6d6', panelRaised: '#ffefbd', pressed: '#ffe17e', border: '#1b1b1b', borderStrong: '#1b1b1b',
  borderActive: '#1b1b1b', borderFocus: '#1d4ed8', text: '#1b1b1b', onAccent: '#ffffff', muted: '#4a3d14', faint: '#64531f',
  accent: '#1a44c2', mint: '#0e6a32', onMint: '#ffffff', red: '#a3200f', blue: '#1d4ed8', artOpacity: 0.3, star: '#d8341e',
  warn: '#7a3300', warnFill: '#d8341e', warnBorder: '#1b1b1b', goodBg: '#e8f6da', goodBorder: '#1b1b1b', playingBorder: '#147a3c',
  scrim: 'rgba(27,27,27,0.45)', tint: 'rgba(255,246,214,0.78)', float: 'rgba(255,246,214,0.97)', floatSoft: 'rgba(255,246,214,0.82)',
  glass: '#fff6d6', glassBorder: '#1b1b1b', glow: 'rgba(29,78,216,0.16)',
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

/** Each designed look's palette and whether it is light or dark. */
export const LOOK_THEMES: Record<Exclude<Look, 'classic'>, { colors: Colors; scheme: Scheme }> = {
  console: { colors: consoleColors, scheme: 'dark' },
  bento: { colors: bentoColors, scheme: 'light' },
  desk: { colors: deskColors, scheme: 'light' },
  glass: { colors: glassColors, scheme: 'dark' },
  funk: { colors: funkColors, scheme: 'dark' },
};

export function keyLook(look: Look, colors: Colors): KeyLook {
  switch (look) {
    case 'console':
      return { radius: 7, borderWidth: 1, bg: '#22262b', border: '#ffb547', shadow: '0px 0px 9px rgba(255, 181, 71, 0.45)', ink: '#e9edf0', labelSize: 10, labelWeight: '600', lcd: { bg: '#10221a', ink: '#7dffb6', edge: 'rgba(0, 0, 0, 0.6)', halo: 'rgba(125, 255, 182, 0.6)' } };
    case 'bento':
      return { radius: 22, borderWidth: 0, bg: '#ffffff', border: 'transparent', ink: '#111114', labelSize: 19, labelWeight: '800',
        tiles: [['#ff5a36', '#1a0700'], ['#2f5bff', '#ffffff'], ['#ffd23f', '#1d1600'], ['#00b37a', '#00170f'], ['#ff7ad9', '#2b0020'], ['#7b4dff', '#ffffff']] };
    case 'desk':
      return { radius: 14, borderWidth: 3, bg: '#ffffff', border: '#1b1b1b', shadow: '4px 5px 0px #1b1b1b', ink: '#1b1b1b', labelSize: 13, labelWeight: '700' };
    case 'glass':
      return { radius: 20, borderWidth: 1, bg: colors.glass, border: colors.glassBorder, shadow: '0px 8px 24px rgba(0, 0, 0, 0.35)', ink: colors.text, labelSize: 13, labelWeight: '600', touchLight: 'rgba(205, 215, 255, 0.55)' };
    case 'funk':
      return { radius: 16, borderWidth: 3, bg: '#251845', border: '#0b0618', shadow: '0px 5px 0px #0b0618', ink: '#fbf6ea', labelSize: 13, labelWeight: '800',
        tiles: [['#c6ff3d', '#16200a'], ['#3fd9ff', '#04202b'], ['#ff4fd8', '#2b0024'], ['#ffa53d', '#2a1500'], ['#d9ccff', '#1a1033']] };
    default:
      return { radius: 16, borderWidth: 1, bg: colors.glass, border: colors.glassBorder, ink: colors.text, labelSize: 13, labelWeight: '500' };
  }
}

/** A button icon the PC saved as SVG was saved in the dark deck's light ink: it takes the theme's ink. */
export function inkIcon(svg: string, scheme: Scheme): string {
  return scheme === 'light' ? inkIconAs(svg, '#18181b') : svg;
}

/** The same icon in any ink, for a key whose surface is its own color. */
export const inkIconAs = (svg: string, ink: string) => svg.replace(/stroke="#f4f4f5"/gi, `stroke="${ink}"`);

/** The colors of the Console and Desk backdrops (see wallpaper.tsx). */
export const backdrops = {
  metal: { top: '#23272c', bottom: '#101214', line: '#ffffff' },
  desk: { red: '#d8341e', cream: '#fff6d6', ink: '#1b1b1b' },
};

/** The phone wallpapers: three soft glows each, as color and where it sits (fractions of the screen). */
export const wallpaperGlows: Record<'aurora' | 'ember' | 'ocean' | 'forest', [string, number, number][]> = {
  aurora: [['#7c3aed', 0.15, 0.2], ['#06b6d4', 0.85, 0.45], ['#ec4899', 0.35, 0.9]],
  ember: [['#f97316', 0.2, 0.15], ['#e11d48', 0.8, 0.55], ['#facc15', 0.3, 0.95]],
  ocean: [['#2563eb', 0.2, 0.25], ['#14b8a6', 0.8, 0.6], ['#6366f1', 0.4, 0.95]],
  forest: [['#16a34a', 0.2, 0.2], ['#84cc16', 0.85, 0.5], ['#0d9488', 0.3, 0.9]],
};
