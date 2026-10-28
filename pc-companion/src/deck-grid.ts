// The grid arithmetic behind the Deck editor: where an item sits, what fits, and where a new item goes.
// Kept apart from the editor so scripts/check-deck-grid.ts can test it.
export type Placement = { row: number; column: number; rowSpan: number; columnSpan: number };
export type GridButton = { id: string; placement?: Placement };
export type GridWidget = { id: string; placement: Placement };
export type GridScreen = { rows: number; columns: number; buttons: GridButton[]; widgets: GridWidget[] };

export function buttonPlacement(page: { columns: number; buttons: GridButton[] }, button: GridButton): Placement {
  if (button.placement) return button.placement;
  const index = page.buttons.findIndex((item) => item.id === button.id);
  return { row: Math.floor(index / page.columns), column: index % page.columns, rowSpan: 1, columnSpan: 1 };
}

export function swapPlacements(rows: number, columns: number, items: { id: string; placement: Placement }[], firstId: string, secondId: string): Map<string, Placement> | null {
  const first = items.find((item) => item.id === firstId)?.placement;
  const second = items.find((item) => item.id === secondId)?.placement;
  if (!first || !second || firstId === secondId) return null;
  const placements = items.map((item) => ({
    id: item.id,
    placement: item.id === firstId ? { ...first, row: second.row, column: second.column }
      : item.id === secondId ? { ...second, row: first.row, column: first.column }
        : item.placement,
  }));
  const fits = placements.every(({ placement }, index) => placement.row >= 0 && placement.column >= 0 && placement.row + placement.rowSpan <= rows && placement.column + placement.columnSpan <= columns &&
    placements.slice(index + 1).every(({ placement: other }) => placement.row >= other.row + other.rowSpan || other.row >= placement.row + placement.rowSpan || placement.column >= other.column + other.columnSpan || other.column >= placement.column + placement.columnSpan));
  return fits ? new Map(placements.map((item) => [item.id, item.placement])) : null;
}

export function canPlaceWidgetItem(screen: GridScreen, itemId: string, placement: Placement): boolean {
  if (![placement.row, placement.column, placement.rowSpan, placement.columnSpan].every(Number.isInteger) ||
      placement.row < 0 || placement.column < 0 || placement.rowSpan < 1 || placement.columnSpan < 1 ||
      placement.row + placement.rowSpan > screen.rows || placement.column + placement.columnSpan > screen.columns) return false;
  const items = [
    ...screen.buttons.map((button) => ({ id: button.id, placement: buttonPlacement(screen, button) })),
    ...screen.widgets.map((widget) => ({ id: widget.id, placement: widget.placement })),
  ];
  return items.every((item) => item.id === itemId ||
    placement.row >= item.placement.row + item.placement.rowSpan || item.placement.row >= placement.row + placement.rowSpan ||
    placement.column >= item.placement.column + item.placement.columnSpan || item.placement.column >= placement.column + placement.columnSpan);
}

export function firstWidgetPlacement(screen: GridScreen, rowSpan = 1, columnSpan = 1): Placement | null {
  for (let row = 0; row <= screen.rows - rowSpan; row++) {
    for (let column = 0; column <= screen.columns - columnSpan; column++) {
      const placement = { row, column, rowSpan, columnSpan };
      if (canPlaceWidgetItem(screen, '', placement)) return placement;
    }
  }
  return null;
}

export function defaultSpan(kind: string): { rows: number; columns: number } {
  if (kind === 'clock') return { rows: 1, columns: 2 };
  if (kind === 'now_playing') return { rows: 2, columns: 2 };
  if (kind === 'lyrics') return { rows: 2, columns: 3 };
  if (kind === 'pet') return { rows: 2, columns: 2 };
  return { rows: 1, columns: 1 };
}

export function fitPlacement(screen: GridScreen, want: { rows: number; columns: number }, at: { row: number; column: number } | null): Placement | null {
  const sizes: { rows: number; columns: number }[] = [];
  for (let rows = Math.min(want.rows, screen.rows); rows >= 1; rows--) {
    for (let columns = Math.min(want.columns, screen.columns); columns >= 1; columns--) sizes.push({ rows, columns });
  }
  sizes.sort((a, b) => b.rows * b.columns - a.rows * a.columns);
  for (const size of sizes) {
    const placement = at ? { row: at.row, column: at.column, rowSpan: size.rows, columnSpan: size.columns } : firstWidgetPlacement(screen, size.rows, size.columns);
    if (placement && canPlaceWidgetItem(screen, '', placement)) return placement;
  }
  return null;
}
