// Shared with pc-companion/src/now-playing-layout.ts. Keep the two files identical:
// scripts/check-now-playing-layout.ts fails when they differ.

export type NowPlayingRow = 'title' | 'detail' | 'album' | 'progress' | 'times' | 'controls';
export type NowPlayingMode = 'compact' | 'stack' | 'row';
export type NowPlayingLayout = {
  mode: NowPlayingMode;
  scale: number;
  padding: number;
  gap: number;
  artSize: number;
  columnWidth: number;
  show: NowPlayingRow[];
  volumeButton: boolean;
  titleSize: number;
  detailSize: number;
  timeSize: number;
  barHeight: number;
  controlSize: number;
  primaryControlSize: number;
};

const BASE = { pad: 10, gap: 6, title: 15, detail: 11, time: 9, bar: 4, ctl: 32, ctlMain: 40, art: 56 };
const DROP: NowPlayingRow[] = ['album', 'times', 'progress', 'controls', 'detail'];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function sized(mode: NowPlayingMode, scale: number, padding: number, gap: number, artSize: number, columnWidth: number, show: NowPlayingRow[]): NowPlayingLayout {
  return {
    mode, scale, padding, gap, artSize, columnWidth, show,
    // The volume button joins the controls row only when four buttons fit across.
    volumeButton: show.includes('controls') && columnWidth >= 150,
    titleSize: BASE.title * scale,
    detailSize: BASE.detail * scale,
    timeSize: BASE.time * scale,
    barHeight: BASE.bar * scale,
    controlSize: Math.max(26, BASE.ctl * scale),
    primaryControlSize: Math.max(30, BASE.ctlMain * scale),
  };
}

// Picks how a Now Playing widget fills a block of the given size in px. Both the
// phone widget and the desktop preview render from this result, so they match.
export function nowPlayingLayout(width: number, height: number): NowPlayingLayout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const mode: NowPlayingMode = w < 140 && h >= 90 ? 'compact' : h >= 280 || (h >= 200 && w / h <= 1.7) ? 'stack' : 'row';
  // Scale follows the area, but never more than the height allows, so wide strips don't blow up.
  const s0 = clamp(Math.min(Math.sqrt(w * h) / 170, h / 110), 0.75, 2.4);
  let show: NowPlayingRow[] = mode === 'compact' ? ['title', 'detail', 'progress'] : mode === 'row' ? ['title', 'detail', 'progress', 'times', 'controls'] : ['title', 'detail', 'album', 'progress', 'times', 'controls'];
  // A short, wide strip (one grid row) keeps title, artist and progress, like a 1x1, and gives up the controls first.
  const strip = mode === 'row' && h < 90 && w / h >= 3;
  const order: NowPlayingRow[] = strip ? ['times', 'controls', 'detail', 'progress'] : DROP;
  while (true) {
    for (const s of [s0, Math.max(0.75, s0 * 0.9), Math.max(0.75, s0 * 0.8)]) {
      // Very short blocks (a 1x1 on a 6-row page is ~46 px) tighten padding and gaps so three lines still fit.
      const pad = Math.min(BASE.pad * s, h * 0.1);
      const gap = Math.min(BASE.gap * s, h * 0.06);
      const art = mode === 'row' ? clamp(h - 2 * pad, 28, (w - 2 * pad) * 0.34) : mode === 'compact' ? clamp(Math.min(w * 0.6, h * 0.38), 20, 64) : 0;
      const columnWidth = mode === 'row' ? w - 2 * pad - art - gap : w - 2 * pad;
      const rows = show.filter((row) => row !== 'controls' || columnWidth >= 110);
      const rowHeight: Record<NowPlayingRow, number> = { title: BASE.title * s * 1.25, detail: BASE.detail * s * 1.3, album: BASE.detail * s * 1.3, progress: BASE.bar * s + 2, times: BASE.time * s * 1.3, controls: Math.max(30, BASE.ctlMain * s) };
      const columnHeight = rows.reduce((sum, row) => sum + rowHeight[row], 0) + gap * (rows.length - 1);
      const minArt = mode === 'stack' ? Math.max(40, h * 0.28) : 28;
      const room = mode === 'row' ? h - 2 * pad : mode === 'compact' ? h - 2 * pad - art - gap : h - 2 * pad - gap - minArt;
      if (columnHeight <= room) {
        const artSize = mode === 'stack' ? clamp(h - 2 * pad - gap - columnHeight, minArt, (w - 2 * pad) * 0.62) : art;
        return sized(mode, s, pad, gap, artSize, columnWidth, rows);
      }
    }
    const next = order.find((row) => show.includes(row));
    if (!next) {
      // Nothing left to drop: the title and art at the smallest scale.
      const pad = Math.min(BASE.pad * 0.75, h * 0.08);
      const gap = BASE.gap * 0.75;
      const art = clamp(Math.min(w, h) * 0.38, 18, 40);
      return sized(mode, 0.75, pad, gap, art, mode === 'row' ? w - 2 * pad - art - gap : w - 2 * pad, show);
    }
    show = show.filter((row) => row !== next);
  }
}

// The phone's widget area, as reported to the desktop so its preview can size blocks the same way.
export type WidgetSurface = { width: number; height: number; gap: number; inset: number; fixedRowHeight: number | null; portrait?: boolean };

// Pixel size of a widget's content box for a span, given the grid the phone displays.
export function widgetBlockSize(surface: WidgetSurface, columns: number, rows: number, columnSpan: number, rowSpan: number) {
  const cellWidth = (surface.width - surface.gap * (columns - 1)) / Math.max(1, columns);
  const cellHeight = surface.fixedRowHeight ?? (surface.height - surface.gap * (rows - 1)) / Math.max(1, rows);
  return {
    width: Math.max(1, columnSpan * cellWidth + (columnSpan - 1) * surface.gap - 2 * surface.inset),
    height: Math.max(1, rowSpan * cellHeight + (rowSpan - 1) * surface.gap - 2 * surface.inset),
  };
}

// The whole grid as the phone draws it (width over height), and whether the phone is held upright.
export function phoneGridShape(surface: WidgetSurface, columns: number, rows: number) {
  const grid = widgetBlockSize(surface, columns, rows, columns, rows);
  return { aspect: (grid.width + 2 * surface.inset) / (grid.height + 2 * surface.inset), portrait: surface.portrait === true };
}
