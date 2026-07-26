# Desktop MVP Design QA

Source visual truth: `/var/folders/l4/qhmjdv2d42b6wx8xm8t18cb80000gn/T/codex-clipboard-c316780e-44ee-46f0-9095-00ea70507560.png`

Implementation screenshot: `/Users/ent/ArcMind/packages/desktop/test-results/mvp-implementation.png`

Viewport: 1429 × 767 CSS pixels, dark theme. The implementation capture was normalized to the source image density for comparison.

State: packaged ARM64 Electron app with three projects, five persisted tasks, an active task, user and assistant messages, tool-call rows, and an enabled composer.

Full-view comparison evidence: `/Users/ent/ArcMind/packages/desktop/test-results/mvp-comparison.png`

Focused composer comparison evidence: `/Users/ent/ArcMind/packages/desktop/test-results/mvp-composer-comparison.png`

## Findings

- No actionable P0, P1, or P2 differences remain in the requested MVP surfaces.
- Fonts and typography: the implementation uses the native system sans stack with comparable 15px conversation text, compact sidebar labels, matching hierarchy, truncation, and line-height. Dynamic content and product language intentionally differ from the Codex reference.
- Spacing and layout rhythm: the 240px sidebar, 62px header, centered 760px conversation column, bottom composer, radii, dividers, and dark-surface spacing now follow the source composition without overlap or clipped persistent controls.
- Colors and visual tokens: sidebar, workspace, elevated composer, text, muted text, borders, selected task, and user-bubble tones closely track the inferred neutral dark palette. The small `ready` state is an intentional ArcMind runtime indicator.
- Image quality and asset fidelity: the target contains no required photographic or illustrative assets. Visible UI icons use one real Phosphor icon family; no custom SVG, CSS art, emoji, or placeholder imagery is used.
- Copy and content: ArcMind branding and English labels are intentional product content. Conversation and task content are realistic persisted data rather than a static mock.
- P3 follow-up: the source includes secondary Codex navigation and account chrome outside this MVP's requested projects/tasks/conversation scope; these are intentionally deferred.

## Comparison History

1. P1 — the composer dock stretched across the lower half of the workspace when optional banners were absent. Fixed the workspace from a fixed-row grid to a vertical flex layout. Post-fix evidence: the final full-view comparison shows the transcript filling available height and the composer anchored naturally at the bottom.
2. P2 — the first pass used a 300px sidebar and 900px content column, producing visibly different major-region proportions. Fixed them to 240px and 760px after matching the source's logical viewport. Post-fix evidence: `/Users/ent/ArcMind/packages/desktop/test-results/mvp-comparison.png`.
3. P2 — the composer was taller and sat higher than the source. Reduced textarea height, internal gap, padding, and dock bottom spacing. Post-fix evidence: `/Users/ent/ArcMind/packages/desktop/test-results/mvp-composer-comparison.png`.

## Interaction and Runtime Checks

- Tested real new-task creation, persisted project/session listing, opening a task, sending a message, streaming completion, renderer reload, App Server crash recovery, and 10,000-delta slow-client catch-up in the packaged Electron app.
- Keyboard send and Shift+Enter behavior are implemented in the composer; send/stop controls retain accessible names and focus states.
- Renderer console and page errors were monitored during recovery E2E and remained empty.
- The final package executable was verified as native macOS ARM64.

final result: passed

## Composer add menu follow-up

Source visual truth: `/var/folders/l4/qhmjdv2d42b6wx8xm8t18cb80000gn/T/codex-clipboard-36459ce7-e608-470a-bc16-b7142663e93d.png`

Implementation screenshot: `/tmp/arcmind-final-submenu-open.png`

Viewport and normalization: the source is 1560 × 858 pixels and the implementation capture is 2880 × 1800 pixels from a 1440 × 900 Retina desktop. The menus were compared as equal-density focused regions: 450 × 170 pixels for the primary menu and 388 × 360 pixels for the skills menu.

State: packaged ARM64 Electron app, Chat composer open, primary menu open, Skills active, and the installed-skills submenu open with pointer interaction.

Full-view evidence: `/tmp/arcmind-final-submenu-open.png`

Focused primary-menu comparison: `/tmp/arcmind-menu-final-compare.png`

Focused skills-menu comparison: `/tmp/arcmind-submenu-final-compare.png`

### Findings

- No actionable P0, P1, or P2 differences remain in the requested menu surfaces.
- Fonts and typography: menu labels now use an explicit 16px system sans, 400 weight, 1.25 line-height, and bright foreground instead of inheriting the composer's 11px muted style. Shortcut text remains muted and right-aligned.
- Spacing and layout rhythm: row centers match the reference's 64-pixel backing-pixel cadence; reduced outer padding aligns the divider and active-row position. Both menus keep the reference radius, border, active fill, and layered shadow shape.
- Colors and visual tokens: menu `#383835`, active row `#42423f`, bright labels, muted caret/shortcut, border opacity, and shadow layers visibly track the reference.
- Image quality and asset fidelity: the add, paperclip, scroll, caret, and briefcase marks are real Phosphor icons. No text glyph or handmade SVG substitutes are used for icons.
- Copy and content: the primary menu contains only the approved Add files or photos and Skills entries. The submenu uses ArcMind's live installed skills and intentionally omits Browse skills, Add connector, and Add plugins.

### Comparison history

1. P1 — menu labels inherited the composer's 11px muted toolbar style, making them visibly too small and grey. Fixed with an explicit 16px, 400-weight, bright menu type rule. Post-fix evidence: `/tmp/arcmind-menu-final-compare.png`.
2. P2 — menu rows lacked the reference divider and the active Skills state. Added the separator and persistent active fill while the submenu is open. Post-fix evidence: `/tmp/arcmind-menu-final-compare.png`.
3. P2 — icon scale, outer padding, and the missing Command-U affordance left the menu visibly different. Matched icon scale and padding, added `⌘U`, and wired it to the real file picker. Post-fix evidence: `/tmp/arcmind-menu-final-compare.png` and `/tmp/arcmind-submenu-final-compare.png`.

final result: passed
