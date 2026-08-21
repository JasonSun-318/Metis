import { afterEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "../src/core/memory/memory-embedder.ts";

const settings = {
	name: "Embedding",
	provider: "Qwen",
	baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
	api: "openai-compatible" as const,
	modelId: "text-embedding-v4",
	dimensions: 2,
};

describe("memory embedder", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("posts to one OpenAI-compatible embeddings operation and restores provider order", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings");
			expect(init?.method).toBe("POST");
			expect(init?.redirect).toBe("error");
			const body = JSON.parse(String(init?.body));
			expect(body).toEqual({ model: "text-embedding-v4", input: ["A", "B"], dimensions: 2 });
			expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
			return new Response(
				JSON.stringify({
					data: [
						{ embedding: [0, 1], index: 1 },
						{ embedding: [1, 0], index: 0 },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as typeof fetch;

		const vectors = await embedTexts(["A", "B"], { settings, apiKey: "test-key" });
		expect(vectors).toEqual([new Float32Array([1, 0]), new Float32Array([0, 1])]);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		[
			[
				{ index: 0, embedding: [1, 0] },
				{ index: 0, embedding: [0, 1] },
			],
			/index/i,
		],
		[
			[
				{ index: 0, embedding: [1, Number.NaN] },
				{ index: 1, embedding: [0, 1] },
			],
			/finite/i,
		],
		[
			[
				{ index: 0, embedding: [1e100, 0] },
				{ index: 1, embedding: [0, 1] },
			],
			/float32/i,
		],
		[
			[
				{ index: 0, embedding: [0, 0] },
				{ index: 1, embedding: [0, 1] },
			],
			/norm/i,
		],
		[
			[
				{ index: 0, embedding: [1] },
				{ index: 1, embedding: [0, 1] },
			],
			/length/i,
		],
	] as const)("rejects invalid embedding rows", async (rows, reason) => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify({ data: rows }), { status: 200 }),
		) as typeof fetch;
		await expect(embedTexts(["A", "B"], { settings, apiKey: "secret" })).rejects.toThrow(reason);
	});

	it("rejects bounded inputs and does not expose a non-2xx response body", async () => {
		await expect(embedTexts([], { settings, apiKey: "secret" })).rejects.toThrow(/1 through 32/i);
		await expect(embedTexts(["x".repeat(8_001)], { settings, apiKey: "secret" })).rejects.toThrow(/8000/i);
		globalThis.fetch = vi.fn(async () => new Response("secret-body", { status: 401 })) as typeof fetch;
		await expect(embedTexts(["A"], { settings, apiKey: "secret" })).rejects.not.toThrow(/secret-body/);
	});

	it("rejects an oversized declared response before JSON parsing", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response("{}", { status: 200, headers: { "content-length": String(16 * 1024 * 1024 + 1) } }),
		) as typeof fetch;
		await expect(embedTexts(["A"], { settings, apiKey: "secret" })).rejects.toThrow(/16,777,216 bytes/i);
	});
});
