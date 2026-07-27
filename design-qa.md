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
