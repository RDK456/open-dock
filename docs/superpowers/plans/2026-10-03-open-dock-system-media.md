# Open Dock System Media Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Spotify-specific starter and show live system-wide now-playing metadata and artwork in Open Dock's existing widget area on connected phones.

**Architecture:** A single Windows-native provider reads the system-selected Global System Media Transport Controls session and broadcasts a bounded live state over Open Dock's authenticated WebSocket. The desktop editor adds a built-in widget type, and the phone renders it with a Open Dock-owned adaptive card; no Spotify API credentials or runtime plugin code are involved.

**Tech Stack:** Rust + Tauri, Windows Runtime APIs through the existing `windows` crate, Axum WebSocket, React + TypeScript, Expo React Native.

**Spec:** `docs/superpowers/specs/2026-10-03-open-dock-system-media-design.md`

## Global Constraints

- First provider target is Windows; metadata is limited to apps publishing Windows Global System Media Transport Controls sessions.
- Do not add Spotify login, developer credentials, service-specific branding, or app-specific UI.
- Do not add player-specific controls or a provider scripting runtime.
- Live media state is in memory and separate from saved deck JSON, deck snapshots, and device navigation selection.
- Only send media state over authenticated paired-device connections.
- Bound artwork size and update frequency; missing metadata/artwork and native API errors must fall back safely.
- Keep the existing clock and plugin text widget JSON backward-compatible.
- Remove the bundled and installed Spotify sample without deleting saved deck layouts or unrelated plugins.
- Keep the Now Playing view Open Dock-owned, responsive, and consistent in normal, widget-only, and immersive landscape modes.
- Do not add or run automated test suites; use the project's build/type checks and the focused manual runtime checklist below.

## File Map

- Create `pc-companion/src-tauri/src/system_media.rs`: Windows-native session discovery, metadata/artwork extraction, snapshot comparison, and single monitor task.
- Modify `pc-companion/src-tauri/src/lib.rs`: module registration, retained shared media state, monitor startup, and authenticated WebSocket media-state publishing.
- Modify `pc-companion/src-tauri/Cargo.toml` and lockfile only if thumbnail stream reading or base64 encoding needs direct Windows/Rust dependencies.
- Modify `pc-companion/src/App.tsx` and `pc-companion/src/App.css`: built-in widget type, add/picker flow, and an attractive responsive editor preview styled with existing Open Dock tokens.
- Modify `phone-app/src/connection.tsx`: Now Playing deck widget type, live state contract, validation, and connection-context state.
- Modify `phone-app/src/app/(tabs)/index.tsx`: Open Dock-styled responsive renderer for normal and immersive widget canvases.
- Delete `pc-companion/plugins/opendock.spotify-controls/`: remove the Spotify-specific starter and its README/script.
- Remove the installed `opendock.spotify-controls` package from the current companion plugin directory if present; retain deck configuration data.

## Review Focus

1. **No session / unsupported media app:** the widget shows a stable Open Dock-owned empty state, not stale previous-track content or an error screen.
2. **Track/session switches:** title, artist, playback, source and artwork switch together; old artwork never appears with new metadata.
3. **Absent, invalid, or oversized artwork:** the text remains readable and the neutral artwork fallback is used.
4. **Connected-device boundaries:** unauthenticated sockets receive no media state; late/reconnected phones receive the latest state after authentication.
5. **Very small/tall/wide widget placements:** no text, cover art, or progress bar overflows in portrait, widget-only, or landscape immersive views.

---

### Task 1: Add the native Windows system-media provider

**Files:**
- Create: `pc-companion/src-tauri/src/system_media.rs`
- Modify: `pc-companion/src-tauri/src/lib.rs` only for module declaration, if needed
- Modify: `pc-companion/src-tauri/Cargo.toml` and `Cargo.lock` only for direct APIs actually used

**Interfaces:**
- Produces `SystemMediaState`, serializable as camelCase with optional `sourceAppId`, `title`, `artist`, `album`, `playbackState`, `positionMs`, `durationMs`, and `artworkDataUrl`.
- Produces `pub fn spawn_system_media_monitor(updates: tokio::sync::watch::Sender<SystemMediaState>)`, which starts one provider loop for the desktop process.
- Consumes the existing Windows Runtime dependency and emits an empty state on unsupported platforms.

- [ ] Define `SystemMediaState` with optional text/art/timeline data and a normalized playback state (`playing`, `paused`, `stopped`, or `unavailable`).
- [ ] Request `GlobalSystemMediaTransportControlsSessionManager` once, identify the OS-selected current session, and fetch its media properties and timeline.
- [ ] Read the thumbnail stream with a strict 512 KiB decoded cap; encode only valid image data as a data URL. If the thumbnail is absent, unreadable, or over cap, emit no artwork.
- [ ] Keep one monitoring task; refresh metadata/session selection on changes or a modest fallback interval, and position once per second only while playing.
- [ ] Compare snapshots before broadcasting: send track/art/source/artwork changes atomically, playback changes immediately, and bounded position-only updates.
- [ ] On no session or recoverable WinRT failure, broadcast a clean empty/unavailable state rather than retaining stale values.
- [ ] Use conditional compilation so macOS and other builds compile and return an empty/unavailable provider state without Windows APIs.
- [ ] Run `cargo fmt --check` and `cargo check` in `pc-companion/src-tauri`.

**Manual checks for this task:**
- With no media session, the provider emits the empty state.
- With a supported session, the state includes available metadata/art and normalized playback.
- Change track and session; the next snapshot contains a fully coherent new item.
- Force/observe an absent thumbnail; provider continues without failing.

### Task 2: Broadcast live media state through authenticated phone connections

**Files:**
- Modify: `pc-companion/src-tauri/src/lib.rs`

**Interfaces:**
- `AppState` owns a `watch::Sender<SystemMediaState>` so it retains the latest snapshot for late-joining phones; the monitor starts once at application setup.
- Authenticated clients receive `{ "type": "media_state", "state": { ... } }`.
- `phone-app/src/connection.tsx` will consume this message in Task 4.

- [ ] Add the watch channel to application state and start one system-media monitor when the Tauri app/server is initialized.
- [ ] Subscribe each WebSocket handler to the watch channel and send its retained latest state immediately after successful authentication.
- [ ] Forward later media updates only after authentication; use the watch receiver's coalesced latest value so a slow phone does not replay every intermediate position tick.
- [ ] Keep media messages independent from deck snapshots, shared navigation broadcasts, and per-device selection.
- [ ] Cap serialized message size consistently with the artwork limit; never let one invalid image prevent deck messages from working.
- [ ] Run `cargo fmt --check` and `cargo check` in `pc-companion/src-tauri`.

**Manual checks for this task:**
- A paired phone receives the current state on connect and changes while connected.
- A socket that has not authenticated receives no `media_state` payload.
- Several paired devices receive the same track update from one monitor.
- Navigation changes and deck edits continue to use their existing messages.

### Task 3: Add the built-in Now Playing widget to the desktop editor

**Files:**
- Modify: `pc-companion/src-tauri/src/lib.rs`
- Modify: `pc-companion/src/App.tsx`
- Modify: `pc-companion/src/App.css`

**Interfaces:**
- Add the serialized type `{ id: string; type: 'now_playing'; placement: DeckPlacement }` to the editor's `DeckWidget` union.
- Consumes the existing widget-area add, first-free placement, selection, delete, drag, and resize paths.
- Produces a built-in widget card preview; no plugin manifest or installed package is required.

- [ ] Add `NowPlaying` to Rust `DeckWidgetType`, validate it as a built-in with no plugin metadata, and extend the desktop TypeScript widget type while preserving all legacy clock/plugin shapes.
- [ ] Add **Now Playing** beside **Add clock** and ensure empty cells and the existing widget picker can create it through first-free placement.
- [ ] Render a polished editor preview using Open Dock colors and a neutral cover-art placeholder; show a hierarchy of artwork, sample title/artist, and progress only when cell dimensions can support them.
- [ ] Show selection and resizing with existing editor behavior; ensure labels stay legible and clipped/wrapped rather than changing grid placement.
- [ ] Keep add/delete/drag/resize and save behavior identical to existing built-in widgets.
- [ ] Run `npm run build` in `pc-companion`.

**Manual checks for this task:**
- Add, select, resize, move, save and delete Now Playing on an existing widget page.
- Reload the editor and confirm the widget type and placement persist.
- Existing clock and plugin text widgets remain editable.

### Task 4: Sync the media state into phone state

**Files:**
- Modify: `phone-app/src/connection.tsx`

**Interfaces:**
- `DeckWidget` includes the built-in `now_playing` variant.
- Connection context exposes `mediaState: SystemMediaState` to screens.
- The `media_state` WebSocket parser accepts optional metadata and an optional bounded image data URL, or discards malformed state without marking the whole connection invalid.

- [ ] Add and export phone-side `SystemMediaState` with the same optional fields and allowed playback literals as the desktop.
- [ ] Add `now_playing` to `DeckWidget` validation while preserving clock/plugin parsing and placement validation.
- [ ] Parse the separate `media_state` event safely; validate string lengths, finite non-negative timeline values, image prefix/size, and playback state.
- [ ] On malformed media data, retain or clear only media state safely; never set the entire deck connection to error.
- [ ] Do not write live media state or image bytes to SQLite KV storage or SecureStore.
- [ ] Run `npx tsc --noEmit` in `phone-app` (use the package manager already used by the repository).

### Task 5: Render the adaptive Open Dock-style Now Playing widget on the phone

**Files:**
- Modify: `phone-app/src/app/(tabs)/index.tsx`

**Interfaces:**
- `NowPlayingWidget` consumes `SystemMediaState`, a `DeckWidget` placement, and an immersive boolean.
- Render the same built-in widget from both standard widget grid and immersive widget grid code paths.

- [ ] Create one `NowPlayingWidget` component using existing colors, borders, spacing, and lucide icons; do not reproduce Spotify or Elgato artwork/UI.
- [ ] In wide/roomy placements, use artwork as an anchor beside title/artist and show playback progress/time when timeline data exists.
- [ ] In narrow/small/tall placements, use size-aware layout: crop/contain artwork safely, reduce text lines, and omit progress/source details before text or cover overflows.
- [ ] Use a tasteful Open Dock-branded neutral artwork fallback for no artwork/no session; clear old metadata immediately when the session is empty or changes.
- [ ] Keep artwork transitions and text updates atomic using stable track/session keys; do not allow stale image races.
- [ ] Render properly in widget-only mode and landscape immersive mode, preserving the existing responsive cell sizing and page swipes.
- [ ] Run `npx tsc --noEmit` in `phone-app`.

**Manual checks for this task:**
- View a live track in one-cell, wide, tall and multi-cell placements; verify no overflow.
- Check a missing image, missing title/artist, stopped session, and rapid track changes.
- Inspect portrait, widget-only, and immersive landscape layouts.

### Task 6: Remove the Spotify starter and verify the complete flow

**Files:**
- Delete: `pc-companion/plugins/opendock.spotify-controls/`
- Remove if present: the installed `opendock.spotify-controls` package under the current user's Open Dock plugin data directory
- Modify: any documentation/reference that specifically advertises the removed sample package

**Interfaces:**
- Existing saved deck data is retained.
- Generic Open Dock media actions remain available.
- A saved reference to the removed plugin is displayed as unavailable until the user replaces it.

- [ ] Search the repository for the removed plugin ID and Spotify-specific sample documentation; remove obsolete starter references without deleting general system media behavior.
- [ ] Remove only the verified `opendock.spotify-controls` package directory from the user's Open Dock plugin folder; preserve other plugins and all deck/configuration files.
- [ ] Confirm saved plugin references load and display an unavailable state; do not silently remove their buttons or widget placements.
- [ ] Run `git diff --check`, `cargo check`, `npm run build`, and `npx tsc --noEmit`; capture each exit result.
- [ ] Start or restart the desktop app and Expo mobile app. Keep both running for the user to test.
- [ ] Summarize supported media-session limits, launch status, and verification results; do not claim unsupported players provide artwork/metadata.

## Execution Notes

- Implement inline with `superpowers:executing-plans`; the desktop provider, WebSocket message, phone state and renderer share a small number of exact interfaces, so sequential integration is the quickest path.
- Do not use subagents; this task is an inline implementation.
- Make short commits at independently coherent points only after the relevant build checks pass; never stage unrelated pre-existing changes.
- Start both development apps at the end, as requested.
