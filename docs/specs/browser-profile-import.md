# Browser Profile Import Specification

## Goal

Let macOS and Windows x64 users import data from a selected local Chromium-family browser profile into an isolated Metis browser profile — Cookies and browsing history on macOS, browsing history only on Windows — so personal and work identities can remain signed in to the same sites at the same time without overwriting each other.

## Supported platform and sources

- The first release supports macOS plus Windows x64.
- Detect installed Google Chrome, Microsoft Edge, Brave, and Chromium applications from their standard macOS profile roots under `~/Library/Application Support` and their standard Windows user-data roots under `%LOCALAPPDATA%` (for example `Google/Chrome/User Data`).
- Read each browser's `Local State` `profile.info_cache` and expose every usable local profile by its source directory id, display name, and optional email.
- Do not expose absolute source paths to the renderer.
- A running source browser blocks import. The dialog tells the user to close that browser and retry.

## Metis browser profiles

- Every browser tab has an immutable `profileId` chosen before its `WebContentsView` is created.
- The built-in Default profile keeps the existing `persist:metis-browser` partition so current cookies and site data remain available without migration.
- Each imported profile receives a stable UUID and a separate partition named `persist:metis-browser-<profileId>`.
- Importing the same `(sourceBrowser, sourceProfileDirectory)` again updates the same Metis profile instead of creating a duplicate.
- Different source profiles never share cookies, cache, local storage, service workers, browsing history, or network sessions.
- Browser sessions and native views are created lazily. Listing profiles at startup must not create Electron `Session` or `WebContentsView` instances.
- The add-browser flow asks which Metis profile to use when more than one exists. With only Default, it keeps the current one-click behavior.
- A visible profile badge identifies the profile used by an open browser tab. Switching profiles means opening another tab; an existing tab never changes profile.

## Import dialog

- Opened from the browser overflow menu as `Import browser data…`.
- Reuse the existing modal focus trap, escape handling, menu select, theme tokens, and reduced-motion behavior.
- Show a source-browser selector followed by a source-profile selector.
- On macOS, offer exactly two independently selectable data types:
  - `Cookies` — imports every valid, decryptable, non-expired, non-partitioned cookie; there is no numeric cookie limit.
  - `Browsing history` — merges source and target history, deduplicates by URL, sorts by `visitedAt` descending, and retains at most 500 total entries in that Metis profile.
- On Windows, offer browsing history only. The dialog explains that Metis currently imports browsing history only and that Cookies and sign-in state are not imported, and it always requests `{ cookies: false, history: true }` regardless of renderer state.
- Do not show or import passwords, autofill data, bookmarks, extensions, open tabs, cache, local storage, IndexedDB, or service workers.
- Disable Import until a browser, a source profile, and at least one data type are selected.
- While importing, disable cancellation and all controls and show `Importing…`.
- On completion, show safe counts for imported/skipped cookies and retained history. Never show cookie names or values.
- A new source profile creates a Metis profile and opens a browser tab using it. Re-importing an already mapped source profile updates it without creating another profile.

## Import mechanics

- Source databases are read-only. On macOS, copy `Network/Cookies` (falling back to `Cookies`) and `History`; on Windows, copy only `History` — always including available `-wal` and `-shm` siblings, into a unique temporary directory before opening them.
- Delete the temporary directory in a `finally` block on success, failure, and cancellation.
- Use Electron's bundled Node `node:sqlite`; add no SQLite or browser-import dependency.
- Query only the columns needed for cookies and history.
- Convert Chromium timestamps from microseconds since 1601-01-01 to Unix seconds for cookie expiry and Unix milliseconds for Metis history.
- On macOS only, retrieve each browser's Safe Storage secret with `/usr/bin/security` using argument arrays, never a shell command. Do not log command output.
- Derive and decrypt macOS Chromium `v10` cookie values with Node `crypto`. For database schema version 24 or newer, validate and remove the SHA-256 host prefix before importing the value.
- On macOS only, skip expired cookies, cookies whose decryption or validation fails, and partitioned cookies that Electron's cookie interface cannot preserve. Count every skip.
- On macOS only, write cookies directly in the main process with the target Electron Session's `cookies.set()` and call `cookies.flushStore()` after the batch.
- Cookie values, decryption keys, database rows, and absolute browser profile paths must never cross IPC, enter renderer state, or be written to diagnostics. Windows imports never read, decrypt, or copy Cookies, so no Keychain or Safe Storage access occurs on Windows.

## History semantics

- History is stored per Metis browser profile.
- The Default profile continues using the existing `browser-history.json` file.
- Imported profiles use `browser-history-<profileId>.json` under Electron `userData`.
- During import, combine existing and imported entries, group by normalized URL, retain the entry with the newest `visitedAt`, sort newest first, and slice to 500.
- The import result reports how many source rows were accepted and how many entries remain after merging; it must not claim that 500 entries were added.
- History list, history events, and clear-history operations are scoped by `profileId`.

## Security and validation

- Preserve `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true` for every profile.
- Preserve deny-by-default permission handlers for every lazily created Session.
- Validate every IPC request and response with exact keys, bounded strings, UUID profile ids, supported source ids, and boolean data-type selections.
- Reject source profile ids containing separators, `.` segments, NULs, or more than 128 characters.
- Reject any Windows import request containing `dataTypes.cookies: true` in the main-process importer, even if a compromised renderer bypasses the UI.
- Return stable, actionable messages for unsupported platform, missing source, running source browser, denied Keychain access (macOS), corrupt source database, and no importable data.
- Never delete or modify source-browser files.

## Performance

- Profile discovery may read metadata files but must not open Cookie or History databases.
- Import runs only after explicit user action.
- Process database rows incrementally; do not retain encrypted cookie blobs after each row is handled.
- Listing profiles creates no Electron Sessions. A profile with no open tabs owns no `WebContentsView`; after a profile has been opened or imported, Electron may retain its persistent partition cache internally.

## Acceptance criteria

- Existing Metis users retain the Default profile's current cookies, site data, and browsing history.
- Importing Chrome Personal and Chrome Work produces two Metis profiles whose cookies and histories do not overwrite each other.
- Re-importing Chrome Personal updates its existing Metis profile.
- New tabs can be opened independently under Default, Personal, or Work.
- The imported profile remains signed in after restarting the packaged app when the source cookie is persistent and the site does not require additional storage or device binding.
- Existing plus imported history never exceeds 500 entries per profile and is globally newest-first within that profile.
- Browser/Profile discovery and result payloads contain no cookie values, decryption keys, or absolute source paths.
- On Windows, simulated discovery finds Google Chrome, Microsoft Edge, Brave, and Chromium from their standard `%LOCALAPPDATA%` roots, and history-only import succeeds without any Keychain or Safe Storage access.
- Windows import requests containing Cookies are rejected by the main-process importer, and the Windows import dialog sends `{ cookies: false, history: true }` without advertising Cookie import.
- Browser-manager, importer, store, IPC security, renderer dialog, type checks, desktop tests, and packaged-app verification all pass.

## Non-goals

- Password or autofill import.
- Safari or Firefox import.
- Linux browser import.
- Windows Cookie or sign-in-state import.
- Synchronizing future source-browser changes automatically.
- Exporting Metis cookies.
- Editing, renaming, or deleting Metis browser profiles in this release.
- Preserving Chromium partitioned cookies that Electron cannot faithfully set.
