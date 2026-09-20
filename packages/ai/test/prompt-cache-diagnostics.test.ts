import { describe, expect, it, vi } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { KnownApi, Model, PromptCacheRequestSnapshot } from "../src/types.ts";
import { observePromptCacheRequest } from "../src/utils/prompt-cache-diagnostics.ts";

const model = (api: KnownApi): Model<KnownApi> => ({
	api,
	provider: "test",
	id: "test-model",
	name: "test",
	baseUrl: "https://example.invalid/private-endpoint",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const apis: KnownApi[] = [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"bedrock-converse-stream",
	"mistral-conversations",
];
async function snapshot(api: KnownApi, payload: unknown): Promise<PromptCacheRequestSnapshot> {
	let result: PromptCacheRequestSnapshot | undefined;
	await observePromptCacheRequest(model(api), payload, {
		promptCacheDiagnostics: {
			enabled: () => true,
			onRequest: (value) => {
				result = value;
			},
		},
	});
	expect(result).toBeDefined();
	return result!;
}

describe("provider request cache diagnostics", () => {
	it.each(apis)("captures %s without retaining private payloads or mutating requests", async (api) => {
		const messages = [{ role: "user", content: "private-user-content" }];
		const payload = api.startsWith("google")
			? {
					contents: messages,
					config: { systemInstruction: "private-system", tools: [{ name: "private-tool" }], temperature: 1 },
				}
			: api.includes("responses")
				? { input: messages, instructions: "private-system", tools: [{ name: "private-tool" }], temperature: 1 }
				: { messages, system: "private-system", tools: [{ name: "private-tool" }], temperature: 1 };
		const before = JSON.stringify(payload);
		const result = await snapshot(api, payload);
		expect(JSON.stringify(payload)).toBe(before);
		expect(JSON.stringify(result)).not.toContain("private-");
		expect(result.messageCount).toBe(1);
		expect(result.messages[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(result.boundary).toBe("adapter-payload");
	});
	it("distinguishes append, earlier history edits, system, tools and settings", async () => {
		const payload = {
			messages: [{ role: "user", content: "one" }],
			system: "sys",
			tools: [{ name: "tool" }],
			temperature: 1,
		};
		const a = await snapshot("openai-completions", payload);
		const b = await snapshot("openai-completions", {
			...payload,
			messages: [...payload.messages, { role: "user", content: "two" }],
		});
		expect(b.messages[0]).toEqual(a.messages[0]);
		expect(b.settings).toEqual(a.settings);
		const c = await snapshot("openai-completions", { ...payload, messages: [{ role: "user", content: "changed" }] });
		expect(c.messages[0]?.digest).not.toBe(a.messages[0]?.digest);
		for (const key of ["system", "tools", "temperature"] as const) {
			const changed = await snapshot("openai-completions", { ...payload, [key]: "changed" });
			expect(changed[key === "temperature" ? "settings" : key].digest).not.toBe(
				a[key === "temperature" ? "settings" : key].digest,
			);
		}
	});
	it("does zero serialization while disabled and isolates observer failures", async () => {
		const toJSON = vi.fn(() => {
			throw new Error("must not serialize");
		});
		await observePromptCacheRequest(
			model("openai-completions"),
			{ toJSON },
			{ promptCacheDiagnostics: { enabled: () => false, onRequest: vi.fn() } },
		);
		expect(toJSON).not.toHaveBeenCalled();
		await expect(
			observePromptCacheRequest(
				model("openai-completions"),
				{},
				{
					promptCacheDiagnostics: {
						enabled: () => true,
						onRequest: () => {
							throw new Error("observer failed");
						},
					},
				},
			),
		).resolves.toBeUndefined();
	});
	it("isolates asynchronous observer failures", async () => {
		await expect(
			observePromptCacheRequest(
				model("openai-completions"),
				{},
				{
					promptCacheDiagnostics: {
						enabled: () => true,
						onRequest: async () => {
							throw new Error("async observer failed");
						},
					},
				},
			),
		).resolves.toBeUndefined();
	});
	it("bounds retained history without claiming complete evidence", async () => {
		const result = await snapshot("openai-completions", {
			messages: Array.from({ length: 2050 }, () => ({ role: "user", content: "x" })),
		});
		expect(result.messages).toHaveLength(2048);
		expect(result.messageCount).toBe(2050);
		expect(result.complete).toBe(false);
	});
	it("preserves both observation hooks through streamSimple base options", () => {
		const onPromptCachePrepared = vi.fn();
		const promptCacheDiagnostics = { enabled: () => true, onRequest: vi.fn() };
		const options = buildBaseOptions(
			model("anthropic-messages"),
			{ messages: [] },
			{ onPromptCachePrepared, promptCacheDiagnostics },
		);
		expect(options.onPromptCachePrepared).toBe(onPromptCachePrepared);
		expect(options.promptCacheDiagnostics).toBe(promptCacheDiagnostics);
	});
});
