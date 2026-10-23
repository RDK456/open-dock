# Open Dock-native plugin widgets

## Goal

Let a Open Dock plugin contribute configurable widgets to the existing widget area on a deck page. Widgets must render consistently on Android, iOS, and iPadOS while keeping plugin code off the phone.

## First-version scope

- A plugin manifest may declare widget definitions independently from its button actions.
- Each widget definition selects a renderer implemented by Open Dock. The first supported renderer is `text`, with configurable title and body text. Clock remains a built-in widget.
- The desktop editor lists widgets from installed plugins, lets the user add one to a widget page, configure its declared text inputs, move it, and resize it using the existing grid controls.
- A saved widget instance contains its ID, plugin ID, widget definition ID, configured input values, and the existing grid placement.
- The phone receives widget instances through the existing deck snapshot and renders them with Open Dock-owned React Native components. It does not evaluate plugin JavaScript, HTML, or native code.
- Each saved instance carries its Open Dock renderer identifier, so the phone does not need installed plugin metadata to render it. If a renderer identifier is unknown to that phone version, it shows a neutral unavailable state and continues rendering the rest of the page.

## Data and manifest contract

- Keep `DeckWidget` backward-compatible with existing `{ id, type: "clock", placement }` values. Add a plugin-widget variant instead of changing clock serialization.
- Add an optional top-level `widgets` list to the plugin manifest. Each definition has `id`, `name`, optional `description`, `type: "text"`, and an `inputs` list. Each input has `id`, `label`, `type`, optional `default`, and `options` only for `select`.
- A text widget displays its configured title and body. The manifest declares those as inputs, which are saved as strings on the widget instance. Example:

  ```json
  {
    "widgets": [
      {
        "id": "note",
        "name": "Note",
        "type": "text",
        "inputs": [
          { "id": "title", "label": "Title", "type": "text", "default": "" },
          { "id": "body", "label": "Text", "type": "text", "default": "" }
        ]
      }
    ]
  }
  ```
- The saved plugin widget shape is `{ id, type: "plugin", pluginId, widgetId, renderType: "text", values, placement }`; `values` maps manifest input IDs to configured strings. The phone uses the included renderer identifier and values, not plugin code or installed manifest metadata.
- Plugin widget IDs and input IDs use the existing Open Dock plugin ID validation. Inputs reuse the existing `text`, `number`, and `select` contract and the same size limits.
- A plugin may declare up to 32 widget definitions, and each widget may declare up to 16 inputs.
- On the desktop, reject unknown input fields, oversized values, invalid select choices, and grid collisions through the existing validation paths. On the phone, accept the self-contained renderer and values without requiring plugin metadata; an unavailable plugin ID does not prevent rendering the saved text.
- Plugin widget definitions are metadata only. The first version does not run a provider process, fetch remote data, or execute code while rendering a widget.

## Installation and editor flow

- Open Dock installs widget definitions from the same local plugin manifest as plugin actions, using the current installer and plugin folder model.
- The desktop editor's widget canvas adds a plugin-widget picker beside **Add clock**. Choosing an item creates a configured instance at the first available cell; the existing drag and resize behavior remains unchanged.
- Selecting an instance shows its plugin name, widget name, declared input fields, and a remove control. Removing the plugin remains blocked while any deck references one of its actions or widgets.
- Existing decks and plugins with no `widgets` manifest property continue to load unchanged.

## Phone behavior

- The widget area uses the existing page layout and swipe model. Plugin widgets take the configured grid placement and do not alter button rows or columns.
- Text widgets use responsive typography, clipping/wrapping rules, and the existing widget card style. Unknown renderers use a recoverable placeholder without invalidating the complete deck snapshot.
- Widget values and plugin metadata are not treated as executable input by the phone.

## Security and privacy

- Continue running plugin scripts only on the PC after the existing per-button permission is enabled. Plugin widgets in this version do not execute scripts.
- Do not support password/secret inputs, arbitrary HTML, JavaScript bundles, remote code, Marketplace packages, or Elgato `.streamDeckPlugin` files.
- Validate manifest metadata and deck values at installation and deserialization boundaries. Limit widget definitions per plugin and input count/size using the action limits.

## Acceptance criteria

1. An installed Open Dock plugin can declare a text widget with labeled configurable fields.
2. The desktop editor can add/configure/remove that widget and place/resize it with the current widget-grid editor.
3. The saved deck syncs the instance to a phone; Android and iOS render it using the same native Open Dock widget layout without requiring plugin installation on the phone.
4. Legacy clock widgets and plugins without widget declarations still load and sync.
5. Removing a referenced plugin is blocked; uninstalling an unreferenced plugin still works.
6. Malformed or oversized widget definitions/values are rejected without breaking other installed plugins or the deck editor; unsupported renderer identifiers show a placeholder.

## Deferred

Dynamic data providers, refresh scheduling, interactive plugin widgets, custom renderer code, plugin networking, Marketplace compatibility, and Elgato package support are separate follow-up designs. Dynamic data will need an explicit desktop-side execution and phone update lifecycle.

## Legal/product boundary

This is an independent Open Dock format with Open Dock-owned renderer components and original UI. It does not implement Elgato protocol compatibility or import third-party Marketplace plugins. Any later compatibility project remains subject to written clearance and applicable legal review.
