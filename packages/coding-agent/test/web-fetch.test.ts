import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchToolDefinition } from "../src/core/tools/web-fetch.ts";

const originalFetch = globalThis.fetch;
const tool = createWebFetchToolDefinition();

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

function execute(url: string) {
	return tool.execute("tool-call", { url }, undefined, undefined, undefined as never);
}

describe("web_fetch", () => {
	it("fetches HTML and returns Markdown", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("<h1>Hello</h1><p>World</p>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		) as typeof fetch;

		const result = await execute("https://example.com/page");

		expect(result.content).toEqual([{ type: "text", text: "# Hello\n\nWorld" }]);
		expect(result.details).toMatchObject({
			url: "https://example.com/page",
			status: 200,
			contentType: "text/html",
			bytes: 26,
		});
	});

	it("requires separate permission before following a redirect to another network target", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.1/private" },
				}),
		);
		globalThis.fetch = fetchMock as typeof fetch;

		await expect(execute("https://example.com/start")).rejects.toThrow("requires separate network permission");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			new URL("https://example.com/start"),
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("follows same-target redirects and resolves relative links against the final URL", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "/pages/final.html" },
				}),
			)
			.mockResolvedValueOnce(
				new Response('<a href="./docs">Docs</a><img src="/logo.png" alt="Logo">', {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);
		globalThis.fetch = fetchMock as typeof fetch;

		const result = await execute("https://example.com/start");
		const markdown = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(markdown).toContain("[Docs](https://example.com/pages/docs)");
		expect(markdown).toContain("![Logo](https://example.com/logo.png)");
		expect(result.details.url).toBe("https://example.com/pages/final.html");
	});

	it("decodes the charset declared by the Content-Type header", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), {
					status: 200,
					headers: { "content-type": "text/plain; charset=iso-8859-1" },
				}),
		) as typeof fetch;

		const result = await execute("https://example.com/latin1");

		expect(result.content).toEqual([{ type: "text", text: "café" }]);
	});

	it("decodes an HTML meta charset declaration", async () => {
		const prefix = Buffer.from('<meta charset="iso-8859-1"><p>caf', "ascii");
		const suffix = Buffer.from("</p>", "ascii");
		globalThis.fetch = vi.fn(
			async () =>
				new Response(Uint8Array.from([...prefix, 0xe9, ...suffix]), {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		) as typeof fetch;

		const result = await execute("https://example.com/meta-charset");

		expect(result.content).toEqual([{ type: "text", text: "café" }]);
	});

	it("rejects non-HTTP URLs", async () => {
		await expect(execute("file:///etc/passwd")).rejects.toThrow("HTTP or HTTPS");
		expect(globalThis.fetch).toBe(originalFetch);
	});

	it("rejects responses larger than the limit", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("too large", {
					status: 200,
					headers: { "content-type": "text/html", "content-length": "2000001" },
				}),
		) as typeof fetch;

		await expect(execute("https://example.com/large")).rejects.toThrow("2,000,000 bytes");
	});
});
