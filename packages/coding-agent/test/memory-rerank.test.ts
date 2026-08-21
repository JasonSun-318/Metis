import { afterEach, describe, expect, it, vi } from "vitest";
import { rerankDocuments } from "../src/core/memory/memory-rerank.ts";

const documents = [
	{ id: "a", text: "A" },
	{ id: "b", text: "B" },
];

describe("memory rerank", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		"https://api.cohere.com/v2/rerank",
		"https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
		"https://EXAMPLE.test/rerank/",
	])("uses the configured endpoint verbatim: %s", async (endpointUrl) => {
		const fetchFn = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						results: [
							{ index: 1, relevance_score: 0.9 },
							{ index: 0, relevance_score: 0.2 },
						],
					}),
					{ status: 200 },
				),
		);
		const scores = await rerankDocuments({
			settings: { name: "Rerank", provider: "Any", endpointUrl, modelId: "rerank-model" },
			apiKey: "secret",
			query: "query",
			documents,
			fetchFn,
		});
		expect(fetchFn.mock.calls[0]?.[0]).toBe(endpointUrl);
		expect(fetchFn.mock.calls[0]?.[1]?.redirect).toBe("error");
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({ top_n: documents.length });
		expect(scores.map((score) => score.id)).toEqual(["b", "a"]);
	});

	it.each([
		[
			[
				{ index: 0, relevance_score: 1 },
				{ index: 0, relevance_score: 0 },
			],
			/duplicate/i,
		],
		[[{ index: 2, relevance_score: 1 }], /range/i],
		[[{ index: 0, relevance_score: Number.NaN }], /finite/i],
	] as const)("rejects invalid scores", async (results, reason) => {
		await expect(
			rerankDocuments({
				settings: { name: "Rerank", provider: "Any", endpointUrl: "https://example.test/rerank", modelId: "m" },
				apiKey: "secret",
				query: "query",
				documents,
				fetchFn: async () => new Response(JSON.stringify({ results }), { status: 200 }),
			}),
		).rejects.toThrow(reason);
	});

	it("rejects an oversized declared response before parsing", async () => {
		await expect(
			rerankDocuments({
				settings: {
					name: "Rerank",
					provider: "Any",
					endpointUrl: "https://example.test/rerank",
					modelId: "m",
				},
				apiKey: "secret",
				query: "query",
				documents,
				fetchFn: async () =>
					new Response("{}", {
						status: 200,
						headers: { "content-length": String(16 * 1024 * 1024 + 1) },
					}),
			}),
		).rejects.toThrow(/16,777,216 bytes/i);
	});
});
