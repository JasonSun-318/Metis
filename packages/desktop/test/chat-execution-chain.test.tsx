// @vitest-environment jsdom
import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptTurn } from "../src/renderer/components/TranscriptTurn.tsx";

function item(id: string, content: ItemContentBlockView[], state: ItemView["state"] = "completed"): ItemView {
	return {
		itemId: id,
		role: "assistant",
		sessionId: "chain",
		turnId: "turn",
		state,
		content,
		createdAt: "2026-10-30T00:00:00Z",
	};
}

let root: Root;
let container: HTMLDivElement;
async function render(items: ItemView[], running = false) {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	if (!container) {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	}
	await act(async () => root.render(<TranscriptTurn items={items} running={running} />));
}

afterEach(async () => {
	if (root) await act(async () => root.unmount());
	container?.remove();
	container = undefined!;
	vi.restoreAllMocks();
});

describe("Chat execution chain", () => {
	it("streams actual thinking in one closed summary and retains user expansion through completion", async () => {
		const first = item("live", [{ type: "thinking", text: "先确认表格需要哪些列。" }], "streaming");
		await render([first], true);
		const chain = container.querySelector<HTMLDetailsElement>(".execution-chain")!;
		const summary = chain.querySelector<HTMLElement>(":scope > summary")!;
		expect(chain.open).toBe(false);
		expect(summary.textContent).toContain("先确认表格需要哪些列。");
		expect(summary.getAttribute("aria-label")).toBe("Thought process");
		const updated = {
			...first,
			content: [{ type: "thinking" as const, text: "先确认表格需要哪些列。\n再确定每列的格式。" }],
		};
		await render([updated], true);
		expect(chain.querySelector(":scope > summary")).toBe(summary);
		expect(summary.textContent).toContain("再确定每列的格式。");
		await act(async () => summary.click());
		expect(chain.open).toBe(true);
		await render([{ ...updated, state: "completed" }]);
		expect(chain.open).toBe(true);
		expect(summary.textContent).toBe("Thought process");
		expect(container.querySelector(".execution-chain-live-preview")).toBeNull();
		expect(container.querySelector(".turn-runtime-status")).toBeNull();
	});

	it("stops the live thought title when the model starts a tool or public reply", async () => {
		const thinking = { type: "thinking" as const, text: "正在检查数据。" };
		await render([item("live", [thinking], "streaming")], true);
		expect(container.querySelector(".execution-chain-live-preview")).not.toBeNull();
		await render(
			[
				item(
					"live",
					[thinking, { type: "tool_call", toolCallId: "read", name: "read", state: "running" }],
					"streaming",
				),
			],
			true,
		);
		expect(container.querySelector(".execution-chain-live-preview")).toBeNull();
		await render([item("live", [thinking, { type: "text", text: "这是整理后的表格。" }], "streaming")], true);
		expect(container.querySelector(".execution-chain-live-preview")).toBeNull();
		expect(container.querySelector("[data-transcript-answer]")?.textContent).toContain("这是整理后的表格。");
	});

	it("caps thoughts independently, retains Markdown, and keeps the leading preview fixed during streaming", async () => {
		const actualRect = HTMLElement.prototype.getBoundingClientRect;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.matches(".thinking-preview > .activity-step-message")) return { height: 500 } as DOMRect;
			return actualRect.call(this);
		});
		const content: ItemContentBlockView[] = [
			{ type: "thinking", text: "1. **确认列名**\n2. 检查类型\n\n".repeat(12) },
			{ type: "tool_call", toolCallId: "bash", name: "bash", state: "completed", inputPreview: '{"command":"pwd"}' },
			{ type: "thinking", text: "分析结果。\n\n".repeat(20) },
		];
		await render([item("steps", content, "streaming")], true);
		await act(async () => container.querySelector<HTMLElement>(".execution-chain > summary")!.click());
		const thoughts = [...container.querySelectorAll<HTMLElement>(".activity-step-thinking")];
		const firstButton = thoughts[0]!.querySelector<HTMLButtonElement>(".thinking-show-more")!;
		const secondButton = thoughts[1]!.querySelector<HTMLButtonElement>(".thinking-show-more")!;
		expect(firstButton.textContent).toBe("Show more");
		expect(secondButton.textContent).toBe("Show more");
		expect(thoughts[0]!.querySelector("ol strong")?.textContent).toBe("确认列名");
		await act(async () => firstButton.click());
		expect(firstButton.getAttribute("aria-expanded")).toBe("true");
		expect(secondButton.getAttribute("aria-expanded")).toBe("false");
		expect(firstButton.getAttribute("aria-controls")).toBe(thoughts[0]!.querySelector(".thinking-preview")?.id);
		const secondViewport = thoughts[1]!.querySelector<HTMLElement>(".thinking-preview")!;
		secondViewport.scrollTop = 100;
		await render(
			[
				item(
					"steps",
					[...content.slice(0, -1), { type: "thinking", text: `${"分析结果。\n\n".repeat(20)}新的思考内容。` }],
					"streaming",
				),
			],
			true,
		);
		expect(secondViewport.scrollTop).toBe(0);
		expect(firstButton.getAttribute("aria-expanded")).toBe("true");
		expect(secondButton.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector(".tool-step-command > summary")?.textContent).toContain("Ran command");
		expect(container.querySelector(".execution-chain-show-more")).toBeNull();
	});

	it("keeps the final reply and delivered file after one continuous execution group", async () => {
		const deliveredFile = {
			fileId: "file",
			sourcePath: "/workspace/deck.pptx",
			name: "deck.pptx",
			byteLength: 12,
			deliveredAt: "2026-10-30T00:00:00Z",
			availability: "available" as const,
		};
		const items = [
			item("build", [
				{ type: "thinking", text: "检查文件。" },
				{ type: "tool_call", toolCallId: "bash", name: "bash", state: "completed" },
			]),
			item("delivery", [{ type: "tool_call", toolCallId: "delivery", name: "deliver_file", state: "completed" }]),
			{
				...item("result", [
					{
						type: "tool_result",
						toolCallId: "delivery",
						name: "deliver_file",
						isError: false,
						output: "delivered",
						deliveredFile,
					},
				]),
				role: "tool" as const,
			},
			item("final", [
				{ type: "thinking", text: "整理交付说明。" },
				{ type: "text", text: "| 页面 | 内容 |\n| --- | --- |\n| 1 | 简介 |" },
			]),
		];
		await render(items);
		expect(container.querySelectorAll(".execution-chain")).toHaveLength(1);
		expect(container.querySelector("[data-transcript-answer] table")?.textContent).toContain("简介");
		await act(async () => root.render(<TranscriptTurn items={items} onOpenDeliveredFile={() => undefined} />));
		expect(container.textContent).toContain("File · PPTX");
	});
});
