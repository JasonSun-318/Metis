import type { ThinkingLevel } from "@metis/agent-core";
import type { ThinkingLevelMap } from "@metis/ai";
import { hasConfiguredManualThinkingLevel, normalizeManualThinkingLevelMap } from "../custom-model-reasoning.ts";

export type ReviewerApi = "openai-responses" | "openai-completions" | "anthropic-messages";

/** Adapter APIs that can carry the reviewer verdict tool contract. */
export const REVIEWER_APIS: ReadonlySet<string> = new Set<ReviewerApi>([
	"openai-responses",
	"openai-completions",
	"anthropic-messages",
]);

/** Dedicated reviewer connections never use a provider's ambient reasoning guesses. */
export type ReviewerReasoningMode = "off" | "manual";

/** Existing profile: an independently selected chat provider and model. */
export interface PermissionReviewerProviderConfig {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly timeoutMs: number;
	readonly maxOutputTokens: number;
}

/**
 * Dedicated profile: a reviewer connection that is never registered in the chat
 * model catalog. The credential lives in AuthStorage under its own key.
 */
export interface PermissionReviewerDedicatedConfig {
	readonly source: "dedicated";
	readonly name: string;
	readonly api: ReviewerApi;
	readonly baseUrl: string;
	readonly modelId: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly timeoutMs: number;
	readonly maxOutputTokens: number;
	readonly reasoningMode: ReviewerReasoningMode;
	readonly thinkingLevelMap?: ThinkingLevelMap;
}

/** Independent Auto-mode approval model. Never falls back to the chat model. */
export type PermissionReviewerConfig = PermissionReviewerProviderConfig | PermissionReviewerDedicatedConfig;

export function isDedicatedReviewerConfig(
	config: PermissionReviewerConfig,
): config is PermissionReviewerDedicatedConfig {
	return "source" in config && config.source === "dedicated";
}

export type ReviewerConfigurationStatus = "unconfigured" | "configured" | "invalid";

export interface PermissionReviewerView {
	readonly config: PermissionReviewerConfig | null;
	readonly status: ReviewerConfigurationStatus;
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PROVIDER_KEYS = ["provider", "modelId", "thinkingLevel", "timeoutMs", "maxOutputTokens"] as const;
const DEDICATED_KEYS = [
	"source",
	"name",
	"api",
	"baseUrl",
	"modelId",
	"thinkingLevel",
	"timeoutMs",
	"maxOutputTokens",
	"reasoningMode",
] as const;
const DEDICATED_OPTIONAL_KEYS = ["thinkingLevelMap"] as const;
const THINKING_MAP_KEYS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_NAME_LENGTH = 120;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 300;

function isExactObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError("Invalid permission reviewer configuration");
	}
	const ownKeys = Object.getOwnPropertyNames(value);
	if (
		!required.every((key) => ownKeys.includes(key)) ||
		ownKeys.some((key) => !required.includes(key) && !optional.includes(key))
	) {
		throw new TypeError("Invalid permission reviewer configuration");
	}
	for (const key of ownKeys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
			throw new TypeError("Invalid permission reviewer configuration");
		}
	}
}

function readThinkingLevel(value: unknown): ThinkingLevel {
	if (typeof value !== "string" || !THINKING_LEVELS.has(value as ThinkingLevel)) {
		throw new TypeError("Permission reviewer thinking level is not supported");
	}
	return value as ThinkingLevel;
}

function readTimeout(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 15_000) {
		throw new TypeError("Permission reviewer timeout must be an integer between 1000 and 15000 ms");
	}
	return value;
}

function readOutputBudget(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 128 || value > 8_192) {
		throw new TypeError("Permission reviewer output budget must be an integer between 128 and 8192 tokens");
	}
	return value;
}

function readBaseUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE_URL_LENGTH) {
		throw new TypeError("Permission reviewer base URL is invalid");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("Permission reviewer base URL must use HTTP or HTTPS");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
		throw new TypeError("Permission reviewer base URL must use HTTP or HTTPS without credentials");
	}
	return value;
}

function normalizeProviderConfig(value: Record<string, unknown>): PermissionReviewerProviderConfig {
	assertExactKeys(value, PROVIDER_KEYS);
	const { provider, modelId } = value;
	if (typeof provider !== "string" || provider.trim() === "") {
		throw new TypeError("Permission reviewer provider must not be empty");
	}
	if (typeof modelId !== "string" || modelId.trim() === "") {
		throw new TypeError("Permission reviewer model must not be empty");
	}
	return Object.freeze({
		provider,
		modelId,
		thinkingLevel: readThinkingLevel(value.thinkingLevel),
		timeoutMs: readTimeout(value.timeoutMs),
		maxOutputTokens: readOutputBudget(value.maxOutputTokens),
	});
}

function normalizeDedicatedConfig(value: Record<string, unknown>): PermissionReviewerDedicatedConfig {
	assertExactKeys(value, DEDICATED_KEYS, DEDICATED_OPTIONAL_KEYS);
	// The dispatcher only decides which branch to read; the discriminator value
	// itself is part of the profile and must be exact.
	if (value.source !== "dedicated") {
		throw new TypeError("Permission reviewer connection source is not supported");
	}
	const { name, api, baseUrl, modelId, reasoningMode } = value;
	if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME_LENGTH) {
		throw new TypeError("Permission reviewer name must not be empty");
	}
	if (typeof api !== "string" || !REVIEWER_APIS.has(api)) {
		throw new TypeError("Permission reviewer API is not supported");
	}
	if (typeof modelId !== "string" || modelId.trim() === "" || modelId.length > MAX_MODEL_ID_LENGTH) {
		throw new TypeError("Permission reviewer model must not be empty");
	}
	if (reasoningMode !== "off" && reasoningMode !== "manual") {
		throw new TypeError("Permission reviewer reasoning mode must be off or manual");
	}
	const thinkingLevel = readThinkingLevel(value.thinkingLevel);
	const thinkingLevelMap = value.thinkingLevelMap;
	let normalizedMap: ThinkingLevelMap | undefined;
	if (reasoningMode === "off") {
		if (thinkingLevelMap !== undefined) {
			throw new TypeError("Permission reviewer reasoning is off but a thinking level map is configured");
		}
		if (thinkingLevel !== "off") {
			throw new TypeError("Permission reviewer thinking requires a manual reasoning map");
		}
	} else {
		if (thinkingLevelMap !== undefined) {
			if (!isExactObject(thinkingLevelMap) || Object.getOwnPropertySymbols(thinkingLevelMap).length > 0) {
				throw new TypeError("Invalid permission reviewer thinking level map");
			}
			for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(thinkingLevelMap))) {
				if (!THINKING_MAP_KEYS.has(key) || !("value" in descriptor) || !descriptor.enumerable) {
					throw new TypeError("Invalid permission reviewer thinking level map");
				}
				if (descriptor.value !== null && typeof descriptor.value !== "string") {
					throw new TypeError("Invalid permission reviewer thinking level map");
				}
			}
		}
		normalizedMap = normalizeManualThinkingLevelMap(thinkingLevelMap as ThinkingLevelMap | undefined);
		if (!hasConfiguredManualThinkingLevel(normalizedMap)) {
			throw new TypeError("Permission reviewer manual reasoning needs at least one thinking level value");
		}
		if (normalizedMap[thinkingLevel] === null) {
			throw new TypeError(`Thinking level "${thinkingLevel}" is not configured for this reviewer`);
		}
	}
	return Object.freeze({
		source: "dedicated",
		name,
		api: api as ReviewerApi,
		baseUrl: readBaseUrl(baseUrl),
		modelId,
		thinkingLevel,
		timeoutMs: readTimeout(value.timeoutMs),
		maxOutputTokens: readOutputBudget(value.maxOutputTokens),
		reasoningMode,
		...(normalizedMap ? { thinkingLevelMap: Object.freeze(normalizedMap) } : {}),
	});
}

/**
 * Strictly read the independent reviewer profile.
 *
 * A dedicated connection is identified by its exact `source: "dedicated"`
 * profile; any other plain object must be the legacy five-field provider
 * profile. A legacy V2 object, injected credential/endpoint field, or a
 * prototype/accessor anomaly invalidates the whole value rather than being
 * partially revived.
 */
export function normalizePermissionReviewerConfig(value: unknown): PermissionReviewerConfig | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isExactObject(value)) throw new TypeError("Invalid permission reviewer configuration");
	return Object.hasOwn(value, "source") ? normalizeDedicatedConfig(value) : normalizeProviderConfig(value);
}
