import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';

export type ShortcutIcon = 'command' | 'monitor' | 'music' | 'mic' | 'headphones' | 'app-window';
export type CustomShortcut = { id: string; label: string; icon?: ShortcutIcon } & (
  | { type?: 'hotkey'; keys: string[] }
  | { type: 'launch_app'; app: string }
  | { type: 'sequence'; steps: string[][] }
);
export type DeckPage = { id: string; name: string; shortcuts: CustomShortcut[] };

const PAGES_KEY = 'opendock.deck-pages';
const ACTIVE_PAGE_KEY = 'opendock.active-deck-page';
const LEGACY_KEYS = ['opendock.custom-shortcuts', 'decklink.custom-shortcuts'];

function validPages(value: unknown): value is DeckPage[] {
  return Array.isArray(value) && value.length > 0 && value.every((page) =>
    page && typeof page.id === 'string' && typeof page.name === 'string' && Array.isArray(page.shortcuts),
  );
}

export async function loadDeckPages(): Promise<DeckPage[]> {
  const saved = await Storage.getItem(PAGES_KEY);
  if (saved) {
    try {
      const parsed: unknown = JSON.parse(saved);
      if (validPages(parsed)) {
        await SecureStore.deleteItemAsync(PAGES_KEY);
        return parsed;
      }
    } catch {
      // Recover from the previous secure-storage copy or shortcut-only data.
    }
    await Storage.removeItem(PAGES_KEY);
  }

  const previousPages = await SecureStore.getItemAsync(PAGES_KEY);
  if (previousPages) {
    try {
      const parsed: unknown = JSON.parse(previousPages);
      if (validPages(parsed)) {
        await Storage.setItem(PAGES_KEY, JSON.stringify(parsed));
        await SecureStore.deleteItemAsync(PAGES_KEY);
        return parsed;
      }
    } catch {
      // Recover from shortcut-only data below.
    }
    await SecureStore.deleteItemAsync(PAGES_KEY);
  }

  let shortcuts: CustomShortcut[] = [];
  for (const key of LEGACY_KEYS) {
    const legacy = await SecureStore.getItemAsync(key);
    if (!legacy) continue;
    try {
      const parsed: unknown = JSON.parse(legacy);
      if (Array.isArray(parsed)) shortcuts = parsed as CustomShortcut[];
    } catch {
      // Ignore invalid legacy data and start with an empty page.
    }
    await SecureStore.deleteItemAsync(key);
  }
  const pages = [{ id: 'default', name: 'Default', shortcuts }];
  await saveDeckPages(pages);
  return pages;
}

export async function saveDeckPages(pages: DeckPage[]) {
  await Storage.setItem(PAGES_KEY, JSON.stringify(pages));
  await SecureStore.deleteItemAsync(PAGES_KEY);
}

export async function loadActivePageId() {
  const saved = await Storage.getItem(ACTIVE_PAGE_KEY);
  if (saved) {
    await SecureStore.deleteItemAsync(ACTIVE_PAGE_KEY);
    return saved;
  }
  const previous = await SecureStore.getItemAsync(ACTIVE_PAGE_KEY);
  if (previous) {
    await Storage.setItem(ACTIVE_PAGE_KEY, previous);
    await SecureStore.deleteItemAsync(ACTIVE_PAGE_KEY);
  }
  return previous;
}

export async function saveActivePageId(id: string) {
  await Storage.setItem(ACTIVE_PAGE_KEY, id);
  await SecureStore.deleteItemAsync(ACTIVE_PAGE_KEY);
}
