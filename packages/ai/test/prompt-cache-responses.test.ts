import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { expect, it, onTestFinished } from "vitest";
import { stream as streamCodexResponses } from "../src/api/openai-codex-responses.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Context, Model, PromptCacheObservation } from "../src/types.ts";
import { captureWire } from "./prompt-cache-fixtures.ts";

type WireItem = Record<string, unknown>;

function inputItems(body: Record<string, unknown>): WireItem[] {
	return (body.input as WireItem[]) ?? [];
}

function countBreakpoints(value: unknown): number {
	if (value === null || typeof value !== "object") return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countBreakpoints(item), 0);
	const record = value as WireItem;
	let count = record.prompt_cache_breakpoint !== undefined ? 1 : 0;
	for (const key of Object.keys(record)) count += countBreakpoints(record[key]);
	return count;
}

function breakpointItems(body: Record<string, unknown>): WireItem[] {
	return inputItems(body).filter((item) => countBreakpoints(item) > 0);
}

const explicitCompat = { supportsExplicitPromptCacheMode: true } as const;

it("places the breakpoint inside the stable tool result text", async () => {
	const assistant = fauxAssistantMessage(
		[{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }],
		{ stopReason: "toolUse" },
	);
	const { body } = await captureWire(
		"openai-responses",
		{
			messages: [
				assistant,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "exact output\n" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "complete-plan", timestamp: 3 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "entry:r", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{ cacheRetention: "short" },
		explicitCompat,
	);
	const input = inputItems(body);
	const result = input.find((item) => item.type === "function_call_output")!;
	expect(result.output).toEqual([
		{ type: "input_text", text: "exact output\n", prompt_cache_breakpoint: { mode: "explicit" } },
	]);
	expect(input.some((item) => item.type === "prompt_cache_breakpoint")).toBe(false);
});

it("reuses the old endpoint after append-only growth and reports a checkpoint", async () => {
	const first = await captureWire(
		"openai-responses",
		{
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "history", timestamp: 1 },
				{ role: "user", content: "plan", timestamp: 2 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{ cacheRetention: "short" },
		explicitCompat,
	);
	expect(first.observations).toHaveLength(1);
	const checkpoint = first.observations[0]!.checkpoint;
	expect(checkpoint?.historyBoundary.originId).toBe("entry:a");
	expect(first.observations[0]!.reason).toBe("append");
	const firstMarked = breakpointItems(first.body);
	expect(firstMarked).toHaveLength(1);
	expect(firstMarked[0]!.role).toBe("user");
	expect((firstMarked[0]!.content as WireItem[])[0]!.text).toBe("history");

	// Second request: same stable prefix, grown volatile suffix. The old
	// boundary must still be marked and reported as reused.
	const grown: Context = {
		systemPrompt: "sys",
		messages: [
			{ role: "user", content: "history", timestamp: 1 },
			{ role: "user", content: `plan ${"more ".repeat(20)}`, timestamp: 2 },
		],
		cacheHints: {
			origins: [
				{ id: "entry:a", kind: "stable" },
				{ id: "request:plan", kind: "volatile" },
			],
			previous: checkpoint,
		},
	};
	const second = await captureWire("openai-responses", grown, { cacheRetention: "short" }, explicitCompat);
	const secondMarked = breakpointItems(second.body);
	expect(secondMarked).toHaveLength(1);
	expect((secondMarked[0]!.content as WireItem[])[0]!.text).toBe("history");
	expect(second.observations[0]!.reason).toBe("suffix");
	expect(second.observations[0]!.reusableInputBytes).toBeGreaterThan(0);

	// Editing the stable prefix invalidates the old boundary.
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
	const third = await captureWire("openai-responses", changed, { cacheRetention: "short" }, explicitCompat);
	expect(third.observations[0]!.reason).toBe("history-change");
	expect(third.observations[0]!.reusableInputBytes).toBe(0);
});

it("marks old and new endpoints when a reusable boundary and a newer stable source exist", async () => {
	const first = await captureWire(
		"openai-responses",
		{
			messages: [
				{ role: "user", content: "history", timestamp: 1 },
				{ role: "user", content: "plan", timestamp: 2 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{ cacheRetention: "short" },
		explicitCompat,
	);
	const checkpoint = first.observations[0]!.checkpoint;

	const second = await captureWire(
		"openai-responses",
		{
			messages: [
				{ role: "user", content: "history", timestamp: 1 },
				{ role: "user", content: "follow-up", timestamp: 2 },
				{ role: "user", content: "plan", timestamp: 3 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "entry:b", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
				previous: checkpoint,
			},
		},
		{ cacheRetention: "short" },
		explicitCompat,
	);
	// Old reusable endpoint plus the newest stable endpoint are both marked.
	const marked = breakpointItems(second.body);
	expect(marked).toHaveLength(2);
	const texts = marked.map((item) => (item.content as WireItem[])[0]!.text);
	expect(texts).toEqual(["history", "follow-up"]);
	expect(second.observations[0]!.reason).toBe("append");
});

it("suppresses markers for cacheRetention none and stays identical without capability", async () => {
	const context: Context = {
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
	};

	const none = await captureWire("openai-responses", context, { cacheRetention: "none" }, explicitCompat);
	expect(countBreakpoints(none.body)).toBe(0);
	expect(none.observations[0]!.reason).toBe("disabled");

	// Without the capability the payload is byte-identical to a hint-less
	// request — no wrapping, no breakpoint fields.
	const unsupported = await captureWire("openai-responses", context, { cacheRetention: "short" });
	const baseline = await captureWire("openai-responses", { messages: context.messages }, { cacheRetention: "short" });
	expect(unsupported.body).toEqual(baseline.body);
	expect(unsupported.observations[0]!.reason).toBe("unsupported");
	expect(countBreakpoints(unsupported.body)).toBe(0);
});

it("keeps image content and array outputs intact while marking them", async () => {
	const assistant = fauxAssistantMessage([{ type: "toolCall", id: "call_1", name: "shot", arguments: {} }], {
		stopReason: "toolUse",
	});
	const { body } = await captureWire(
		"openai-responses",
		{
			messages: [
				assistant,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "shot",
					content: [
						{ type: "text", text: "capture" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "plan", timestamp: 3 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "entry:r", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{ cacheRetention: "short" },
		explicitCompat,
	);
	const result = inputItems(body).find((item) => item.type === "function_call_output")!;
	// Array outputs stay arrays; the image part is untouched and the marker
	// lands on the input_text block.
	const output = result.output as WireItem[];
	expect(Array.isArray(output)).toBe(true);
	expect(output.map((part) => part.type)).toEqual(["input_text", "input_image"]);
	expect(output[0]!.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
	expect(output[1]!.prompt_cache_breakpoint).toBeUndefined();
	expect((output[1]!.image_url as string).startsWith("data:image/png;base64,")).toBe(true);
});

it("preserves foreign tool call ids and fallback message ids", async () => {
	const foreignId = "call_foreign|weird/item+id==";
	const assistant = fauxAssistantMessage(
		[
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
			{ type: "toolCall", id: foreignId, name: "read", arguments: {} },
		],
		{ stopReason: "toolUse" },
	);
	const buildContext = (withHints: boolean): Context => ({
		messages: [
			{ role: "user", content: "hi", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: foreignId,
				toolName: "read",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "plan", timestamp: 4 },
		],
		...(withHints
			? {
					cacheHints: {
						origins: [
							{ id: "entry:u", kind: "stable" },
							{ id: "entry:a", kind: "stable" },
							{ id: "entry:r", kind: "stable" },
							{ id: "request:plan", kind: "volatile" },
						],
					},
				}
			: {}),
	});
	const hinted = await captureWire(
		"openai-responses",
		buildContext(true),
		{ cacheRetention: "short" },
		explicitCompat,
	);
	const plain = await captureWire(
		"openai-responses",
		buildContext(false),
		{ cacheRetention: "short" },
		explicitCompat,
	);

	const ids = (body: Record<string, unknown>) =>
		inputItems(body)
			.map((item) => (item.id as string | undefined) ?? (item.call_id as string | undefined))
			.filter(Boolean);
	// Markers must not drift generated ids.
	expect(ids(hinted.body)).toEqual(ids(plain.body));
	// The foreign call/result pairing survives normalization untouched.
	const call = inputItems(hinted.body).find((item) => item.type === "function_call")!;
	const result = inputItems(hinted.body).find((item) => item.type === "function_call_output")!;
	expect(call.call_id).toBe(result.call_id);
	expect(String(call.call_id)).toContain("call_foreign");
});

it("lets onPayload inspect and replace the marked request body", async () => {
	const seen: Record<string, unknown>[] = [];
	const { body } = await captureWire(
		"openai-responses",
		{
			messages: [
				{ role: "user", content: "history", timestamp: 1 },
				{ role: "user", content: "plan", timestamp: 2 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{
			cacheRetention: "short",
			onPayload: (params) => {
				seen.push(params as Record<string, unknown>);
				const replaced = structuredClone(params) as Record<string, unknown>;
				(replaced as { metadata?: Record<string, string> }).metadata = { tag: "hook" };
				return replaced as never;
			},
		},
		explicitCompat,
	);
	expect(seen).toHaveLength(1);
	// The hook observed the marked payload, and its replacement was sent.
	expect(countBreakpoints(seen[0]!)).toBe(1);
	expect((body.metadata as Record<string, string>).tag).toBe("hook");
	expect(countBreakpoints(body)).toBe(1);
});

it("retreats to the last markable block when deferred tool items close the source", async () => {
	const assistant = fauxAssistantMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }], {
		stopReason: "toolUse",
	});
	const tool = {
		name: "deferred_tool",
		description: "deferred",
		parameters: { type: "object" as const, properties: {} },
	};
	const { body } = await captureWire(
		"openai-responses",
		{
			tools: [tool],
			messages: [
				assistant,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 2,
					addedToolNames: ["deferred_tool"],
				},
				{ role: "user", content: "plan", timestamp: 3 },
			],
			cacheHints: {
				origins: [
					{ id: "entry:a", kind: "stable" },
					{ id: "entry:r", kind: "stable" },
					{ id: "request:plan", kind: "volatile" },
				],
			},
		},
		{ cacheRetention: "short" },
		{ ...explicitCompat, supportsToolSearch: true },
	);
	const input = inputItems(body);
	const search = input.find((item) => item.type === "tool_search_call");
	expect(search).toBeDefined();
	// The marker lands on the tool result text, never inside the tool-search
	// group that closes the same source.
	const marked = breakpointItems(body);
	expect(marked).toHaveLength(1);
	expect(marked[0]!.type).toBe("function_call_output");
	expect(input.every((item) => item.type !== "tool_search_call" || countBreakpoints(item) === 0)).toBe(true);
});

// --- Codex endpoint: identical body unless its own compat confirms support ---

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

async function captureCodexWire(
	context: Context,
	compat: Model<"openai-codex-responses">["compat"],
	transport: "sse" | "websocket",
): Promise<{ body: Record<string, unknown>; observations: PromptCacheObservation[] }> {
	const tempDir = mkdtempSync(join(tmpdir(), "metis-codex-cache-"));
	onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }));
	process.env.METIS_CODING_AGENT_DIR = tempDir;

	let body: Record<string, unknown> | undefined;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const raw = Buffer.concat(chunks);
		if (raw.length > 0) {
			// The codex SSE path may send a zstd-compressed body.
			const isZstd = raw.length > 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd;
			body = JSON.parse((isZstd ? zstdDecompressSync(raw) : raw).toString("utf8"));
		}
		// Empty-body requests (e.g. the WebSocket upgrade probe) get a plain
		// non-upgrade response so the client falls back to SSE.
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	const observations: PromptCacheObservation[] = [];
	const model: Model<"openai-codex-responses"> = {
		id: "codex-cache-test",
		name: "Codex Cache Test",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: `http://127.0.0.1:${port}`,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1024,
		...(compat !== undefined ? { compat } : {}),
	};
	try {
		const events = streamCodexResponses(model, context, {
			apiKey: codexToken(),
			transport,
			maxRetries: 0,
			timeoutMs: 2000,
			websocketConnectTimeoutMs: 500,
			onPromptCachePrepared: (observation) => observations.push(observation),
		});
		try {
			await events.result();
		} catch {
			// Empty SSE bodies may produce an error result; only the captured
			// request body matters here.
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	}
	if (!body) throw new Error("Expected loopback codex request");
	return { body, observations };
}

const codexContext: Context = {
	systemPrompt: "sys",
	messages: [
		{ role: "user", content: "history", timestamp: 1 },
		{ role: "user", content: "plan", timestamp: 2 },
	],
	cacheHints: {
		origins: [
			{ id: "entry:a", kind: "stable" },
			{ id: "request:plan", kind: "volatile" },
		],
	},
};

it("keeps the codex request identical without explicit capability, on SSE and WebSocket fallback", async () => {
	const withHints = await captureCodexWire(codexContext, undefined, "sse");
	const { cacheHints: _hints, ...plainContext } = codexContext;
	const plain = await captureCodexWire(plainContext, undefined, "sse");
	expect(withHints.body).toEqual(plain.body);
	expect(countBreakpoints(withHints.body)).toBe(0);
	expect(withHints.observations[0]!.reason).toBe("unsupported");

	// The WebSocket transport falls back to the same request shape when the
	// connection cannot be established; the body still carries no markers.
	const ws = await captureCodexWire(codexContext, undefined, "websocket");
	expect(ws.body).toEqual(plain.body);
	expect(countBreakpoints(ws.body)).toBe(0);
});

it("marks codex breakpoints only when its own compat confirms explicit mode", async () => {
	const supported = await captureCodexWire(codexContext, { supportsExplicitPromptCacheMode: true }, "sse");
	expect(countBreakpoints(supported.body)).toBe(1);
	const marked = breakpointItems(supported.body);
	expect((marked[0]!.content as WireItem[])[0]!.text).toBe("history");
	expect(supported.observations[0]!.checkpoint?.provider).toBe("openai-codex");
});
