import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchToolDefinition } from "../src/core/tools/web-search.ts";
import type { WebSearchProvider } from "../src/core/web-search-config.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

function configuredTool(provider: WebSearchProvider, request: typeof fetch = globalThis.fetch) {
	return createWebSearchToolDefinition({
		getSettings: () => ({ enabled: true, provider }),
		getApiKey: async () => "secret",
		fetch: request,
	});
}

async function execute(provider: WebSearchProvider, type: "web" | "images", payload: unknown) {
	const request = vi.fn(async () => Response.json(payload)) as typeof fetch;
	const result = await configuredTool(provider, request).execute(
		"call",
		{ query: "arc mind", type, limit: 10 },
		undefined,
		undefined,
		undefined as never,
	);
	return { result, request };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("web_search", () => {
	it.each([
		[
			"brave",
			{ web: { results: [{ title: "Brave", url: "https://example.com/a", description: "A" }] } },
			{ title: "Brave", url: "https://example.com/a", snippet: "A" },
		],
		[
			"tavily",
			{ results: [{ title: "Tavily", url: "https://example.com/b", content: "B" }] },
			{ title: "Tavily", url: "https://example.com/b", snippet: "B" },
		],
		[
			"serpapi",
			{ organic_results: [{ title: "Light", link: "https://example.com/c", snippet: "C" }] },
			{ title: "Light", url: "https://example.com/c", snippet: "C" },
		],
	] as const)("normalizes %s web results", async (provider, payload, expected) => {
		const { result } = await execute(provider, "web", payload);
		expect(JSON.parse(text(result))).toEqual({ type: "web", results: [expected] });
		expect(result.details).toEqual({ provider, type: "web", count: 1 });
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it.each([
		[
			"brave",
			{
				results: [
					{
						title: "Brave image",
						url: "https://example.com/page-a",
						properties: { url: "https://example.com/a.jpg" },
					},
				],
			},
			{ url: "https://example.com/a.jpg", title: "Brave image", sourceUrl: "https://example.com/page-a" },
		],
		[
			"tavily",
			{ images: [{ url: "https://example.com/b.jpg", description: "Tavily image" }] },
			{ url: "https://example.com/b.jpg", title: "Tavily image" },
		],
		[
			"serpapi",
			{
				images_results: [
					{ original: "https://example.com/c.jpg", title: "Google image", link: "https://example.com/page-c" },
				],
			},
			{ url: "https://example.com/c.jpg", title: "Google image", sourceUrl: "https://example.com/page-c" },
		],
	] as const)("normalizes %s image results", async (provider, payload, expected) => {
		const { result } = await execute(provider, "images", payload);
		expect(JSON.parse(text(result))).toEqual({ type: "images", results: [expected] });
		expect(result.details).toEqual({ provider, type: "images", count: 1 });
	});

	it("uses the dedicated Brave endpoints and subscription header", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ web: { results: [] } }))
			.mockResolvedValueOnce(Response.json({ results: [] }));
		const definition = configuredTool("brave", request as typeof fetch);

		await definition.execute("web", { query: "q" }, undefined, undefined, undefined as never);
		await definition.execute(
			"images",
			{ query: "q", type: "images", limit: 3 },
			undefined,
			undefined,
			undefined as never,
		);

		expect(String(request.mock.calls[0]?.[0])).toContain("/res/v1/web/search?q=q&count=10");
		expect(String(request.mock.calls[1]?.[0])).toContain("/res/v1/images/search?q=q&count=3");
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			redirect: "error",
			headers: { accept: "application/json", "x-subscription-token": "secret" },
		});
	});

	it("requests Tavily image descriptions without raw content", async () => {
		const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({ images: [] }),
		);
		const definition = configuredTool("tavily", request as typeof fetch);

		await definition.execute(
			"images",
			{ query: "q", type: "images", limit: 4 },
			undefined,
			undefined,
			undefined as never,
		);

		const init = request.mock.calls[0]?.[1] as RequestInit;
		expect(String(request.mock.calls[0]?.[0])).toBe("https://api.tavily.com/search");
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
		});
		expect(JSON.parse(String(init.body))).toEqual({
			query: "q",
			max_results: 4,
			search_depth: "basic",
			include_answer: false,
			include_raw_content: false,
			include_images: true,
			include_image_descriptions: true,
		});
	});

	it("uses Google Light for web and Google Images for image search", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ organic_results: [] }))
			.mockResolvedValueOnce(Response.json({ images_results: [] }));
		const definition = configuredTool("serpapi", request as typeof fetch);

		await definition.execute("web", { query: "q" }, undefined, undefined, undefined as never);
		await definition.execute("images", { query: "q", type: "images" }, undefined, undefined, undefined as never);

		expect(String(request.mock.calls[0]?.[0])).toContain("engine=google_light");
		expect(String(request.mock.calls[0]?.[0])).toContain("num=10");
		expect(String(request.mock.calls[1]?.[0])).toContain("engine=google_images");
		expect(String(request.mock.calls[1]?.[0])).not.toContain("num=");
		expect(String(request.mock.calls[0]?.[0])).toContain("api_key=secret");
	});

	it("fails closed when disabled or missing the selected provider key", async () => {
		const disabled = createWebSearchToolDefinition({
			getSettings: () => ({ enabled: false, provider: "brave" }),
			getApiKey: async () => "secret",
		});
		await expect(disabled.execute("call", { query: "q" }, undefined, undefined, undefined as never)).rejects.toThrow(
			"disabled",
		);

		const missing = createWebSearchToolDefinition({
			getSettings: () => ({ enabled: true, provider: "tavily" }),
			getApiKey: async () => undefined,
		});
		await expect(missing.execute("call", { query: "q" }, undefined, undefined, undefined as never)).rejects.toThrow(
			"Tavily API key is not configured",
		);
	});

	it("rejects redirects and oversized or invalid JSON responses without leaking credentials", async () => {
		const redirect = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }),
		);
		await expect(
			configuredTool("brave", redirect as typeof fetch).execute(
				"redirect",
				{ query: "q" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("HTTP 302");

		const oversized = vi.fn(async () => new Response("{}", { headers: { "content-length": "2000001" } }));
		await expect(
			configuredTool("tavily", oversized as typeof fetch).execute(
				"large",
				{ query: "q" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("2,000,000 bytes");

		const invalid = vi.fn(async () => new Response("not json"));
		const error = await configuredTool("serpapi", invalid as typeof fetch)
			.execute("invalid", { query: "q" }, undefined, undefined, undefined as never)
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("invalid JSON");
		expect(String(error)).not.toContain("secret");
	});

	it("drops malformed, credential-bearing, and non-http result URLs before applying the limit", async () => {
		const { result } = await execute("serpapi", "web", {
			organic_results: [
				{ title: "bad scheme", link: "javascript:alert(1)" },
				{ title: "credential", link: "https://user:pass@example.com/private" },
				{ link: "https://example.com/missing" },
				{ title: "good", link: "https://example.com", snippet: "good" },
			],
		});
		expect(JSON.parse(text(result))).toEqual({
			type: "web",
			results: [{ title: "good", url: "https://example.com/", snippet: "good" }],
		});
	});
});
