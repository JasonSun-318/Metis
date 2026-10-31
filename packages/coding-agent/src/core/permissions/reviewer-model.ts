import { getSupportedThinkingLevels, type Model } from "@metis/ai/compat";
import { resolveCustomModelReasoning } from "../custom-model-reasoning.ts";
import {
	isDedicatedReviewerConfig,
	type PermissionReviewerConfig,
	type PermissionReviewerDedicatedConfig,
	REVIEWER_APIS,
} from "./reviewer-config.ts";

/**
 * Synthesized provider id for dedicated reviewer models. The matching
 * AuthStorage key is reserved for the independent reviewer; it is never read
 * through the chat provider configuration or environment lookup.
 */
export const DEDICATED_REVIEWER_PROVIDER = "metis-permission-reviewer";
export const DEDICATED_REVIEWER_AUTH_KEY = DEDICATED_REVIEWER_PROVIDER;

/** Hard reviewer output ceiling; model capabilities may only lower it. */
const REVIEWER_MAX_OUTPUT_TOKENS = 8_192;
const REVIEWER_CONTEXT_WINDOW = 128_000;

export interface ReviewerModelLookup {
	find(provider: string, modelId: string): Model<any> | undefined;
}

export type ReviewerModelResolution =
	| { readonly ok: true; readonly model: Model<any> }
	| { readonly ok: false; readonly error: string };

export interface ReviewerApiKeySource {
	getApiKey(provider: string, options?: { includeFallback?: boolean }): Promise<string | undefined>;
}

/** Runtime-only request authentication for one reviewer call. Never persisted. */
export interface ReviewerRequestAuth {
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly env?: Record<string, string>;
}

/** Read the dedicated credential without falling back to provider env or shared keys. */
export function resolveDedicatedReviewerApiKey(source: ReviewerApiKeySource): Promise<string | undefined> {
	return source.getApiKey(DEDICATED_REVIEWER_AUTH_KEY, { includeFallback: false });
}

/**
 * Select the credential for one reviewer call from the saved profile source.
 * The synthesized model provider is not authoritative: a shared provider may
 * legitimately share the reserved name, so only `source: "dedicated"` selects
 * the isolated key.
 */
export async function resolveReviewerAuthentication(
	config: PermissionReviewerConfig,
	model: Model<any>,
	sources: {
		readonly authStorage: ReviewerApiKeySource;
		getSharedAuth(model: Model<any>): Promise<ReviewerRequestAuth>;
	},
): Promise<ReviewerRequestAuth> {
	if (!isDedicatedReviewerConfig(config)) return sources.getSharedAuth(model);
	const apiKey = await resolveDedicatedReviewerApiKey(sources.authStorage);
	if (!apiKey) throw new Error("Permission reviewer authentication is unavailable");
	return { apiKey };
}

function dedicatedReviewerModel(config: PermissionReviewerDedicatedConfig): Model<any> {
	const reasoning = resolveCustomModelReasoning({
		mode: config.reasoningMode,
		modelId: config.modelId,
		api: config.api,
		catalog: [],
		...(config.thinkingLevelMap ? { thinkingLevelMap: config.thinkingLevelMap } : {}),
	});
	return Object.freeze({
		id: config.modelId,
		name: config.name,
		api: config.api,
		provider: DEDICATED_REVIEWER_PROVIDER,
		baseUrl: config.baseUrl,
		reasoning: reasoning.reasoning,
		...(reasoning.thinkingLevelMap ? { thinkingLevelMap: reasoning.thinkingLevelMap } : {}),
		...(reasoning.source === "manual" ? { explicitThinkingLevels: true } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: REVIEWER_CONTEXT_WINDOW,
		maxTokens: REVIEWER_MAX_OUTPUT_TOKENS,
	}) as Model<any>;
}

/**
 * Resolve the exact model for a saved reviewer profile. Dedicated connections
 * are synthesized in memory and never registered in the chat model catalog;
 * provider profiles must still match their exact registered identity.
 */
export function resolveReviewerModel(
	config: PermissionReviewerConfig,
	lookup: ReviewerModelLookup,
): ReviewerModelResolution {
	let model: Model<any>;
	if (isDedicatedReviewerConfig(config)) {
		model = dedicatedReviewerModel(config);
	} else {
		const found = lookup.find(config.provider, config.modelId);
		if (!found || found.provider !== config.provider || found.id !== config.modelId) {
			return { ok: false, error: "The permission reviewer model is unavailable" };
		}
		model = found;
	}
	if (!REVIEWER_APIS.has(model.api)) {
		return { ok: false, error: `The permission reviewer model uses an unsupported API: ${model.api}` };
	}
	if (!getSupportedThinkingLevels(model).includes(config.thinkingLevel)) {
		return { ok: false, error: `Thinking level "${config.thinkingLevel}" is not available for this model` };
	}
	if (config.maxOutputTokens > Math.min(REVIEWER_MAX_OUTPUT_TOKENS, Math.max(1, Math.trunc(model.maxTokens)))) {
		return { ok: false, error: "The permission reviewer output budget exceeds the model limit" };
	}
	return { ok: true, model };
}
