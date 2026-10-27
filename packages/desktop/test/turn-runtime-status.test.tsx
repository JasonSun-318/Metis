// @vitest-environment jsdom

import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	advanceDisplayedTokens,
	estimateOutputTokens,
	TurnRuntimeStatus,
	turnTokenTarget,
} from "../src/renderer/components/TurnRuntimeStatus.tsx";

function assistant(itemId: string, content: ItemContentBlockView[], usage?: ItemView["usage"]): ItemView {
	return {
		itemId,
		sessionId: "session-1",
		turnId: "turn-1",
		role: "assistant",
		state: "streaming",
		content,
		...(usage ? { usage } : {}),
		createdAt: "2026-08-08T00:00:00.000Z",
	};
}

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("TurnRuntimeStatus", () => {
	it("reuses the thinking line for retry progress and clears it on recovery", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(<TurnRuntimeStatus items={[]} running retry={{ attempt: 1, maxAttempts: 5, delayMs: 2000 }} />),
		);
		expect(container.querySelector("output")?.getAttribute("aria-label")).toBe("Retrying (1/5)");
		expect(container.querySelectorAll(".turn-runtime-spinner")).toHaveLength(1);
		await act(async () =>
			root.render(<TurnRuntimeStatus items={[]} running retry={{ attempt: 5, maxAttempts: 5, delayMs: 30_000 }} />),
		);
		expect(container.textContent).toContain("Retrying (5/5)");
		await act(async () => root.render(<TurnRuntimeStatus items={[]} running />));
		expect(container.textContent).toContain("Thinking");
		expect(container.textContent).not.toContain("Retrying");
		await act(async () => root.unmount());
	});
	it("estimates current-turn output and eases toward corrected targets", () => {
		expect(estimateOutputTokens("hello world")).toBe(3);
		expect(estimateOutputTokens("请分析代码")).toBe(5);
		expect(
			turnTokenTarget([
				assistant("exact", [{ type: "thinking", text: "分析" }], { outputTokens: 20 }),
				assistant("estimated", [{ type: "text", text: "final answer" }]),
			]),
		).toEqual({ tokens: 23, exact: false });
		expect(advanceDisplayedTokens(0, 44)).toBe(11);
		expect(advanceDisplayedTokens(43, 44)).toBe(44);
		expect(advanceDisplayedTokens(50, 44)).toBe(48);
	});

	it("estimates streaming output while a provider reports placeholder zero usage", () => {
		const target = turnTokenTarget([
			assistant("placeholder", [{ type: "text", text: "正在分析当前代码并准备结果" }], { outputTokens: 0 }),
		]);
		expect(target.tokens).toBeGreaterThan(0);
		expect(target.exact).toBe(false);
	});

	it("renders one local spinner and cleans up its progress timer", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const items = [assistant("streaming", [{ type: "text", text: "正在分析当前代码并准备结果" }])];

		await act(async () =>
			root.render(<TurnRuntimeStatus items={items} running startedAt="2026-08-08T00:00:00.000Z" />),
		);
		const status = container.querySelector(".turn-runtime-status");
		expect(status?.textContent).toContain("0s");
		expect(status?.textContent).toContain("0 tokens");
		expect(status?.textContent).toContain("Thinking");
		expect(container.querySelectorAll(".turn-runtime-spinner > span")).toHaveLength(6);

		await act(async () => vi.advanceTimersByTimeAsync(100));
		const first = Number(container.querySelector("[data-runtime-tokens]")?.getAttribute("data-runtime-tokens"));
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(turnTokenTarget(items).tokens);

		await act(async () => vi.advanceTimersByTimeAsync(900));
		expect(status?.textContent).toContain("1s");

		await act(async () =>
			root.render(<TurnRuntimeStatus items={items} running={false} startedAt="2026-08-08T00:00:00.000Z" />),
		);
		expect(container.querySelector(".turn-runtime-status")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		await act(async () => root.unmount());
	});

	it("resets token progress and elapsed time only when the run identity changes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const runA = [assistant("a", [{ type: "text", text: "正在分析当前代码并准备结果" }])];
		const runB = [assistant("b", [{ type: "text", text: "新的任务正在执行" }])];

		await act(async () =>
			root.render(<TurnRuntimeStatus items={runA} running runId="run-a" startedAt="2026-08-08T00:00:00.000Z" />),
		);
		await act(async () => vi.advanceTimersByTimeAsync(1_200));
		const output = container.querySelector("output");
		expect(output?.textContent).toContain("1s");
		expect(Number(output?.getAttribute("data-runtime-tokens"))).toBeGreaterThan(0);

		await act(async () => root.render(<TurnRuntimeStatus items={runB} running runId="run-b" />));
		expect(container.querySelector("output")).toBe(output);
		expect(output?.textContent).toContain("0s");
		expect(output?.textContent).toContain("0 tokens");
		expect(vi.getTimerCount()).toBe(1);
		await act(async () => root.unmount());
	});

	it("applies a corrected start time for the same run without resetting token progress", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const items = [assistant("streaming", [{ type: "text", text: "正在分析当前代码并准备结果" }])];

		await act(async () =>
			root.render(<TurnRuntimeStatus items={items} running runId="run-a" startedAt="2026-08-08T00:00:00.000Z" />),
		);
		await act(async () => vi.advanceTimersByTimeAsync(5_200));
		const output = container.querySelector("output");
		expect(output?.textContent).toContain("5s");
		const tokens = output?.getAttribute("data-runtime-tokens");

		await act(async () =>
			root.render(<TurnRuntimeStatus items={items} running runId="run-a" startedAt="2026-08-08T00:00:02.000Z" />),
		);
		expect(output?.textContent).toContain("3s");
		expect(output?.getAttribute("data-runtime-tokens")).toBe(tokens);
		expect(vi.getTimerCount()).toBe(1);
		await act(async () => root.unmount());
	});

	it("does not schedule progress while waiting for an answer", async () => {
		vi.useFakeTimers();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TurnRuntimeStatus items={[]} running waitingForAnswer={true} />));
		expect(container.textContent).toContain("Waiting for your answer");
		expect(vi.getTimerCount()).toBe(0);
		await act(async () => root.unmount());
	});

	it("replaces token progress with the compaction state", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<TurnRuntimeStatus items={[]} running startedAt="2026-08-08T00:00:00.000Z" variant="compaction" />,
			),
		);
		expect(container.querySelector("output")?.textContent).toContain("Compacting conversation");
		expect(container.querySelector("[data-runtime-tokens]")).toBeNull();
		expect(container.textContent).not.toContain("tokens");
		await act(async () => root.unmount());
	});
});
