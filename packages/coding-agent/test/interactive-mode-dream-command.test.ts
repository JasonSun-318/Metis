import type { Component } from "@metis/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode /dream", () => {
	beforeAll(() => initTheme("dark"));

	it("shows active extract state and recent runs", () => {
		const addChild = vi.fn();
		const requestRender = vi.fn();
		const getMemoryExtractStatus = vi.fn(() => ({
			enabled: true,
			active: {
				id: "active",
				sessionId: "session",
				mode: "chat" as const,
				extractMode: "reconcile" as const,
				cwd: "/Users/ent/Metis",
				trigger: "manual",
				startedAt: "2026-07-15T06:00:00.000Z",
			},
			recent: Array.from({ length: 10 }, (_, index) => ({
				id: `run-${index}`,
				startedAt: "2026-07-15T05:00:00.000Z",
				trigger: "threshold",
				status: "success" as const,
				reason: null,
			})),
		}));
		const context = {
			session: { getMemoryExtractStatus },
			chatContainer: { addChild },
			ui: { requestRender },
		};
		const handler = Reflect.get(InteractiveMode.prototype, "handleDreamCommand") as (this: typeof context) => void;

		handler.call(context);

		expect(getMemoryExtractStatus).toHaveBeenCalledWith(10);
		expect(addChild).toHaveBeenCalledTimes(2);
		const rendered = addChild.mock.calls
			.map(([component]) => component as Component)
			.flatMap((component) => component.render(1000))
			.join("\n");
		expect(rendered).toContain("running");
		expect(rendered).toContain("success");
		expect(rendered).toContain("/Users/ent/Metis");
		expect(requestRender).toHaveBeenCalled();
	});
});
