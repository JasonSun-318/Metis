import { Type } from "typebox";
import { expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Context, Tool } from "../src/types.ts";
import { captureWire } from "./prompt-cache-fixtures.ts";

const lookupTool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

type WireMessage = { role: string; content: unknown };

function contentBlocks(message: WireMessage): Record<string, unknown>[] {
	return typeof message.content === "string"
		? [{ type: "text", text: message.content }]
		: (message.content as Record<string, unknown>[]);
}

function countMarkers(value: unknown): number {
	if (value === null || typeof value !== "object") return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countMarkers(item), 0);
	const record = value as Record<string, unknown>;
	let count = record.cache_control !== undefined ? 1 : 0;
	for (const key of Object.keys(record)) count += countMarkers(record[key]);
	return count;
}

function markerPositions(body: Record<string, unknown>): string[] {
	const positions: string[] = [];
	((body.system as Record<string, unknown>[] | undefined) ?? []).forEach((block, index) => {
		if (block.cache_control) positions.push(`system:${index}`);
	});
	((body.tools as Record<string, unknown>[] | undefined) ?? []).forEach((tool, index) => {
		if (tool.cache_control) positions.push(`tools:${index}`);
	});
	((body.messages as WireMessage[] | undefined) ?? []).forEach((message, paramIndex) => {
		contentBlocks(message).forEach((block, blockIndex) => {
			if (block.cache_control) positions.push(`messages:${paramIndex}:${blockIndex}`);
		});
	});
	return positions;
}

it("marks stable history instead of the repeated plan suffix", async () => {
	const { body } = await captureWire(
		"anthropic-messages",
		{
			messages: [
				{ role: "user", content: "history", timestamp: 1 },
				{ role: "user", content: "complete-plan", timestamp: 2 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{ cacheRetention: "short" },
	);
	const messages = body.messages as { content: { text: string; cache_control?: unknown }[] }[];
	expect(messages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
	expect(messages[1]!.content[0]!.cache_control).toBeUndefined();
});

it("emits a checkpoint and reuses the old endpoint after append-only growth", async () => {
	const first = await captureWire(
		"anthropic-messages",
		{
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "history", timestamp: 1 },
				{ role: "user", content: "plan-one", timestamp: 2 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{ cacheRetention: "short" },
	);
	expect(first.observations).toHaveLength(1);
	const checkpoint = first.observations[0]!.checkpoint;
	expect(checkpoint?.historyBoundary.originId).toBe("entry:a");
	expect(first.observations[0]!.reason).toBe("append");
	expect(markerPositions(first.body)).toContain("messages:0:0");

	// Second request: same stable history plus 30 new trailing blocks in the
	// volatile plan suffix. The old boundary must still be marked.
	const grown: Context = {
		systemPrompt: "sys",
		messages: [
			{ role: "user", content: "history", timestamp: 1 },
			{
				role: "user",
				content: ["plan", ...Array.from({ length: 30 }, (_, i) => `block-${i}`)].join("\n"),
				timestamp: 2,
			},
		],
		cacheHints: {
			origins: [
				{ id: "entry:a", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
			previous: checkpoint,
		},
	};
	const second = await captureWire("anthropic-messages", grown, { cacheRetention: "short" });
	expect(markerPositions(second.body)).toContain("messages:0:0");
	// Only the volatile suffix changed, so the reused boundary reports "suffix".
	expect(second.observations[0]!.reason).toBe("suffix");
	expect(second.observations[0]!.reusableInputBytes).toBeGreaterThan(0);

	// Changing the first history message invalidates the old boundary.
	const changed: Context = {
		systemPrompt: "sys",
		messages: [
			{ role: "user", content: "history edited", timestamp: 1 },
			{ role: "user", content: "plan", timestamp: 2 },
		],
		cacheHints: {
			origins: [
				{ id: "entry:a", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
			previous: checkpoint,
		},
	};
	const third = await captureWire("anthropic-messages", changed, { cacheRetention: "short" });
	expect(third.observations[0]!.reason).toBe("history-change");
	expect(third.observations[0]!.reusableInputBytes).toBe(0);
});

it("keeps the legacy tail marker when hints are absent or retention is none", async () => {
	const base: Context = {
		messages: [
			{ role: "user", content: "history", timestamp: 1 },
			{ role: "user", content: "complete-plan", timestamp: 2 },
		],
	};
	const noHints = await captureWire("anthropic-messages", base, { cacheRetention: "short" });
	expect(markerPositions(noHints.body)).toContain("messages:1:0");
	expect(noHints.observations).toHaveLength(0);

	const none = await captureWire(
		"anthropic-messages",
		{
			...base,
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{ cacheRetention: "none" },
	);
	expect(countMarkers(none.body)).toBe(0);
});

it("marks tool result endpoints inside a merged group without touching sibling content", async () => {
	const assistant = fauxAssistantMessage(
		[
			{ type: "toolCall", id: "call_1", name: "lookup", arguments: { value: "a" } },
			{ type: "toolCall", id: "call_2", name: "lookup", arguments: { value: "b" } },
		],
		{ stopReason: "toolUse" },
	);
	const context: Context = {
		tools: [lookupTool],
		messages: [
			assistant,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "lookup",
				content: [{ type: "text", text: "first result" }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "lookup",
				content: [{ type: "text", text: "second result" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "complete-plan", timestamp: 4 },
		],
		cacheHints: {
			origins: [
				{ id: "entry:assistant", kind: "stable" },
				{ id: "entry:r1", kind: "stable" },
				{ id: "entry:r2", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
		},
	};
	const { body } = await captureWire("anthropic-messages", context, { cacheRetention: "short" });
	const positions = markerPositions(body);
	// The merged toolResult group is messages:1; the last stable source (r2)
	// ends at its tool_result block.
	expect(positions).toContain("messages:1:1");
	expect(positions.filter((p) => p.startsWith("messages:1:"))).toHaveLength(1);
	expect(countMarkers(body)).toBeLessThanOrEqual(4);
	const serialized = JSON.stringify(body);
	expect(serialized).toContain("first result");
	expect(serialized).toContain("second result");
	expect(serialized).toContain("complete-plan");
});

it("caps total markers at four across history, system, and tools", async () => {
	const context: Context = {
		systemPrompt: "sys",
		tools: [lookupTool],
		messages: [
			{ role: "user", content: "h1", timestamp: 1 },
			{ role: "user", content: "h2", timestamp: 2 },
			{ role: "user", content: "complete-plan", timestamp: 3 },
		],
		cacheHints: {
			origins: [
				{ id: "entry:a", kind: "stable" },
				{ id: "entry:b", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
		},
	};
	const { body } = await captureWire("anthropic-messages", context, { cacheRetention: "short" });
	expect(countMarkers(body)).toBeLessThanOrEqual(4);
	expect(markerPositions(body)).toContain("messages:1:0");
});

it("keeps image blocks untouched and falls back when origins are unmapped", async () => {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
				timestamp: 1,
			},
			{ role: "user", content: "tail", timestamp: 2 },
		],
		// Origins shorter than messages: treated as absent by the adapter.
		cacheHints: { origins: [{ id: "entry:a", kind: "stable" }] },
	};
	const { body } = await captureWire("anthropic-messages", context, { cacheRetention: "short" });
	const messages = body.messages as WireMessage[];
	const image = contentBlocks(messages[0]!)[0]!;
	expect(image.type).toBe("image");
	expect(image.cache_control).toBeUndefined();
	expect(markerPositions(body)).toContain("messages:1:0");
});
