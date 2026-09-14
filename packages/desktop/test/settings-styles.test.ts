// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

let parsedRules: CSSStyleRule[] | null = null;
function rule(selector: string): CSSStyleDeclaration {
	if (!parsedRules) {
		const style = document.createElement("style");
		style.textContent = css;
		document.head.replaceChildren(style);
		parsedRules = Array.from(style.sheet?.cssRules ?? []) as CSSStyleRule[];
	}
	const match = parsedRules.find((candidate) => candidate.selectorText === selector);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("Settings visual states", () => {
	it("uses compact Windows title spacing without changing the macOS traffic-light area", () => {
		expect(rule(':root[data-platform="win32"] .settings-backdrop').top).toBe("32px");
		const windowsNavigationTop = rule(':root[data-platform="win32"] .settings-navigation-top');
		expect(windowsNavigationTop.height).toBe("0px");
		expect(windowsNavigationTop.marginBottom).toBe("0px");
		expect(rule(':root[data-platform="win32"] .settings-main').gridTemplateRows).toBe("40px minmax(0, 1fr)");
		expect(rule(':root[data-platform="win32"] .settings-main-header').height).toBe("40px");
		expect(rule(".settings-navigation-top").height).toBe("52px");
		expect(rule(".settings-back-button").height).toBe("36px");
		expect(rule(".settings-nav-divider").marginTop).toBe("3px");
	});

	it("uses restrained overlays and a flatter content hierarchy", () => {
		expect(rule(".settings-backdrop").background).toBe("var(--app-bg)");
		expect(rule(".settings-backdrop").padding).toBe("0px");
		expect(rule(".model-provider-grid").gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
		expect(rule(".usage-detail-card").borderWidth).toBe("0px");
		expect(rule(".usage-detail-card").borderRadius).toBe("0px");
		expect(rule(".usage-detail-card").background).toBe("transparent");
		expect(rule(".usage-detail-card").padding).toBe("4px 16px");
		expect(rule(".model-provider-card small").color).toBe("var(--text-10)");
		expect(rule(".usage-metric-card small").color).toBe("var(--text-10)");
		expect(rule(".usage-chart-axis").color).toBe("var(--text-10)");
		expect(rule(".usage-chart-axis").fontSize).toBe("11px");
		expect(rule(".usage-detail-card li small").color).toBe("var(--text-09)");
		expect(rule(".memory-engine-card-desc").color).toBe("var(--text-10)");
		expect(rule(".profile-section-heading small").color).toBe("var(--text-09)");
		expect(rule(".profile-section-heading small").fontSize).toBe("11px");
	});

	it("groups Memory engines as two flat choices inside one shared surface", () => {
		expect(rule(".memory-engine-grid").gap).toBe("0px");
		expect(rule(".memory-engine-grid").background).toBe("var(--surface-02)");
		expect(rule(".memory-engine-grid").padding).toBe("0px");
		expect(rule(".memory-engine-card").borderWidth).toBe("0px");
		expect(rule(".memory-engine-card").borderRadius).toBe("0px");
		expect(rule(".memory-engine-card").background).toBe("transparent");
		expect(rule(".memory-engine-card + .memory-engine-card").borderLeft).toBe("1px solid var(--border-weak)");
	});

	it("keeps API key text clear of the reveal control", () => {
		const style = document.createElement("style");
		style.textContent = css;
		document.head.append(style);
		const page = document.createElement("div");
		page.className = "settings-page";
		page.innerHTML =
			'<div class="web-search-api-key-field"><input type="text"><button class="web-search-api-key-reveal"></button></div>';
		document.body.append(page);

		const input = page.querySelector("input")!;
		const reveal = page.querySelector("button")!;
		expect(Number.parseFloat(getComputedStyle(input).paddingRight)).toBeGreaterThan(
			Number.parseFloat(getComputedStyle(reveal).width),
		);
		expect(getComputedStyle(reveal).backgroundColor).not.toBe("transparent");
	});

	it("scopes Auto command allowlist styles and avoids global form selectors", () => {
		const style = document.createElement("style");
		style.textContent = css;
		document.head.replaceChildren(style);
		const selectors = Array.from(style.sheet?.cssRules ?? [])
			.filter((candidate): candidate is CSSStyleRule => candidate instanceof CSSStyleRule)
			.map((candidate) => candidate.selectorText);
		expect(selectors.some((selector) => selector.startsWith(".auto-command-allowlist-page"))).toBe(true);
		expect(
			selectors
				.filter((selector) => selector.includes("auto-command-allowlist"))
				.every((selector) => selector.includes(".auto-command-allowlist-page")),
		).toBe(true);
	});

	it("renders the Auto command allowlist as one card with switch, chips, and banners", () => {
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-form").padding).toBe("12px 16px");
		expect(rule('.auto-command-allowlist-page .auto-command-allowlist-form input[type="text"]').flex).toBe("1 1 0%");
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-toggle").display).toBe("inline-flex");
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-toggle-track").width).toBe("36px");
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-toggle-track").height).toBe("22px");
		expect(
			rule(
				".auto-command-allowlist-page .auto-command-allowlist-toggle input:checked + .auto-command-allowlist-toggle-track",
			).background,
		).toBe("var(--accent)");
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-rules").borderTop).toBe(
			"1px solid var(--border-weak)",
		);
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-chip").borderRadius).toBe("999px");
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-chip > button").borderRadius).toBe("999px");
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-empty").justifyItems).toBe("center");
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-footer").borderTop).toBe(
			"1px solid var(--border-weak)",
		);
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-add-all").justifySelf).toBe("start");
		expect(rule(".auto-command-allowlist-page .auto-command-allowlist-info svg").color).toBe("var(--text-14)");
	});
});
