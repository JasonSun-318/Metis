---
name: testing-metis-desktop
description: How to launch, navigate, and verify the Metis Electron desktop app end-to-end (macOS), including theme switching, workspace setup, and objective pixel-based visual checks
---

# Testing the Metis desktop app (Electron, macOS)

## Launch
- Dev build: `npm start` in `packages/desktop` (repo root `~/repos/Metis`). First build takes ~3–4 min.
- Node >=22.19 required (engines). On macOS, system node >=24 satisfies this. Dependencies: `npm install --ignore-scripts` (required — see blueprint; also fetch the Electron binary via `node node_modules/electron/install.js` and `chmod u+x node_modules/@electron-forge/cli/dist/electron-forge.js` if missing).
- The app registers in the macOS accessibility tree as app `Electron` — drive it with the `macos` computer target (`app="Electron"`). The web UI is exposed inside the tree (webarea).

## Theme switching
- Click the "Metis User" popupbutton (bottom-left of the sidebar) → "Settings" → "General" nav → the Appearance icon segmented group: moon = dark, sun = light, desktop = system.
- Settings dialog tabs: Profile (default), General, Model, Personalization, Memory, Agent types, Permissions, Browser.

## Opening a session workspace
- "New task" → "Choose folder" opens the native macOS picker — press Cmd+Shift+G, type a path (e.g. `/Users/devin/repos`), Return, then Open. Type text in the composer and press Return to start the agent.
- WITHOUT a model provider configured, sending a message shows a "Request failed / Operation failed" toast — EXPECTED environmental failure, not a bug. The workspace shell (transcript, composer, right-hand "Chat tools" sidebar with Terminal/Browser launcher cards) still works.
- Tool sidebar toggles: "Hide tools sidebar" / "Hide sessions sidebar" checkboxes in the top toolbar. "Chat"/"Code" workspace-mode segmented control at top of the sidebar.

## Known limits without a model provider
- The composer effort slider ("Select effort" popupbutton) renders but is DISABLED (available effort levels < 2), so the fill can't be dragged — only the 8px fill stub at the left is visible.
- "Select model" popupbutton is disabled.

## Objective visual checks (theme/CSS verification)
- The computer tool's screenshots save to `/Users/devin/screenshots/*.png` at 1600x1200 (1.5625x the 1024x768 coordinate space).
- A pure-stdlib PNG pixel sampler lives at `/Users/devin/sample_px.py`: `python3 /Users/devin/sample_px.py <png> x,y ...` prints hex+rgb for points given in 1024x768 tool coordinates (auto-scaled). Use it to verify exact token colors instead of eyeballing — e.g. light `--app-bg` #f4f2ed, `--sidebar` #fbfbfa, `--panel-selected` #e3e1da, `--heat-empty` #e6e4de, `--panel-hover` #ecebe6; dark `--app-bg` #121212, `--sidebar` #141414.
- For hover states: `mouse_move` to the element, wait ~0.5s, screenshot, then sample the hovered row/card pixel.
- `zoom` on a region gives a full-res crop for reading fine borders/separators.

## Miscellaneous
- Maximize the window for recording via the green "full screen" window button (macOS target lists it as a button in the window controls). macOS notification banners may overlap the app — hover the banner to reveal its close button and dismiss before recording.
- Customize page (sidebar "Customize" button) = plugins panel: Skills / MCP / Hooks / Plugins tabs, search field, source dropdown, skill rows with separators.

## Devin Secrets Needed
- None for visual/UI verification. A configured model provider would be needed to actually run the agent end-to-end.
