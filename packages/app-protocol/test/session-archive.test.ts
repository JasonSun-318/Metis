import { describe, expect, it } from "vitest";
import { validateClientRequest } from "../src/index.ts";

function request(method: string, params: Record<string, unknown>) {
	return { jsonrpc: "2.0", id: "archive-test", method, params };
}

describe("conversation archive and rename requests", () => {
	it("bounds archive pages and accepts opaque continuation tokens", () => {
		for (const params of [{}, { limit: 1 }, { limit: 100, cursor: "opaque-token" }]) {
			expect(validateClientRequest(request("session/archived/list", params))).toBeDefined();
		}
		for (const params of [{ limit: 0 }, { limit: 101 }, { cursor: "" }, { cursor: 12 }]) {
			expect(() => validateClientRequest(request("session/archived/list", params))).toThrow();
		}
	});

	it("requires rename identity and enforces the child name contract", () => {
		const params = {
			sessionId: "11111111-1111-4111-8111-111111111111",
			agentId: "22222222-2222-4222-8222-222222222222",
			requestId: "33333333-3333-4333-8333-333333333333",
			name: "资料整理",
		};
		expect(validateClientRequest(request("agent/rename", params))).toBeDefined();
		for (const name of ["", "x".repeat(129), "😀".repeat(65), "line\nbreak", "hidden\u007f"]) {
			expect(() => validateClientRequest(request("agent/rename", { ...params, name }))).toThrow();
		}
		const { requestId: _requestId, ...missingRequestId } = params;
		expect(() => validateClientRequest(request("agent/rename", missingRequestId))).toThrow();
	});
});
