// The Wallpaper widget's layouts. The ids match WALLPAPER_FACES on the PC side (src-tauri/src/lib.rs) and the
// phone's desktop-wallpaper-card.tsx.
export const WALLPAPER_FACES: [id: string, name: string, detail: string][] = [
  ['grid', 'Grid', 'Small pictures, two across, scroll down'],
  ['cards', 'Cards', 'Big pictures with their names, one per row'],
  ['carousel', 'Carousel', 'One big picture at a time, swipe sideways'],
];
export const DEFAULT_WALLPAPER_FACE = 'grid';
