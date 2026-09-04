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
	type ModelReviewVerdict,
} from "../../src/core/permissions/model-reviewer.ts";
import { request, reviewInput } from "./reviewer-fixtures.ts";

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
		ModelReviewVerdict | Error | ((reviewRequest: ModelReviewTransportRequest) => Promise<ModelReviewVerdict>)
	>;

	constructor(
		responses: Array<
			ModelReviewVerdict | Error | ((reviewRequest: ModelReviewTransportRequest) => Promise<ModelReviewVerdict>)
		>,
	) {
		this.responses = responses;
	}

	async run(reviewRequest: ModelReviewTransportRequest): Promise<ModelReviewVerdict> {
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

function verdictMessage(decision: "allow" | "deny"): AssistantMessage {
	return {
		...assistantMessage(""),
		content: [
			{
				type: "toolCall",
				id: "review-verdict-1",
				name: "submit_permission_review",
				arguments: { decision },
			},
		],
		stopReason: "toolUse",
	};
}

function transportRequest(): ModelReviewTransportRequest {
	return {
		model: model("isolated"),
		thinkingLevel: "off",
		systemPrompt: "permission reviewer",
		userPayload: '{"schemaVersion":2}',
		signal: new AbortController().signal,
	};
}

function emit(
	message: AssistantMessage,
	reason: "stop" | "toolUse" = message.stopReason === "toolUse" ? "toolUse" : "stop",
): StreamFn {
	return (_usedModel, _context, _options) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason, message }));
		return stream;
	};
}

describe("ModelPermissionReviewer", () => {
	it("uses the active model and its lowest supported thinking at call time", async () => {
		const modelA = model("model-a");
		const modelB = model("model-b", true);
		let activeModel = modelA;
		const transport = new FakeTransport(["allow", "deny"]);
		const reviewer = createReviewer(transport, () => activeModel);

		await reviewer.review(request());
		activeModel = modelB;
		await reviewer.review(request());

		expect(transport.calls.map(({ model: used, thinkingLevel }) => [used.id, thinkingLevel])).toEqual([
			[modelA.id, getSupportedThinkingLevels(modelA)[0]],
			[modelB.id, getSupportedThinkingLevels(modelB)[0]],
		]);
	});

	it("sends one bounded payload through an isolated request", async () => {
		const transport = new FakeTransport(["allow"]);
		await createReviewer(transport).review(request());

		const call = transport.calls[0];
		expect(call).toBeDefined();
		expect(Object.keys(call ?? {}).sort()).toEqual(
			["model", "signal", "systemPrompt", "thinkingLevel", "userPayload"].sort(),
		);
		expect(call?.systemPrompt).toContain("submit_permission_review");
		expect(call?.systemPrompt).toContain("trustedUserMessages may confirm user intent");
		expect(call?.systemPrompt).toContain("Allow clear non-destructive reads");
		expect(call?.systemPrompt).toContain("Emit no other output");
		expect(JSON.parse(call?.userPayload ?? "{}")).toMatchObject({ schemaVersion: 2 });
		expect(call).not.toHaveProperty("sessionHistory");
		expect(call).not.toHaveProperty("extensions");
		expect(call).not.toHaveProperty("memory");
		expect(call).not.toHaveProperty("tools");
		expect(call).not.toHaveProperty("maxRetries");
	});

	it.each(["allow", "deny"] as const)("returns the exact %s verdict", async (decision) => {
		const transport = new FakeTransport([decision]);
		expect(await createReviewer(transport).review(request())).toEqual({ kind: decision, reviewer: "model" });
		expect(transport.calls).toHaveLength(1);
	});

	it("does not retry transport failure and immediately becomes unavailable", async () => {
		const transport = new FakeTransport([new ModelReviewTransportError("temporary")]);
		const result = await createReviewer(transport).review(request());

		expect(result).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(transport.calls).toHaveLength(1);
	});

	it("uses one timeout budget and does not retry", async () => {
		const transport = new FakeTransport([
			async ({ signal }) =>
				new Promise<ModelReviewVerdict>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		]);

		const result = await createReviewer(transport, undefined, 5).review(request());

		expect(result).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0]?.signal.aborted).toBe(true);
	});

	it("does not start when the parent is already aborted", async () => {
		const parent = new AbortController();
		parent.abort(new Error("cancelled"));
		const transport = new FakeTransport(["allow"]);

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
				return new Promise<ModelReviewVerdict>((_resolve, reject) => {
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
		const transport = new FakeTransport(["allow"]);
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

	it("turns text-only, missing, wrong, malformed, extra, multiple, oversized, and incomplete outputs into unavailable", async () => {
		const cases: Array<[string, StreamFn]> = [
			["text-only", emit(assistantMessage("allow"))],
			["no call", emit({ ...assistantMessage(""), content: [] })],
			[
				"wrong tool",
				emit({
					...verdictMessage("allow"),
					content: [{ type: "toolCall", id: "review-verdict-1", name: "bash", arguments: { decision: "allow" } }],
				}),
			],
			[
				"malformed args",
				emit({
					...verdictMessage("allow"),
					content: [
						{
							type: "toolCall",
							id: "review-verdict-1",
							name: "submit_permission_review",
							arguments: { decision: "maybe" },
						},
					],
				}),
			],
			[
				"extra args",
				emit({
					...verdictMessage("allow"),
					content: [
						{
							type: "toolCall",
							id: "review-verdict-1",
							name: "submit_permission_review",
							arguments: { decision: "allow", extra: true },
						},
					],
				}),
			],
			[
				"multiple calls",
				emit({
					...verdictMessage("allow"),
					content: [
						...verdictMessage("allow").content,
						{
							type: "toolCall",
							id: "review-verdict-2",
							name: "submit_permission_review",
							arguments: { decision: "deny" },
						},
					],
				}),
			],
			["oversized", emit(assistantMessage("x".repeat(16 * 1_024 + 1)))],
			[
				"incomplete",
				() => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => stream.end());
					return stream;
				},
			],
		];

		for (const [label, streamFn] of cases) {
			const result = await createReviewer(new AgentModelReviewTransport(streamFn)).review(request());
			expect(result, label).toMatchObject({ kind: "unavailable", reviewer: "model" });
		}
	});
});

describe("AgentModelReviewTransport", () => {
	it("creates a fresh Agent with one terminal verdict tool and required tool choice", async () => {
		const calls: Array<{ model: Model<any>; context: Context; options?: SimpleStreamOptions }> = [];
		const streamFn: StreamFn = (usedModel, context, options) => {
			calls.push({ model: usedModel, context, options });
			return emit(verdictMessage("allow"))(usedModel, context, options);
		};
		const transport = new AgentModelReviewTransport(streamFn);
		const activeModel = model("isolated", true);

		const output = await transport.run({
			model: activeModel,
			thinkingLevel: "low",
			systemPrompt: "permission reviewer",
			userPayload: '{"schemaVersion":2}',
			signal: new AbortController().signal,
		});

		expect(output).toBe("allow");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe(activeModel);
		expect(calls[0]?.context.systemPrompt).toBe("permission reviewer");
		expect(calls[0]?.context.tools?.map((tool) => tool.name)).toEqual(["submit_permission_review"]);
		expect(calls[0]?.context.messages).toHaveLength(1);
		expect(calls[0]?.context.messages[0]).toMatchObject({ role: "user" });
		expect(calls[0]?.options).toMatchObject({
			maxRetries: 0,
			maxTokens: 256,
			toolChoice: "required",
			reasoning: "low",
		});
		expect(calls[0]?.options?.sessionId).toBeUndefined();
	});

	it("returns deny from one tool execution and does not issue a second provider request", async () => {
		const calls: Array<{ model: Model<any>; context: Context; options?: SimpleStreamOptions }> = [];
		const streamFn: StreamFn = (usedModel, context, options) => {
			calls.push({ model: usedModel, context, options });
			return emit(verdictMessage("deny"))(usedModel, context, options);
		};

		expect(await new AgentModelReviewTransport(streamFn).run(transportRequest())).toBe("deny");
		expect(calls).toHaveLength(1);
	});

	it("rejects tool-isolation bypasses, oversized output, and incomplete streams", async () => {
		await expect(
			new AgentModelReviewTransport(emit(assistantMessage("allow"))).run(transportRequest()),
		).rejects.toMatchObject({ retryable: false });
		await expect(
			new AgentModelReviewTransport(emit(assistantMessage("x".repeat(16 * 1_024 + 1)))).run(transportRequest()),
		).rejects.toMatchObject({ retryable: false });
		await expect(
			new AgentModelReviewTransport(() => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.end());
				return stream;
			}).run(transportRequest()),
		).rejects.toMatchObject({ retryable: false });
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
			...transportRequest(),
			signal: controller.signal,
		});

		await started.promise;
		controller.abort(new Error("cancelled"));

		await expect(pending).rejects.toBeDefined();
		expect(observedAbort).toHaveBeenCalledOnce();
	});
});
