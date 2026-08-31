/**
 * Test that BashExecutionComponent's collapsed output respects the render-time width,
 * not a stale captured width. Regression test for #2569.
 */
import { visibleWidth } from "@metis/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** Minimal TUI stub that only exposes terminal.columns */
function createTuiStub(columns: number): { columns: number; stub: any } {
	const state = { columns };
	const stub = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return 24;
			},
		},
		// Loader calls ui.addInterval / ui.removeInterval
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return { columns: state.columns, stub };
}

describe("BashExecutionComponent width handling (#2569)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("collapsed preview lines respect render-time width, not construction-time width", () => {
		const wideWidth = 200;
		const narrowWidth = 80;

		const { stub } = createTuiStub(wideWidth);
		const component = new BashExecutionComponent("pwd", stub);

		// Add output with long lines that will wrap differently at different widths
		const longLine = "x".repeat(150);
		component.appendOutput(`${longLine}\n${longLine}\n`);

		// Complete the command so it enters collapsed mode
		component.setComplete(0, false);

		// Render at the narrow width (simulating a resize or split pane)
		const lines = component.render(narrowWidth);

		// Every rendered line must fit within the narrow width
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]);
			expect(w, `Line ${i} visibleWidth=${w} > ${narrowWidth}`).toBeLessThanOrEqual(narrowWidth);
		}
	});

	it("re-computes lines when width changes between renders", () => {
		const { stub } = createTuiStub(200);
		const component = new BashExecutionComponent("echo hello", stub);

		const longLine = "abcdefghij".repeat(20); // 200 chars
		component.appendOutput(`${longLine}\n`);
		component.setComplete(0, false);

		// First render at width 200
		const lines200 = component.render(200);
		for (const line of lines200) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}

		// Second render at width 60 (split pane scenario)
		const lines60 = component.render(60);
		for (let i = 0; i < lines60.length; i++) {
			const w = visibleWidth(lines60[i]);
			expect(w, `Line ${i} visibleWidth=${w} > 60`).toBeLessThanOrEqual(60);
		}
	});

	it("keeps streaming display state bounded while preserving exact raw output", () => {
		const { stub } = createTuiStub(120);
		const component = new BashExecutionComponent("build", stub);
		const chunks = Array.from({ length: 2_000 }, (_, index) => `line-${index}-${"x".repeat(80)}\n`);
		for (const chunk of chunks) component.appendOutput(chunk);

		expect(component.getOutput()).toBe(chunks.join(""));
		const displayTail = (component as unknown as { displayTail: string }).displayTail;
		expect(Buffer.byteLength(displayTail, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});
});
