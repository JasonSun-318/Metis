import type { Model } from "@metis/ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { PermissionReviewerDedicatedConfig } from "../../src/core/permissions/reviewer-config.ts";
import {
	DEDICATED_REVIEWER_AUTH_KEY,
	DEDICATED_REVIEWER_PROVIDER,
	resolveDedicatedReviewerApiKey,
	resolveReviewerAuthentication,
	resolveReviewerModel,
} from "../../src/core/permissions/reviewer-model.ts";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "chat-model",
		name: "Chat model",
		api: "openai-completions",
		provider: "chat-provider",
		baseUrl: "https://chat.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4096,
		...overrides,
	} as Model<any>;
}

function lookupFor(...models: Model<any>[]) {
	return {
		find: vi.fn((provider: string, modelId: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === modelId),
		),
	};
}

const providerConfig = {
	provider: "chat-provider",
	modelId: "chat-model",
	thinkingLevel: "off",
	timeoutMs: 8000,
	maxOutputTokens: 512,
} as const;

const dedicatedConfig: PermissionReviewerDedicatedConfig = {
	source: "dedicated",
	name: "Local reviewer",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1234/v1",
	modelId: "review-model",
	thinkingLevel: "off",
	timeoutMs: 8000,
	maxOutputTokens: 512,
	reasoningMode: "off",
};

describe("reviewer model resolution", () => {
	it("uses the exact registered provider identity", () => {
		const registered = model();
		const lookup = lookupFor(registered);
		const resolution = resolveReviewerModel(providerConfig, lookup);
		expect(resolution).toEqual({ ok: true, model: registered });
		expect(lookup.find).toHaveBeenCalledExactlyOnceWith("chat-provider", "chat-model");

		const missing = resolveReviewerModel({ ...providerConfig, modelId: "other-model" }, lookup);
		expect(missing).toEqual({ ok: false, error: "The permission reviewer model is unavailable" });
	});

	it("rejects provider capabilities the reviewer contract cannot carry", () => {
		const unsupported = resolveReviewerModel(
			providerConfig,
			lookupFor(model({ api: "unsupported-api" as Model<any>["api"] })),
		);
		expect(unsupported).toEqual({
			ok: false,
			error: "The permission reviewer model uses an unsupported API: unsupported-api",
		});

		const noThinking = resolveReviewerModel({ ...providerConfig, thinkingLevel: "low" }, lookupFor(model()));
		expect(noThinking).toEqual({
			ok: false,
			error: 'Thinking level "low" is not available for this model',
		});

		const oversized = resolveReviewerModel(
			{ ...providerConfig, maxOutputTokens: 2048 },
			lookupFor(model({ maxTokens: 1024 })),
		);
		expect(oversized).toEqual({
			ok: false,
			error: "The permission reviewer output budget exceeds the model limit",
		});
	});

	it("synthesizes a dedicated model without consulting the chat catalog", () => {
		const lookup = lookupFor();
		const resolution = resolveReviewerModel(dedicatedConfig, lookup);
		expect(lookup.find).not.toHaveBeenCalled();
		if (!resolution.ok) throw new Error(resolution.error);
		expect(resolution.model).toEqual({
			id: "review-model",
			name: "Local reviewer",
			api: "openai-completions",
			provider: DEDICATED_REVIEWER_PROVIDER,
			baseUrl: "http://127.0.0.1:1234/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		});
		expect(Object.isFrozen(resolution.model)).toBe(true);

		// Independent of the chat provider: a colliding search result is ignored.
		expect(
			resolveReviewerModel(dedicatedConfig, lookupFor(model({ provider: DEDICATED_REVIEWER_PROVIDER }))),
		).toMatchObject({ ok: true });
	});

	it("maps manual reasoning to the configured levels only", () => {
		const manual: PermissionReviewerDedicatedConfig = {
			...dedicatedConfig,
			thinkingLevel: "low",
			reasoningMode: "manual",
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null },
		};
		const resolution = resolveReviewerModel(manual, lookupFor());
		if (!resolution.ok) throw new Error(resolution.error);
		expect(resolution.model.reasoning).toBe(true);
		expect(resolution.model.explicitThinkingLevels).toBe(true);
		expect(resolution.model.thinkingLevelMap).toEqual(manual.thinkingLevelMap);

		const unconfigured = resolveReviewerModel({ ...manual, thinkingLevel: "high" }, lookupFor());
		expect(unconfigured).toEqual({
			ok: false,
			error: 'Thinking level "high" is not available for this model',
		});
	});
});

describe("dedicated reviewer credential", () => {
	it("reads only the dedicated key without provider fallback", async () => {
		const getApiKey = vi.fn(async () => "dedicated-key");
		await expect(resolveDedicatedReviewerApiKey({ getApiKey })).resolves.toBe("dedicated-key");
		expect(getApiKey).toHaveBeenCalledExactlyOnceWith(DEDICATED_REVIEWER_AUTH_KEY, { includeFallback: false });
	});

	it("reports a missing dedicated key instead of falling back", async () => {
		const getApiKey = vi.fn(async () => undefined);
		await expect(resolveDedicatedReviewerApiKey({ getApiKey })).resolves.toBeUndefined();
		expect(getApiKey).toHaveBeenCalledExactlyOnceWith(DEDICATED_REVIEWER_AUTH_KEY, { includeFallback: false });
	});
});

describe("reviewer authentication selection", () => {
	const sharedAuth = { apiKey: "shared-key", headers: { "x-shared": "1" } };

	it("uses the dedicated key only for a dedicated profile", async () => {
		const getSharedAuth = vi.fn(async () => sharedAuth);
		const authStorage = { getApiKey: vi.fn(async () => "dedicated-key") };
		const modelForReview = resolveReviewerModel(dedicatedConfig, lookupFor());
		if (!modelForReview.ok) throw new Error(modelForReview.error);

		await expect(
			resolveReviewerAuthentication(dedicatedConfig, modelForReview.model, { authStorage, getSharedAuth }),
		).resolves.toEqual({ apiKey: "dedicated-key" });
		expect(getSharedAuth).not.toHaveBeenCalled();
		expect(authStorage.getApiKey).toHaveBeenCalledExactlyOnceWith(DEDICATED_REVIEWER_AUTH_KEY, {
			includeFallback: false,
		});
	});

	it("keeps shared provider auth even when the provider reuses the reserved name", async () => {
		const getSharedAuth = vi.fn(async () => sharedAuth);
		const authStorage = { getApiKey: vi.fn(async () => "dedicated-key") };
		// A shared provider may legitimately be named like the synthesized one;
		// only the saved profile source decides which credential to use.
		const sharedModel = model({ provider: DEDICATED_REVIEWER_PROVIDER });

		await expect(
			resolveReviewerAuthentication(providerConfig, sharedModel, { authStorage, getSharedAuth }),
		).resolves.toEqual(sharedAuth);
		expect(getSharedAuth).toHaveBeenCalledExactlyOnceWith(sharedModel);
		expect(authStorage.getApiKey).not.toHaveBeenCalled();
	});

	it("fails closed for a dedicated profile without an isolated key", async () => {
		const source = resolveReviewerModel(dedicatedConfig, lookupFor());
		if (!source.ok) throw new Error(source.error);
		await expect(
			resolveReviewerAuthentication(dedicatedConfig, source.model, {
				authStorage: { getApiKey: async () => undefined },
				getSharedAuth: async () => sharedAuth,
			}),
		).rejects.toThrow("Permission reviewer authentication is unavailable");
	});
});
