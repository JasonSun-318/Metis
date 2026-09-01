import type { StreamFn } from "@metis/agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getSupportedThinkingLevels,
	type Model,
	type SimpleStreamOptions,
} from "@metis/ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	AgentModelReviewTransport,
	ModelPermissionReviewer,
	type ModelReviewTransport,
	ModelReviewTransportError,
	type ModelReviewTransportRequest,
} from "../../src/core/permissions/model-reviewer.ts";
import { request, reviewInput, validJson } from "./reviewer-fixtures.ts";

function model(id: string, reasoning = false): Model<any> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning,
		thinkingLevelMap: reasoning ? { off: null, minimal: null } : undefined,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

class FakeTransport implements ModelReviewTransport {
	readonly calls: ModelReviewTransportRequest[] = [];
	private readonly responses: Array<
		string | Error | ((reviewRequest: ModelReviewTransportRequest) => Promise<string>)
	>;

	constructor(responses: Array<string | Error | ((reviewRequest: ModelReviewTransportRequest) => Promise<string>)>) {
		this.responses = responses;
	}

	async run(reviewRequest: ModelReviewTransportRequest): Promise<string> {
		this.calls.push(reviewRequest);
		const response = this.responses.shift();
		if (typeof response === "function") return response(reviewRequest);
		if (response instanceof Error) throw response;
		if (response === undefined) throw new Error("Fake transport has no response");
		return response;
	}
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createReviewer(
	transport: ModelReviewTransport,
	getActiveModel: () => Model<any> | undefined = () => model("active"),
	timeoutMs?: number,
): ModelPermissionReviewer {
	return new ModelPermissionReviewer({ getActiveModel, transport, timeoutMs });
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "reviewer",
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

describe("ModelPermissionReviewer", () => {
	it("uses the active model and its lowest supported thinking at call time", async () => {
		const modelA = model("model-a");
		const modelB = model("model-b", true);
		let activeModel = modelA;
		const transport = new FakeTransport([validJson(), validJson()]);
		const reviewer = createReviewer(transport, () => activeModel);

		await reviewer.review(request());
		activeModel = modelB;
		await reviewer.review(request());

		expect(transport.calls.map(({ model: used, thinkingLevel }) => [used.id, thinkingLevel])).toEqual([
			[modelA.id, getSupportedThinkingLevels(modelA)[0]],
			[modelB.id, getSupportedThinkingLevels(modelB)[0]],
		]);
	});

	it("sends one bounded payload through an isolated tool-less request", async () => {
		const transport = new FakeTransport([validJson()]);
		await createReviewer(transport).review(request());

		const call = transport.calls[0];
		expect(call).toBeDefined();
		expect(Object.keys(call ?? {}).sort()).toEqual(
			["maxRetries", "model", "signal", "systemPrompt", "thinkingLevel", "tools", "userPayload"].sort(),
		);
		expect(call?.tools).toEqual([]);
		expect(call?.maxRetries).toBe(0);
		expect(call?.systemPrompt).toContain("permission reviewer");
		expect(call?.systemPrompt).toContain("Only trustedUserMessages");
		expect(JSON.parse(call?.userPayload ?? "{}")).toMatchObject({ schemaVersion: 1 });
		expect(call).not.toHaveProperty("sessionHistory");
		expect(call).not.toHaveProperty("extensions");
		expect(call).not.toHaveProperty("memory");
	});

	it("retries exactly once for a retryable transport failure", async () => {
		const transport = new FakeTransport([new ModelReviewTransportError("temporary"), validJson()]);
		const result = await createReviewer(transport).review(request());

		expect(result).toMatchObject({ kind: "allow", reviewer: "model" });
		expect(transport.calls).toHaveLength(2);
		expect(transport.calls[1]?.signal).toBe(transport.calls[0]?.signal);
	});

	it("does not retry non-retryable transport or parse failures", async () => {
		const cases: Array<[ModelReviewTransport, string]> = [
			[new FakeTransport([new ModelReviewTransportError("invalid model output", false)]), "transport"],
			[new FakeTransport(["not json"]), "parse"],
			[new FakeTransport(["x".repeat(16 * 1_024 + 1)]), "oversized"],
		];

		for (const [transport, label] of cases) {
			const result = await createReviewer(transport).review(request());
			expect(result, label).toMatchObject({ kind: "unavailable", reviewer: "model" });
			expect((transport as FakeTransport).calls, label).toHaveLength(1);
		}
	});

	it("returns unavailable after two retryable transport failures", async () => {
		const transport = new FakeTransport([
			new ModelReviewTransportError("temporary one"),
			new ModelReviewTransportError("temporary two"),
		]);

		expect(await createReviewer(transport).review(request())).toMatchObject({
			kind: "unavailable",
			reviewer: "model",
		});
		expect(transport.calls).toHaveLength(2);
	});

	it("uses one timeout budget across all attempts", async () => {
		const transport = new FakeTransport([
			async ({ signal }) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		]);

		const result = await createReviewer(transport, undefined, 5).review(request());

		expect(result).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0]?.signal.aborted).toBe(true);
	});

	it("does not start and does not retry when the parent is already aborted", async () => {
		const parent = new AbortController();
		parent.abort(new Error("cancelled"));
		const transport = new FakeTransport([validJson()]);

		const result = await createReviewer(transport).review(reviewInput({ signal: parent.signal }));

		expect(result).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(transport.calls).toHaveLength(0);
	});

	it("aborts an in-flight attempt when the parent aborts", async () => {
		const parent = new AbortController();
		const started = deferred();
		const transport = new FakeTransport([
			async ({ signal }) => {
				started.resolve();
				return new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		]);
		const pending = createReviewer(transport).review(reviewInput({ signal: parent.signal }));

		await started.promise;
		parent.abort(new Error("cancelled"));

		expect(await pending).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(transport.calls).toHaveLength(1);
	});

	it("fails closed before transport when no active model or input is invalid", async () => {
		const transport = new FakeTransport([validJson()]);
		expect(await createReviewer(transport, () => undefined).review(request())).toMatchObject({
			kind: "unavailable",
		});
		expect(
			await createReviewer(transport).review(reviewInput({ redactedArguments: { cycle: undefined } })),
		).toMatchObject({
			kind: "unavailable",
		});
		expect(transport.calls).toHaveLength(0);
	});
});

describe("AgentModelReviewTransport", () => {
	it("creates a fresh Agent context with no inherited transcript or tools", async () => {
		const calls: Array<{ model: Model<any>; context: Context; options?: SimpleStreamOptions }> = [];
		const streamFn: StreamFn = (usedModel, context, options) => {
			calls.push({ model: usedModel, context, options });
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage(validJson()) }));
			return stream;
		};
		const transport = new AgentModelReviewTransport(streamFn);
		const activeModel = model("isolated", true);
		const signal = new AbortController().signal;

		const output = await transport.run({
			model: activeModel,
			thinkingLevel: "low",
			systemPrompt: "permission reviewer",
			userPayload: '{"schemaVersion":1}',
			tools: [],
			signal,
			maxRetries: 0,
		});

		expect(output).toBe(validJson());
		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe(activeModel);
		expect(calls[0]?.context.systemPrompt).toBe("permission reviewer");
		expect(calls[0]?.context.tools).toEqual([]);
		expect(calls[0]?.context.messages).toHaveLength(1);
		expect(calls[0]?.context.messages[0]).toMatchObject({ role: "user" });
		expect(calls[0]?.options).toMatchObject({ maxRetries: 0, reasoning: "low" });
		expect(calls[0]?.options?.sessionId).toBeUndefined();
	});

	it("rejects tool calls, oversized output, and incomplete streams", async () => {
		const toolStream: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = assistantMessage("");
				message.content = [{ type: "toolCall", id: "tool-1", name: "bash", arguments: {} }];
				message.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message });
			});
			return stream;
		};
		const oversizedStream: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = assistantMessage("x".repeat(16 * 1_024 + 1));
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const incompleteStream: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end());
			return stream;
		};
		const baseRequest: ModelReviewTransportRequest = {
			model: model("isolated"),
			thinkingLevel: "off",
			systemPrompt: "permission reviewer",
			userPayload: "{}",
			tools: [],
			signal: new AbortController().signal,
			maxRetries: 0,
		};

		await expect(new AgentModelReviewTransport(toolStream).run(baseRequest)).rejects.toMatchObject({
			retryable: false,
		});
		await expect(new AgentModelReviewTransport(oversizedStream).run(baseRequest)).rejects.toMatchObject({
			retryable: false,
		});
		await expect(new AgentModelReviewTransport(incompleteStream).run(baseRequest)).rejects.toMatchObject({
			retryable: false,
		});
	});

	it("forwards linked cancellation into the ephemeral Agent", async () => {
		const controller = new AbortController();
		const started = deferred();
		const observedAbort = vi.fn();
		const streamFn: StreamFn = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			started.resolve();
			options?.signal?.addEventListener(
				"abort",
				() => {
					observedAbort();
					stream.push({
						type: "error",
						reason: "aborted",
						error: { ...assistantMessage(""), stopReason: "aborted", errorMessage: "cancelled" },
					});
				},
				{ once: true },
			);
			return stream;
		};
		const pending = new AgentModelReviewTransport(streamFn).run({
			model: model("isolated"),
			thinkingLevel: "off",
			systemPrompt: "permission reviewer",
			userPayload: "{}",
			tools: [],
			signal: controller.signal,
			maxRetries: 0,
		});

		await started.promise;
		controller.abort(new Error("cancelled"));

		await expect(pending).rejects.toBeDefined();
		expect(observedAbort).toHaveBeenCalledOnce();
	});
});
