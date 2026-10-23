# Open Dock Core Desktop and Phone Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the Windows-first desktop companion the authority for Open Dock profiles, pages, built-in buttons, and action execution, with the phone showing a synchronized remote deck.

**Architecture:** Keep the desktop's Rust process as the single source of truth and action executor. Persist a versioned local JSON config, expose safe Tauri editor commands, and send authenticated config snapshots over the existing WebSocket; the phone sends only stable button/profile/page IDs with the current revision. Preserve the current pairing identity, Wi-Fi and Android USB transports, and paired-PC storage while replacing phone-owned deck editing with remote controls.

**Tech Stack:** Tauri 2, Rust/Serde/JSON, Axum WebSocket, React 19/Vite, Expo SDK 57 / React Native 0.86, Expo Router, existing SQLite key-value storage and SecureStore.

**Spec:** `../specs/2026-09-27-desktop-owned-deck-design.md`

## Global Constraints

- Work in `D:\opendock\pc-companion` for the desktop and `D:\opendock\phone-app` for the phone; the PC companion is currently not a Git repository.
- Preserve all existing user changes in the phone repo. Do not reset, clean, or stage unrelated files.
- Windows is the first implementation target; use OS-conditional action execution and keep the config/protocol portable for the planned macOS build.
- Do not add plugin or script runtime code in this core plan. Those are later projects after the core is stable.
- Phone pairing tokens remain in SecureStore; profile snapshots contain no secrets. Never accept app paths, sequence definitions, or arbitrary shell text from a phone command.
- Keep QR pairing, paired-PC management, capped reconnect behavior, manual retry, Wi-Fi, and Android USB behavior intact.
- Expo dependency versions must remain aligned to Expo SDK 57; use `npx expo install` if a package change is required.
- Before completion, run the phone lint and TypeScript checks required by `AGENTS.md`, and the desktop frontend build and Rust compile check. Do not add test frameworks.

## Review Focus

- Config decoding and atomic persistence: reject malformed/oversized structures and recover without losing the last valid config.
- Trust boundary: phone action messages contain only known IDs and revision; all execution details resolve on the PC.
- Multi-client synchronization: desktop edits broadcast consistent snapshots to all authenticated sockets.
- Migration: offer legacy phone data for explicit PC-side import and never overwrite an existing profile silently.
- Lifecycle and compatibility: pairing, USB reverse, offline cached view, playback state, and cross-platform action dispatch continue to behave correctly.

---

## Tasks

### Task 1: Add the PC-owned core deck model and persistence

**Files:** `D:\opendock\pc-companion\src-tauri\src\lib.rs`

- [x] Add Serde models for `DeckConfig`, `DeckProfile`, `DeckPage`, `DeckButton`, and core actions only: media, hotkey, app launch, sequence, and profile/page navigation.
- [x] Add a default profile containing the existing six media buttons. Use stable IDs and existing Lucide key names; no plugin/script variants in this phase.
- [x] Extend `AppState` with the in-memory config, revision, config path, and a small client broadcast channel for deck snapshots.
- [x] On Tauri setup, load and validate `deck-config.json`; create the default config if absent or invalid. Save edits by serializing to a sibling temporary file then replacing the target.
- [x] Add `deck_config` and `save_deck_config` Tauri commands. Validate IDs, labels, button/page/profile limits, action bounds, and app targets before writing.

**Check:** `cargo check` from `D:\opendock\pc-companion\src-tauri`; inspect that the old pairing key path and permissions are untouched.

### Task 2: Add a desktop Deck editor for built-in actions

**Files:** `D:\opendock\pc-companion\src\App.tsx`, `D:\opendock\pc-companion\src\App.css`

- [x] Add a Deck navigation item and a compact shadcn-like editor view using the existing dark palette and Lucide icons.
- [x] Load/save via the Tauri deck commands. Show profile selector, page tabs, button grid, and selected-button properties.
- [x] Support creating/renaming/deleting profiles and pages; add, edit, reorder, duplicate, and remove buttons within existing safety limits.
- [x] Configure media, hotkey, app launch, and bounded sequences on the PC. Use a validated Windows app path field; defer a native file picker until the desktop has an existing dialog dependency or the path field proves insufficient.
- [x] Keep Overview and QR pairing content available and do not add plugin/script screens in this task.

**Check:** `npm run build` in `D:\opendock\pc-companion`; manually verify empty/default config and editor changes persist across app restart.

### Task 3: Change the authenticated socket protocol to host-resolved IDs

**Files:** `D:\opendock\pc-companion\src-tauri\src\lib.rs`

- [x] After successful authentication, send a versioned complete deck snapshot and initial playback state instead of only `ready`.
- [x] Add messages for `invoke_button`, `select_profile`, and `select_page`; include request IDs and config revision.
- [x] Resolve each button ID from PC config and run only the stored action. Reject stale revisions, unknown IDs, malformed IDs, and unsupported actions with a correlated result.
- [x] Broadcast saved config snapshots and active profile/page updates to every authenticated phone when desktop changes occur.
- [x] Preserve capped WebSocket payload sizes, authentication, active-device accounting, playback updates, and key rotation behavior.

**Check:** `cargo check`; inspect every `ClientMessage` branch and verify no phone-supplied launch path or action payload reaches `run_action`.

### Task 4: Make the phone connection context consume host snapshots

**Files:** `D:\opendock\phone-app\src\connection.tsx`, `D:\opendock\phone-app\src\theme.ts` (only if snapshot types need styling-independent placement)

- [x] Define mobile-side types for the versioned deck snapshot and correlated action results.
- [x] On the new authenticated snapshot message, keep the current PC's snapshot in context and cache the last valid snapshot in existing SQLite key-value storage.
- [x] Replace `sendAction(action)` with stable-ID invocation and profile/page selection requests that carry the current revision.
- [x] Preserve secure pairing records, connection retry cap/manual retry, saved device selection, and USB behavior without rescan.
- [x] Keep cached snapshot visible while disconnected but disable action presses; request a fresh snapshot after reconnect or stale-revision error.

**Check:** `npx tsc --noEmit` and `npm run lint` in `D:\opendock\phone-app`; manually verify authenticated `ready`/snapshot flow against the desktop server.

### Task 5: Render the PC-owned deck and remote profile/page selectors on phone

**Files:** `D:\opendock\phone-app\src\app\(tabs)\index.tsx`, `D:\opendock\phone-app\src\app\(tabs)\edit.tsx`, `D:\opendock\phone-app\src\app\pages.tsx`, `D:\opendock\phone-app\src\deck.ts`, `D:\opendock\phone-app\src\app\(tabs)\_layout.tsx`

- [x] Render the active PC profile/page and button definitions from connection context; resolve Lucide icons using the existing icon registry.
- [x] Invoke buttons by ID/revision and use correlated responses for feedback. Keep media icon/label state driven by the desktop playback state.
- [x] Replace the local Customize flow with a Profiles remote selector; page selection remains on Deck.
- [x] Remove local create/edit/reorder actions from the phone's active flow while retaining legacy data reading for migration.
- [x] Preserve the Connect tab's behavior and keep its paired-device section outside the collapsed Manual setup section.

**Check:** `npx tsc --noEmit` and `npm run lint`; manually verify profile/page switching from phone updates the desktop state and all connected phones.

### Task 6: Offer explicit migration of legacy phone decks

**Files:** `D:\opendock\pc-companion\src-tauri\src\lib.rs`, `D:\opendock\pc-companion\src\App.tsx`, `D:\opendock\phone-app\src\connection.tsx`, `D:\opendock\phone-app\src\deck.ts`

- [x] During the versioned handshake, let the phone indicate only whether legacy deck data exists; transfer bounded data only after the PC user requests it.
- [x] Validate imported labels, icon keys, action types, sequence sizes, and targets as untrusted input; regenerate PC-owned IDs. Require PC-side app target review where a phone target does not suit Windows.
- [x] Import only as a new profile, only after explicit confirmation, and never overwrite an existing non-default PC profile.
- [x] On decline/invalid data, leave the phone cache and PC config intact. After success, mark the phone legacy payload as migrated without clearing pairing secrets.

**Check:** desktop Rust/frontend build and phone lint/typecheck; manually exercise accept, decline, malformed payload, and existing-profile cases.

### Task 7: Preserve and refine Connect experience against the new deck protocol

**Files:** `D:\opendock\phone-app\src\app\(tabs)\connect.tsx`, `D:\opendock\phone-app\src\connection.tsx`, `D:\opendock\pc-companion\src\App.tsx`

- [x] Keep Add PC/QR, separate Paired PCs list, Manual setup, per-device status/actions, and capped retries with manual retry after exhaustion.
- [x] Show the selected PC's snapshot readiness and deck protocol compatibility in the connection status, with a clear update-required state for unsupported protocol versions.
- [x] Keep desktop QR pairing and pairing-key reset behavior; do not alter the pairing key format or rotate keys during ordinary reconnects.

**Check:** phone lint/typecheck, desktop build, and Rust compile check; manually verify QR pair, saved reconnect, disconnect/retry, Android USB, and incompatible-version messaging.
