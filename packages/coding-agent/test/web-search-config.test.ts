import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	resolveWebSearchApiKey,
	webSearchCredentialId,
	webSearchProviderFromCredentialId,
} from "../src/core/web-search-config.ts";

describe("web search configuration", () => {
	it("uses namespaced credential ids and resolves stored keys", async () => {
		const auth = AuthStorage.inMemory();
		auth.set("web-search:tavily", { type: "api_key", key: "stored-key" });

		expect(webSearchCredentialId("tavily")).toBe("web-search:tavily");
		expect(webSearchProviderFromCredentialId("web-search:tavily")).toBe("tavily");
		expect(webSearchProviderFromCredentialId("tavily")).toBeUndefined();
		await expect(resolveWebSearchApiKey(auth, "tavily")).resolves.toBe("stored-key");
	});

	it("returns undefined when the selected provider has no stored key", async () => {
		await expect(resolveWebSearchApiKey(AuthStorage.inMemory(), "serpapi")).resolves.toBeUndefined();
	});
});
