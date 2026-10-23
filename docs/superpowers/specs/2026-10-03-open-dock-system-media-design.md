# Open Dock System Media Integration

## Goal

Replace the Spotify-specific starter plugin with a general system-media integration. Show live now-playing details and artwork from the desktop's current media session on the configured Open Dock widget screen, and keep using Open Dock's existing cross-platform deck controls.

## User intent and scope

- Support media players through the operating system's current media session, rather than a Spotify-owned API client.
- Show the active track's artwork and metadata on connected phones.
- Remove the Spotify-specific sample plugin from Open Dock.
- Keep the editor's existing per-page widget area and grid controls.
- First provider target is Windows, matching the requested FluentFlyout-style system-wide behavior.
- Do not add Spotify login, developer credentials, service-specific branding, or app-specific UI.
- This first release is a now-playing widget, not a generic browse/search/queue/library feature. Such features require service-specific APIs and are outside this design.

## Approaches considered

1. **Windows Global System Media Transport Controls (recommended).** Read the system-selected media session. It can expose the title, artist, album, playback status, timeline and thumbnail without a Spotify API client. This is the broadest Windows source with the least service-specific code.
2. **Separate Spotify, Apple Music and other service integrations.** Each needs its own interface, authentication or platform-specific behavior; this is slower and recreates the limitations of the Spotify-only approach.
3. **Generic media keys only.** Open Dock already supports global media-key actions, but those cannot reliably supply track metadata or artwork.

The first approach is selected. Windows chooses the session it considers most likely to control; users do not choose a specific player in v1.

## Architecture

### Desktop media source

- Add a Windows-only provider backed by `GlobalSystemMediaTransportControlsSessionManager`, reusing the existing `windows::Media::Control` dependency already used for playback state.
- Observe current-session, media-properties, playback and timeline changes. Refresh the current position periodically while playing; do not poll all installed applications or request a Spotify token.
- Publish one current-session state with available source app ID, title, artist, album, playback state, position/duration and artwork. Missing optional metadata and missing artwork are valid states.
- When no current session exists, publish a cleared/empty state. A player that does not publish a Windows media session cannot be discovered by this provider.
- Use Open Dock's existing global media commands for buttons. Do not add player-specific controls or a provider scripting runtime.

### Phone synchronization and rendering

- Add a separate `media_state` message to the authenticated existing WebSocket protocol. It is a live snapshot, independent of deck configuration and device navigation selection.
- Send an initial state after authentication, then send updates only when track, playback, timeline, or artwork changes. Position-only messages may be sent at a modest interval while playing.
- Read artwork from the Windows session thumbnail and send a bounded image data URL only when that artwork changes. Cap its decoded size; if absent or too large, omit it and show Open Dock's neutral music artwork fallback. Do not put live metadata or artwork into saved deck JSON or long-lived phone storage.
- Keep the source display Open Dock-owned and responsive in normal, widget-only, and landscape immersive views. Text must truncate safely in narrow cells, and missing title/artist/artwork must not make the widget invalid.
- Do not transmit media state to unauthenticated sockets. Existing pairing token and local-network transport remain the boundary.

### Editor and widget contract

- Add one built-in **Now Playing** option beside the existing built-in widgets in the desktop widget editor. It is available on each existing widget page and uses the existing add, move, resize, and delete flows.
- Serialize the instance as a built-in widget type, separate from the existing plugin text widget. Old clock and plugin widget JSON remain backward-compatible.
- The phone renders the built-in type directly; no separate installation is required on the phone.
- Multiple Now Playing instances may display the same current session. They do not create multiple provider subscriptions.

### Visual direction

- Make the widget feel like part of Open Dock: use the existing dark neutral surfaces, restrained borders, typography and spacing, with Open Dock's cool accent for playback/progress details. Do not use Spotify branding/green or reproduce Elgato's artwork/layout.
- Let artwork be the visual anchor in roomy cells. Pair it with a clear title/artist hierarchy, quiet album/source details, and a compact playback progress treatment when timeline data exists.
- Adapt the layout to widget aspect ratio and available size: wide cells can place artwork beside text and progress; narrow/small cells must prioritize legible artwork and a short title/artist without overflow. Keep all labels and progress optional when space is tight.
- Preserve the same visual language in standard, widget-only, and immersive landscape modes, including stable empty/missing-art states.

### Spotify starter removal

- Remove the bundled `opendock.spotify-controls` sample package and its Spotify-specific documentation/references.
- Remove its installed package from the current desktop companion if present.
- Preserve saved deck JSON and unrelated plugins. Any saved references to the removed plugin remain as data and are visibly unavailable until replaced; do not silently delete buttons or widget layouts.
- Open Dock's existing generic system media buttons remain available.

## Constraints and edge cases

- Supported sources are limited to applications that publish metadata through Windows Global System Media Transport Controls. Audio being audible or responding to a hardware media key does not guarantee track metadata or artwork is available.
- When several sessions exist, show the Windows-selected current session; when it changes, replace all displayed metadata/artwork atomically to avoid showing a mixed old/new track.
- Treat WinRT session/property/thumbnail errors as unavailable data, not as a fatal error for the desktop companion or the phone connection.
- Bound artwork size and update frequency so a large image or fast timeline does not flood the paired-device link.
- Keep media state in memory and do not save it to profiles or deck snapshots.
- macOS media metadata and artwork are not included in this Windows-first milestone. The widget contract stays platform-neutral so a native macOS provider can be added later.

## Acceptance criteria

1. The Spotify sample is removed from the repository and current companion installation without deleting deck layouts.
2. Windows exposes the current supported media session's metadata, playback state, timeline and thumbnail when available, without Spotify credentials.
3. Playing, pausing, seeking, changing tracks, switching media sessions and stopping playback update the phone widget.
4. No session, unsupported player, missing metadata, absent artwork, or a rejected/oversized thumbnail produces a stable fallback instead of a crash or stale mixed metadata.
5. The editor can add, place, resize and delete Now Playing in existing widget pages; legacy clock and plugin text widgets still work.
6. Live updates use the existing authenticated phone connection and do not alter shared or per-device navigation.
7. The desktop and phone development apps are launched after implementation so the user can try the result.

## Deferred

- macOS media-session provider.
- Per-service search, library, saved-track, playlist, queue and account features.
- Third-party executable widget providers, Marketplace, Elgato protocol compatibility, and arbitrary plugin UI/code.
