import { describe, expect, it } from "vitest";
import { trustedBaseUrl } from "../src/main/trusted-base-url.ts";

describe("trustedBaseUrl", () => {
	it("accepts credential-free HTTPS URLs and normalizes the pathname", () => {
		expect(trustedBaseUrl("https://updates.example.test/metis")?.href).toBe("https://updates.example.test/metis/");
		expect(trustedBaseUrl("https://updates.example.test/metis/")?.href).toBe("https://updates.example.test/metis/");
		expect(trustedBaseUrl("https://updates.example.test/metis///")?.href).toBe("https://updates.example.test/metis/");
		expect(trustedBaseUrl("https://updates.example.test")?.href).toBe("https://updates.example.test/");
		expect(trustedBaseUrl("https://updates.example.test:8443/Metis")?.href).toBe(
			"https://updates.example.test:8443/Metis/",
		);
	});

	it.each([undefined, null, ""])("rejects a missing base URL: %s", (value) => {
		expect(trustedBaseUrl(value)).toBeUndefined();
	});

	it.each([
		"http://updates.example.test/metis",
		"file:///tmp/metis",
		"https://user@updates.example.test/metis",
		"https://user:secret@updates.example.test/metis",
		"https://updates.example.test/metis?channel=beta",
		"https://updates.example.test/metis#notes",
		"https://",
		"not a URL",
	])("rejects an insecure or ambiguous base URL: %s", (value) => {
		expect(trustedBaseUrl(value)).toBeUndefined();
	});
});
