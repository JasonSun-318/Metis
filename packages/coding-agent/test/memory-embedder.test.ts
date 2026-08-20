import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { embedTexts, MemoryEmbedTimeout, resolveEmbeddingEndpoint } from "../src/core/memory/memory-embedder.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

describe("memory embedder", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("POSTs OpenAI-compatible /v1/embeddings and returns Float32Array vectors", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://api.openai.com/v1/embeddings");
			expect(init?.method).toBe("POST");
			const body = JSON.parse(String(init?.body));
			expect(body).toEqual({ model: "text-embedding-3-small", input: ["hello world"] });
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
			return new Response(
				JSON.stringify({
					data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as typeof fetch;

		const vectors = await embedTexts(["hello world"], {
			endpoint: {
				baseUrl: "https://api.openai.com",
				apiKey: "test-key",
				modelId: "text-embedding-3-small",
			},
		});
		expect(vectors).toHaveLength(1);
		expect(vectors[0]).toBeInstanceOf(Float32Array);
		expect(Array.from(vectors[0]!).map((n) => Number(n.toFixed(1)))).toEqual([0.1, 0.2, 0.3]);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("throws MemoryEmbedTimeout when the request exceeds timeout", async () => {
		vi.useFakeTimers();
		globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				signal.addEventListener("abort", () => {
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				});
			});
		}) as typeof fetch;

		const pending = embedTexts(["slow"], {
			endpoint: {
				baseUrl: "https://api.openai.com",
				apiKey: "test-key",
				modelId: "text-embedding-3-small",
			},
			timeoutMs: 50,
		});
		const assertion = expect(pending).rejects.toBeInstanceOf(MemoryEmbedTimeout);
		await vi.advanceTimersByTimeAsync(60);
		await assertion;
	});

	it("resolves provider/model via ModelRegistry baseUrl and API key", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "sk-test");
		const registry = ModelRegistry.inMemory(authStorage);
		const endpoint = await resolveEmbeddingEndpoint(registry, "openai/text-embedding-3-small");
		expect(endpoint.modelId).toBe("text-embedding-3-small");
		expect(endpoint.apiKey).toBe("sk-test");
		expect(endpoint.baseUrl).toMatch(/^https?:\/\//);
	});
});
