import { createHash } from "node:crypto";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { Context, PromptCacheCheckpoint, Tool } from "../src/types.ts";
import { captureWire, type PromptCacheWireApi } from "./prompt-cache-fixtures.ts";

type JsonObject = Record<string, unknown>;
type WireItem = Record<string, unknown>;

const lookupTool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

const compatFor = (api: PromptCacheWireApi) =>
	api === "openai-responses" ? ({ supportsExplicitPromptCacheMode: true } as const) : undefined;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

interface ExpectedPrefix {
	digest: string;
	settingsDigest: string;
	bytes: number;
}

interface PrefixState {
	digest: string;
	bytes: number;
}

/** Independent implementation of the persisted `[previous, frameJson]` chain. */
function advance(state: PrefixState, frame: unknown): void {
	const json = JSON.stringify(frame);
	state.digest = sha256(JSON.stringify([state.digest, json]));
	state.bytes += Buffer.byteLength(json, "utf8");
}

function withoutMarker(value: unknown, marker: "cache_control" | "prompt_cache_breakpoint"): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const { [marker]: _marker, ...rest } = value as JsonObject;
	return rest;
}

/**
 * Replay the Anthropic chain from the captured pre-hook wire body. The body is
 * stripped of this layout's own markers, so the expected digest describes the
 * same pre-marking frames the adapter must have hashed.
 */
function expectedAnthropicPrefix(body: JsonObject, paramIndex: number, blockIndex: number): ExpectedPrefix {
	const { messages, tools, system, ...settings } = body;
	const settingsJson = JSON.stringify(settings);
	const state: PrefixState = {
		digest: sha256(JSON.stringify({ model: body.model ?? null, tool_choice: body.tool_choice ?? null })),
		bytes: Buffer.byteLength(settingsJson, "utf8"),
	};
	if (tools) advance(state, Array.isArray(tools) ? tools.map((tool) => withoutMarker(tool, "cache_control")) : tools);
	if (system) {
		advance(state, Array.isArray(system) ? system.map((block) => withoutMarker(block, "cache_control")) : system);
	}
	const wireMessages = (messages as WireItem[] | undefined) ?? [];
	for (let index = 0; index < wireMessages.length; index++) {
		const message = wireMessages[index]!;
		advance(state, { role: message.role });
		const blocks =
			typeof message.content === "string"
				? [message.content]
				: Array.isArray(message.content)
					? message.content.map((block) => withoutMarker(block, "cache_control"))
					: [];
		for (let position = 0; position < blocks.length; position++) {
			advance(state, blocks[position]);
			if (index === paramIndex && position === blockIndex) {
				return { ...state, settingsDigest: sha256(settingsJson) };
			}
		}
	}
	throw new Error("Anthropic expected prefix does not contain the requested block");
}

function stripResponsesMarkers(item: unknown): unknown {
	if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
	const record = { ...(item as JsonObject) };
	if (Array.isArray(record.content)) {
		record.content = record.content.map((block) => withoutMarker(block, "prompt_cache_breakpoint"));
	}
	if (record.type === "function_call_output" && Array.isArray(record.output)) {
		record.output = record.output.map((block) => withoutMarker(block, "prompt_cache_breakpoint"));
	}
	return record;
}

/** Replay the Responses chain from the captured pre-hook wire body. */
function expectedResponsesPrefix(body: JsonObject, itemIndex: number): ExpectedPrefix {
	const { input, ...settings } = body;
	const settingsJson = JSON.stringify(settings);
	const state: PrefixState = {
		digest: sha256(
			JSON.stringify({
				model: body.model ?? null,
				instructions: body.instructions ?? null,
				tool_choice: body.tool_choice ?? null,
				tools: body.tools ?? null,
				previous_response_id: body.previous_response_id ?? null,
			}),
		),
		bytes: Buffer.byteLength(settingsJson, "utf8"),
	};
	const items = (input as unknown[] | undefined) ?? [];
	for (let index = 0; index < items.length; index++) {
		advance(state, stripResponsesMarkers(items[index]));
		if (index === itemIndex) return { ...state, settingsDigest: sha256(settingsJson) };
	}
	throw new Error("Responses expected prefix does not contain the requested item");
}

/** `historyIndex` is the stable history entry; Responses adds its leading system item. */
function expectedPrefix(api: PromptCacheWireApi, body: JsonObject, historyIndex = 0): ExpectedPrefix {
	return api === "anthropic-messages"
		? expectedAnthropicPrefix(body, historyIndex, 0)
		: expectedResponsesPrefix(body, historyIndex + 1);
}

function context(previous?: PromptCacheCheckpoint): Context {
	return {
		systemPrompt: "系统 😀",
		tools: [lookupTool],
		messages: [
			{ role: "user", content: [{ type: "text", text: "历史 😀 first" }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "plan" }], timestamp: 2 },
		],
		cacheHints: {
			origins: [
				{ id: "entry:a", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
			...(previous ? { previous } : {}),
		},
	};
}

function appendedContext(previous: PromptCacheCheckpoint): Context {
	return {
		systemPrompt: "系统 😀",
		tools: [lookupTool],
		messages: [
			{ role: "user", content: [{ type: "text", text: "历史 😀 first" }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "history 😀 second" }], timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "plan" }], timestamp: 3 },
		],
		cacheHints: {
			origins: [
				{ id: "entry:a", kind: "stable" },
				{ id: "entry:b", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
			previous,
		},
	};
}

function changedContext(previous: PromptCacheCheckpoint): Context {
	return {
		systemPrompt: "系统 😀",
		tools: [lookupTool],
		messages: [
			{ role: "user", content: [{ type: "text", text: "历史 😀 edited" }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "plan" }], timestamp: 2 },
		],
		cacheHints: {
			origins: [
				{ id: "entry:a", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
			previous,
		},
	};
}

function editWireText(api: PromptCacheWireApi, body: JsonObject, from: string, to: string): void {
	const items = (api === "anthropic-messages" ? body.messages : body.input) as WireItem[] | undefined;
	for (const item of items ?? []) {
		const content = item.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if ((block as WireItem).text === from) (block as WireItem).text = to;
		}
	}
}

for (const api of ["anthropic-messages", "openai-responses"] as const) {
	it(`${api}: hashes real wire prefixes with UTF-8 byte accounting and reuses warm digests`, async () => {
		const first = await captureWire(api, context(), { cacheRetention: "short" }, compatFor(api));
		const expected = expectedPrefix(api, first.body);
		const observation = first.observations[0]!;
		expect(observation.reason).toBe("append");
		expect(observation.checkpoint?.settingsDigest).toBe(expected.settingsDigest);
		expect(observation.checkpoint?.historyBoundary.prefixDigest).toBe(expected.digest);
		expect(observation.reusableInputBytes).toBe(0);
		// The Unicode system prompt and history must count serialized UTF-8 bytes,
		// not JavaScript code units.
		expect(observation.stableInputBytes).toBe(expected.bytes);

		const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest");
		try {
			const warm = await captureWire(api, context(), { cacheRetention: "short" }, compatFor(api));
			expect(digestSpy).not.toHaveBeenCalled();
			expect(warm.observations).toEqual(first.observations);
		} finally {
			digestSpy.mockRestore();
		}
	});

	it(`${api}: reuses appended history and invalidates a rewritten prefix`, async () => {
		const first = await captureWire(api, context(), { cacheRetention: "short" }, compatFor(api));
		const checkpoint = first.observations[0]!.checkpoint!;
		const firstExpected = expectedPrefix(api, first.body);

		const appended = await captureWire(api, appendedContext(checkpoint), { cacheRetention: "short" }, compatFor(api));
		const appendExpected = expectedPrefix(api, appended.body, 1);
		const appendObservation = appended.observations[0]!;
		expect(appendObservation.reason).toBe("append");
		expect(appendObservation.checkpoint?.historyBoundary.originId).toBe("entry:b");
		expect(appendObservation.checkpoint?.historyBoundary.prefixDigest).toBe(appendExpected.digest);
		expect(appendObservation.checkpoint?.historyBoundary.prefixDigest).not.toBe(firstExpected.digest);
		expect(appendObservation.reusableInputBytes).toBe(firstExpected.bytes);
		expect(appendObservation.stableInputBytes).toBe(appendExpected.bytes);

		const changed = await captureWire(api, changedContext(checkpoint), { cacheRetention: "short" }, compatFor(api));
		const changedExpected = expectedPrefix(api, changed.body);
		const changedObservation = changed.observations[0]!;
		expect(changedObservation.reason).toBe("history-change");
		expect(changedObservation.checkpoint?.historyBoundary.originId).toBe("entry:a");
		expect(changedObservation.checkpoint?.historyBoundary.prefixDigest).toBe(changedExpected.digest);
		expect(changedObservation.checkpoint?.historyBoundary.prefixDigest).not.toBe(firstExpected.digest);
		expect(changedObservation.reusableInputBytes).toBe(0);
		expect(changedObservation.stableInputBytes).toBe(changedExpected.bytes);
	});

	it(`${api}: payload hooks preserve a suffix checkpoint and revoke a rewritten prefix`, async () => {
		const first = await captureWire(api, context(), { cacheRetention: "short" }, compatFor(api));
		const checkpoint = first.observations[0]!.checkpoint!;
		const stableBytes = expectedPrefix(api, first.body).bytes;

		const suffix = await captureWire(
			api,
			context(checkpoint),
			{
				cacheRetention: "short",
				onPayload: (params) => {
					editWireText(api, params as JsonObject, "plan", "plan (hook suffix)");
				},
			},
			compatFor(api),
		);
		expect(suffix.observations[0]!.reason).toBe("suffix");
		expect(suffix.observations[0]!.checkpoint?.historyBoundary).toEqual(checkpoint.historyBoundary);
		expect(suffix.observations[0]!.reusableInputBytes).toBe(stableBytes);
		expect(suffix.observations[0]!.stableInputBytes).toBe(stableBytes);

		const rewritten = await captureWire(
			api,
			context(checkpoint),
			{
				cacheRetention: "short",
				onPayload: (params) => {
					editWireText(api, params as JsonObject, "历史 😀 first", "历史 😀 hook edit");
				},
			},
			compatFor(api),
		);
		expect(rewritten.observations[0]!.reason).toBe("hook-change");
		expect(rewritten.observations[0]!.checkpoint).toBeUndefined();
		expect(rewritten.observations[0]!.reusableInputBytes).toBe(0);
		expect(rewritten.observations[0]!.stableInputBytes).toBe(stableBytes);
	});
}
