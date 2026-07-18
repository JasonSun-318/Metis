import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ArcMindMcpOAuthProvider, startMcpOAuthCallback } from "../src/core/mcp/oauth.ts";

async function visit(url: URL): Promise<number> {
	return new Promise((resolve, reject) => {
		request(url, (response) => {
			response.resume();
			response.once("end", () => resolve(response.statusCode ?? 0));
		})
			.once("error", reject)
			.end();
	});
}

describe("MCP OAuth", () => {
	it("persists SDK OAuth fields under a server-scoped key", async () => {
		const storage = AuthStorage.inMemory();
		const redirect = vi.fn();
		const provider = new ArcMindMcpOAuthProvider({
			serverName: "figma",
			redirectUrl: new URL("http://127.0.0.1/callback"),
			authStorage: storage,
			onRedirect: redirect,
		});

		provider.saveCodeVerifier("verifier");
		provider.saveTokens({ access_token: "access", token_type: "bearer" });
		provider.redirectToAuthorization(new URL("https://auth.example.test"));

		expect(provider.codeVerifier()).toBe("verifier");
		expect(provider.tokens()).toMatchObject({ access_token: "access" });
		expect(storage.get("mcp:figma")).toMatchObject({ type: "mcp_oauth" });
		expect(await storage.getApiKey("mcp:figma", { includeFallback: false })).toBeUndefined();
		expect(redirect).toHaveBeenCalledOnce();
	});

	it("accepts one callback with the matching state and closes the listener", async () => {
		const callback = await startMcpOAuthCallback({ state: "expected" });
		const url = new URL(callback.redirectUrl);
		url.searchParams.set("code", "good-code");
		url.searchParams.set("state", "expected");

		expect(await visit(url)).toBe(200);
		await expect(callback.waitForCode).resolves.toBe("good-code");
		await callback.close();
	});

	it("rejects a mismatched state and closes the listener", async () => {
		const callback = await startMcpOAuthCallback({ state: "expected" });
		const rejected = expect(callback.waitForCode).rejects.toThrow("state mismatch");
		const url = new URL(callback.redirectUrl);
		url.searchParams.set("code", "bad-code");
		url.searchParams.set("state", "wrong");

		expect(await visit(url)).toBe(400);
		await rejected;
		await callback.close();
	});
});
