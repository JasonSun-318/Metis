import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

describe("provider retry classification", () => {
	it.each(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "408 Request Timeout"])(
		"retries transient transport failures (%s)",
		(errorMessage) => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
		},
	);

	it.each([
		"401 Unauthorized: upstream 503",
		"403 Forbidden",
		"400 Invalid request: retry this request",
		"invalid_api_key",
		"503 billing_scope_unavailable",
		"429 insufficient_quota",
	])("does not retry permanent request or account failures (%s)", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});
	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it("matches Bun fetch socket drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
			),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});
