import type { StreamFn } from "@metis/agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
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
import type { PermissionReviewerConfig } from "../../src/core/permissions/reviewer-config.ts";
import { request, reviewInput } from "./reviewer-fixtures.ts";

const MAX_TEST_OUTPUT_BYTES = 64 * 1024;

function model(id: string, reasoning = false, overrides: Partial<Model<any>> = {}): Model<any> {
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
		...overrides,
	};
}

function reviewerModel(overrides: Partial<Model<any>> = {}): Model<any> {
	return model("review-only", false, { provider: "review-provider", ...overrides });
}

function reviewerConfig(overrides: Partial<PermissionReviewerConfig> = {}): PermissionReviewerConfig {
	return Object.freeze({
		provider: "review-provider",
		modelId: "review-only",
		thinkingLevel: "off",
		timeoutMs: 8_000,
		maxOutputTokens: 512,
		...overrides,
	});
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
	options: {
		readonly getConfiguration?: () => PermissionReviewerConfig | undefined;
		readonly resolveModel?: (provider: string, modelId: string) => Model<any> | undefined;
		readonly timeoutMs?: number;
	} = {},
): ModelPermissionReviewer {
	return new ModelPermissionReviewer({
		getConfiguration: options.getConfiguration ?? (() => reviewerConfig()),
		resolveModel: options.resolveModel ?? (() => reviewerModel()),
		transport,
		timeoutMs: options.timeoutMs,
	});
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

function verdictMessage(
	decision: "allow" | "deny",
	argumentsValue: Record<string, unknown> = { decision },
): AssistantMessage {
	return {
		...assistantMessage(""),
		content: [
			{
				type: "toolCall",
				id: "review-verdict-1",
				name: "submit_permission_review",
				arguments: argumentsValue,
			},
		],
		stopReason: "toolUse",
	};
}

function transportRequest(overrides: Partial<ModelReviewTransportRequest> = {}): ModelReviewTransportRequest {
	return {
		model: model("isolated", false, { provider: "review-provider" }),
		thinkingLevel: "off",
		maxOutputTokens: 512,
		systemPrompt: "permission reviewer",
		userPayload: '{"schemaVersion":2}',
		signal: new AbortController().signal,
		...overrides,
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
	it("uses the independently selected model, thinking level, and budget exactly once", async () => {
		const reviewModel = reviewerModel();
		const transport = new FakeTransport(["allow"]);
		const resolveModel = vi.fn(() => reviewModel);
		const reviewer = new ModelPermissionReviewer({
			getConfiguration: () =>
				reviewerConfig({ provider: "review-provider", modelId: "review-only", thinkingLevel: "off" }),
			resolveModel,
			transport,
		});

		await reviewer.review(request());

		expect(resolveModel).toHaveBeenCalledWith("review-provider", "review-only");
		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0]).toMatchObject({
			model: reviewModel,
			thinkingLevel: "off",
			maxOutputTokens: 512,
		});
	});

	it("snapshots authentication once before transport without re-reading it", async () => {
		const authentication = { apiKey: "first-key", headers: { "x-review": "1" } };
		const resolveAuthentication = vi.fn((_config: PermissionReviewerConfig, _model: Model<any>) => authentication);
		const transport = new FakeTransport(["allow"]);
		const reviewer = new ModelPermissionReviewer({
			getConfiguration: () => reviewerConfig(),
			resolveModel: () => reviewerModel(),
			resolveAuthentication,
			transport,
		});

		const result = await reviewer.review(request());

		expect(result).toEqual({ kind: "allow", reviewer: "model" });
		expect(resolveAuthentication).toHaveBeenCalledTimes(1);
		expect(resolveAuthentication.mock.calls[0]?.[0]).toEqual(reviewerConfig());
		expect(transport.calls[0]?.authentication).toEqual(authentication);
	});

	it("fails closed before transport when authentication is unavailable", async () => {
		const transport = new FakeTransport(["allow"]);
		const reviewer = new ModelPermissionReviewer({
			getConfiguration: () => reviewerConfig(),
			resolveModel: () => reviewerModel(),
			resolveAuthentication: async () => {
				throw new Error("no dedicated key");
			},
			transport,
		});

		const result = await reviewer.review(request());

		expect(result).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(transport.calls).toHaveLength(0);
	});

	it("reads the independent configuration for each review without a chat-model fallback", async () => {
		const firstModel = reviewerModel();
		const secondModel = reviewerModel({ id: "review-second", reasoning: true });
		const transport = new FakeTransport(["allow", "deny"]);
		const resolveModel = vi.fn((provider: string, modelId: string) => {
			if (provider !== "review-provider") return undefined;
			return modelId === "review-second" ? secondModel : firstModel;
		});
		let config = reviewerConfig();
		const reviewer = createReviewer(transport, { getConfiguration: () => config, resolveModel });

		await reviewer.review(request());
		config = reviewerConfig({ modelId: "review-second", thinkingLevel: "low", maxOutputTokens: 1_024 });
		await reviewer.review(request());

		expect(resolveModel.mock.calls).toEqual([
			["review-provider", "review-only"],
			["review-provider", "review-second"],
		]);
		expect(
			transport.calls.map(({ model: used, thinkingLevel, maxOutputTokens }) => [
				used.id,
				thinkingLevel,
				maxOutputTokens,
			]),
		).toEqual([
			[firstModel.id, "off", 512],
			[secondModel.id, "low", 1_024],
		]);
	});

	it.each([
		["missing configuration", (): undefined => undefined, (): Model<any> => reviewerModel()],
		["an unavailable exact model", () => reviewerConfig(), (): Model<any> | undefined => undefined],
		["an unsupported thinking level", () => reviewerConfig({ thinkingLevel: "high" }), () => reviewerModel()],
		["an unsupported API adapter", () => reviewerConfig(), () => reviewerModel({ api: "google-generative-ai" })],
		[
			"an output budget above the model limit",
			() => reviewerConfig({ maxOutputTokens: 2_048 }),
			() => reviewerModel({ maxTokens: 1_024 }),
		],
	] as const)("fails closed without a transport call for %s", async (_label, getConfiguration, resolveModel) => {
		const transport = new FakeTransport(["allow"]);
		const result = await createReviewer(transport, { getConfiguration, resolveModel }).review(request());

		expect(result).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(transport.calls).toHaveLength(0);
	});

	it("freezes the configuration when a review starts", async () => {
		const started = deferred();
		const release = deferred();
		const transport = new FakeTransport([
			async () => {
				started.resolve();
				await release.promise;
				return "allow";
			},
		]);
		let config = reviewerConfig({ maxOutputTokens: 512 });
		const reviewer = createReviewer(transport, { getConfiguration: () => config });
		const pending = reviewer.review(request());

		await started.promise;
		config = reviewerConfig({ maxOutputTokens: 4_096 });
		release.resolve();
		await pending;

		expect(transport.calls[0]?.maxOutputTokens).toBe(512);
		expect(transport.calls).toHaveLength(1);
	});

	it("sends one bounded payload through an isolated request", async () => {
		const transport = new FakeTransport(["allow"]);
		await createReviewer(transport).review(request());

		const call = transport.calls[0];
		expect(call).toBeDefined();
		expect(Object.keys(call ?? {}).sort()).toEqual(
			["model", "signal", "systemPrompt", "thinkingLevel", "userPayload", "maxOutputTokens"].sort(),
		);
		expect(call?.systemPrompt).toContain("submit_permission_review");
		expect(call?.systemPrompt).toContain("trustedUserMessages establish the user's task");
		expect(call?.systemPrompt).toContain("Allow ordinary reads");
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

	it("uses the configured deadline as a single budget and does not retry", async () => {
		const transport = new FakeTransport([
			async ({ signal }): Promise<ModelReviewVerdict> =>
				new Promise<ModelReviewVerdict>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		]);

		const result = await createReviewer(transport, {
			getConfiguration: () => reviewerConfig({ timeoutMs: 1_000 }),
		}).review(request());

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
			async ({ signal }): Promise<ModelReviewVerdict> => {
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

	it("fails closed before transport when input is invalid", async () => {
		const transport = new FakeTransport(["allow"]);
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
			["truncated terminal", emit({ ...verdictMessage("allow"), stopReason: "length" })],
			["wrong finish reason", emit({ ...verdictMessage("allow"), stopReason: "stop" })],
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
			["oversized", emit(assistantMessage("x".repeat(MAX_TEST_OUTPUT_BYTES + 1)))],
			[
				"oversized thinking",
				emit({
					...assistantMessage(""),
					content: [{ type: "thinking", thinking: "x".repeat(MAX_TEST_OUTPUT_BYTES + 1) }],
				}),
			],
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
	it("creates a fresh Agent with one terminal verdict tool and the configured budget", async () => {
		const calls: Array<{ model: Model<any>; context: Context; options?: SimpleStreamOptions }> = [];
		const streamFn: StreamFn = (usedModel, context, options) => {
			calls.push({ model: usedModel, context, options });
			return emit(verdictMessage("allow"))(usedModel, context, options);
		};
		const transport = new AgentModelReviewTransport(streamFn);
		const activeModel = reviewerModel({ reasoning: true, maxTokens: 2_048 });

		const output = await transport.run(
			transportRequest({ model: activeModel, thinkingLevel: "low", maxOutputTokens: 2_048 }),
		);

		expect(output).toBe("allow");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe(activeModel);
		expect(calls[0]?.context.systemPrompt).toBe("permission reviewer");
		expect(calls[0]?.context.tools?.map((tool) => tool.name)).toEqual(["submit_permission_review"]);
		expect(calls[0]?.context.messages).toHaveLength(1);
		expect(calls[0]?.context.messages[0]).toMatchObject({ role: "user" });
		expect(calls[0]?.options).toMatchObject({
			maxRetries: 0,
			maxTokens: 2_048,
			toolChoice: "auto",
			reasoning: "low",
		});
		expect(calls[0]?.options?.sessionId).toBeUndefined();
	});

	it("applies the review's authentication snapshot to the single provider request", async () => {
		let observed: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (usedModel, context, options) => {
			observed = options;
			return emit(verdictMessage("allow"))(usedModel, context, options);
		};

		await new AgentModelReviewTransport(streamFn).run(
			transportRequest({
				authentication: { apiKey: "snapshot-key", headers: { "x-review": "1" }, env: { REVIEW: "1" } },
			}),
		);

		expect(observed).toMatchObject({
			apiKey: "snapshot-key",
			headers: { "x-review": "1" },
			env: { REVIEW: "1" },
		});
	});

	it.each([
		["openai-completions", "off", "required"],
		["openai-responses", "off", "required"],
		["anthropic-messages", "off", "required"],
		["openai-completions", "low", "auto"],
		["openai-responses", "low", "auto"],
		["anthropic-messages", "low", "auto"],
	] as const)("maps %s with thinking %s to tool choice %s", async (api, thinkingLevel, expected) => {
		let observed: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (usedModel, context, options) => {
			observed = options;
			return emit(verdictMessage("allow"))(usedModel, context, options);
		};

		await new AgentModelReviewTransport(streamFn).run(
			transportRequest({
				model: reviewerModel({ api, reasoning: thinkingLevel !== "off" }),
				thinkingLevel,
				maxOutputTokens: 512,
			}),
		);

		expect(observed).toMatchObject({ maxRetries: 0, maxTokens: 512, toolChoice: expected });
	});

	it("does not issue a provider request for an unsupported API adapter", async () => {
		const streamFn = vi.fn<StreamFn>();
		await expect(
			new AgentModelReviewTransport(streamFn).run(
				transportRequest({ model: reviewerModel({ api: "google-generative-ai" }) }),
			),
		).rejects.toMatchObject({ retryable: false });
		expect(streamFn).not.toHaveBeenCalled();
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

	it("rejects an invalid final message before any recovery request", async () => {
		let requests = 0;
		const streamFn: StreamFn = (usedModel, context, options) => {
			requests += 1;
			if (requests > 1) throw new Error("unexpected recovery request");
			return emit(verdictMessage("allow", { decision: "allow", extra: true }))(usedModel, context, options);
		};

		await expect(new AgentModelReviewTransport(streamFn).run(transportRequest())).rejects.toMatchObject({
			retryable: false,
		});
		expect(requests).toBe(1);
	});

	it("rejects tool-isolation bypasses, oversized output, and incomplete streams", async () => {
		await expect(
			new AgentModelReviewTransport(emit(assistantMessage("allow"))).run(transportRequest()),
		).rejects.toMatchObject({ retryable: false });
		await expect(
			new AgentModelReviewTransport(emit(assistantMessage("x".repeat(MAX_TEST_OUTPUT_BYTES + 1)))).run(
				transportRequest(),
			),
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
