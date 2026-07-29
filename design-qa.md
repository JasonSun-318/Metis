# Desktop model and effort controls — Design QA

final result: passed

## Evidence

- Model reference: `/var/folders/l4/qhmjdv2d42b6wx8xm8t18cb80000gn/T/codex-clipboard-01cc9ac8-503a-4cb8-bce1-5301bafccdd1.png` (`2762 × 1572` physical px).
- Effort reference: `/var/folders/l4/qhmjdv2d42b6wx8xm8t18cb80000gn/T/codex-clipboard-85b1bcac-7246-42d1-9311-9f029fb51099.png` (`2760 × 1572` physical px).
- Ultra reference: `/var/folders/l4/qhmjdv2d42b6wx8xm8t18cb80000gn/T/codex-clipboard-ae273fa1-9936-439e-a84b-41f616b2de92.png` (`2762 × 1560` physical px).
- Model implementation: `/tmp/arcmind-model-selector-final.png`.
- Effort implementation: `/tmp/arcmind-effort-selector-final.png`.
- Ultra implementation: `/tmp/arcmind-effort-ultra-final.png`.
- Implementation viewport: `1280 × 791` CSS px at DPR `2` (`2560 × 1582` physical px).
- Normalization: reference and implementation were compared together at CSS scale, using the open popover state and the same lower-right composer region.

## Full-view and focused comparison

- Full-view comparison confirmed the selectors remain anchored to the existing ArcMind composer without changing its dimensions or surrounding layout.
- Focused measurements: model menu `156 × 114` CSS px; effort menu `220 × 96` CSS px; effort track `196 × 20` CSS px.
- Typography hierarchy, row density, selected checkmark, border, radius, shadow, tick spacing, thumb proportions, active label, and Ultra field match the supplied references at normalized scale.
- Model rows intentionally use the three models returned by the authenticated ArcMind session instead of the reference repository's six demo rows.
- Effort labels intentionally use ArcMind's real model contract (`High`, `Ultra`) rather than the reference labels (`Max`, `Ultracode`).

## Comparison history

1. Initial implementation review found an oversized effort track and thumb relative to the reference (P2).
2. The track, thumb, panel spacing, type scale, and shadow were corrected and recaptured.
3. Final model, normal-effort, and Ultra states were compared again in paired reference/implementation passes; no actionable P0, P1, or P2 issue remained.
4. Final code review found and corrected stale preview restoration after an external value change plus pending-frame cleanup on disabled state; the focused regression passed without changing the verified visuals.

## Interaction and runtime verification

- A real installed ARM64 app switched `MiMo-V2.5-Pro → MiMo-V2.5 → MiMo-V2.5-Pro`; the App Server snapshot and visible trigger stayed synchronized.
- A native pointer drag switched `Ultra → High → Ultra`; the panel stayed open, the real session value changed, and the Ultra canvas appeared only at the real `ultra` stop.
- Fractional drag preview, magnetic attraction, velocity-aware spring settlement, keyboard selection, outside click, Escape, and reduced-motion behavior are covered by component tests.
- Package verification, ARM64 architecture check, and strict code-sign verification passed.
- Final installed-app console check: no errors.
- The QA session was restored to its original model and `Ultra` effort.

## Findings

- P0: none.
- P1: none.
- P2: none.
- P3: the surrounding ArcMind screen is not a clone of the reference application's screen; this is expected because the requested scope preserves ArcMind's current composer and layout.

---

# Desktop conversation typography and shell alignment — Design QA

## Evidence

- Source visual truth: `/var/folders/l4/qhmjdv2d42b6wx8xm8t18cb80000gn/T/codex-clipboard-6ddc2405-7485-4b3e-b1a1-2860ccfbc2cc.png` (`2560 × 1440` px).
- Installed-app implementation: `/Users/ent/ArcMind/packages/desktop/test-results/typography-layout-full.png` (`2560 × 1440` px).
- Same-size combined comparison: `/Users/ent/ArcMind/packages/desktop/test-results/typography-layout-comparison.png` (`5120 × 1440` px, source left and implementation right).
- Focused header evidence: `/Users/ent/ArcMind/packages/desktop/test-results/typography-layout-reference-header.png` and `/Users/ent/ArcMind/packages/desktop/test-results/typography-layout-implementation-header.png` (each `1200 × 220` px).
- Responsive implementation: `/Users/ent/ArcMind/packages/desktop/test-results/typography-layout-narrow.png` (`900 × 720` px).
- Computed renderer evidence: `/Users/ent/ArcMind/packages/desktop/test-results/typography-layout-metrics.json`.
- Viewport and normalization: source and full implementation were compared at the same `2560 × 1440` CSS/pixel viewport at DPR `1`; no density scaling was used. The narrow pass used `900 × 720` CSS px at DPR `1`.
- State: both captures use dark Chat mode with the sidebar, transcript, and composer visible. Session copy differs because the implementation uses a real ArcMind session; copy-specific wrapping was excluded from geometric comparisons.

## Full-view and focused comparison

- Full-view evidence confirms the sidebar track, centered `730px` transcript, user-message alignment, and `770px` composer preserve the reference composition.
- Focused header evidence confirms the sidebar frame begins at `7px`, the mode switch begins at `x=16`, the workspace title begins at `x=326`, and the title baseline aligns with the reference. Fullscreen titlebar controls now begin at `x=16`; the corresponding normal-window control position remains `x=92` to clear macOS traffic lights.
- The reference's unbroken workspace background is preserved by removing the previous `1px` workspace-header divider.
- The transcript's `36px` top inset and `46px` header reproduce the reference's vertical start without changing composer dimensions.

## Required fidelity surfaces

- Fonts and typography: the existing Inter/system UI and serif final-answer stacks were retained. Full-view computed sizes are `14px` metadata/sidebar, `15px` activity body, and `16px` final answer/user/composer, with `21px`, `24px`, and `24.8px` line heights respectively. At `900px` width they resolve to `13px`, `14px`, and `15px`, proving bounded responsive scaling without dropping below readable sizes.
- Spacing and layout rhythm: the sidebar uses `7px` outer margins, asymmetric `8px/6px` inner padding, a `47px` drag region, a `46px` main header, and the existing composer dimensions. The one-pixel antialiasing difference on the sidebar border is acceptable P3 rendering variance.
- Colors and visual tokens: the existing ArcMind dark tokens, selected-row contrast, muted metadata color, user bubble, border opacity, and composer elevation were unchanged because they already match the source closely.
- Image quality and asset fidelity: this surface has no raster product imagery. Existing Phosphor icons remain vector-sharp at both tested sizes; no placeholder or hand-drawn replacement asset was introduced.
- Copy and content: reference-specific labels and messages intentionally differ from the authenticated ArcMind session. Shared interface copy and hierarchy remain stable; no layout conclusion depends on matching transcript text.

## Comparison history

1. Initial source/current comparison found a P2 density mismatch: the final answer rendered at `18px`, activity text at `16px`, and the chat transcript used an independent `744px` width.
2. Shared bounded type tokens were applied and the transcript was routed through the existing `730px` token. The header, sidebar gutter, divider, and vertical inset were corrected and recaptured.
3. The first same-size post-fix comparison found one remaining P2 shell mismatch: fullscreen macOS titlebar controls retained a `76px` traffic-light offset after the traffic lights disappeared.
4. Fullscreen detection now removes only that offset; normal windows retain it. The final installed application was repackaged and recaptured. No actionable P0, P1, or P2 mismatch remains.

## Runtime verification

- Desktop tests: `10` files and `95` tests passed.
- Desktop renderer/main TypeScript checks passed.
- Package verification confirmed the packaged App Server assets; strict deep code-sign verification passed; installed version is `0.80.6`.
- The real packaged renderer reported fullscreen controls at `x=16` and normal/narrow controls at `x=92`.
- The real packaged renderer reported the expected full/narrow computed type values, and the final console-error capture was empty.

## Findings

- P0: none.
- P1: none.
- P2: none.
- P3: session content differs from the source capture by design, and the sidebar border has a one-pixel rasterization variance that does not alter its perceived width.

final result: passed

---

# Desktop mode project actions — Design QA

## Build and evidence

- Reviewed bundle: `/Users/ent/ArcMind/packages/desktop/out/ArcMind-darwin-arm64/ArcMind.app`, built `2026-07-30 03:55:17 CST` from the current workspace rather than `/Applications/ArcMind.app`.
- ASAR verification found `project/deletePreview` and `project/delete` in the protocol, App Server, main, preload, and renderer bundles; `Project actions` and `Rename project` were present in the renderer bundle.
- Packaged screenshots: `/Users/ent/ArcMind/packages/desktop/test-results/design-qa/project-actions/project-menu-normal.png`, `rename-dialog-normal.png`, `delete-loading-normal.png`, `delete-blocker-normal.png`, `delete-ready-narrow.png`, `delete-ready-zoom-200.png`, `delete-deleting-narrow.png`, `delete-error-held-lease.png`, and `delete-success-narrow.png`.
- The Loading capture pauses the real packaged App Server process around the request; it is not a renderer mock. The 200% equivalent uses a `450 × 360` CSS viewport, verifies the dialog and confirmation control are in the viewport, and confirms vertically scrollable reflow.

## Packaged behavior

- The real packaged lifecycle covered mode-scoped rename/pin, a same-folder empty Chat task, active-plus-archived preview, fixed-schedule blocking, schedule removal through the fixture API, one confirmed Trash operation, and exact disk inspection.
- Chat journals, Chat memory, attachments, images, tool outputs, Subagent data, and document-work files moved away. The same-cwd Code journal/memory, source sentinel, Project Skill, trust decision, and global memory remained and reopened successfully.
- A held session lease produced a friendly fail-closed dialog, retained every owned file, and succeeded only after releasing the lease and loading a fresh preview.
- Full packaged E2E passed `5/5` including App Server restart recovery and a blocked renderer catching up with `10,000` deltas. The final plan-scoped packaged smoke passed `3/3` in `39.9s`.

## Performance evidence

- Baseline: RPC cold-ready median `1233.4ms`; one idle RPC process `210.3 MiB`; three idle RPC processes `646.5 MiB`; one idle in-process runtime `207.6 MiB`; three idle in-process runtimes `203.8 MiB`.
- Current Desktop: launch-to-usable median `1068.3ms`; App Server ready median `743.8ms`; three-session RSS ratio `1.012` against a `1.25` budget; first-delta server overhead P95 `54.9ms` against `100ms`; crash recovery P95 `1026.8ms` against `3000ms`; minimum history scroll `60.9 FPS`; maximum virtualized DOM count `22`.
- Every recorded Desktop performance budget passed. Project deletion remains one renderer request and one Trash command; catalog and runtime exclusion locks are project/session scoped, not held globally over Trash or Dream model work.

## Review passes

1. Destructive safety: traced canonical identity, complete active/archive membership, hard-link/symlink and TOCTOU checks, session/project leases, durable manifest staging, reverse rollback, startup recovery, Trash-only success, missing source folders, and every preserved root. Review found and fixed alias/realpath sessions splitting one logical project across storage directories; a red-to-green App Server regression now locks that boundary.
2. Concurrency and recovery: traced catalog project blocking, grouped runtime quiescence, Chat schedule cwd locking, replay IDs, renderer generation guards, Dream scope locks, one evidence serialization, concurrent global/project Dream, and concurrent compaction. Review fixed structured RPC error transport across Electron and distinguishes known server failure (new retry ID) from a lost response (same replay ID).
3. Product and accessibility: traced Chat/Code identity, shared cwd Skills, local mode-scoped rename/pin, active-session cleanup, icon order, keyboard menu navigation, Escape/focus restoration, dialog names/status announcements, reduced motion, narrow layout, and newly built bundle selection. Review added bounded dialog scrolling for high zoom; no P0/P1/P2 issue remains.

## Validation

- Generated protocol check and Protocol tests: `49/49` passed.
- Focused Coding Agent memory/Dream/delete/schedule suites: `124/124` passed.
- Focused App Server: `37/37` passed. Focused Desktop: `70/70` passed.
- Full workspace: Agent `202/202`; AI `493` passed and `733` conditionally skipped; App Server `112/112`; Coding Agent `2417` passed and `52` skipped; Desktop `129/129`; TUI exited `0`.
- Full TypeScript, Desktop main/renderer types, Biome over `251` affected source files, generated schema, package verification, dependency-lock checks, browser smoke, and `git diff --check` passed.
- Root `npm run build` is blocked outside this feature by current remote catalog generation: without proxy, `models.dev` times out and the existing generator removes 26 catalogs; with a curl-captured official response, generation completes but current OpenCode Go metadata adds `openai-responses`, which the existing AI provider type rejects. Generated drift was fully restored. The checked-in AI catalog and every remaining workspace were built successfully offline, and the final packaged bundle/E2E passed afterward.

## Findings

- P0: none.
- P1: none in mode project actions, memory, Dream, schedules, protocol, App Server, Desktop, or packaged behavior.
- P2: none after the alias-storage, IPC error transport, and zoom-reflow fixes.
- External release-infrastructure blocker: current live AI model catalog is incompatible with the existing OpenCode Go provider type; resolving that model-system issue is outside the mode-project plan.

final result: mode-project feature passed; root online model-generation build remains externally blocked as documented above
