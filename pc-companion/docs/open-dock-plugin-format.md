# Open Dock plugin format (v1)

Open Dock plugins are locally installed packages that add named script actions to a deck. This format is independent of Elgato's SDK and `.streamDeckPlugin` packages.

## Folder layout

```text
my-open-dock-plugin/
  manifest.json
  scripts/
    open-calculator.ps1
```

On macOS, use a `.sh` or `.py` script. Windows supports `.ps1` and `.py`. The script must be in the package's `scripts/` folder; nested paths, symlinks, and external files are rejected.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "example.open-calculator",
  "name": "Open Calculator",
  "version": "1.0.0",
  "description": "A small example Open Dock plugin.",
  "actions": [
    {
      "id": "open-calculator",
      "name": "Open calculator",
      "description": "Launches the built-in calculator.",
      "script": "scripts/open-calculator.ps1",
      "inputs": [
        { "id": "query", "label": "Search query", "type": "text", "default": "" },
        { "id": "limit", "label": "Result limit", "type": "number", "default": "5" },
        { "id": "mode", "label": "Mode", "type": "select", "options": ["quick", "full"], "optionLabels": ["Quick", "Full"], "default": "quick" }
      ]
    }
  ]
}
```

The manifest is UTF-8 JSON, at most 64 KiB. It may define 1–32 actions and up to 32 widgets; at least one action or widget is required. IDs contain only letters, numbers, dots, underscores, or hyphens and are limited to 64 characters. Names are required; descriptions are optional. Each referenced script is limited to 1 MiB. Open Dock copies only the manifest and referenced scripts when installing.

Each action may define up to 16 inputs. Input IDs use the same ID format. Supported types are `text`, `number`, and `select`; select inputs require 1–32 unique options. Optional `optionLabels` provide user-facing names in the same order as `options`. The editor stores each action's values in the deck. At run time Open Dock passes one argument per input to the script in manifest order, using the configured value or its default. Values are passed as process arguments and are never concatenated into a shell command. Input values are limited to 1 KiB each and 8 KiB total. Password and secret inputs are not supported.

## Text widgets

Widgets are declarative and rendered by Open Dock; they do not run plugin code. The first renderer is `text`, which displays configured `title` and `body` strings. Declare those as normal inputs so the desktop editor can configure them:

```json
{
  "schemaVersion": 1,
  "id": "example.note-widget",
  "name": "Note Widget",
  "version": "1.0.0",
  "description": "A static text widget.",
  "actions": [],
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

Widget inputs use the same `text`, `number`, and `select` types and size limits as action inputs. The desktop stores the configured strings and grid placement in the deck snapshot; the phone renders those values using Open Dock's native text widget. Widgets with an unknown renderer show an unavailable placeholder. Dynamic data providers, network access, and executable widget code are not supported.

## Permissions and execution

After installation, choose the plugin action in a button's **Action** menu. Each button starts with execution disabled; enable its explicit permission checkbox before a paired phone can trigger it. Scripts run as the signed-in desktop user and are not sandboxed. Open Dock does not bypass the operating system's script policy, and plugin code may access anything that user can access. Install only code you trust.

The installer accepts a folder, not an Elgato package. It does not access a marketplace, load a third-party plugin binary, or accept DRM-protected packages. Open Dock widgets are limited to the declared renderers shipped in Open Dock; there is no network/plugin lifecycle API or plugin marketplace.
