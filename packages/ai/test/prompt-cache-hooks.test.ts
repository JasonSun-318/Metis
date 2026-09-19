import { expect, it } from "vitest";
import type { Context, PromptCacheCheckpoint } from "../src/types.ts";
import { captureWire, type PromptCacheWireApi } from "./prompt-cache-fixtures.ts";

type WireItem = Record<string, unknown>;

function countMarkers(api: PromptCacheWireApi, value: unknown): number {
	if (value === null || typeof value !== "object") return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countMarkers(api, item), 0);
	const record = value as WireItem;
	const marker = api === "anthropic-messages" ? "cache_control" : "prompt_cache_breakpoint";
	let count = record[marker] !== undefined ? 1 : 0;
	for (const key of Object.keys(record)) count += countMarkers(api, record[key]);
	return count;
}

function messagesWithHints(previous?: PromptCacheCheckpoint): Context {
	return {
		systemPrompt: "sys",
		messages: [
			{ role: "user", content: "first history", timestamp: 1 },
			{ role: "user", content: "second history", timestamp: 2 },
			{ role: "user", content: "plan", timestamp: 3 },
		],
		cacheHints: {
			origins: [
				{ id: "entry:a", kind: "stable" },
				{ id: "entry:b", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
			...(previous ? { previous } : {}),
		},
	};
}

const compatFor = (api: PromptCacheWireApi) =>
	api === "openai-responses" ? { supportsExplicitPromptCacheMode: true } : undefined;

function editItemText(item: WireItem | undefined, text: string): void {
	if (!item) return;
	if (typeof item.content === "string") {
		item.content = text;
		return;
	}
	const content = item.content as WireItem[] | undefined;
	if (Array.isArray(content)) {
		const block = content.find((entry) => typeof entry?.text === "string");
		if (block) block.text = text;
	}
}

function findItemByText(items: WireItem[], text: string): WireItem | undefined {
	return items.find((item) => {
		const content = item.content;
		if (typeof content === "string") return content === text;
		if (Array.isArray(content)) {
			return content.some((block) => (block as WireItem)?.text === text);
		}
		return false;
	});
}

/**
 * Apply the hook mutation to a serialized request body for either provider.
 * Returns the body so hooks may return a replacement instead of mutating.
 */
function applyChange(api: PromptCacheWireApi, change: string, body: WireItem): WireItem {
	const items = (api === "anthropic-messages" ? body.messages : body.input) as WireItem[];
	switch (change) {
		case "suffix-text":
			editItemText(findItemByText(items, "plan"), "plan (hook suffix)");
			return body;
		case "first-history-text":
			editItemText(findItemByText(items, "first history"), "first history (hook)");
			return body;
		case "prepend-message":
			items.unshift(
				api === "anthropic-messages"
					? { role: "user", content: [{ type: "text", text: "hook injected" }] }
					: { type: "message", role: "user", content: [{ type: "input_text", text: "hook injected" }] },
			);
			return body;
		case "clone-only":
			return JSON.parse(JSON.stringify(body)) as WireItem;
		default:
			throw new Error(`Unknown hook change: ${change}`);
	}
}

// The second request re-marks only the reused boundary (one history marker);
// Anthropic additionally spends a marker on the system prefix.
const validMarkerCount = (api: PromptCacheWireApi) => (api === "anthropic-messages" ? 2 : 1);

const hookCases = [
	{ change: "suffix-text", expected: "suffix", checkpoint: true },
	{ change: "first-history-text", expected: "hook-change", checkpoint: false },
	{ change: "prepend-message", expected: "hook-change", checkpoint: false },
	{ change: "clone-only", expected: "suffix", checkpoint: true },
] as const;

for (const api of ["anthropic-messages", "openai-responses"] as const) {
	for (const hookCase of hookCases) {
		it(`${api}: ${hookCase.change} hook reports ${hookCase.expected}`, async () => {
			const first = await captureWire(api, messagesWithHints(), { cacheRetention: "short" }, compatFor(api));
			const checkpoint = first.observations[0]!.checkpoint;
			expect(checkpoint).toBeDefined();

			let calls = 0;
			const second = await captureWire(
				api,
				messagesWithHints(checkpoint),
				{
					cacheRetention: "short",
					onPayload: (params) => {
						calls++;
						return applyChange(api, hookCase.change, params as WireItem) as never;
					},
				},
				compatFor(api),
			);
			expect(calls).toBe(1);
			const observation = second.observations[0]!;
			expect(observation.reason).toBe(hookCase.expected);
			if (hookCase.checkpoint) {
				expect(observation.checkpoint).toBeDefined();
			} else {
				expect(observation.checkpoint).toBeUndefined();
			}

			const items = (api === "anthropic-messages" ? second.body.messages : second.body.input) as WireItem[];
			switch (hookCase.change) {
				case "suffix-text": {
					const edited = findItemByText(items, "plan (hook suffix)");
					expect(edited).toBeDefined();
					expect(countMarkers(api, second.body)).toBe(validMarkerCount(api));
					break;
				}
				case "first-history-text": {
					const edited = findItemByText(items, "first history (hook)");
					expect(edited).toBeDefined();
					// The still-identifiable markers were revoked.
					expect(countMarkers(api, second.body)).toBe(0);
					break;
				}
				case "prepend-message": {
					expect(items).toHaveLength(api === "anthropic-messages" ? 4 : 5);
					expect(findItemByText(items, "hook injected")).toBeDefined();
					expect(countMarkers(api, second.body)).toBe(0);
					break;
				}
				case "clone-only": {
					expect(countMarkers(api, second.body)).toBe(validMarkerCount(api));
					break;
				}
			}
		});
	}
}

it("openai-responses: hook rewriting the settings frame keeps markers and checkpoint", async () => {
	const first = await captureWire(
		"openai-responses",
		messagesWithHints(),
		{ cacheRetention: "short" },
		compatFor("openai-responses"),
	);
	const second = await captureWire(
		"openai-responses",
		messagesWithHints(first.observations[0]!.checkpoint),
		{
			cacheRetention: "short",
			onPayload: (params) => {
				const cloned = JSON.parse(JSON.stringify(params)) as WireItem;
				cloned.metadata = { tag: "hook" };
				cloned.temperature = 0.1;
				return cloned as never;
			},
		},
		compatFor("openai-responses"),
	);
	expect(second.body.metadata).toEqual({ tag: "hook" });
	expect(second.body.temperature).toBe(0.1);
	expect(countMarkers("openai-responses", second.body)).toBe(1);
	expect(second.observations[0]!.checkpoint).toBeDefined();
	expect(second.observations[0]!.reason).toBe("suffix");
});

it("openai-responses: hook rewriting tools clears the checkpoint", async () => {
	const first = await captureWire(
		"openai-responses",
		messagesWithHints(),
		{ cacheRetention: "short" },
		compatFor("openai-responses"),
	);
	const second = await captureWire(
		"openai-responses",
		messagesWithHints(first.observations[0]!.checkpoint),
		{
			cacheRetention: "short",
			onPayload: (params) => {
				const cloned = JSON.parse(JSON.stringify(params)) as WireItem;
				cloned.tools = [{ type: "function", name: "hook_tool", parameters: {} }];
				return cloned as never;
			},
		},
		compatFor("openai-responses"),
	);
	expect((second.body.tools as WireItem[])[0]!.name).toBe("hook_tool");
	expect(second.observations[0]!.reason).toBe("hook-change");
	expect(second.observations[0]!.checkpoint).toBeUndefined();
});

it("anthropic-messages: hook rewriting tools clears the checkpoint", async () => {
	const first = await captureWire(
		"anthropic-messages",
		messagesWithHints(),
		{ cacheRetention: "short" },
		compatFor("anthropic-messages"),
	);
	const second = await captureWire(
		"anthropic-messages",
		messagesWithHints(first.observations[0]!.checkpoint),
		{
			cacheRetention: "short",
			onPayload: (params) => {
				const cloned = JSON.parse(JSON.stringify(params)) as WireItem;
				cloned.tools = [{ name: "hook_tool", input_schema: { type: "object" } }];
				return cloned as never;
			},
		},
		compatFor("anthropic-messages"),
	);
	expect((second.body.tools as WireItem[])[0]!.name).toBe("hook_tool");
	expect(second.observations[0]!.reason).toBe("hook-change");
	expect(second.observations[0]!.checkpoint).toBeUndefined();
	expect(countMarkers("anthropic-messages", second.body)).toBe(0);
});

it("observation callback failures do not break the request", async () => {
	const { body } = await captureWire(
		"openai-responses",
		messagesWithHints(),
		{
			cacheRetention: "short",
			onPromptCachePrepared: () => {
				throw new Error("observer exploded");
			},
		},
		compatFor("openai-responses"),
	);
	expect(countMarkers("openai-responses", body)).toBeGreaterThan(0);
});
