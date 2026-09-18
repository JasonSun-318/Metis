// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStatusPanel } from "../src/renderer/components/SessionStatusPanel.tsx";

afterEach(() => document.body.replaceChildren());

describe("SessionStatusPanel", () => {
	it("shows only the requested session metrics and closes with Escape", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onClose = vi.fn();
		await act(async () =>
			root.render(
				<SessionStatusPanel
					loading={false}
					onClose={onClose}
					status={{
						sessionId: "session-1",
						mode: "code",
						contextTokens: 64_000,
						contextWindow: 128_000,
						contextBasis: "reported_total",
						contextBreakdown: [
							{ category: "system_prompt", tokens: 4_000 },
							{ category: "tool_definitions", tokens: 8_000 },
							{ category: "conversation", tokens: 52_000 },
						],
						remainingPercent: 50,
						cacheHitPercent: 24.6,
					}}
				/>,
			),
		);
		expect(container.textContent).toContain("Context Usage");
		expect(container.textContent).toContain("50% Full");
		expect(container.textContent).toContain("~64.0K / 128K");
		expect(container.querySelectorAll(".context-usage-segment")).toHaveLength(3);
		expect(
			container.querySelector('.context-usage-breakdown > li[data-category="system_prompt"]')?.textContent,
		).toContain("System prompt");
		expect(
			container.querySelector('.context-usage-breakdown > li[data-category="system_prompt"]')?.textContent,
		).toContain("6.3%");
		expect(
			container.querySelector('.context-usage-breakdown > li[data-category="conversation"]')?.textContent,
		).toContain("81.3%");
		expect(container.textContent).not.toContain("Reported total; fixed modules calibrated for this model");
		expect(container.textContent).not.toContain("Other");
		expect(container.querySelector(".context-usage-bar-used")?.getAttribute("style")).toMatch(/width:\s*50%/);
		expect(container.textContent).toContain("Cache hit rate (latest completed request)");
		expect(container.textContent).toContain("category shares are estimates of used tokens");
		expect(container.textContent).toContain("24.6%");
		expect(container.querySelector(".context-usage-cache-track")?.getAttribute("aria-valuenow")).toBe("24.6");
		expect(container.querySelector(".context-usage-cache-meter")?.getAttribute("style")).toMatch(/width:\s*24\.6%/);
		expect(container.textContent).not.toContain("session-1");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(onClose).toHaveBeenCalledOnce();
		await act(async () => root.unmount());
	});

	it("keeps the visual fill bounded while showing an exceeded context", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<SessionStatusPanel
					loading={false}
					onClose={() => undefined}
					status={{
						sessionId: "session-1",
						mode: "code",
						contextTokens: 144_000,
						contextWindow: 128_000,
						contextBasis: "estimated_total",
						contextBreakdown: [{ category: "conversation", tokens: 144_000 }],
						remainingPercent: 0,
						cacheHitPercent: null,
					}}
				/>,
			),
		);
		expect(container.textContent).toContain("112.5% Full");
		expect(container.textContent).toContain("Context exceeded");
		expect(container.textContent).not.toContain("Context and breakdown estimated");
		expect(container.querySelector(".context-usage-bar-used")?.getAttribute("style")).toMatch(/width:\s*100%/);
		await act(async () => root.unmount());
	});

	it("keeps the reported total when no trustworthy breakdown is available", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<SessionStatusPanel
					loading={false}
					onClose={() => undefined}
					status={{
						sessionId: "session-1",
						mode: "code",
						contextTokens: 64_000,
						contextWindow: 128_000,
						contextBasis: "reported_total",
						contextBreakdown: null,
						remainingPercent: 50,
						cacheHitPercent: null,
					}}
				/>,
			),
		);
		expect(container.textContent).toContain("~64.0K / 128K");
		expect(container.textContent).toContain("Context breakdown unavailable");
		expect(container.querySelector(".context-usage-breakdown")).toBeNull();
		expect(container.textContent).toContain("Cache usage not reported");
		expect(container.querySelector(".context-usage-cache-track")).toBeNull();
		await act(async () => root.unmount());
	});
});
