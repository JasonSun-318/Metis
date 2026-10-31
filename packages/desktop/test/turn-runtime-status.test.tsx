// @vitest-environment jsdom

import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("TurnRuntimeStatus", () => {
	it("reuses the activity line for retry progress and clears it on recovery", async () => {
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

	it("distinguishes streaming estimates from completed provider usage", () => {
		expect(estimateOutputTokens("hello world")).toBe(3);
		expect(estimateOutputTokens("请分析代码")).toBe(5);
		expect(
			turnTokenTarget([
				assistant("reported", [{ type: "thinking", text: "分析" }], { outputTokens: 20 }),
				assistant("estimated", [{ type: "text", text: "final answer" }]),
			]),
		).toEqual({ tokens: 23, exact: false });
		const completed = { ...assistant("exact", [], { outputTokens: 42 }), state: "completed" as const };
		expect(turnTokenTarget([completed])).toEqual({ tokens: 42, exact: true });
	});

	it("keeps token estimates useful when the provider reports placeholder zero usage", () => {
		const target = turnTokenTarget([
			assistant("placeholder", [{ type: "text", text: "正在分析当前代码并准备结果" }], { outputTokens: 0 }),
		]);
		expect(target.tokens).toBeGreaterThan(0);
		expect(target.exact).toBe(false);
	});

	it("shows only activity initially, reveals elapsed after three seconds, and cleans up its timer", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TurnRuntimeStatus items={[]} running startedAt="2026-08-08T00:00:00.000Z" />));
		expect(container.querySelector(".turn-runtime-elapsed")).toBeNull();
		expect(container.querySelector("details")).toBeNull();
		expect(container.textContent).toBe("Thinking…");
		await act(async () => vi.advanceTimersByTimeAsync(2999));
		expect(container.querySelector(".turn-runtime-elapsed")).toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(container.querySelector(".turn-runtime-elapsed")?.textContent).toBe("3s");
		expect(container.querySelector(".turn-runtime-elapsed")?.getAttribute("aria-hidden")).toBe("true");
		await act(async () => root.render(<TurnRuntimeStatus items={[]} running={false} />));
		expect(container.querySelector(".turn-runtime-status")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		await act(async () => root.unmount());
	});

	it("acknowledges a slow first output and resumes the normal label as content arrives", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<TurnRuntimeStatus items={[]} running runId="slow" />));
			await act(async () => vi.advanceTimersByTimeAsync(19_000));
			expect(container.querySelector("output")?.textContent).toBe("Thinking…");
			await act(async () => vi.advanceTimersByTimeAsync(1000));
			expect(container.querySelector("output")?.textContent).toBe("Still waiting for model output…");
			await act(async () =>
				root.render(
					<TurnRuntimeStatus
						items={[assistant("thought", [{ type: "thinking", text: "Working through the request" }])]}
						running
						runId="slow"
					/>,
				),
			);
			expect(container.querySelector("output")?.textContent).toBe("Thinking…");
			await act(async () => root.render(<TurnRuntimeStatus items={[]} running runId="next" />));
			expect(container.querySelector("output")?.textContent).toBe("Thinking…");
			expect(container.querySelector(".turn-runtime-elapsed")).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("shows estimated and exact tokens inline after the activity without a disclosure", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const items = [assistant("streaming", [{ type: "thinking", text: "请分析代码" }])];
		await act(async () => root.render(<TurnRuntimeStatus items={items} running />));
		expect(container.querySelector("details, summary")).toBeNull();
		expect(container.querySelector(".turn-runtime-usage")?.textContent).toContain("≈ 5 tokens");
		expect(container.querySelector("output")?.textContent).toBe("Thinking…");
		await act(async () =>
			root.render(
				<TurnRuntimeStatus items={[{ ...items[0]!, state: "completed", usage: { outputTokens: 1284 } }]} running />,
			),
		);
		expect(container.querySelector(".turn-runtime-usage")?.textContent).toContain("1,284 tokens");
		expect(container.querySelector(".turn-runtime-usage")?.textContent).not.toContain("≈");
		await act(async () => root.unmount());
	});

	it("changes activity with real tools and keeps the writing label alongside usage", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const read: ItemContentBlockView = { type: "tool_call", toolCallId: "read-1", name: "read", state: "running" };
		await act(async () => root.render(<TurnRuntimeStatus items={[assistant("read", [read])]} running />));
		expect(container.querySelector("output")?.getAttribute("aria-label")).toBe("Reading files…");
		await act(async () =>
			root.render(
				<TurnRuntimeStatus
					items={[
						assistant("read", [
							read,
							{
								type: "tool_result",
								toolCallId: "read-1",
								name: "read",
								isError: false,
								output: "file contents",
							},
						]),
					]}
					running
				/>,
			),
		);
		expect(container.querySelector("output")?.getAttribute("aria-label")).toBe("Thinking…");
		await act(async () =>
			root.render(
				<TurnRuntimeStatus
					items={[
						assistant("bash", [{ type: "tool_call", toolCallId: "bash-1", name: "bash", state: "running" }]),
					]}
					running
				/>,
			),
		);
		expect(container.querySelector("output")?.getAttribute("aria-label")).toBe("Running a command");
		await act(async () =>
			root.render(
				<TurnRuntimeStatus
					items={[assistant("reply", [{ type: "text", text: "Here is the answer" }])]}
					running
					replyVisible
				/>,
			),
		);
		expect(container.querySelector(".turn-runtime-label")?.textContent).toBe("Writing reply…");
		expect(container.querySelector("output")?.getAttribute("aria-label")).toBe("Writing reply…");
		await act(async () => root.unmount());
	});

	it("resets elapsed on a new run, and accepts corrected start times", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const items = [assistant("streaming", [{ type: "thinking", text: "分析代码" }])];
		await act(async () =>
			root.render(<TurnRuntimeStatus items={items} running runId="run-a" startedAt="2026-08-08T00:00:00.000Z" />),
		);
		await act(async () => vi.advanceTimersByTimeAsync(5200));
		expect(container.querySelector(".turn-runtime-elapsed")?.textContent).toBe("5s");
		await act(async () =>
			root.render(<TurnRuntimeStatus items={items} running runId="run-a" startedAt="2026-08-08T00:00:02.000Z" />),
		);
		expect(container.querySelector(".turn-runtime-elapsed")?.textContent).toBe("3s");
		await act(async () => vi.advanceTimersByTimeAsync(0));
		await act(async () => root.render(<TurnRuntimeStatus items={items} running runId="run-b" />));
		expect(container.querySelector(".turn-runtime-elapsed")).toBeNull();
		expect(container.querySelector("details")).toBeNull();
		expect(vi.getTimerCount()).toBe(1);
		await act(async () => root.unmount());
	});

	it("does not schedule progress while waiting for an answer", async () => {
		vi.useFakeTimers();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TurnRuntimeStatus items={[]} running waitingForAnswer />));
		expect(container.textContent).toContain("Waiting for your answer");
		expect(vi.getTimerCount()).toBe(0);
		await act(async () => root.unmount());
	});

	it("replaces token details with the compaction state", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TurnRuntimeStatus items={[]} running variant="compaction" />));
		expect(container.querySelector("output")?.textContent).toContain("Compacting conversation");
		expect(container.querySelector("[data-runtime-tokens]")).toBeNull();
		expect(container.querySelector("details")).toBeNull();
		await act(async () => root.unmount());
	});
});
