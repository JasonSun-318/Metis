import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
const apiKey = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.bbb`;
const completed = JSON.stringify({
	type: "response.completed",
	response: { id: "resp_test", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});
const success = () => new Response(`data: ${completed}\n\n`);

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Codex retry boundaries", () => {
	it.each([400, 401, 403])("does not retry terminal HTTP %s even with a misleading body", async (status) => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () => new Response("service unavailable: invalid credentials", { status }));
		vi.stubGlobal("fetch", fetchMock);
		const result = stream(model, context, { apiKey, transport: "sse", maxRetries: 2 }).result();
		await vi.runAllTimersAsync();
		expect((await result).stopReason).toBe("error");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("does not retry response callback failures", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () => success());
		vi.stubGlobal("fetch", fetchMock);
		const result = stream(model, context, {
			apiKey,
			transport: "sse",
			maxRetries: 2,
			onResponse: () => {
				throw new Error("callback failed");
			},
		}).result();
		await vi.runAllTimersAsync();
		expect((await result).errorMessage).toContain("callback failed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it.each([429, 503])("rejects excessive Retry-After for HTTP %s", async (status) => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("busy", { status, headers: { "retry-after-ms": "3600000" } }))
			.mockImplementation(async () => success());
		vi.stubGlobal("fetch", fetchMock);
		const result = stream(model, context, {
			apiKey,
			transport: "sse",
			maxRetries: 1,
			maxRetryDelayMs: 60000,
		}).result();
		await vi.runAllTimersAsync();
		expect((await result).errorMessage).toContain("3600000");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it.each([false, true])("removes retry sleep listeners after completion or abort (%s)", async (abort) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockImplementation(async () => success());
		vi.stubGlobal("fetch", fetchMock);
		const result = stream(model, context, {
			apiKey,
			transport: "sse",
			signal: controller.signal,
			maxRetries: 1,
		}).result();
		await vi.advanceTimersByTimeAsync(0);
		if (abort) controller.abort();
		await vi.runAllTimersAsync();
		expect((await result).stopReason).toBe(abort ? "aborted" : "stop");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledTimes(abort ? 1 : 2);
	});
	it("caps exponential backoff for transport failures", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockRejectedValueOnce(new Error("network"))
				.mockRejectedValueOnce(new Error("network"))
				.mockImplementation(async () => success()),
		);
		const result = stream(model, context, {
			apiKey,
			transport: "sse",
			maxRetries: 2,
			maxRetryDelayMs: 1500,
		}).result();
		await vi.runAllTimersAsync();
		expect((await result).stopReason).toBe("stop");
		expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toEqual([1000, 1500]);
	});
});

it.each(["\n", "\r\n"])("reads SSE split at every byte with %j line endings", async (newline) => {
	const bytes = new TextEncoder().encode(`data: ${completed}${newline}${newline}`);
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
							controller.close();
						},
					}),
				),
		),
	);
	expect((await stream(model, context, { apiKey, transport: "sse" }).result()).stopReason).toBe("stop");
});

class TestWebSocket {
	static instances: TestWebSocket[] = [];
	readyState = 1;
	listeners = new Map<string, Set<(event: unknown) => void>>();
	constructor() {
		TestWebSocket.instances.push(this);
		queueMicrotask(() => this.emit("open", {}));
	}
	addEventListener(type: string, listener: (event: unknown) => void) {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: string, event: unknown) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
	send() {
		queueMicrotask(() => this.emit("message", { data: completed }));
	}
	close() {
		this.readyState = 3;
	}
}

it("keeps one cached socket after concurrent first requests and closes all session state", async () => {
	TestWebSocket.instances = [];
	vi.stubGlobal("WebSocket", TestWebSocket);
	const options = { apiKey, sessionId: "concurrent", transport: "websocket" as const };
	const results = await Promise.all([
		stream(model, context, options).result(),
		stream(model, context, options).result(),
	]);
	expect(results.map((result) => result.stopReason)).toEqual(["stop", "stop"]);
	expect(TestWebSocket.instances.filter((socket) => socket.readyState === 1)).toHaveLength(1);
	await stream(model, context, options).result();
	expect(TestWebSocket.instances).toHaveLength(2);
	closeOpenAICodexWebSocketSessions("concurrent");
	expect(TestWebSocket.instances.every((socket) => socket.readyState === 3)).toBe(true);
	expect(getOpenAICodexWebSocketDebugStats("concurrent")).toBeUndefined();
});

it("clears sticky SSE fallback when a session is closed", async () => {
	vi.stubGlobal(
		"WebSocket",
		class {
			constructor() {
				throw new Error("unavailable");
			}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => success()),
	);
	const options = { apiKey, sessionId: "fallback", transport: "auto" as const };
	await stream(model, context, options).result();
	expect(getOpenAICodexWebSocketDebugStats("fallback")?.websocketFallbackActive).toBe(true);
	closeOpenAICodexWebSocketSessions("fallback");
	expect(getOpenAICodexWebSocketDebugStats("fallback")).toBeUndefined();
	TestWebSocket.instances = [];
	vi.stubGlobal("WebSocket", TestWebSocket);
	await stream(model, context, options).result();
	expect(TestWebSocket.instances).toHaveLength(1);
});

it("does not let an expired entry's queued timer evict a replacement connection", async () => {
	vi.useFakeTimers();
	const timers = vi.spyOn(globalThis, "setTimeout");
	TestWebSocket.instances = [];
	vi.stubGlobal("WebSocket", TestWebSocket);
	const options = { apiKey, sessionId: "replacement", transport: "websocket" as const };
	await stream(model, context, options).result();
	const expiry = timers.mock.calls.find((call) => call[1] === 5 * 60 * 1000)![0] as () => void;
	closeOpenAICodexWebSocketSessions("replacement");
	await stream(model, context, options).result();
	expiry();
	await stream(model, context, options).result();
	expect(TestWebSocket.instances).toHaveLength(2);
	expect(getOpenAICodexWebSocketDebugStats("replacement")?.connectionsReused).toBe(1);
});
