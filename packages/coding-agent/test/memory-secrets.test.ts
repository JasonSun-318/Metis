import { describe, expect, it } from "vitest";
import { looksLikeSecret } from "../src/core/memory/memory-secrets.ts";

describe("looksLikeSecret", () => {
	it("flags OpenAI-style sk- keys and leaves normal prose alone", () => {
		expect(looksLikeSecret("sk-abc...")).toBe(true);
		expect(looksLikeSecret("User prefers Chinese")).toBe(false);
	});

	it("flags AWS access keys, PEM headers, api_key assignments, and .env lines", () => {
		expect(looksLikeSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
		expect(looksLikeSecret("-----BEGIN PRIVATE KEY-----\nMIIE")).toBe(true);
		expect(looksLikeSecret("api_key=sk-live-1234567890")).toBe(true);
		expect(looksLikeSecret("DATABASE_URL=postgres://user:pass@localhost/db")).toBe(true);
		expect(looksLikeSecret("OPENAI_API_KEY=secret-value")).toBe(true);
	});
});
