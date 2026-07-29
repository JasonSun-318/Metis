import type { Component } from "@arcmind/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode /dream", () => {
	beforeAll(() => initTheme("dark"));

	it("shows active state and the latest ten metadata records", () => {
		const addChild = vi.fn();
		const requestRender = vi.fn();
		const getDreamStatus = vi.fn(() => ({
			enabled: true,
			active: {
				id: "active",
				sessionId: "session",
				mode: "chat" as const,
				cwd: "/Users/ent/ArcMind",
				trigger: "manual" as const,
				startedAt: "2026-07-15T06:00:00.000Z",
			},
			recent: Array.from({ length: 10 }, (_, index) => ({
				id: `run-${index}`,
				sessionId: "session",
				mode: "chat" as const,
				cwd: "/Users/ent/ArcMind",
				trigger: "threshold" as const,
				startedAt: "2026-07-15T05:00:00.000Z",
				completedAt: "2026-07-15T05:00:01.000Z",
				durationMs: 1000,
				global: {
					status: "success" as const,
					changes: { created: [], updated: ["MEMORY.md"], deleted: [] },
					durationMs: 500,
				},
				project: {
					status: "success" as const,
					changes: { created: [], updated: ["project.md"], deleted: [] },
					durationMs: 500,
				},
			})),
		}));
		const context = {
			session: { getDreamStatus },
			chatContainer: { addChild },
			ui: { requestRender },
		};
		const handler = Reflect.get(InteractiveMode.prototype, "handleDreamCommand") as (this: typeof context) => void;

		handler.call(context);

		expect(getDreamStatus).toHaveBeenCalledWith(10);
		expect(addChild).toHaveBeenCalledTimes(2);
		const rendered = addChild.mock.calls
			.map(([component]) => component as Component)
			.flatMap((component) => component.render(1000))
			.join("\n");
		expect(rendered).toContain("running");
		expect(rendered).toContain("success");
		expect(rendered).toContain("/Users/ent/ArcMind");
		expect(requestRender).toHaveBeenCalled();
	});
});
