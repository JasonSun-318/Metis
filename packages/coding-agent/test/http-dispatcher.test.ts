import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHttpProxySettings, createUndiciClient, requestProxyUrl } from "../src/core/http-dispatcher.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

describe("http proxy settings", () => {
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("applies httpProxy to HTTP_PROXY and HTTPS_PROXY", () => {
		applyHttpProxySettings("http://127.0.0.1:7890");

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("does not override existing proxy env vars", () => {
		process.env.HTTP_PROXY = "http://env-http:8080";
		process.env.HTTPS_PROXY = "http://env-https:8080";

		applyHttpProxySettings("http://settings:7890");

		expect(process.env.HTTP_PROXY).toBe("http://env-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://env-https:8080");
	});

	it("ignores empty values", () => {
		applyHttpProxySettings("   ");

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});

	it("selects the proxy the same way as the global env agent", () => {
		expect(requestProxyUrl(new URL("http://docs.internal/wiki"))).toBeUndefined();

		process.env.HTTP_PROXY = "http://proxy.internal:8080";
		expect(requestProxyUrl(new URL("http://docs.internal/wiki"))).toBe("http://proxy.internal:8080");
		expect(requestProxyUrl(new URL("https://docs.internal/wiki"))).toBe("http://proxy.internal:8080");

		process.env.HTTPS_PROXY = "http://secure-proxy.internal:8443";
		expect(requestProxyUrl(new URL("https://docs.internal/wiki"))).toBe("http://secure-proxy.internal:8443");
		expect(requestProxyUrl(new URL("http://docs.internal/wiki"))).toBe("http://proxy.internal:8080");

		process.env.NO_PROXY = "docs.internal, *.example.com";
		expect(requestProxyUrl(new URL("http://docs.internal/wiki"))).toBeUndefined();
		expect(requestProxyUrl(new URL("https://api.example.com/page"))).toBeUndefined();
		expect(requestProxyUrl(new URL("http://other.internal/"))).toBe("http://proxy.internal:8080");
	});

	it("absorbs an undici client error emitted while a response body is aborted", async () => {
		const client = createUndiciClient("http://example.com", {});
		expect(() => (client as EventEmitter).emit("error", new Error("body aborted"))).not.toThrow();
		await client.destroy();
	});
});
