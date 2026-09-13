import { describe, expect, it } from "vitest";
import { classifyRuntimeFailure } from "../src/core/agent-session.ts";

describe("classifyRuntimeFailure", () => {
	it.each([
		["OpenAI API error (404): Not Found", "MODEL_ENDPOINT_NOT_FOUND"],
		["401 Unauthorized", "MODEL_AUTHENTICATION_FAILED"],
		["403 Forbidden", "MODEL_ACCESS_DENIED"],
		["429 Too Many Requests", "MODEL_RATE_LIMITED"],
		["Request timed out", "MODEL_TIMEOUT"],
		["socket disconnected", "MODEL_NETWORK_ERROR"],
		["provider returned malformed data", "MODEL_REQUEST_FAILED"],
	])("maps %s to %s", (message, code) => {
		expect(classifyRuntimeFailure(message).code).toBe(code);
	});

	it("keeps explicit user interruptions separate from provider errors", () => {
		expect(classifyRuntimeFailure("This operation was aborted", true).code).toBe("RUNTIME_INTERRUPTED");
	});
});
