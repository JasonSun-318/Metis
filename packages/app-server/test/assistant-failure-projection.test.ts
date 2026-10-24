import { describe, expect, it } from "vitest";
import { projectLiveMessage, projectSessionEntry } from "../src/item-projection.ts";

const CREATED_AT = "2026-10-23T12:00:00.000Z";
const FAILURE_NOTICE = {
	type: "notice",
	level: "error",
	text: "The model provider could not complete the request. Try again or choose another configured model.",
} as const;

function projectHistory(
	message: Record<string, unknown>,
	turnState: "active" | "completed" | "interrupted" = "completed",
) {
	return projectSessionEntry({
		entry: { type: "message", id: "assistant-1", turnId: "turn-1", timestamp: CREATED_AT, message },
		sessionId: "session-1",
		turnStates: new Map([["turn-1", turnState]]),
		toolStates: new Map(),
		fallbackTimestamp: CREATED_AT,
	});
}

function projectLive(message: Record<string, unknown>, state: "streaming" | "completed" | "interrupted" = "completed") {
	return projectLiveMessage({
		itemId: "assistant-1",
		sessionId: "session-1",
		turnId: "turn-1",
		state,
		message: { ...message, timestamp: Date.parse(CREATED_AT) },
		fallbackTimestamp: CREATED_AT,
	});
}

describe("durable assistant failure visibility", () => {
	it.each(["503 Service unavailable", "https://private.example/api?token=secret-key", undefined])(
		"keeps empty provider failures in cold history without exposing diagnostics (%s)",
		(errorMessage) => {
			const item = projectHistory({ role: "assistant", content: [], stopReason: "error", errorMessage });

			expect(item).toMatchObject({
				role: "assistant",
				state: "interrupted",
				content: [FAILURE_NOTICE],
				createdAt: CREATED_AT,
				completedAt: CREATED_AT,
			});
			expect(JSON.stringify(item)).not.toContain("private.example");
			expect(JSON.stringify(item)).not.toContain("secret-key");
			expect(JSON.stringify(item)).not.toContain("503 Service unavailable");
		},
	);

	it.each(["completed", "interrupted"] as const)(
		"projects a live provider failure as interrupted rather than %s",
		(state) => {
			const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "503" };
			const item = projectLive(message, state);

			expect(item).toMatchObject({ state: "interrupted", content: [FAILURE_NOTICE], completedAt: CREATED_AT });
			expect(item).toEqual(projectHistory(message));
		},
	);

	it("does not publish a final failure notice from a provisional stream start", () => {
		const item = projectLive(
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "503" },
			"streaming",
		);
		expect(item).toMatchObject({ state: "streaming", content: [] });
	});

	it.each([{ content: [] }, { content: [{ type: "text", text: "Partial answer" }] }])(
		"keeps retry attempts without red notices in live and cold history",
		({ content }) => {
			const message = {
				role: "assistant",
				content,
				stopReason: "error",
				errorMessage: "private endpoint error",
				diagnostics: [{ type: "auto_retry_scheduled", timestamp: 1, details: { attempt: 1, maxAttempts: 5 } }],
			};
			for (const item of [projectHistory(message), projectLive(message)]) {
				expect(item).toMatchObject({ state: "interrupted", content });
				expect(JSON.stringify(item)).not.toContain("private endpoint");
				expect(JSON.stringify(item)).not.toContain("diagnostics");
			}
		},
	);

	it("preserves partial output with an explicit failure notice in both projections", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Partial answer" }],
			stopReason: "error",
			errorMessage: "provider rejected secret-key at https://private.example",
			usage: { output: 12 },
		};
		const item = projectHistory(message);

		expect(item).toMatchObject({
			state: "interrupted",
			content: [{ type: "text", text: "Partial answer" }, FAILURE_NOTICE],
			usage: { outputTokens: 12 },
		});
		expect(projectLive(message)).toEqual(item);
	});

	it("keeps a failed assistant message interrupted when its turn is still active", () => {
		const item = projectHistory({ role: "assistant", content: [], stopReason: "error" }, "active");

		expect(item).toMatchObject({ state: "interrupted", content: [FAILURE_NOTICE], completedAt: CREATED_AT });
	});

	it.each(["stop", "aborted", "toolUse", undefined])(
		"retains ordinary empty terminal-message filtering for %s",
		(stopReason) => {
			const message = { role: "assistant", content: [], stopReason };

			expect(projectHistory(message)).toBeUndefined();
			expect(projectLive(message)).toBeUndefined();
		},
	);

	it("does not label a human interruption as a model failure", () => {
		const message = { role: "assistant", content: [{ type: "text", text: "Partial answer" }], stopReason: "aborted" };

		expect(projectHistory(message, "interrupted")).toMatchObject({
			state: "interrupted",
			content: [{ type: "text", text: "Partial answer" }],
		});
		expect(projectLive(message, "interrupted")).toEqual(projectHistory(message, "interrupted"));
	});

	it("keeps ordinary empty streaming items available for later deltas", () => {
		expect(projectLive({ role: "assistant", content: [] }, "streaming")).toMatchObject({
			state: "streaming",
			content: [],
		});
	});
});
