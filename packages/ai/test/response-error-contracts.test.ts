import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	stream as codexStream,
	getOpenAICodexWebSocketDebugStats,
} from "../src/api/openai-codex-responses.ts";
import { streamSimple as openAIResponsesStreamSimple } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function createResponsesModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createCodexModel(): Model<"openai-codex-responses"> {
	return {
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
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function sseResponse(event: unknown): Response {
	return new Response(`data: ${JSON.stringify(event)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const codexApiKey = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
).toString("base64")}.bbb`;

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Responses terminal error contracts", () => {
	it.each([
		{ type: "response.completed", code: "server_error", message: "upstream exploded" },
		{ type: "response.incomplete", code: "invalid_prompt", message: "bad prompt" },
	])("$type with an error status keeps the provider code and message", async ({ type, code, message }) => {
		const model = createResponsesModel();
		const output = createOutput(model);
		const event = {
			type,
			sequence_number: 0,
			response: {
				id: "resp_test",
				status: "failed",
				error: { code, message },
				output: [],
			},
		} as unknown as ResponseStreamEvent;

		await processResponsesStream(
			(async function* () {
				yield event;
			})(),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe(`${code}: ${message}`);
	});

	it("keeps response.failed code and message through the provider error stream", async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse({
				type: "response.failed",
				response: {
					id: "resp_test",
					status: "failed",
					error: { code: "invalid_prompt", message: "bad prompt" },
					output: [],
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await openAIResponsesStreamSimple(createResponsesModel(), context, {
			apiKey: "test-key",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("invalid_prompt: bad prompt");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ type: "response.completed", code: "server_error", message: "upstream exploded" },
		{ type: "response.incomplete", code: "invalid_prompt", message: "bad prompt" },
	])("$type error details are not replaced by a generic unknown error", async ({ type, code, message }) => {
		const fetchMock = vi.fn(async () =>
			sseResponse({
				type,
				response: {
					id: "resp_test",
					status: "failed",
					error: { code, message },
					output: [],
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const model = createResponsesModel();
		const result = await openAIResponsesStreamSimple(model, context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(`${code}: ${message}`);
		expect(result.errorMessage).not.toContain("An unknown error occurred");
		expect(result.api).toBe(model.api);
		expect(result.provider).toBe(model.provider);
		expect(result.model).toBe(model.id);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("still completes a normal response.completed event", async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse({
				type: "response.completed",
				response: {
					id: "resp_ok",
					status: "completed",
					error: null,
					output: [],
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await openAIResponsesStreamSimple(createResponsesModel(), context, {
			apiKey: "test-key",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("Codex terminal error protocol", () => {
	it.each(["response.done", "response.completed", "response.incomplete"])(
		"emits an error event for %s with status=failed instead of done.reason:error",
		async (terminalType) => {
			const fetchMock = vi.fn(async (input: string | URL) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url !== "https://chatgpt.com/backend-api/codex/responses") {
					throw new Error(`Unexpected request: ${url}`);
				}
				return sseResponse({
					type: terminalType,
					response: {
						id: "resp_test",
						status: "failed",
						error: { code: "server_error", message: "upstream exploded" },
						output: [],
					},
				});
			});
			vi.stubGlobal("fetch", fetchMock);

			const stream = codexStream(createCodexModel(), context, { apiKey: codexApiKey, transport: "sse" });
			const events: string[] = [];
			for await (const event of stream) events.push(event.type);
			const result = await stream.result();

			expect(events).toContain("error");
			expect(events).not.toContain("done");
			expect(events.at(-1)).toBe("error");
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("server_error: upstream exploded");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("does not fall back to SSE when a websocket terminal response fails", async () => {
		const fetchMock = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor() {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(): void {
				queueMicrotask(() => {
					this.dispatch("message", {
						data: JSON.stringify({
							type: "response.completed",
							response: {
								id: "resp_test",
								status: "failed",
								error: { code: "server_error", message: "upstream exploded" },
								output: [],
							},
						}),
					});
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const stream = codexStream(createCodexModel(), context, { apiKey: codexApiKey, transport: "websocket" });
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(events.at(-1)).toBe("error");
		expect(events).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("server_error: upstream exploded");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("drops a failed websocket-cached continuation and reuses only the healthy connection", async () => {
		const fetchMock = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		type ScriptedResponse =
			| { kind: "failed"; responseId: string; code: string; message: string }
			| { kind: "success"; responseId: string; messageId: string; text: string };
		const responses: ScriptedResponse[] = [
			{ kind: "failed", responseId: "resp_failed", code: "server_error", message: "first request failed" },
			{ kind: "success", responseId: "resp_ok", messageId: "msg_ok", text: "Recovered" },
			{ kind: "success", responseId: "resp_2", messageId: "msg_2", text: "Done" },
		];
		const sentBodies: Array<{ connection: number; body: { input?: unknown[]; previous_response_id?: string } }> = [];

		class MockWebSocket {
			static OPEN = 1;
			static instances: MockWebSocket[] = [];
			readonly connection: number;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor() {
				this.connection = MockWebSocket.instances.length + 1;
				MockWebSocket.instances.push(this);
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				const body = JSON.parse(data) as { input?: unknown[]; previous_response_id?: string };
				sentBodies.push({ connection: this.connection, body });
				const response = responses.shift();
				if (!response) throw new Error("unexpected websocket request");
				const events =
					response.kind === "failed"
						? [
								{
									type: "response.completed",
									response: {
										id: response.responseId,
										status: "failed",
										error: { code: response.code, message: response.message },
										output: [],
									},
								},
							]
						: [
								{ type: "response.created", response: { id: response.responseId } },
								{
									type: "response.output_item.added",
									item: {
										type: "message",
										id: response.messageId,
										role: "assistant",
										status: "in_progress",
										content: [],
									},
								},
								{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
								{ type: "response.output_text.delta", delta: response.text },
								{
									type: "response.output_item.done",
									item: {
										type: "message",
										id: response.messageId,
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: response.text }],
									},
								},
								{
									type: "response.completed",
									response: {
										id: response.responseId,
										status: "completed",
										usage: {
											input_tokens: 5,
											output_tokens: 3,
											total_tokens: 8,
											input_tokens_details: { cached_tokens: 0 },
										},
									},
								},
							];
				queueMicrotask(() => {
					for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const model = createCodexModel();
		const sessionId = "session-failed-recovery";
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "first", timestamp: 1 }],
		};

		const first = await codexStream(model, firstContext, {
			apiKey: codexApiKey,
			sessionId,
			transport: "websocket-cached",
		}).result();
		expect(first.stopReason).toBe("error");
		expect(first.errorMessage).toBe("server_error: first request failed");
		expect(MockWebSocket.instances).toHaveLength(1);
		expect(MockWebSocket.instances[0]!.readyState).toBe(3);
		expect(fetchMock).not.toHaveBeenCalled();

		const secondContext: Context = {
			...firstContext,
			messages: [...firstContext.messages, first, { role: "user", content: "retry", timestamp: 2 }],
		};
		const second = await codexStream(model, secondContext, {
			apiKey: codexApiKey,
			sessionId,
			transport: "websocket-cached",
		}).result();
		expect(second.stopReason).toBe("stop");
		expect(second.content.find((block) => block.type === "text")?.text).toBe("Recovered");
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(sentBodies).toHaveLength(2);
		expect(sentBodies[1]!.connection).toBe(2);
		expect(sentBodies[1]!.body.previous_response_id).toBeUndefined();
		expect(sentBodies[1]!.body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first" }] },
			{ role: "user", content: [{ type: "input_text", text: "retry" }] },
		]);
		expect(fetchMock).not.toHaveBeenCalled();

		const thirdContext: Context = {
			...secondContext,
			messages: [...secondContext.messages, second, { role: "user", content: "finish", timestamp: 3 }],
		};
		const third = await codexStream(model, thirdContext, {
			apiKey: codexApiKey,
			sessionId,
			transport: "websocket-cached",
		}).result();
		expect(third.stopReason).toBe("stop");
		expect(sentBodies).toHaveLength(3);
		expect(sentBodies[2]!.connection).toBe(2);
		expect(sentBodies[2]!.body.previous_response_id).toBe("resp_ok");
		expect(sentBodies[2]!.body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "finish" }] }]);
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
			requests: 3,
			connectionsCreated: 2,
			connectionsReused: 1,
			cachedContextRequests: 3,
			storeTrueRequests: 0,
			fullContextRequests: 2,
			deltaRequests: 1,
			lastPreviousResponseId: "resp_ok",
			sseFallbacks: 0,
		});
	});
});
