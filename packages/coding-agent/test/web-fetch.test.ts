import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchToolDefinition, type WebFetchToolOptions } from "../src/core/tools/web-fetch.ts";
import { createUnattendedPinnedLookup, UNATTENDED_BLOCKED_FETCH_REASON } from "../src/core/unattended-fetch-guard.ts";

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
	lookup: (...args: unknown[]) => lookupMock(...args),
}));

const originalFetch = globalThis.fetch;
const tool = createWebFetchToolDefinition();

afterEach(() => {
	globalThis.fetch = originalFetch;
	lookupMock.mockReset();
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

	it("still fetches loopback and link-local URLs outside unattended execution", async () => {
		const fetchMock = vi.fn(
			async () => new Response("local", { status: 200, headers: { "content-type": "text/plain" } }),
		);
		globalThis.fetch = fetchMock as typeof fetch;

		await execute("http://127.0.0.1/local");
		await execute("http://169.254.169.254/latest/meta-data");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(lookupMock).not.toHaveBeenCalled();
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

describe("unattended web_fetch", () => {
	function execute(url: string, fetchImpl: WebFetchToolOptions["fetch"]) {
		const unattended = createWebFetchToolDefinition({ unattended: true, fetch: fetchImpl });
		return unattended.execute("tool-call", { url }, undefined, undefined, undefined as never);
	}

	function textResponse(body: string, status = 200, headers?: Record<string, string>) {
		return new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
	}

	it.each([
		"http://127.0.0.1/secret",
		"http://127.1/",
		"http://0/",
		"http://0.0.0.0/",
		"http://localhost/docs",
		"http://LOCALHOST./docs",
		"http://[::1]/",
		"http://[::]/",
		"http://[::ffff:127.0.0.1]/",
		"http://169.254.169.254/latest/meta-data",
		"http://[::ffff:169.254.169.254]/",
		"http://[fe80::1]/",
		"http://2130706433/",
	])("refuses %s before connecting", async (url) => {
		const fetchMock = vi.fn();
		await expect(execute(url, fetchMock as WebFetchToolOptions["fetch"])).rejects.toThrow(
			UNATTENDED_BLOCKED_FETCH_REASON,
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("refuses a hostname that resolves to cloud metadata or loopback", async () => {
		lookupMock.mockImplementation(async (hostname: string) => {
			if (hostname === "metadata.google.internal") return [{ address: "169.254.169.254", family: 4 }];
			if (hostname === "localhost.localdomain") return [{ address: "::1", family: 6 }];
			if (hostname === "mixed.example") {
				return [
					{ address: "93.184.216.34", family: 4 },
					{ address: "127.0.0.1", family: 4 },
				];
			}
			throw new Error(`unexpected lookup ${hostname}`);
		});
		const fetchMock = vi.fn();
		for (const url of [
			"http://metadata.google.internal/latest",
			"http://localhost.localdomain/",
			"https://mixed.example/page",
		]) {
			await expect(execute(url, fetchMock as WebFetchToolOptions["fetch"])).rejects.toThrow(
				UNATTENDED_BLOCKED_FETCH_REASON,
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetches RFC1918 and public hosts, including a resolved private address", async () => {
		lookupMock.mockResolvedValue([{ address: "10.8.0.4", family: 4 }]);
		const fetchMock = vi.fn(async (_url: URL, _init: RequestInit & { dispatcher?: object }) =>
			textResponse("internal doc"),
		);
		const literal = await execute("http://192.168.1.20/docs", fetchMock);
		const resolved = await execute("http://docs.internal/wiki", fetchMock);

		expect(literal.content).toEqual([{ type: "text", text: "internal doc" }]);
		expect(resolved.content).toEqual([{ type: "text", text: "internal doc" }]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ dispatcher: expect.any(Object) }));
		expect(lookupMock).toHaveBeenCalledTimes(1);
		expect(lookupMock).toHaveBeenCalledWith("docs.internal", { all: true, verbatim: true });
	});

	it("refuses a redirect onto a link-local address without advertising that URL", async () => {
		lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "http://169.254.169.254/latest/meta-data" },
				}),
		);
		await expect(execute("https://example.com/start", fetchMock)).rejects.toThrow(UNATTENDED_BLOCKED_FETCH_REASON);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refuses a redirect whose host resolves to loopback", async () => {
		lookupMock.mockImplementation(async (hostname: string) => {
			if (hostname === "example.com") return [{ address: "93.184.216.34", family: 4 }];
			if (hostname === "rebind.example") return [{ address: "127.0.0.1", family: 4 }];
			throw new Error(`unexpected lookup ${hostname}`);
		});
		const fetchMock = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "https://rebind.example/secret" } }),
		);
		await expect(execute("https://example.com/start", fetchMock)).rejects.toThrow(UNATTENDED_BLOCKED_FETCH_REASON);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("follows a same-host redirect after the next address is still allowed", async () => {
		lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/pages/final.txt" } }))
			.mockResolvedValueOnce(textResponse("done"));
		const result = await execute("http://docs.internal/start", fetchMock);
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		expect(result.details.url).toBe("http://docs.internal/pages/final.txt");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps the separate permission check for a redirect to another public host", async () => {
		lookupMock.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
		const fetchMock = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "https://other.example/page" } }),
		);
		await expect(execute("https://example.com/start", fetchMock)).rejects.toThrow(
			"requires separate network permission",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the host cannot be resolved", async () => {
		lookupMock.mockRejectedValue(Object.assign(new Error("no such host"), { code: "ENOTFOUND" }));
		const fetchMock = vi.fn();
		await expect(execute("https://missing.example/", fetchMock)).rejects.toThrow("could not resolve the host");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("pins the connection to the accepted address", async () => {
		const server = createServer((_request, response) => {
			response.end("pinned");
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const port = (server.address() as AddressInfo).port;
		const agent = new Agent({
			allowH2: false,
			connect: {
				lookup: createUnattendedPinnedLookup("pinned.example", [{ address: "127.0.0.1", family: 4 }]),
			},
		});
		try {
			const response = await undiciFetch(`http://pinned.example:${port}/ok`, { dispatcher: agent });
			expect(await response.text()).toBe("pinned");
			await expect(undiciFetch(`http://other.example:${port}/ok`, { dispatcher: agent })).rejects.toThrow();
		} finally {
			await agent.close();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
