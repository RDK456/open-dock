import type { DeckButton, DeckPlacement, DeckWidget } from './connection';

type PlacedItem = { id: string; placement?: DeckPlacement };

// Anything drawn on a grid: a page, or a folder opened from it.
export type DeckSurface = { rows: number; columns: number; buttons: DeckButton[]; widgets: DeckWidget[] };

export function buttonPlacement(columns: number, button: DeckButton, index: number): DeckPlacement {
  if (button.placement) return button.placement;
  return { row: Math.floor(index / columns), column: index % columns, rowSpan: 1, columnSpan: 1 };
}

function validLayout(rows: number, columns: number, items: PlacedItem[], allowRowMajorFallback = false): boolean {
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || items.length > rows * columns) return false;
  const occupied = new Set<number>();
  for (const [index, item] of items.entries()) {
    const placement = item.placement ?? (allowRowMajorFallback ? { row: Math.floor(index / columns), column: index % columns, rowSpan: 1, columnSpan: 1 } : undefined);
    if (!placement || ![placement.row, placement.column, placement.rowSpan, placement.columnSpan].every(Number.isInteger) ||
        placement.row < 0 || placement.column < 0 || placement.rowSpan < 1 || placement.columnSpan < 1 ||
        placement.row + placement.rowSpan > rows || placement.column + placement.columnSpan > columns) return false;
    for (let row = placement.row; row < placement.row + placement.rowSpan; row++) {
      for (let column = placement.column; column < placement.column + placement.columnSpan; column++) {
        const cell = row * columns + column;
        if (occupied.has(cell)) return false;
        occupied.add(cell);
      }
    }
  }
  return true;
}

export function validSurfaceLayout(surface: DeckSurface): boolean {
  const items = [...surface.buttons, ...surface.widgets] as PlacedItem[];
  return validLayout(surface.rows, surface.columns, items, true);
}

export type SurfaceItem = { type: 'button'; button: DeckButton } | { type: 'widget'; widget: DeckWidget };

// Which item covers each cell (row * columns + column) of the grid.
export function surfaceOccupancy(surface: DeckSurface): Map<number, SurfaceItem> {
  const occupied = new Map<number, SurfaceItem>();
  const cover = (placement: DeckPlacement, item: SurfaceItem) => {
    for (let row = placement.row; row < placement.row + placement.rowSpan; row++) {
      for (let column = placement.column; column < placement.column + placement.columnSpan; column++) occupied.set(row * surface.columns + column, item);
    }
  };
  surface.buttons.forEach((button, index) => cover(buttonPlacement(surface.columns, button, index), { type: 'button', button }));
  surface.widgets.forEach((widget) => cover(widget.placement, { type: 'widget', widget }));
  return occupied;
}

/**
 * How far, in cells, to shift a page so the area its items cover sits in the middle of the grid. Empty rows or
 * columns along one edge then no longer leave everything pushed to a corner.
 */
export function centeringShift(surface: DeckSurface): { rows: number; columns: number } {
  let minRow = Infinity, maxRow = -1, minColumn = Infinity, maxColumn = -1;
  const take = (placement: DeckPlacement) => {
    minRow = Math.min(minRow, placement.row);
    maxRow = Math.max(maxRow, placement.row + placement.rowSpan - 1);
    minColumn = Math.min(minColumn, placement.column);
    maxColumn = Math.max(maxColumn, placement.column + placement.columnSpan - 1);
  };
  surface.buttons.forEach((button, index) => take(buttonPlacement(surface.columns, button, index)));
  surface.widgets.forEach((widget) => take(widget.placement));
  if (maxRow < 0) return { rows: 0, columns: 0 };
  return { rows: (surface.rows - 1 - maxRow - minRow) / 2, columns: (surface.columns - 1 - maxColumn - minColumn) / 2 };
}
