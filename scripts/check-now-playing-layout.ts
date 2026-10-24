// Run: node scripts/check-now-playing-layout.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nowPlayingLayout, phoneGridShape, widgetBlockSize, type WidgetSurface } from '../phone-app/src/now-playing-layout.ts';

assert.equal(
  readFileSync(new URL('../phone-app/src/now-playing-layout.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../pc-companion/src/now-playing-layout.ts', import.meta.url), 'utf8'),
  'phone-app and pc-companion copies of now-playing-layout.ts differ',
);

// Approximate widget areas: landscape immersive phones and tablet, plus the portrait list (100 px rows).
const surfaces: Record<string, WidgetSurface> = {
  proMax: { width: 790, height: 385, gap: 10, inset: 5, fixedRowHeight: null },
  se: { width: 603, height: 331, gap: 10, inset: 5, fixedRowHeight: null },
  android: { width: 851, height: 368, gap: 10, inset: 5, fixedRowHeight: null },
  ipad: { width: 1116, height: 756, gap: 10, inset: 5, fixedRowHeight: null },
  portrait: { width: 334, height: 0, gap: 9, inset: 5, fixedRowHeight: 100 },
};

const rowHeight = (layout: ReturnType<typeof nowPlayingLayout>) => ({
  title: layout.titleSize * 1.25, detail: layout.detailSize * 1.3, album: layout.detailSize * 1.3,
  progress: layout.barHeight + 2, times: layout.timeSize * 1.3, controls: layout.primaryControlSize,
});

let checked = 0;
for (const [name, surface] of Object.entries(surfaces)) {
  for (let columns = 1; columns <= 6; columns++) for (let rows = 1; rows <= 6; rows++) {
    for (let columnSpan = 1; columnSpan <= columns; columnSpan++) for (let rowSpan = 1; rowSpan <= rows; rowSpan++) {
      const { width, height } = widgetBlockSize(surface, columns, rows, columnSpan, rowSpan);
      const layout = nowPlayingLayout(width, height);
      const where = `${name} ${columns}x${rows} page, ${columnSpan}x${rowSpan} widget (${Math.round(width)}x${Math.round(height)})`;
      assert.ok(layout.show.includes('title'), `title hidden: ${where}`);
      if (layout.show.length > 1) {
        const heights = rowHeight(layout);
        const column = layout.show.reduce((sum, row) => sum + heights[row], 0) + layout.gap * (layout.show.length - 1);
        const art = layout.mode === 'row' ? 0 : layout.artSize + layout.gap;
        assert.ok(column + art + 2 * layout.padding <= height + 0.5, `rows overflow: ${where}`);
      }
      checked++;
    }
  }
}

// One-row strips show the same three lines as a 1x1.
assert.deepEqual(nowPlayingLayout(790, 48).show, ['title', 'detail', 'progress']);
assert.deepEqual(nowPlayingLayout(115, 48).show, ['title', 'detail', 'progress']);
// Big blocks stack.
assert.equal(nowPlayingLayout(780, 375).mode, 'stack');
// The desktop draws the grid in the phone's own proportions: upright 3x4 keys of 150 px are taller than wide.
assert.ok(phoneGridShape({ width: 360, height: 0, gap: 9, inset: 5, fixedRowHeight: 150, portrait: true }, 3, 4).aspect < 1);
assert.ok(Math.abs(phoneGridShape({ width: 790, height: 385, gap: 10, inset: 5, fixedRowHeight: null }, 3, 2).aspect - 790 / 385) < 1e-9);
console.log(`now-playing layout: ${checked} blocks ok`);
