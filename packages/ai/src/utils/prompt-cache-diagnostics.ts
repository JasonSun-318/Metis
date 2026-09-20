import type { Api, Model, PromptCacheFingerprint, PromptCacheRequestSnapshot, StreamOptions } from "../types.ts";

const MAX_MESSAGE_FINGERPRINTS = 2048;
const encoder = new TextEncoder();

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

async function fingerprint(value: unknown): Promise<PromptCacheFingerprint> {
	const bytes = encoder.encode(JSON.stringify(value) ?? "undefined");
	const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return {
		digest: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(""),
		bytes: bytes.byteLength,
	};
}

/**
 * Observe the final SDK-boundary request, never modify it. These fingerprints
 * cannot prove provider cache eligibility, token prefixes or server routing.
 * Headers and transport configuration are deliberately outside this boundary.
 * No raw values or user-supplied property names escape this function.
 */
export async function observePromptCacheRequest(
	model: Model<Api>,
	payload: unknown,
	options?: StreamOptions,
): Promise<void> {
	try {
		const observer = options?.promptCacheDiagnostics;
		if (!observer?.enabled()) return;
		const capturedAt = Date.now();
		const body = record(payload);
		const { messages, input, contents, system, instructions, tools, toolConfig, config, ...settings } = body;
		const {
			systemInstruction,
			tools: googleTools,
			httpOptions: _httpOptions,
			abortSignal: _abortSignal,
			...googleSettings
		} = record(config);
		const history = messages ?? input ?? contents;
		const items = Array.isArray(history) ? history : history === undefined ? [] : [history];
		const systemMessages = items.filter((item) => ["system", "developer"].includes(String(record(item).role)));
		const [endpoint, settingsPrint, systemPrint, toolsPrint, historyPrint, messagePrints] = await Promise.all([
			fingerprint(model.baseUrl),
			fingerprint({ ...settings, ...(config === undefined ? {} : { config: googleSettings }) }),
			fingerprint({ system, instructions, systemInstruction, systemMessages }),
			fingerprint({ tools, toolConfig, googleTools }),
			fingerprint(history),
			Promise.all(items.slice(0, MAX_MESSAGE_FINGERPRINTS).map(fingerprint)),
		]);
		const snapshot: PromptCacheRequestSnapshot = {
			version: 1,
			boundary: "adapter-payload",
			api: model.api,
			provider: model.provider,
			model: model.id,
			endpointDigest: endpoint.digest,
			capturedAt,
			settings: settingsPrint,
			system: systemPrint,
			tools: toolsPrint,
			history: historyPrint,
			messages: messagePrints,
			messageCount: items.length,
			complete: items.length <= MAX_MESSAGE_FINGERPRINTS,
		};
		await observer.onRequest(snapshot);
	} catch {
		// Diagnostics must never prevent a request, including serialization,
		// crypto availability, settings lookup and observer callback failures.
	}
}
