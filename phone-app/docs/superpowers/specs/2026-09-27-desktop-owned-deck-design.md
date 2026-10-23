# Open Dock Desktop-Owned Deck Design

**Status:** Proposed for review

**Date:** 2026-09-27

## Summary

Open Dock will use the desktop companion as the authoritative deck editor and action runner. The phone will display the selected PC's deck and send control requests. The Connect tab will be redesigned while retaining QR pairing, manual setup, saved PCs, connection status/retry, and Android USB setup.

This follows Elgato's mobile model: its desktop software manages mobile actions and profiles, while Smart Profiles can change the active profile when an associated application becomes focused.

## Current state and reason for change

The phone currently saves pages, icons, launch targets, and keyboard sequences locally. On a tap, it sends the selected action payload to the desktop. The desktop executes that supplied payload. That makes each phone a separate configuration source and makes launch targets platform-dependent on the phone's knowledge of the PC.

The intended boundary is:

```text
Desktop editor -> PC-owned profiles/actions -> authenticated local connection -> phone deck view
Phone tap(button ID) -> PC resolves configured action -> Windows/macOS executes -> result/state -> phone
```

## Goals

- Make each PC's saved profiles, pages, button assignments, labels, icons, order, and action settings authoritative.
- Keep the phone deck and PC preview synchronized with the selected PC.
- Resolve and execute app launches and action sequences on the PC using its operating-system-specific targets.
- Support a broad set of Stream Deck keypad actions through direct compatibility when possible and Open Dock-built functional equivalents when a plugin cannot run in Open Dock.
- Make it straightforward to create and configure PC-local custom script actions.
- Improve the phone's Connect flow and layout without losing existing pairing and reconnect capabilities.
- Keep the existing Wi-Fi and Android USB transports and pairing workflow.
- Preserve the existing pairing/security model while redesigning the Connect tab.
- Maintain the current simple dark Open Dock/shadcn-inspired visual style and Lucide icon set.
- Retain one-time migration for decks currently saved on a phone.

## Not in scope

- Cloud accounts, remote Internet relay, or cloud synchronization.
- iPhone USB control.
- Editing profile definitions on the phone.
- Bypassing DRM, encryption, package integrity checks, or access controls for Elgato Marketplace downloads.
- Promising support for every third-party plugin or for dial/encoder hardware features that the phone does not provide.
- Running plugin code or scripts on the phone or directly from network-supplied source text.

## Ownership and data model

The desktop companion owns a versioned `DeckConfig` with profiles, pages, buttons, and the active profile/page. One Rust-owned state instance is shared by the desktop's Tauri commands and the WebSocket server, so local edits and remote reads use the same config. A button contains a stable ID, display label, Lucide icon key, and an action definition. Core action types are media control, keyboard shortcut, app launch, sequence, and profile/page navigation. Existing six media controls become ordinary configured buttons in the default profile rather than being separately hard-coded into the phone. Plugin and custom script actions are added only in their later phases, after the core protocol is stable.

An app launch action stores an application identity/target for the host platform. It may include per-platform target mappings for a profile shared through a future export/import feature, but a local profile must always resolve to an installed app on its own PC. The desktop editor supplies the app target; no path is sent from the phone at invocation time.

Sequences are configured on the desktop as ordered supported action steps. They execute on the PC, stop and report an error when a step fails, and have a bounded number of steps. They may contain approved built-in, plugin, or script actions; nested sequences are excluded initially.

## Elgato compatibility and Open Dock actions

The compatibility target is the Elgato Stream Deck SDK's key-based action model: plugin/action metadata, action settings, lifecycle and key-press events, dynamic title/image/state updates, and property-inspector configuration. Open Dock advertises a keypad-like virtual device to compatible plugins. Encoder/dial-only actions cannot be represented directly by the current phone deck and remain unsupported unless a useful tap/gesture mapping can be implemented without misleading behavior.

The PC companion will have a plugin catalog and install/import flow. It will validate a plugin manifest, show publisher/source and requested capabilities, and run compatible plugin processes on the PC. The catalog will show whether a Marketplace action is direct-compatible, has a Open Dock equivalent, or is unsupported, and can link to the official listing. The direct compatibility path targets `.streamDeckPlugin` packages that are accessible, permitted for this use, and can run against Open Dock's supported host surface. Plugins that depend on private Stream Deck software, physical hardware, unsupported native extensions, or inaccessible Marketplace packaging are not considered compatible merely because their manifest can be read.

For high-demand Marketplace features that cannot run directly, Open Dock will provide independently implemented Open Dock actions under Open Dock's own naming and assets, using public service APIs or documented operating-system interfaces. Do not copy proprietary plugin source, artwork, package contents, or marketplace pages. Direct Marketplace browsing/install or distribution of third-party packages remains conditional on Elgato's written clarification and applicable publisher rights. A Open Dock catalog can instead link to Elgato's listing and offer a clearly labeled Open Dock equivalent when available.

Compatibility is a matrix, not a claim that every Marketplace plugin works: audit the catalog, then record tested plugin/SDK version, operating system, supported action subset, and unsupported device/service dependencies. Prioritize keypad actions for common streaming, communications, media, system, and smart-device workflows, then select concrete integrations using user demand and feasibility. Track coverage as direct-compatible, Open Dock equivalent, or unsupported so “most” can be measured against an agreed target list instead of implied universal support.

## Custom scripts

Custom script actions are created and saved on the desktop. A small guided editor offers starter templates, a plain code field or local script-file picker, runtime selection/detection, optional static arguments, a **Test script** button, and readable output/errors. Initial runtimes should use common Windows/macOS interpreters (PowerShell, Python, and Node.js where installed); the UI reports a missing interpreter and gives setup guidance. Script files and arguments are PC-local and are never sent in a phone invocation.

Before enabling a script, Open Dock shows its exact source path or saved contents, interpreter, arguments, and that it runs as the logged-in PC user. The user explicitly enables that script once; subsequent button presses run the saved action without repeated prompts. Scripts run as a child process with a timeout and bounded output capture, using structured executable/argument values instead of constructing a shell command string. This is a trust/consent boundary, not a claim that arbitrary user scripts are sandboxed.

Plugin and service credentials are kept outside profile/plugin configuration files and the phone. Store tokens in the host operating system's protected credential storage, request only needed integration scopes, and provide disconnect/revoke controls on the desktop.

The PC persists the config in its application data directory as versioned JSON, using a temporary file and replace/recovery when saving to avoid partial writes. Pairing credentials remain separate. Startup validates the saved schema and creates a default profile with the current six media controls when there is no valid config. This uses existing Rust/Serde and filesystem support rather than introducing a database dependency for a small local configuration.

Initially, the PC's active profile is shared by all phones connected to that PC. Any profile switch is made by the desktop or a configured phone button and is broadcast to other connected phones.

## Connection protocol

The existing pairing token remains the authentication mechanism. After authentication, the desktop sends a protocol version and a complete deck snapshot containing the configuration revision, profiles/pages/buttons, active profile/page, and current system-driven button state. A newly paired phone receives this snapshot over either existing transport.

For an action tap, the phone sends a request ID, the current config revision, and a button ID. The PC validates the request and resolves the action from its own config before execution. The PC returns a result correlated by request ID and publishes relevant state changes. Profile/page selection requests use stable IDs and are accepted only when those IDs exist in the PC config. Configuration edits made on the desktop are saved first, increment the revision, then broadcast an updated snapshot to connected phones.

The phone may cache the last snapshot in its existing non-secret persistent storage for faster display. It never treats that cache as editable authority. When disconnected, cached buttons may remain visible but are disabled. A stale revision or unknown button ID causes the PC to reject the request and the phone to request a fresh snapshot.

The protocol is versioned. An incompatible app/desktop pair receives an actionable update-required response rather than silently falling back to phone-supplied executable paths or action payloads.

## Migration of existing phone decks

The first connection after this change may find a legacy deck stored on the phone. During the versioned handshake, the phone may report only that legacy deck data exists. The desktop offers a **Transfer phone deck** action; only after the user requests it does the phone send the bounded deck data. The desktop then offers an explicit **Import phone deck** action to create a new PC profile. Import is validated as untrusted input and never overwrites an existing PC profile. App targets remain disabled until reviewed and approved on the PC, and may need to be selected again for that operating system. Once imported, the PC sends its saved snapshot and is the sole authority. Migration prompting and review appear in the desktop app; the Connect redesign does not change pairing keys or saved-PC records.

If migration is declined or the phone data is invalid, the desktop default profile remains available. Existing pairing keys and saved-PC entries are not migrated or rewritten by this feature.

## Desktop experience

Add a **Deck** area beside the existing Overview. Use a profile selector and page tabs above a simple phone-shaped button canvas. Selecting a button opens a compact properties panel for its label, Lucide icon, action type, and type-specific settings. Users can add, remove, reorder, and duplicate buttons and pages, and create or switch profiles. Add **Plugins & Scripts** for discovering/importing compatible actions, creating custom scripts, managing trust/permissions, and seeing missing or disabled integrations. The overview retains QR pairing and connection status.

The first app picker will select an executable (`.exe`) on Windows or an application bundle (`.app`) on macOS. If a target becomes unavailable, show it as missing and let the user reselect it. Profile auto-switching by focused app is a follow-up phase after manual profiles and synchronization are stable; its platform-specific app association data will be added with that feature.

## Phone experience

- **Deck:** renders the selected PC's profile and page, including host-defined media controls, app launches, and sequences. It reports action results and reflects state updates from the host. Remove local page management and local button editing; the existing page strip becomes the way to select among PC-defined pages.
- **Connect:** redesign the current screen with a clear current-PC status card, a primary **Add PC / Scan QR** flow, a separate first-class **Paired PCs** list, and a separate collapsed **Manual setup** fallback. Each saved PC shows its name and status with connect, disconnect, retry, and remove actions. Keep the existing capped automatic retries and manual retry after retry exhaustion. Keep Wi-Fi and Android USB mode selection associated with the selected PC; pairing remains one-time. Camera denial must leave manual setup reachable. Do not nest Paired PCs under Manual setup.
- **Customize tab:** becomes a **Profiles** remote selector, allowing selection among profiles already defined on the PC. Page selection remains on Deck. It does not create or edit actions.

The Connect redesign improves presentation and pairing guidance while retaining QR scan, manual entry, saved-device connect/disconnect/retry/remove, camera permission fallback, Wi-Fi, and Android USB capabilities. It does not discard paired-device records or rotate pairing keys. PC discovery beyond QR/manual setup is a later enhancement, not a prerequisite for the redesign.

Dynamic labels/icons are derived from host state when available. For example, Play/Pause reflects the system-reported playback state where the OS exposes it; where it does not, Open Dock indicates that the state is unavailable and may use a short-lived visual prediction after a tap.

## Security and failure behavior

- Authenticate before sending deck state or accepting commands.
- A phone can invoke only IDs present in the current PC-owned config; the PC never trusts phone-supplied app paths, sequence bodies, or arbitrary commands.
- Network messages never carry plugin binaries, script source, executable paths, or arbitrary command strings. They identify saved actions only.
- Continue using direct process launching rather than shell interpolation for configured app targets.
- Treat third-party plugins and scripts as PC-executed code. Display source/publisher and capabilities, require explicit enablement, and make disable/uninstall available. A child process alone is not a security sandbox.
- Validate plugin package structure, manifest, action settings, runtime compatibility, target paths, and process resource/time limits before enabling an action.
- Validate persisted config and protocol messages, including action type, target length, sequence count, and ID existence.
- Return actionable errors for missing apps, unsupported host actions, permission failures, stale config revisions, and incompatible protocol versions.
- Preserve the current capped reconnect behavior and explicit manual retry UX.
- Pairing secrets remain in their existing secure stores; the deck cache contains no secrets. Connect presentation and navigation change as described above.

## Delivery phases

1. **Core desktop and phone apps:** establish the PC-owned, versioned profile/action config, persistence/default deck, authenticated snapshot protocol, revision updates, and ID-based invoke/select requests. Build the desktop profile/page/button editor, action configuration for built-ins, app picker, sequence composition, and live preview; make the phone render the PC deck and remotely select profiles/pages; provide explicit legacy phone-deck import. Preserve Wi-Fi, Android USB, and existing pairing identity.
2. **Connect experience:** redesign Add PC/QR, the first-class paired-PC list, manual setup, transport selection, and status/retry controls without losing existing pairing behavior or records.
3. **Core platform completion:** add optional foreground-app profile association and platform-specific app/media state reporting. Ship Windows first while keeping host abstractions portable, then validate native macOS launch/control and supported macOS versions.
4. **Custom script actions:** after the desktop and phone core is stable, build the PC-only guided script editor, runtime detection, templates/test flow, and trust/enable controls. Keep script paths/source and credentials off the phone; apply the security boundaries above.
5. **Elgato compatibility research spike:** after core delivery, test an official, non-protected sample plugin against a narrow Open Dock host prototype. Establish which SDK lifecycle, settings, property-inspector, and dynamic-state features can be supported on Windows and macOS. Do not use or attempt to unwrap Marketplace DRM packages. Record the compatibility matrix before committing to broad third-party support.
6. **Plugin platform and marketplace equivalents:** add a documented Open Dock plugin/action API and compatible `.streamDeckPlugin` support for validated, permitted packages where the spike proves feasible. Independently implement Open Dock actions for selected common integrations where Marketplace packages are protected, host-dependent, or unsupported. Direct Marketplace package support requires rights/technical confirmation; never decrypt or patch protected packages.
7. **Release validation:** validate cross-platform behavior, permissions, connection flows, persistence/migration, plugin compatibility claims, and packaging against the supported feature matrix.

## Sub-project boundaries

- **Core desktop and phone apps:** PC-owned profiles, desktop editing, built-in action configuration, versioned connection protocol, phone remote rendering, and one-time migration. This is the prerequisite for all extension actions.
- **Connection experience:** the phone Connect redesign is part of the initial product work and preserves the same pairing identity and saved-device behavior.
- **Custom scripts:** a later PC-only action provider that plugs into the stable deck core; keep it separate from third-party plugin compatibility because its editor, runtime discovery, and permission model differ.
- **Plugin compatibility:** a later, separate platform project. Begin with the bounded compatibility spike, then implement only the supported key-action subset and selected Open Dock equivalents. Do not block core desktop or phone apps on Marketplace coverage.

## Acceptance criteria

- Editing, reordering, or deleting a profile/button in the desktop app persists across restart and appears on every connected phone without rescanning its QR code.
- A phone action message contains a button ID and revision, not a launch path or sequence definition; the desktop resolves it from its saved config.
- Media buttons, app launches, and sequences in the phone deck are defined and editable on the desktop.
- A missing target or unsupported/failed action is shown on both the desktop and phone without losing the saved profile.
- Legacy phone deck data can be explicitly imported once without replacing existing PC config.
- The redesigned Connect tab retains QR/manual setup, paired-PC list outside Manual setup, retry/disconnect/remove controls, and Android USB support.
- The same profile model works in Windows and macOS builds, with native application targets resolved per host OS.
- Compatibility claims list the tested plugin/SDK subset and distinguish direct-compatible plugins from Open Dock-built equivalents; unsupported encoder actions are clearly identified.
- A custom script is configured and enabled on the PC; a phone button tap sends only its action ID, and script errors/timeouts appear in the PC app.
- Script/plugin credentials never appear in deck snapshots or phone storage.

## Decisions for this design

- One PC owns one active profile shared by its currently connected phones for the first version.
- Deck editing lives on desktop; phone profile/page selectors are remote controls, not local editors.
- Profiles use a local versioned JSON file and OS-appropriate app targets; there is no cloud service.
- App-linked automatic profile switching follows the editor/synchronization foundation rather than blocking it.
- Plugin imports and scripts run only on the PC after explicit user enablement; Open Dock provides equivalents when third-party plugin packages cannot be hosted.
- Open Dock does not decrypt or bypass access controls on Elgato Marketplace content; direct compatibility is limited to packages and action surfaces that are permitted and technically supported.

## References

- [Elgato Stream Deck Mobile 2.0 — Getting Started](https://help.elgato.com/hc/en-us/articles/16786832942221-Elgato-Stream-Deck-Mobile-2-0-Getting-Started)
- [Elgato Stream Deck — Smart Profiles](https://help.elgato.com/hc/en-us/articles/360053419071-Elgato-Stream-Deck-Smart-Profiles)
- [Elgato Stream Deck plugin manifest](https://docs.elgato.com/streamdeck/sdk/references/manifest/)
- [Elgato plugin environment](https://docs.elgato.com/streamdeck/sdk/v1/introduction/plugin-environment/)
- [Elgato plugin WebSocket protocol](https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin/)
- [Elgato plugin distribution and DRM](https://docs.elgato.com/streamdeck/sdk/introduction/distribution/)
- [Tauri v2 commands and events](https://v2.tauri.app/develop/calling-rust/)
- [Tauri v2 managed state](https://v2.tauri.app/develop/state-management/)
- [Rust process execution](https://doc.rust-lang.org/std/process/struct.Command.html)
- [Expo SDK 57 SQLite](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/)
- [Expo SDK 57 store data guide](https://docs.expo.dev/versions/v57.0.0/develop/user-interface/store-data/)
