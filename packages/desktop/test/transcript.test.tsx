// @vitest-environment jsdom

import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import type { FileDiffMetadata } from "@pierre/diffs";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeTranscriptTurn } from "../src/renderer/components/CodeTranscriptTurn.tsx";
import {
	shouldAdjustTranscriptScroll,
	shouldFollowTranscript,
	Transcript,
} from "../src/renderer/components/Transcript.tsx";
import { TranscriptTurn } from "../src/renderer/components/TranscriptTurn.tsx";
import { messageText } from "../src/renderer/components/transcript-turn-model.ts";

vi.mock("@pierre/diffs/react", () => ({
	FileDiff: ({ fileDiff }: { readonly fileDiff: FileDiffMetadata }) => (
		<pre data-testid="visual-diff">{[...fileDiff.deletionLines, ...fileDiff.additionLines].join("")}</pre>
	),
	WorkerPoolContextProvider: ({ children }: { readonly children: ReactNode }) => children,
}));

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "turn-1";
const LONG_THINKING = "用户希望查看桌面内容。我需要先取得目录访问，然后运行命令确认文件列表。".repeat(24);

class TriggerResizeObserver implements ResizeObserver {
	static readonly instances: TriggerResizeObserver[] = [];
	readonly targets = new Set<Element>();
	private readonly callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		TriggerResizeObserver.instances.push(this);
	}

	disconnect(): void {
		this.targets.clear();
	}

	observe(target: Element): void {
		this.targets.add(target);
	}

	unobserve(target: Element): void {
		this.targets.delete(target);
	}

	static trigger(target: Element): void {
		const entry = { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry;
		for (const observer of TriggerResizeObserver.instances) {
			if (observer.targets.has(target)) observer.callback([entry], observer);
		}
	}
}

function item(
	itemId: string,
	role: ItemView["role"],
	content: ItemContentBlockView[],
	state: ItemView["state"] = "completed",
): ItemView {
	return {
		itemId,
		sessionId: SESSION_ID,
		turnId: TURN_ID,
		role,
		state,
		content,
		createdAt: "2026-07-22T00:00:00.000Z",
		...(state === "completed" ? { completedAt: "2026-07-22T00:00:01.000Z" } : {}),
	};
}

const turnItems: ItemView[] = [
	item("user-1", "user", [{ type: "text", text: "看看桌面有什么" }]),
	item("assistant-plan", "assistant", [
		{ type: "thinking", text: LONG_THINKING },
		{ type: "text", text: "我需要先请求访问你的桌面文件夹才能查看里面的内容。" },
		{
			type: "tool_call",
			toolCallId: "tool-folder",
			name: "request_cowork_directory",
			state: "completed",
		},
	]),
	item("folder-result", "tool", [
		{
			type: "tool_result",
			toolCallId: "tool-folder",
			name: "request_cowork_directory",
			isError: false,
			output: "/Users/ent/Desktop",
		},
	]),
	item("assistant-command", "assistant", [
		{ type: "thinking", text: "目录已经连接，现在列出其中的文件。" },
		{
			type: "tool_call",
			toolCallId: "tool-command",
			name: "bash",
			state: "completed",
			inputPreview: JSON.stringify({ command: "ls -la /Users/ent/Desktop" }),
		},
	]),
	item("command-result", "tool", [
		{ type: "tool_result", toolCallId: "tool-command", name: "bash", isError: false, output: "file.txt" },
	]),
	item("assistant-synthesis", "assistant", [{ type: "thinking", text: "文件列表已经取得，整理为简洁回答。" }]),
	item("assistant-final", "assistant", [{ type: "text", text: "桌面上有 file.txt。" }]),
];

afterEach(() => document.body.replaceChildren());

describe("TranscriptTurn", () => {
	it.each([
		["chat", TranscriptTurn],
		["code", CodeTranscriptTurn],
	] as const)(
		"keeps a %s provider failure notice visible after recovery without presenting failure as an answer",
		async (_mode, Turn) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const onCopy = vi.fn();
			const onFork = vi.fn();
			const failure: ItemView = {
				...item("provider-failure", "assistant", [
					{ type: "notice", level: "error", text: "The model provider could not complete the request." },
				]),
				state: "interrupted",
			};
			const failed = [turnItems[0]!, failure];
			try {
				await act(async () => root.render(<Turn items={failed} onCopy={onCopy} onFork={onFork} />));
				expect(container.querySelectorAll(".notice-error")).toHaveLength(1);
				expect(container.querySelector(".notice-error")?.textContent).toBe(
					"The model provider could not complete the request.",
				);
				expect(container.querySelector("[data-transcript-answer]")).toBeNull();
				expect(container.querySelector(".turn-fork-button")).toBeNull();
				const recovered = [...failed, turnItems.at(-1)!];
				await act(async () => root.render(<Turn items={recovered} onCopy={onCopy} onFork={onFork} />));
				expect(container.querySelectorAll(".notice-error")).toHaveLength(1);
				expect(container.querySelectorAll("[data-transcript-answer]")).toHaveLength(1);
				expect(container.querySelector("[data-transcript-answer]")?.textContent).toContain("桌面上有 file.txt。");
				expect(container.querySelector("[data-transcript-answer]")?.textContent).not.toContain("model provider");
			} finally {
				await act(async () => root.unmount());
			}
		},
	);

	it.each([
		["chat", TranscriptTurn],
		["code", CodeTranscriptTurn],
	] as const)("updates %s memoized rows when callbacks or items change", async (_appearance, Turn) => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const firstCopy = vi.fn();
		const nextCopy = vi.fn();
		const completed = item("memo-reply", "assistant", [{ type: "text", text: "First reply" }]);
		try {
			await act(async () => root.render(<Turn items={[completed]} onCopy={firstCopy} />));
			await act(async () => root.render(<Turn items={[completed]} onCopy={nextCopy} />));
			await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click());
			expect(firstCopy).not.toHaveBeenCalled();
			expect(nextCopy).toHaveBeenLastCalledWith("First reply");

			const updated = item("memo-reply", "assistant", [{ type: "text", text: "Updated reply" }]);
			await act(async () => root.render(<Turn items={[updated]} onCopy={nextCopy} />));
			expect(container.textContent).toContain("Updated reply");
			expect(container.textContent).not.toContain("First reply");
			await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click());
			expect(nextCopy).toHaveBeenLastCalledWith("Updated reply");
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps one ordered execution chain across intermediate progress text", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<TranscriptTurn
					items={[
						item("ordered-user", "user", [{ type: "text", text: "继续处理" }]),
						item("ordered-first", "assistant", [
							{ type: "thinking", text: "先读取当前状态。" },
							{ type: "tool_call", toolCallId: "ordered-read", name: "read", state: "completed" },
						]),
						item("ordered-read-result", "tool", [
							{ type: "tool_result", toolCallId: "ordered-read", name: "read", isError: false, output: "ok" },
						]),
						item("ordered-update", "assistant", [{ type: "text", text: "状态已读取，现在继续修改。" }]),
						item("ordered-second", "assistant", [
							{ type: "thinking", text: "根据读取结果执行修改。" },
							{ type: "tool_call", toolCallId: "ordered-edit", name: "edit", state: "completed" },
						]),
						item("ordered-edit-result", "tool", [
							{ type: "tool_result", toolCallId: "ordered-edit", name: "edit", isError: false, output: "done" },
						]),
						item("ordered-final", "assistant", [{ type: "text", text: "修改完成。" }]),
					]}
				/>,
			),
		);

		const chains = [...container.querySelectorAll<HTMLElement>(".execution-chain")];
		const chain = chains[0]!;
		const firstThought = [...chain.querySelectorAll("p")].find((node) => node.textContent === "先读取当前状态。");
		const update = [...chain.querySelectorAll("p")].find((node) => node.textContent === "状态已读取，现在继续修改。");
		const secondThought = [...chain.querySelectorAll("p")].find(
			(node) => node.textContent === "根据读取结果执行修改。",
		);
		const final = container.querySelector<HTMLElement>("[data-transcript-answer]");
		expect(chains).toHaveLength(1);
		expect(container.querySelector(".turn-intermediate")).toBeNull();
		expect(chain.querySelector(".activity-step-dot")).toBeNull();
		expect(firstThought!.compareDocumentPosition(update!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(update!.compareDocumentPosition(secondThought!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(chain.compareDocumentPosition(final!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

		await act(async () => root.unmount());
	});

	it.each(["chat", "code"] as const)(
		"places a same-turn steer after earlier %s assistant content",
		async (appearance) => {
			(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const items = [
				item("steer-user", "user", [{ type: "text", text: "写一篇介绍" }]),
				item("steer-first", "assistant", [{ type: "text", text: "这是第一段。" }]),
				item("steer-guide", "user", [{ type: "text", text: "改成更短" }]),
				item("steer-final", "assistant", [{ type: "text", text: "更短的介绍。" }]),
			];
			const Turn = appearance === "chat" ? TranscriptTurn : CodeTranscriptTurn;
			await act(async () => root.render(<Turn items={items} running />));

			const users = [
				...container.querySelectorAll<HTMLElement>(appearance === "chat" ? ".turn-user" : ".code-turn-user"),
			];
			const first = container.querySelector<HTMLElement>(
				appearance === "chat" ? ".turn-intermediate" : ".code-turn-status",
			);
			const final = container.querySelector<HTMLElement>("[data-transcript-answer]");
			expect(users).toHaveLength(2);
			expect(users[0]!.textContent).toContain("写一篇介绍");
			expect(users[1]!.textContent).toContain("改成更短");
			expect(users[1]!.classList.contains("is-entering")).toBe(true);
			expect(first?.textContent).toContain("这是第一段。");
			expect(final?.textContent).toContain("更短的介绍。");
			expect(users[0]!.compareDocumentPosition(first!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
			expect(first!.compareDocumentPosition(users[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
			expect(users[1]!.compareDocumentPosition(final!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

			await act(async () => root.unmount());
		},
	);

	it("matches the collapsed, height-capped, show-more, and nested-command states", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const defaultResizeObserver = globalThis.ResizeObserver;
		Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TriggerResizeObserver });
		TriggerResizeObserver.instances.length = 0;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TranscriptTurn items={turnItems} />));

		const chains = [...container.querySelectorAll<HTMLDetailsElement>("details.execution-chain")];
		expect(chains).toHaveLength(1);
		const chain = chains[0]!;
		expect(chain.open).toBe(false);
		expect(chain.querySelector(":scope > summary")?.textContent).toContain("Execution complete");
		expect(chain.querySelector(":scope > .transcript-drawer")?.hasAttribute("inert")).toBe(true);
		expect(chain.querySelector(".execution-chain-caret")).not.toBeNull();
		expect(chain.querySelector(".tool-step-static")?.textContent).toContain("Asked to access a folder");
		expect(chain.querySelector("details.tool-step:not(.tool-step-command)")).toBeNull();
		expect(chain.querySelector(".tool-step-command > summary")?.textContent).toContain("Ran command");
		expect(container.querySelector(".turn-thought-label")).toBeNull();
		const intermediate = [...container.querySelectorAll("p")].find((node) =>
			node.textContent?.startsWith("我需要先请求访问"),
		);
		expect(intermediate).toBeDefined();
		expect(chain.contains(intermediate!)).toBe(true);

		const final = [...container.querySelectorAll("p")].find((node) => node.textContent === "桌面上有 file.txt。");
		expect(final).toBeDefined();
		expect(final!.closest("[data-transcript-answer]")).not.toBeNull();
		expect(chain.contains(final!)).toBe(false);

		await act(async () => chain.querySelector<HTMLElement>(":scope > summary")!.click());
		expect(chain.open).toBe(true);
		expect(chain.textContent).toContain("用户希望查看桌面内容");
		const viewport = chain.querySelector<HTMLElement>(".execution-chain-viewport")!;
		const timeline = chain.querySelector<HTMLElement>(".execution-chain-timeline")!;
		Object.defineProperties(viewport, {
			clientHeight: { configurable: true, value: 520 },
			scrollHeight: { configurable: true, value: 680 },
		});
		for (const child of timeline.children) {
			const height = child.matches("details.tool-step-command") ? 50 : 120;
			Object.defineProperty(child, "getBoundingClientRect", {
				configurable: true,
				value: () => ({ height }) as DOMRect,
			});
			const summary = child.querySelector(":scope > summary");
			if (summary) {
				Object.defineProperty(summary, "getBoundingClientRect", {
					configurable: true,
					value: () => ({ height }) as DOMRect,
				});
			}
		}
		await act(async () => TriggerResizeObserver.trigger(timeline));
		expect(chain.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(true);
		expect(chain.querySelector(".execution-chain-done")).toBeNull();
		const showMore = [...chain.querySelectorAll("button")].find((node) => node.textContent === "Show more");
		expect(showMore).toBeDefined();
		await act(async () => showMore!.click());
		expect(chain.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(false);
		const showLess = [...chain.querySelectorAll("button")].find((node) => node.textContent === "Show less");
		expect(showLess).toBeDefined();
		const done = chain.querySelector(".execution-chain-done");
		expect(done).not.toBeNull();
		expect(done!.compareDocumentPosition(showLess!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		await act(async () => showLess!.click());
		expect(chain.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(true);

		const command = chain.querySelector<HTMLDetailsElement>("details.tool-step-command");
		expect(command).not.toBeNull();
		expect(command!.open).toBe(false);

		await act(async () => command!.querySelector("summary")!.click());
		expect(command!.open).toBe(true);
		expect(command!.textContent).toContain("ls -la /Users/ent/Desktop");
		expect(command!.textContent).toContain("file.txt");

		await act(async () => chain.querySelector<HTMLElement>(":scope > summary")!.click());
		expect(chain.open).toBe(false);
		expect(chain.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(true);

		await act(async () => root.unmount());
		Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: defaultResizeObserver });
		TriggerResizeObserver.instances.length = 0;
	});

	it("opens while running and collapses when the turn completes", async () => {
		const defaultResizeObserver = globalThis.ResizeObserver;
		Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TriggerResizeObserver });
		TriggerResizeObserver.instances.length = 0;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const runningItems = turnItems
			.slice(0, -1)
			.map((entry) => (entry.itemId === "assistant-synthesis" ? { ...entry, state: "streaming" as const } : entry));
		await act(async () => root.render(<TranscriptTurn items={runningItems} running />));
		const chain = container.querySelector<HTMLDetailsElement>(".execution-chain")!;
		expect(chain.open).toBe(true);
		expect(chain.querySelector(":scope > summary")?.textContent).toContain("Execution process");
		expect(chain.querySelector(".turn-runtime-status")).not.toBeNull();
		const viewport = chain.querySelector<HTMLElement>(".execution-chain-viewport")!;
		const timeline = chain.querySelector<HTMLElement>(".execution-chain-timeline")!;
		Object.defineProperties(viewport, {
			clientHeight: { configurable: true, value: 520 },
			scrollHeight: { configurable: true, value: 680 },
		});
		for (const child of timeline.children) {
			const height = child.matches("details.tool-step-command") ? 50 : 120;
			Object.defineProperty(child, "getBoundingClientRect", {
				configurable: true,
				value: () => ({ height }) as DOMRect,
			});
			const summary = child.querySelector(":scope > summary");
			if (summary) {
				Object.defineProperty(summary, "getBoundingClientRect", {
					configurable: true,
					value: () => ({ height }) as DOMRect,
				});
			}
		}
		await act(async () => TriggerResizeObserver.trigger(timeline));
		expect(viewport.scrollTop).toBe(680);

		await act(async () => root.render(<TranscriptTurn items={turnItems} />));
		expect(container.querySelector<HTMLDetailsElement>(".execution-chain")!.open).toBe(false);
		expect(container.querySelector(":scope .execution-chain > summary")?.textContent).toContain("Execution complete");
		await act(async () => root.unmount());
		Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: defaultResizeObserver });
		TriggerResizeObserver.instances.length = 0;
	});

	it("does not count expanded command output toward the outer chain cap", async () => {
		const defaultResizeObserver = globalThis.ResizeObserver;
		Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TriggerResizeObserver });
		TriggerResizeObserver.instances.length = 0;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<TranscriptTurn
						items={[
							item("short-user", "user", [{ type: "text", text: "列出文件" }]),
							item("short-command", "assistant", [
								{
									type: "tool_call",
									toolCallId: "short-command-tool",
									name: "bash",
									state: "completed",
									inputPreview: JSON.stringify({ command: "ls -la" }),
								},
							]),
							item("short-result", "tool", [
								{
									type: "tool_result",
									toolCallId: "short-command-tool",
									name: "bash",
									isError: false,
									output: "a very long command output".repeat(100),
								},
							]),
							item("short-answer", "assistant", [{ type: "text", text: "完成。" }]),
						]}
					/>,
				),
			);

			const chain = container.querySelector<HTMLDetailsElement>(".execution-chain")!;
			await act(async () => chain.querySelector<HTMLElement>(":scope > summary")!.click());
			const viewport = chain.querySelector<HTMLElement>(".execution-chain-viewport")!;
			const timeline = chain.querySelector<HTMLElement>(".execution-chain-timeline")!;
			const command = chain.querySelector<HTMLDetailsElement>("details.tool-step-command")!;
			const commandSummary = command.querySelector<HTMLElement>(":scope > summary")!;
			let timelineHeight = 32;
			Object.defineProperties(viewport, {
				clientHeight: { configurable: true, value: 520 },
				scrollHeight: { configurable: true, get: () => timelineHeight },
			});
			Object.defineProperty(timeline, "scrollHeight", {
				configurable: true,
				get: () => timelineHeight,
			});
			Object.defineProperty(command, "getBoundingClientRect", {
				configurable: true,
				value: () => ({ height: timelineHeight }) as DOMRect,
			});
			Object.defineProperty(commandSummary, "getBoundingClientRect", {
				configurable: true,
				value: () => ({ height: 32 }) as DOMRect,
			});

			await act(async () => TriggerResizeObserver.trigger(timeline));
			expect(chain.querySelector(".execution-chain-show-more")).toBeNull();
			await act(async () => commandSummary.click());
			timelineHeight = 900;
			await act(async () => TriggerResizeObserver.trigger(timeline));
			expect(command.open).toBe(true);
			expect(chain.querySelector(".execution-chain-show-more")).toBeNull();
			expect(chain.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(false);
		} finally {
			await act(async () => root.unmount());
			Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: defaultResizeObserver });
			TriggerResizeObserver.instances.length = 0;
		}
	});

	it("does not add a thought process to a plain answer", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<TranscriptTurn
					items={[
						item("plain-user", "user", [{ type: "text", text: "你好" }]),
						item("plain-answer", "assistant", [{ type: "text", text: "你好！" }]),
					]}
				/>,
			),
		);
		expect(container.querySelector(".execution-chain")).toBeNull();
		expect(container.querySelector(".turn-thought-label")).toBeNull();
		expect(container.textContent).toContain("你好！");
		await act(async () => root.unmount());
	});

	it("summarizes Chat internal tools without exposing failed or orphan JSON", async () => {
		const askInput = JSON.stringify({
			questions: [
				{
					question: "How should Metis answer?",
					multiple: false,
					options: [{ label: "Concise" }, { label: "Detailed" }],
				},
			],
		});
		const askOutput = `User answers:\n${JSON.stringify(
			[
				{
					question: "How should Metis answer?",
					selected: ["Concise"],
				},
			],
			null,
			2,
		)}`;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<TranscriptTurn
					items={[
						item("chat-safe-user", "user", [{ type: "text", text: "Ask and continue" }]),
						item("chat-safe-call", "assistant", [
							{
								type: "tool_call",
								toolCallId: "chat-safe-ask",
								name: "ask_user",
								state: "completed",
								inputPreview: askInput,
							},
						]),
						item("chat-safe-result", "tool", [
							{
								type: "tool_result",
								toolCallId: "chat-safe-ask",
								name: "ask_user",
								isError: false,
								output: askOutput,
							},
						]),
						item("chat-failed-call", "assistant", [
							{
								type: "tool_call",
								toolCallId: "chat-failed-task",
								name: "set_tasks",
								state: "completed",
								inputPreview: JSON.stringify({ tasks: [{ task: "Run validation", completed: false }] }),
							},
						]),
						item("chat-failed-result", "tool", [
							{
								type: "tool_result",
								toolCallId: "chat-failed-task",
								name: "set_tasks",
								isError: true,
								output: JSON.stringify({ internal_error_code: "TASK_FAILED", details: { retry: false } }),
							},
						]),
						item("chat-orphan-result", "tool", [
							{
								type: "tool_result",
								toolCallId: "chat-orphan-close",
								name: "interrupt_agent",
								isError: false,
								output: JSON.stringify({
									name: "Login flow audit",
									status: "stopped",
									taskSummary: "Inspect refresh",
								}),
							},
						]),
						item("chat-safe-final", "assistant", [{ type: "text", text: "Done" }]),
					]}
				/>,
			),
		);

		for (const chain of container.querySelectorAll<HTMLDetailsElement>("details.execution-chain")) {
			await act(async () => chain.querySelector<HTMLElement>(":scope > summary")!.click());
		}
		expect(container.textContent).toContain("How should Metis answer?");
		expect(container.textContent).toContain("Concise");
		expect(container.textContent).toContain("Failed to update task list");
		expect(container.textContent).toContain("Interrupted agent · Login flow audit");
		expect(container.textContent).not.toContain('"questions"');
		expect(container.textContent).not.toContain("internal_error_code");
		expect(container.textContent).not.toContain("secretField");
		expect(container.textContent).not.toContain("child-secret");
		await act(async () => root.unmount());
	});

	it("does not repeat a thinking echo as intermediate assistant text", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const echoedPrefix = "我需要先检查当前工具并确认配置。".repeat(8);
		await act(async () =>
			root.render(
				<TranscriptTurn
					items={[
						item("echo-user", "user", [{ type: "text", text: "检查工具" }]),
						item("echo-assistant", "assistant", [
							{ type: "thinking", text: `${echoedPrefix}重新启动会话或重新加载配置` },
							{ type: "text", text: `${echoedPrefix}重新启动会话或重新配置\n` },
							{ type: "tool_call", toolCallId: "echo-tool", name: "read", state: "completed" },
						]),
						item("echo-result", "tool", [
							{ type: "tool_result", toolCallId: "echo-tool", name: "read", isError: false, output: "ok" },
						]),
						item("echo-final", "assistant", [{ type: "text", text: "工具检查完成。" }]),
					]}
				/>,
			),
		);

		expect(container.querySelector(".turn-intermediate")).toBeNull();
		expect(container.querySelector(".execution-chain")?.textContent).toContain("重新加载配置");
		expect(container.querySelector("[data-transcript-answer]")?.textContent).toContain("工具检查完成。");
		await act(async () => root.unmount());
	});

	it("does not flash a streaming thinking echo as the final answer", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const echoed = "我需要先检查当前工具并确认配置。".repeat(8);
		await act(async () =>
			root.render(
				<TranscriptTurn
					items={[
						item("stream-echo-user", "user", [{ type: "text", text: "检查工具" }]),
						item(
							"stream-echo-assistant",
							"assistant",
							[
								{ type: "thinking", text: echoed },
								{ type: "text", text: echoed },
							],
							"streaming",
						),
					]}
				/>,
			),
		);

		expect(container.querySelector("[data-transcript-answer]")).toBeNull();
		expect(container.querySelector(".execution-chain")?.textContent).toContain(echoed);
		await act(async () =>
			root.render(
				<TranscriptTurn
					items={[
						item("stream-echo-user", "user", [{ type: "text", text: "检查工具" }]),
						item(
							"stream-echo-assistant",
							"assistant",
							[
								{ type: "thinking", text: echoed },
								{ type: "text", text: echoed },
								{ type: "tool_call", toolCallId: "stream-echo-tool", name: "read", state: "running" },
							],
							"streaming",
						),
					]}
				/>,
			),
		);
		expect(container.querySelector(".execution-chain")?.textContent).toContain(echoed);
		expect(container.querySelector(".turn-intermediate")).toBeNull();
		await act(async () => root.unmount());
	});

	it("does not invent a result for a running tool call", async () => {
		const running = [
			turnItems[0]!,
			item(
				"assistant-running",
				"assistant",
				[
					{ type: "thinking", text: "我正在读取桌面目录。" },
					{ type: "tool_call", toolCallId: "tool-running", name: "bash", state: "running", inputPreview: "pwd" },
				],
				"streaming",
			),
		];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TranscriptTurn items={running} />));
		const command = container.querySelector<HTMLDetailsElement>(".tool-step-command");
		expect(command?.textContent).toContain("Running command");
		expect(command?.querySelector(".tool-step-output")).toBeNull();
		await act(async () => root.unmount());
	});

	it("renders assistant Markdown without executing raw HTML or unsafe links", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<TranscriptTurn
					items={[
						item("markdown-user", "user", [{ type: "text", text: "Format this" }]),
						item("markdown-answer", "assistant", [
							{
								type: "text",
								text: "**Bold**\n\n- one\n- two\n\n```ts\nconst safe = true;\n```\n\n[docs](https://example.com) [bad](javascript:alert(1)) [protocol-relative](//example.com) <script>boom()</script>",
							},
						]),
					]}
				/>,
			),
		);

		const answer = container.querySelector("[data-transcript-answer]")!;
		expect(answer.querySelector("strong")?.textContent).toBe("Bold");
		expect([...answer.querySelectorAll("li")].map((node) => node.textContent)).toEqual(["one", "two"]);
		expect(answer.querySelector("pre code")?.textContent).toContain("const safe = true;");
		expect(answer.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')).not.toBeNull();
		expect([...answer.querySelectorAll("a")].find((node) => node.textContent === "bad")?.hasAttribute("href")).toBe(
			false,
		);
		expect(
			[...answer.querySelectorAll("a")]
				.find((node) => node.textContent === "protocol-relative")
				?.hasAttribute("href"),
		).toBe(false);
		expect(answer.querySelector("script")).toBeNull();
		expect(answer.textContent).toContain("<script>boom()</script>");
		await act(async () => root.unmount());
	});

	it("renders Markdown while an answer streams", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (state: ItemView["state"]) =>
			root.render(
				<TranscriptTurn
					items={[
						item("stream-user", "user", [{ type: "text", text: "Stream" }]),
						item("stream-answer", "assistant", [{ type: "text", text: "**Working**" }], state),
					]}
				/>,
			);

		await act(async () => render("streaming"));
		expect(container.querySelector("[data-transcript-answer] strong")?.textContent).toBe("Working");
		await act(async () => render("completed"));
		expect(container.querySelector("[data-transcript-answer] strong")?.textContent).toBe("Working");
		await act(async () => root.unmount());
	});

	it("renders Markdown in Chat assistant messages that also call tools", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<TranscriptTurn
					items={[
						item("mixed-user", "user", [{ type: "text", text: "Summarize" }]),
						item("mixed-report", "assistant", [
							{ type: "text", text: "**Summary**\n\n| Name | State |\n| --- | --- |\n| Child | Done |" },
							{ type: "tool_call", toolCallId: "mixed-stop", name: "interrupt_agent", state: "completed" },
						]),
						item("mixed-result", "tool", [
							{
								type: "tool_result",
								toolCallId: "mixed-stop",
								name: "interrupt_agent",
								isError: false,
								output: "stopped",
							},
						]),
					]}
				/>,
			),
		);

		expect(container.querySelector(".execution-chain strong")?.textContent).toBe("Summary");
		expect(container.querySelector(".execution-chain table")?.textContent).toContain("Child");
		await act(async () => root.unmount());
	});

	it("shows fork and copy actions only after the reply completes", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const props = { onCopy: () => undefined, onFork: () => undefined } as const;

		// 流式中间回复不显示操作按钮。
		const streaming = item("streaming-reply", "assistant", [{ type: "text", text: "working…" }], "streaming");
		await act(async () => root.render(<TranscriptTurn items={[streaming]} {...props} />));
		expect(container.querySelector(".turn-actions")).toBeNull();

		// 回复完成后按钮出现。
		const completed = item("streaming-reply", "assistant", [{ type: "text", text: "done" }], "completed");
		await act(async () => root.render(<TranscriptTurn items={[completed]} {...props} />));
		expect(container.querySelector(".turn-actions")).not.toBeNull();
		expect(container.querySelector('[aria-label="Fork conversation"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("renders tool-result images outside the collapsed execution chain", async () => {
		const image = { hash: "a".repeat(64), mediaType: "image/png" as const, byteLength: 4 };
		const readSessionImage = vi.fn().mockResolvedValue({ data: "aGVsbG8=", mediaType: "image/png" });
		Object.defineProperty(window, "metis", { configurable: true, value: { readSessionImage } });
		const items: ItemView[] = [
			item("gen-user", "user", [{ type: "text", text: "draw a circle" }]),
			item("gen-assistant", "assistant", [
				{ type: "tool_call", toolCallId: "image-tool", name: "image_tool", state: "completed" },
			]),
			item("gen-result", "tool", [
				{
					type: "tool_result",
					toolCallId: "image-tool",
					name: "image_tool",
					isError: false,
					output: "Generated 1 of 1",
					images: [image],
				},
			]),
		];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TranscriptTurn items={items} />));
		expect(readSessionImage).toHaveBeenCalledWith({ sessionId: SESSION_ID, image });
		const img = container.querySelector<HTMLImageElement>("img.tool-result-image");
		expect(img?.src).toContain("data:image/png;base64,");
		expect(container.querySelector(".execution-chain .tool-result-image")).toBeNull();
		await act(async () => root.unmount());
	});
});

describe("CodeTranscriptTurn", () => {
	it("does not expose assistant working text while a Code turn is running", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<CodeTranscriptTurn
					items={[
						item("private-user", "user", [{ type: "text", text: "实现这个功能" }]),
						item(
							"private-working",
							"assistant",
							[{ type: "text", text: "我需要先分析内部实现细节。" }],
							"streaming",
						),
					]}
					running
				/>,
			),
		);

		expect(container.textContent).not.toContain("我需要先分析内部实现细节");
		expect(container.querySelector(".turn-runtime-status")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("renders tool-result images outside collapsed code tools", async () => {
		const image = { hash: "a".repeat(64), mediaType: "image/png" as const, byteLength: 4 };
		const readSessionImage = vi.fn().mockResolvedValue({ data: "aGVsbG8=", mediaType: "image/png" });
		Object.defineProperty(window, "metis", { configurable: true, value: { readSessionImage } });
		const items: ItemView[] = [
			item("gen-user", "user", [{ type: "text", text: "draw a circle" }]),
			item("gen-assistant", "assistant", [
				{ type: "tool_call", toolCallId: "image-tool", name: "image_tool", state: "completed" },
			]),
			item("gen-result", "tool", [
				{
					type: "tool_result",
					toolCallId: "image-tool",
					name: "image_tool",
					isError: false,
					output: "Generated 1 of 1",
					images: [image],
				},
			]),
		];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<CodeTranscriptTurn items={items} />));
		const img = container.querySelector<HTMLImageElement>("img.tool-result-image");
		expect(img?.src).toContain("data:image/png;base64,");
		expect(container.querySelector(".code-execution .tool-result-image")).toBeNull();
		await act(async () => root.unmount());
	});
});

describe("Transcript", () => {
	it.each(["chat", "code"] as const)(
		"keeps a legacy %s continuation tool chain together between explicit human turns",
		async (appearance) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const before = [
				{ ...item("before-user", "user", [{ type: "text", text: "First request" }]), turnId: "before" },
				{ ...item("before-answer", "assistant", [{ type: "text", text: "Initial answer" }]), turnId: "before" },
			];
			const continuation = turnItems.slice(1).map((entry) => ({ ...entry, turnId: undefined }));
			const after = [
				{ ...item("after-user", "user", [{ type: "text", text: "Next request" }]), turnId: "after" },
				{ ...item("after-answer", "assistant", [{ type: "text", text: "Next answer" }]), turnId: "after" },
			];
			const render = (entries: readonly ItemView[]) =>
				root.render(
					<Transcript
						appearance={appearance}
						activeTurnId="after"
						hasOlder={false}
						itemIds={entries.map((entry) => entry.itemId)}
						itemsById={new Map(entries.map((entry) => [entry.itemId, entry]))}
						loadingOlder={false}
						onLoadOlder={async () => undefined}
					/>,
				);
			try {
				await act(async () => render([...before, ...continuation, ...after]));
				const rows = [...container.querySelectorAll("[data-transcript-turn]")];
				expect(rows).toHaveLength(3);
				expect(rows[0]?.querySelector('[data-user-message="before-user"]')).not.toBeNull();
				expect(rows[1]?.querySelector("[data-user-message]")).toBeNull();
				expect(rows[2]?.querySelector('[data-user-message="after-user"]')).not.toBeNull();
				expect(rows[2]?.querySelector(".turn-runtime-status")).not.toBeNull();
				expect(rows[1]?.querySelector(".turn-runtime-status")).toBeNull();
				const execution = container.querySelector<HTMLDetailsElement>(
					appearance === "code" ? ".code-execution" : ".execution-chain",
				)!;
				expect(
					container.querySelectorAll(appearance === "code" ? ".code-execution" : ".execution-chain"),
				).toHaveLength(1);
				expect(execution.open).toBe(false);
				if (appearance === "code") {
					expect(execution.querySelector(":scope > summary")?.textContent).toContain("Ran a command, used a tool");
					expect(execution.querySelectorAll(".code-command-orphan-label")).toHaveLength(0);
				}
				await act(async () => execution.querySelector("summary")!.click());
				expect(execution.open).toBe(true);
				const mailbox: ItemView = {
					...item("mid-chain-mailbox", "system", [{ type: "text", text: "Internal event" }]),
					turnId: undefined,
					origin: { kind: "system", eventId: "mid-chain-event" },
					agentTargetId: SESSION_ID,
				};
				await act(async () => render([...before, continuation[0]!, mailbox, ...continuation.slice(1), ...after]));
				expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(3);
				expect(
					container.querySelector<HTMLDetailsElement>(
						appearance === "code" ? ".code-execution" : ".execution-chain",
					)!.open,
				).toBe(true);
			} finally {
				await act(async () => root.unmount());
			}
		},
	);

	it.each(["chat", "code"] as const)(
		"keeps separate human boundaries in %s history without turn IDs",
		async (appearance) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const entries = [
				item("legacy-user-one", "user", [{ type: "text", text: "First request" }]),
				item("legacy-answer-one", "assistant", [{ type: "text", text: "First answer" }]),
				item("legacy-user-two", "user", [{ type: "text", text: "Second request" }]),
				item("legacy-answer-two", "assistant", [{ type: "text", text: "Second answer" }]),
			].map((entry) => ({ ...entry, turnId: undefined }));
			try {
				await act(async () =>
					root.render(
						<Transcript
							appearance={appearance}
							hasOlder={false}
							showNavigation
							itemIds={entries.map((entry) => entry.itemId)}
							itemsById={new Map(entries.map((entry) => [entry.itemId, entry]))}
							loadingOlder={false}
							onLoadOlder={async () => undefined}
						/>,
					),
				);
				const rows = [...container.querySelectorAll("[data-transcript-turn]")];
				expect(rows).toHaveLength(2);
				expect(rows[0]?.querySelector('[data-user-message="legacy-user-one"]')).not.toBeNull();
				expect(rows[0]?.textContent).toContain("First answer");
				expect(rows[1]?.querySelector('[data-user-message="legacy-user-two"]')).not.toBeNull();
				expect(rows[1]?.textContent).toContain("Second answer");
			} finally {
				await act(async () => root.unmount());
			}
		},
	);

	it.each(["chat", "code"] as const)(
		"does not join %s legacy chains across system or session boundaries",
		async (appearance) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const entries: ItemView[] = [
				item("legacy-before-notice", "assistant", [{ type: "text", text: "Before warning" }]),
				item("legacy-warning", "system", [{ type: "notice", level: "warning", text: "A system warning" }]),
				item("legacy-after-notice", "assistant", [{ type: "text", text: "After warning" }]),
				item("legacy-compaction", "system", [{ type: "compaction" }]),
				item("legacy-after-compaction", "assistant", [{ type: "text", text: "After compaction" }]),
				{
					...item("legacy-other-session", "assistant", [{ type: "text", text: "Another conversation" }]),
					sessionId: "22222222-2222-4222-8222-222222222222",
				},
			].map((entry) => ({ ...entry, turnId: undefined }));
			try {
				await act(async () =>
					root.render(
						<Transcript
							appearance={appearance}
							hasOlder={false}
							itemIds={entries.map((entry) => entry.itemId)}
							itemsById={new Map(entries.map((entry) => [entry.itemId, entry]))}
							loadingOlder={false}
							onLoadOlder={async () => undefined}
						/>,
					),
				);
				expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(6);
				expect(container.querySelectorAll(".transcript-compaction-row")).toHaveLength(1);
				expect(container.querySelector(".notice-warning")?.textContent).toBe("A system warning");
				expect(container.textContent).toContain("Another conversation");
			} finally {
				await act(async () => root.unmount());
			}
		},
	);

	it.each(["chat", "code"] as const)(
		"does not allocate %s virtual rows or new-message notices for internal mailbox events",
		async (appearance) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const internal = Array.from(
				{ length: 12 },
				(_, index): ItemView => ({
					...item(`coordination-${index}`, "system", [{ type: "text", text: `Internal child result ${index}` }]),
					turnId: undefined,
					origin: { kind: "system", eventId: `event-${index}` },
					agentTargetId: "22222222-2222-4222-8222-222222222222",
				}),
			);
			const render = (entries: readonly ItemView[]) =>
				root.render(
					<Transcript
						appearance={appearance}
						hasOlder={false}
						itemIds={entries.map((entry) => entry.itemId)}
						itemsById={new Map(entries.map((entry) => [entry.itemId, entry]))}
						latestLabel="Jump to latest"
						loadingOlder={false}
						onLoadOlder={async () => undefined}
					/>,
				);
			try {
				await act(async () => render(internal));
				expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(0);
				expect(container.querySelector<HTMLElement>(".transcript-space")?.style.height).toBe("0px");
				await act(async () => render([...internal, ...turnItems]));
				expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
				expect(container.querySelector("[data-transcript-turn]")?.getAttribute("data-index")).toBe("0");
				expect(container.textContent).toContain("桌面上有 file.txt。");
				expect(container.textContent).not.toContain("Internal child result");
				const scroll = container.querySelector<HTMLDivElement>(".transcript-scroll")!;
				Object.defineProperties(scroll, {
					clientHeight: { configurable: true, value: 600 },
					scrollHeight: { configurable: true, value: 1_000 },
				});
				scroll.scrollTop = 100;
				await act(async () => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
				await act(async () => render([...internal, ...turnItems, { ...internal[0]!, itemId: "new-event" }]));
				expect(container.querySelector(".transcript-latest")).toBeNull();
				expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
			} finally {
				await act(async () => root.unmount());
			}
		},
	);

	it.each(["chat", "code"] as const)("renders a persistent compacted divider in %s mode", async (appearance) => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const compaction: ItemView = {
			itemId: "compaction-1",
			sessionId: SESSION_ID,
			role: "system",
			state: "completed",
			content: [{ type: "compaction" }],
			createdAt: "2026-07-22T00:00:00.000Z",
			completedAt: "2026-07-22T00:00:01.000Z",
		};
		await act(async () =>
			root.render(
				<Transcript
					appearance={appearance}
					hasOlder={false}
					itemIds={[compaction.itemId]}
					itemsById={new Map([[compaction.itemId, compaction]])}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);
		expect(container.querySelector(".transcript-compaction-row hr")?.getAttribute("aria-label")).toBe("Compacted");
		expect(container.textContent).not.toContain("summary");
		await act(async () => root.unmount());
	});

	it.each(["chat", "code"] as const)(
		"animates only the latest user message in the active %s turn",
		async (appearance) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const items = [
				item("user-first", "user", [{ type: "text", text: "First" }]),
				item("user-latest", "user", [{ type: "text", text: "Latest" }]),
			];
			const render = (activeTurnId: string | null) =>
				root.render(
					<Transcript
						activeTurnId={activeTurnId}
						appearance={appearance}
						hasOlder={false}
						itemIds={items.map(({ itemId }) => itemId)}
						itemsById={new Map(items.map((entry) => [entry.itemId, entry]))}
						loadingOlder={false}
						onLoadOlder={async () => undefined}
					/>,
				);

			await act(async () => render(TURN_ID));
			expect(container.querySelectorAll(appearance === "chat" ? ".turn-user" : ".code-turn-user")).toHaveLength(2);
			expect(container.querySelectorAll(".is-entering")).toHaveLength(1);
			expect(container.querySelector(".is-entering")?.textContent).toContain("Latest");

			await act(async () => render(null));
			expect(container.querySelector(".is-entering")).toBeNull();
			await act(async () => root.unmount());
		},
	);

	it.each(["chat", "code"] as const)("renders one active-turn status in %s mode", async (appearance) => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (activeTurnId: string | null | undefined) =>
			root.render(
				<Transcript
					activeTurnId={activeTurnId}
					activeTurnStartedAt="2026-07-22T00:00:00.000Z"
					appearance={appearance}
					hasOlder={false}
					itemIds={turnItems.map((entry) => entry.itemId)}
					itemsById={new Map(turnItems.map((entry) => [entry.itemId, entry]))}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			);

		await act(async () => render(TURN_ID));
		expect(container.querySelectorAll(".turn-runtime-status")).toHaveLength(1);
		expect(
			container.querySelector(
				`.${appearance === "chat" ? "transcript-turn" : "code-transcript-turn"} .turn-runtime-status`,
			),
		).not.toBeNull();
		await act(async () => render(null));
		expect(container.querySelector(".turn-runtime-status")).toBeNull();
		await act(async () => root.unmount());
	});

	it("only compensates row resizing when the entire row is above the viewport", () => {
		expect(shouldAdjustTranscriptScroll(80, 82)).toBe(true);
		expect(shouldAdjustTranscriptScroll(582, 82)).toBe(false);
	});

	it("follows streaming output only while the viewport is near the end", () => {
		expect(shouldFollowTranscript(1_000, 352, 600)).toBe(true);
		expect(shouldFollowTranscript(1_000, 351, 600)).toBe(false);
	});

	it("keeps the latest output anchored while its viewport resizes", async () => {
		const defaultResizeObserver = globalThis.ResizeObserver;
		Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TriggerResizeObserver });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<Transcript
						appearance="chat"
						hasOlder={false}
						itemIds={turnItems.map((entry) => entry.itemId)}
						itemsById={new Map(turnItems.map((entry) => [entry.itemId, entry]))}
						loadingOlder={false}
						onLoadOlder={async () => undefined}
					/>,
				),
			);
			const scroll = container.querySelector<HTMLDivElement>(".transcript-scroll")!;
			Object.defineProperties(scroll, {
				clientHeight: { configurable: true, value: 600 },
				scrollHeight: { configurable: true, value: 1_000 },
			});

			scroll.scrollTop = 352;
			await act(async () => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
			act(() => TriggerResizeObserver.trigger(scroll));
			expect(scroll.scrollTop).toBe(1_000);

			scroll.scrollTop = 100;
			await act(async () => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
			act(() => TriggerResizeObserver.trigger(scroll));
			expect(scroll.scrollTop).toBe(100);
		} finally {
			await act(async () => root.unmount());
			Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: defaultResizeObserver });
			TriggerResizeObserver.instances.length = 0;
		}
	});

	it("loads older messages at the top without showing a button or jumping", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		let scrollHeight = 1_000;
		const onLoadOlder = vi.fn(async () => {
			scrollHeight = 1_400;
		});
		await act(async () =>
			root.render(
				<Transcript
					appearance="code"
					autoLoadOlder
					hasOlder
					itemIds={turnItems.map((entry) => entry.itemId)}
					itemsById={new Map(turnItems.map((entry) => [entry.itemId, entry]))}
					loadingOlder={false}
					onLoadOlder={onLoadOlder}
				/>,
			),
		);
		const scroll = container.querySelector<HTMLDivElement>(".transcript-scroll")!;
		Object.defineProperties(scroll, {
			clientHeight: { configurable: true, value: 600 },
			scrollHeight: { configurable: true, get: () => scrollHeight },
		});
		expect(container.querySelector(".history-button")).toBeNull();

		scroll.scrollTop = 80;
		await act(async () => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
		expect(onLoadOlder).not.toHaveBeenCalled();
		scroll.scrollTop = 0;
		await act(async () => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
		await act(async () => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(onLoadOlder).toHaveBeenCalledOnce();
		expect(scroll.scrollTop).toBe(400);
		await act(async () => root.unmount());
	});

	it("groups a Chat turn and preserves disclosure state across streaming updates", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const itemIds = turnItems.map((entry) => entry.itemId);
		const itemsById = new Map(turnItems.map((entry) => [entry.itemId, entry]));
		await act(async () =>
			root.render(
				<Transcript
					appearance="chat"
					hasOlder={false}
					itemIds={itemIds}
					itemsById={itemsById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);
		expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
		const chain = container.querySelector<HTMLDetailsElement>(".execution-chain")!;
		await act(async () => chain.querySelector("summary")!.click());
		expect(chain.open).toBe(true);

		itemsById.set("assistant-plan", {
			...itemsById.get("assistant-plan")!,
			content: itemsById
				.get("assistant-plan")!
				.content.map((block) =>
					block.type === "thinking" ? { ...block, text: `${block.text}正在执行。` } : block,
				),
		});
		await act(async () =>
			root.render(
				<Transcript
					appearance="chat"
					hasOlder={false}
					itemIds={itemIds}
					itemsById={itemsById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);
		expect(container.querySelector<HTMLDetailsElement>(".execution-chain")!.open).toBe(true);
		expect(container.textContent).toContain("正在执行。");
		await act(async () => root.unmount());
	});

	it.each(["edit", "bash"])(
		"shows a turn's net total once and each step's independent saved diff (%s)",
		async (toolName) => {
			const content = (id: string, sequence: number, turnCount: number): ItemView[] => [
				item(`${id}-call`, "assistant", [
					{
						type: "tool_call",
						toolCallId: id,
						name: toolName,
						state: "completed",
						inputPreview: '{"path":"src/app.ts"}',
					},
				]),
				item(`${id}-result`, "tool", [
					{
						type: "tool_result",
						toolCallId: id,
						name: toolName,
						isError: false,
						output: "Successfully edited",
						codeChanges: {
							version: 1,
							sequence,
							partial: false,
							turn: { additions: turnCount, deletions: turnCount, partial: false },
							files: [
								{
									path: "src/app.ts",
									kind: "modified",
									additions: 1,
									deletions: 1,
									diff: `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-${id}-before\n+${id}-after\n`,
								},
							],
						},
					},
				]),
			];
			const items = [
				item("code-diff-user", "user", [{ type: "text", text: "Edit then revert" }]),
				...content("first-edit", 1, 1),
				item("code-diff-status", "assistant", [{ type: "text", text: "Checking before reverting" }]),
				...content("revert-edit", 2, 0),
				item("code-diff-final", "assistant", [{ type: "text", text: "Reverted" }]),
			];
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			await act(async () => root.render(<CodeTranscriptTurn items={items} />));
			const executions = container.querySelectorAll<HTMLDetailsElement>(".code-execution");
			expect(executions).toHaveLength(2);
			expect(container.querySelectorAll(".code-turn-change-counts")).toHaveLength(1);
			expect(executions[0]?.querySelector(":scope > summary .code-change-counts")).toBeNull();
			expect(executions[1]?.querySelector(":scope > summary .code-change-additions")?.textContent).toBe("+0");
			expect(executions[1]?.querySelector(":scope > summary .code-change-deletions")?.textContent).toBe("−0");
			expect(container.querySelector(".code-tool-changes")).toBeNull();
			await act(async () => executions[0]!.querySelector<HTMLElement>(":scope > summary")!.click());
			const step = executions[0]!.querySelector<HTMLDetailsElement>(".code-command")!;
			expect(step.querySelector("summary .code-change-additions")?.textContent).toBe("+1");
			expect(step.querySelector("summary .code-change-deletions")?.textContent).toBe("−1");
			expect(step.querySelector("summary")?.textContent).toContain("src/app.ts");
			await act(async () => step.querySelector<HTMLElement>("summary")!.click());
			expect(step.querySelector(".code-tool-changes")?.textContent).toContain("first-edit-before");
			expect(step.querySelector(".code-tool-changes")?.textContent).not.toContain("revert-edit-before");
			expect(step.querySelector(".code-tool-changes")?.textContent).not.toContain("@@");
			const rawDetails = step.querySelector<HTMLDetailsElement>(".code-tool-raw-details")!;
			expect(rawDetails.open).toBe(false);
			expect(rawDetails.querySelector(".code-command-input")?.textContent).toContain('"path": "src/app.ts"');
			expect(step.querySelector(".code-command-output")?.textContent).toBe("Successfully edited");
			await act(async () => rawDetails.querySelector<HTMLElement>("summary")!.click());
			expect(rawDetails.open).toBe(true);
			expect(rawDetails.querySelector(".code-command-output")?.textContent).toBe("Successfully edited");
			await act(async () => root.unmount());
		},
	);

	it.each(["chat", "code"] as const)(
		"keeps retry-only %s turns visible without empty transcript rows",
		async (appearance) => {
			const failed: ItemView = { ...item("retry-failed", "assistant", []), state: "interrupted", turnId: TURN_ID };
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			await act(async () =>
				root.render(
					<Transcript
						appearance={appearance}
						activeTurnId={TURN_ID}
						retry={{ attempt: 1, maxAttempts: 5, delayMs: 2000 }}
						hasOlder={false}
						itemIds={[failed.itemId]}
						itemsById={new Map([[failed.itemId, failed]])}
						loadingOlder={false}
						onLoadOlder={async () => undefined}
					/>,
				),
			);
			expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(0);
			expect(container.querySelector(".turn-runtime-status")?.getAttribute("aria-label")).toBe("Retrying (1/5)");
			await act(async () => root.unmount());
		},
	);

	it("keeps legacy Code steps and Chat transcripts free of invented change counters", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<CodeTranscriptTurn items={turnItems} />));
		expect(container.querySelector(".code-change-counts")).toBeNull();
		await act(async () => root.render(<TranscriptTurn items={turnItems} />));
		expect(container.querySelector(".code-change-counts")).toBeNull();
		await act(async () => root.unmount());
	});

	it.each([false, true])("omits scan-only change metadata from saved command cards (orphan: %s)", async (orphan) => {
		const call = item("browser-close-call", "assistant", [
			{
				type: "tool_call",
				toolCallId: "browser-close",
				name: "bash",
				state: "completed",
				inputPreview: JSON.stringify({ command: "ego-browser nodejs" }),
			},
		]);
		const result = item("browser-close-result", "tool", [
			{
				type: "tool_result",
				toolCallId: "browser-close",
				name: "bash",
				isError: false,
				output: "space 10 finished, all pages closed",
				codeChanges: {
					version: 1,
					sequence: 1,
					files: [],
					partial: true,
					turn: { additions: 0, deletions: 0, partial: true },
				},
			},
		]);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<CodeTranscriptTurn items={orphan ? [result] : [call, result]} />));
		expect(container.querySelector(".code-change-counts")).toBeNull();
		await act(async () => container.querySelector<HTMLElement>(".code-execution > summary")!.click());
		await act(async () => container.querySelector<HTMLElement>(".code-command > summary")!.click());
		expect(container.querySelector(".code-tool-changes")).toBeNull();
		expect(container.querySelector(".code-tool-raw-details")).toBeNull();
		expect(container.querySelector(".code-change-counts")).toBeNull();
		expect(container.querySelector(".code-command-output")?.textContent).toBe("space 10 finished, all pages closed");
		await act(async () => root.unmount());
	});

	it("groups a Code turn and renders a compact tool execution disclosure", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const itemsById = new Map(turnItems.map((entry) => [entry.itemId, entry]));
		await act(async () =>
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={turnItems.map((entry) => entry.itemId)}
					itemsById={itemsById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);
		expect(container.querySelector(".execution-chain")).toBeNull();
		expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
		expect(container.querySelector(".code-turn-user")?.textContent).toContain("看看桌面有什么");
		expect(container.querySelector(".code-execution > summary")?.textContent).toContain("Ran a command, used a tool");
		expect(container.querySelector(".code-turn-answer")?.textContent).toContain("桌面上有 file.txt");
		expect(container.textContent).not.toContain(LONG_THINKING);
		expect(container.textContent).not.toContain("我需要先请求访问你的桌面文件夹");

		const execution = container.querySelector<HTMLDetailsElement>(".code-execution")!;
		expect(execution.open).toBe(false);
		expect(execution.querySelector(".code-execution-card")).not.toBeNull();
		expect(execution.querySelector(":scope > .transcript-drawer")?.hasAttribute("inert")).toBe(true);
		await act(async () => execution.querySelector<HTMLElement>(":scope > summary")!.click());
		expect(execution.open).toBe(true);
		expect(execution.querySelector(":scope > .transcript-drawer")?.hasAttribute("inert")).toBe(false);
		const command = execution.querySelector<HTMLDetailsElement>(".code-command-shell")!;
		expect(command.open).toBe(false);
		expect(command.querySelector(".code-command-details")).not.toBeNull();
		expect(command.querySelector(":scope > .transcript-drawer")?.hasAttribute("inert")).toBe(true);
		await act(async () => command.querySelector("summary")!.click());
		expect(command.open).toBe(true);
		expect(command.textContent).toContain("ls -la /Users/ent/Desktop");
		expect(command.textContent).toContain("file.txt");
		await act(async () => root.unmount());
	});

	it("renders safe Code summaries for internal tools while preserving operation and external details", async () => {
		const askInput = JSON.stringify({
			questions: [
				{
					question: "How should Metis answer?",
					multiple: false,
					options: [
						{ label: "Concise", description: "Short" },
						{ label: "Detailed", description: "Long" },
					],
				},
			],
		});
		const askOutput = `User answers:\n${JSON.stringify(
			[
				{
					question: "How should Metis answer?",
					selected: ["Concise"],
				},
			],
			null,
			2,
		)}`;
		const codeItems = [
			item("code-safe-user", "user", [{ type: "text", text: "Use the tools" }]),
			item("code-safe-calls", "assistant", [
				{
					type: "tool_call",
					toolCallId: "code-safe-ask",
					name: "ask_user",
					state: "completed",
					inputPreview: askInput,
				},
				{
					type: "tool_call",
					toolCallId: "code-safe-tasks",
					name: "set_tasks",
					state: "completed",
					inputPreview: JSON.stringify({ tasks: [{ task: "Run validation", completed: false }] }),
				},
				{
					type: "tool_call",
					toolCallId: "code-safe-write",
					name: "write",
					state: "completed",
					inputPreview: JSON.stringify({ path: "report.txt", content: "verified" }),
				},
				{
					type: "tool_call",
					toolCallId: "code-safe-mcp",
					name: "mcp__docs__search",
					state: "completed",
					inputPreview: JSON.stringify({ query: "refresh token" }),
				},
			]),
			item("code-safe-results", "tool", [
				{ type: "tool_result", toolCallId: "code-safe-ask", name: "ask_user", isError: false, output: askOutput },
				{
					type: "tool_result",
					toolCallId: "code-safe-tasks",
					name: "set_tasks",
					isError: false,
					output: "<task_list>\n- [ ] Run validation\n</task_list>",
				},
				{
					type: "tool_result",
					toolCallId: "code-safe-write",
					name: "write",
					isError: false,
					output: "Wrote report.txt",
				},
				{
					type: "tool_result",
					toolCallId: "code-safe-mcp",
					name: "mcp__docs__search",
					isError: false,
					output: "External result",
				},
			]),
		];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={codeItems.map((entry) => entry.itemId)}
					itemsById={new Map(codeItems.map((entry) => [entry.itemId, entry]))}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);

		const execution = container.querySelector<HTMLDetailsElement>(".code-execution")!;
		expect(execution.open).toBe(false);
		await act(async () => execution.querySelector<HTMLElement>(":scope > summary")!.click());
		const tools = [...execution.querySelectorAll<HTMLDetailsElement>(".code-command")];
		expect(tools).toHaveLength(4);
		for (const tool of tools) {
			expect(tool.open).toBe(false);
			await act(async () => tool.querySelector("summary")!.click());
		}

		expect(execution.textContent).toContain("How should Metis answer?");
		expect(execution.textContent).toContain("Concise");
		expect(execution.textContent).toContain("○ Run validation");
		expect(execution.textContent).toContain('"path": "report.txt"');
		expect(execution.textContent).toContain("Wrote report.txt");
		expect(execution.textContent).toContain('"query": "refresh token"');
		expect(execution.textContent).toContain("External result");
		expect(execution.textContent).not.toContain('"questions"');
		expect(execution.textContent).not.toContain('"multiple"');
		expect(execution.textContent).not.toContain('"selected"');
		await act(async () => root.unmount());
	});

	it("hides Code working text coupled to tools and shows the final answer after completion", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const user = item("markdown-code-user", "user", [{ type: "text", text: "Summarize" }]);
		const report = item(
			"markdown-code-report",
			"assistant",
			[
				{ type: "tool_call", toolCallId: "stop-child", name: "interrupt_agent", state: "running" },
				{ type: "text", text: "**Summary**\n\n| Name | State |\n| --- | --- |\n| Child | Done |" },
			],
			"streaming",
		);
		const render = (entries: readonly ItemView[]) =>
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={entries.map((entry) => entry.itemId)}
					itemsById={new Map(entries.map((entry) => [entry.itemId, entry]))}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			);

		await act(async () => render([user, report]));
		expect(container.querySelector(".code-turn-status")).toBeNull();
		expect(container.textContent).not.toContain("Summary");

		const completedReport = {
			...report,
			state: "completed" as const,
			completedAt: "2026-07-22T00:00:01.000Z",
			content: report.content.map((block) =>
				block.type === "tool_call" ? { ...block, state: "completed" as const } : block,
			),
		};
		await act(async () =>
			render([
				user,
				completedReport,
				item("markdown-code-result", "tool", [
					{
						type: "tool_result",
						toolCallId: "stop-child",
						name: "interrupt_agent",
						isError: false,
						output: "stopped",
					},
				]),
				item("markdown-code-final", "assistant", [{ type: "text", text: "All agents closed." }]),
			]),
		);
		expect(container.querySelector(".code-turn-status")).toBeNull();
		expect(container.textContent).not.toContain("Summary");
		expect(container.querySelector(".code-turn-answer")?.textContent).toBe("All agents closed.");
		await act(async () => root.unmount());
	});

	it("groups consecutive Code tools in the current turn until public assistant text appears", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const withCodeTurn = (entry: ItemView): ItemView => ({ ...entry, turnId: "code-turn" });
		const codeItems = [
			withCodeTurn(item("code-user", "user", [{ type: "text", text: "重试并检查工具" }])),
			withCodeTurn(
				item("code-tool-1", "assistant", [
					{ type: "tool_call", toolCallId: "tool-1", name: "read", state: "completed" },
				]),
			),
			withCodeTurn(
				item("code-result-1", "tool", [
					{ type: "tool_result", toolCallId: "tool-1", name: "read", isError: false, output: "one" },
				]),
			),
			withCodeTurn(
				item("code-tool-2", "assistant", [
					{ type: "tool_call", toolCallId: "tool-2", name: "grep", state: "completed" },
				]),
			),
			withCodeTurn(
				item("code-result-2", "tool", [
					{ type: "tool_result", toolCallId: "tool-2", name: "grep", isError: false, output: "two" },
				]),
			),
			withCodeTurn(
				item("code-tool-3", "assistant", [
					{ type: "tool_call", toolCallId: "tool-3", name: "web_fetch", state: "completed" },
				]),
			),
			withCodeTurn(
				item("code-result-3", "tool", [
					{ type: "tool_result", toolCallId: "tool-3", name: "web_fetch", isError: false, output: "three" },
				]),
			),
		];
		const itemsById = new Map(codeItems.map((entry) => [entry.itemId, entry]));

		await act(async () =>
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={codeItems.map((entry) => entry.itemId)}
					itemsById={itemsById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);

		expect(container.querySelectorAll(".code-execution")).toHaveLength(1);
		expect(container.querySelector(".code-execution > summary")?.textContent).toContain("Used 3 tools");

		const separatedItems = [
			...codeItems.slice(0, 5),
			withCodeTurn(item("code-public-text", "assistant", [{ type: "text", text: "前两个工具完成，继续检查。" }])),
			...codeItems.slice(5),
		];
		const separatedById = new Map(separatedItems.map((entry) => [entry.itemId, entry]));
		await act(async () =>
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={separatedItems.map((entry) => entry.itemId)}
					itemsById={separatedById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);
		expect(container.querySelectorAll(".code-execution")).toHaveLength(2);
		expect(container.textContent).toContain("前两个工具完成，继续检查。");
		await act(async () => root.unmount());
	});

	it("keeps Code disclosure state across streaming updates and never invents tool output", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const running = item(
			"assistant-code-running",
			"assistant",
			[{ type: "tool_call", toolCallId: "code-running", name: "bash", state: "running", inputPreview: "pwd" }],
			"streaming",
		);
		const itemIds = [turnItems[0]!.itemId, running.itemId];
		const itemsById = new Map([turnItems[0]!, running].map((entry) => [entry.itemId, entry]));

		await act(async () =>
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={itemIds}
					itemsById={itemsById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);
		const execution = container.querySelector<HTMLDetailsElement>(".code-execution")!;
		expect(execution.open).toBe(false);
		await act(async () => execution.querySelector<HTMLElement>(":scope > summary")!.click());
		const command = execution.querySelector<HTMLDetailsElement>(".code-command-shell")!;
		expect(command.open).toBe(false);
		await act(async () => command.querySelector("summary")!.click());
		expect(command.open).toBe(true);
		expect(execution.textContent).toContain("Running a command");
		expect(execution.querySelector(".code-command-output")).toBeNull();

		itemsById.set(running.itemId, {
			...running,
			content: [
				{
					type: "tool_call",
					toolCallId: "code-running",
					name: "bash",
					state: "running",
					inputPreview: "pwd && whoami",
				},
			],
		});
		await act(async () =>
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={itemIds}
					itemsById={itemsById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);
		expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
		expect(container.querySelector<HTMLDetailsElement>(".code-execution")!.open).toBe(true);
		expect(container.querySelector<HTMLDetailsElement>(".code-command-shell")!.open).toBe(true);
		expect(container.textContent).toContain("pwd && whoami");
		await act(async () => root.unmount());
	});

	it("renders Code errors and completed Markdown tables without exposing thinking", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const codeItems = [
			item("code-error-user", "user", [{ type: "text", text: "Count files" }]),
			item("code-error-call", "assistant", [
				{ type: "thinking", text: LONG_THINKING },
				{
					type: "tool_call",
					toolCallId: "code-error",
					name: "bash",
					state: "completed",
					inputPreview: "find data",
				},
			]),
			item("code-error-result", "tool", [
				{ type: "tool_result", toolCallId: "code-error", name: "bash", isError: true, output: "Permission denied" },
			]),
			item("code-error-final", "assistant", [
				{ type: "text", text: "| Type | Count |\n| --- | ---: |\n| video | 10 |" },
			]),
		];
		const itemsById = new Map(codeItems.map((entry) => [entry.itemId, entry]));
		await act(async () =>
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={codeItems.map((entry) => entry.itemId)}
					itemsById={itemsById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			),
		);
		const execution = container.querySelector<HTMLDetailsElement>(".code-execution")!;
		await act(async () => execution.querySelector<HTMLElement>(":scope > summary")!.click());
		await act(async () =>
			execution.querySelector<HTMLDetailsElement>(".code-command")!.querySelector("summary")!.click(),
		);
		expect(container.querySelector(".code-command-output-error")?.textContent).toContain("Permission denied");
		expect(container.querySelector(".code-turn-answer table")?.textContent).toContain("video");
		expect(container.textContent).not.toContain(LONG_THINKING);
		await act(async () => root.unmount());
	});

	it("scrolls the Code execution title out and in when the summary text changes", async () => {
		vi.useFakeTimers();
		try {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const running = item(
				"code-running-2",
				"assistant",
				[{ type: "tool_call", toolCallId: "code-running-2", name: "bash", state: "running", inputPreview: "pwd" }],
				"streaming",
			);
			const itemIds = [running.itemId];
			const itemsById = new Map([[running.itemId, running]]);

			await act(async () =>
				root.render(
					<Transcript
						appearance="code"
						hasOlder={false}
						itemIds={itemIds}
						itemsById={itemsById}
						loadingOlder={false}
						onLoadOlder={async () => undefined}
					/>,
				),
			);
			const enter = () => container.querySelector<HTMLElement>(".code-execution-title-enter");
			const leave = () => container.querySelector<HTMLElement>(".code-execution-title-leave");
			expect(enter()?.textContent).toBe("Running a command");
			expect(leave()).toBeNull();

			const completed = item(
				"code-running-2",
				"assistant",
				[
					{
						type: "tool_call",
						toolCallId: "code-running-2",
						name: "bash",
						state: "completed",
						inputPreview: "pwd",
					},
				],
				"completed",
			);
			itemsById.set(running.itemId, completed);
			await act(async () =>
				root.render(
					<Transcript
						appearance="code"
						hasOlder={false}
						itemIds={itemIds}
						itemsById={itemsById}
						loadingOlder={false}
						onLoadOlder={async () => undefined}
					/>,
				),
			);
			expect(leave()?.textContent).toBe("Running a command");
			expect(enter()?.textContent).toBe("Ran a command");

			await act(async () => vi.advanceTimersByTime(200));
			expect(leave()).toBeNull();
			expect(enter()?.textContent).toBe("Ran a command");
			await act(async () => root.unmount());
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("sent attachment cards", () => {
	it.each(["chat", "code"] as const)(
		"preserves selected file cards in %s, including reference-only messages",
		async (appearance) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const Turn = appearance === "chat" ? TranscriptTurn : CodeTranscriptTurn;
			const reference: ItemView = {
				...item("selected-file", "user", [{ type: "text", text: "翻译一下 [literal.md:1–8]" }]),
				fileSelections: [
					{
						name: "AGENTS.md",
						source: "workspace",
						selectedText: "<img src=x onerror=alert(1)>\n# 1. Language",
						startLine: 1,
						endLine: 8,
					},
					{
						name: "report.pdf",
						source: "delivered",
						selectedText: "Selected document text",
						target: { kind: "pdf", page: 2, endPage: 3 },
					},
				],
			};
			await act(async () => root.render(<Turn items={[reference]} />));
			expect(messageText(reference)).toBe("翻译一下 [literal.md:1–8]\n\n[AGENTS.md:1–8] [report.pdf]");
			expect(container.querySelectorAll(".message-file-selection")).toHaveLength(2);
			expect(container.querySelector(".message-file-selection summary")?.textContent).toContain("AGENTS.md");
			expect(container.querySelector(".message-file-selection summary")?.textContent).toContain("1–8");
			expect(container.querySelectorAll(".message-file-selection summary")[1]?.textContent).toContain("2–3");
			expect(container.querySelector(".message-file-selection blockquote")?.textContent).toBe(
				reference.fileSelections![0]!.selectedText,
			);
			expect(container.querySelector(".message-file-selection img, .message-file-selection script")).toBeNull();
			expect(container.querySelector(".message-user, .code-turn-user-bubble")?.textContent).toBe(
				"翻译一下 [literal.md:1–8]",
			);
			await act(async () => root.render(<Turn items={[{ ...reference, content: [] }]} />));
			expect(container.querySelectorAll(".message-file-selection")).toHaveLength(2);
			expect(container.querySelector(".message-user, .code-turn-user-bubble")).toBeNull();
			await act(async () => root.unmount());
		},
	);
	it.each(["chat", "code"] as const)(
		"renders files separately from the %s message and preserves literal brackets",
		async (appearance) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const Turn = appearance === "chat" ? TranscriptTurn : CodeTranscriptTurn;
			const upload: ItemView = {
				...item("upload", "user", [{ type: "text", text: "Read [notes.pdf]" }]),
				attachments: [
					{ name: "notes.pdf", byteLength: 4096 },
					{ name: "说明.md", byteLength: 80 },
				],
			};
			await act(async () => root.render(<Turn items={[upload]} />));
			expect(container.querySelectorAll(".message-file-card")).toHaveLength(2);
			expect(container.querySelector(".message-file-card")?.textContent).toContain("PDF · 4 KB");
			expect(container.querySelector(".message-user, .code-turn-user-bubble")?.textContent).toBe("Read [notes.pdf]");
			await act(async () => root.render(<Turn items={[{ ...upload, content: [] }]} />));
			expect(container.querySelector(".message-user, .code-turn-user-bubble")).toBeNull();
			expect(container.querySelectorAll(".message-file-card")).toHaveLength(2);
			await act(async () => root.unmount());
		},
	);
});
