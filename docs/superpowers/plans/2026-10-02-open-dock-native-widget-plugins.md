# Open Dock-native plugin widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let installed Open Dock plugins provide configurable text widgets that can be placed on the existing desktop-edited widget grid and rendered by the phone app.

**Architecture:** Extend the current plugin manifest with declarative widget metadata and the current deck widget data with a backward-compatible plugin variant. The desktop editor configures instances and stores their placement/values; the phone receives the deck snapshot and renders a Open Dock-owned native text widget without executing plugin code.

**Tech Stack:** Rust + Serde/Tauri backend, React + TypeScript desktop editor, Expo React Native phone app.

**Spec:** `docs/superpowers/specs/2026-10-02-open-dock-native-widget-plugins-design.md`

## Global Constraints

- Keep existing `{ id, type: "clock", placement }` widget data valid and unchanged.
- Support at most 32 widget definitions per plugin and 16 inputs per widget.
- Reuse plugin ID and input validation/size limits; text widget inputs are configured as strings.
- Never execute plugin JavaScript, HTML, or native code on the phone.
- Do not import Elgato packages, add Marketplace compatibility, or add a new dependency.
- Keep the current widget grid, placement, resize, drag, and page swipe behavior.

## Review Focus

- Legacy clock widget JSON still deserializes and serializes with the same fields.
- A stale plugin ID does not prevent the phone from rendering saved text values; an unknown renderer displays a recoverable placeholder.
- Invalid widget IDs, unknown input keys, control characters, and oversized values are rejected at manifest/deck boundaries.
- Widget-only plugins install even when their `actions` list is empty; action-only plugins still install unchanged.
- Plugin removal is blocked when any page references its widget, including widget pages and legacy widget screens.

---

### Task 1: Extend manifest and deck widget models

**Files:**
- Modify: `pc-companion/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: current `OpenDockPluginManifest`, `OpenDockPluginAction`, `DeckWidget`, `validate_plugin_manifest`, plugin install/uninstall paths, and `validate_deck_config`.
- Produces: optional `OpenDockPluginManifest.widgets: Vec<OpenDockPluginWidget>`; `OpenDockPluginWidget { id, name, description, kind, inputs }`; backward-compatible `DeckWidget` plugin fields (`pluginId`, `widgetId`, `renderType`, `values`) while preserving the clock JSON shape.

- [ ] Add a default-empty top-level manifest `widgets` field and a metadata struct with `id`, `name`, optional `description`, `type` renamed to `kind`, and default-empty `inputs`.
- [ ] Validate no more than 32 widget definitions, unique valid IDs, valid labels/descriptions, `type == "text"`, at most 16 inputs, and valid input metadata/options using the same rules as action inputs.
- [ ] Permit widget-only packages by requiring at least one action or widget; keep the existing action count cap and script validation.
- [ ] Add optional plugin ID, widget definition ID, `renderType`, and string values to the existing widget struct with `skip_serializing_if = "Option::is_none"`, leaving clock serialization unchanged; plugin instances set `renderType` to `text`.
- [ ] Validate clock widgets have no plugin metadata; validate plugin widgets reference well-formed IDs/render type and cap values at 16 keys, 1 KiB per value, 8 KiB total, with no control characters. Validate declared keys and select values against the manifest in the desktop editor.
- [ ] Extend plugin-use detection so uninstall is refused while any normal widget page or legacy widget screen contains one of that plugin's widgets.
- [ ] Run `cargo fmt` and `cargo check` from `pc-companion/src-tauri`.

### Task 2: Add widget creation and configuration to the desktop editor

**Files:**
- Modify: `pc-companion/src/App.tsx`
- Modify: `pc-companion/src/App.css`

**Interfaces:**
- Consumes: installed plugin metadata from Task 1 and existing `DeckWidget`, grid placement, drag/resize, and selected-widget property panel flows.
- Produces: desktop widget picker entries from installed plugin definitions; a saved plugin widget instance with `{ id, type: "plugin", pluginId, widgetId, renderType: "text", values, placement }`.

- [x] Extend desktop manifest/widget types to match Task 1 while keeping the clock type.
- [x] Add a plugin-widget picker beside **Add clock**; disable entries when no free grid placement exists.
- [x] Create selected plugin widgets with default values and first-free-cell placement, using the existing `replaceWidgetScreen` path.
- [x] Render plugin widget previews in the editor canvas and select them through the existing widget selection state.
- [x] In widget settings, show plugin/widget labels and declared input controls; update only the selected widget's `values` while preserving placement and default missing values from its manifest definition.
- [x] Keep clock settings unchanged and include plugin widgets in referenced-plugin removal checks if that check is located in the editor.
- [x] Run `npm run build` from `pc-companion`.

### Task 3: Validate and render plugin widgets on the phone

**Files:**
- Modify: `phone-app/src/connection.tsx`
- Modify: `phone-app/src/deck-layout.ts`
- Modify: `phone-app/src/app/(tabs)/index.tsx`

**Interfaces:**
- Consumes: plugin widget metadata and saved instances from Tasks 1–2, existing widget occupancy and responsive grid layout.
- Produces: `DeckWidget` discriminated union for `clock` and `plugin`, snapshot validation for plugin widget values, and a Open Dock-owned text widget view that does not require the plugin manifest on the phone.

- [x] Update `DeckWidget` into a discriminated union while retaining the legacy `clock` shape.
- [x] Validate plugin widget instance IDs, plugin/widget identifiers, renderer string, string values, and placement; allow unknown renderer identifiers through snapshot parsing so the page can render a placeholder.
- [x] Render a responsive text card using `values.title` and `values.body` without plugin metadata; render a neutral unavailable card only for unknown renderers.
- [x] Keep widget page swipe, immersive rendering, widget-only mode, and clock rendering unchanged.
- [x] Run `npx tsc --noEmit` from `phone-app`.

### Task 4: Document the widget manifest and verify the integrated flow

**Files:**
- Modify: `pc-companion/docs/open-dock-plugin-format.md`

**Interfaces:**
- Consumes: manifest and deck shapes from Tasks 1–3.
- Produces: documented widget manifest example and limitations for plugin authors.

- [x] Add a complete manifest example defining a text widget with title and body inputs.
- [x] Document that widgets are rendered by Open Dock, do not run plugin code, and currently display static configured text; list dynamic providers as deferred.
- [x] Re-run `cargo check`, `npm run build`, `npx tsc --noEmit`, and `git diff --check`; read each command's result.
- [x] Confirm the desktop app and Expo server are still running for user testing; restart either app if it stopped.

## Execution Notes

- No automated test files or test commands are included because this task's repository instructions prohibit adding or running tests unless requested. The listed compile/build checks are required before claiming completion.
- Do not commit product changes unless the user asks. The design spec was committed separately before this plan.
