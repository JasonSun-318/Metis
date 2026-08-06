import type { DomainEvent } from "@arcmind/app-protocol";
import type { SubagentVisibleActivity } from "@arcmind/coding-agent";
import { describe, expect, it } from "vitest";
import { MAX_PROJECTED_VISIBLE_TEXT_BYTES } from "../src/item-projection.ts";
import { SubagentLiveProjector } from "../src/subagent-live-projector.ts";

const CREATED_AT = "2026-08-06T00:00:00.000Z";

describe("SubagentLiveProjector", () => {
	it("streams a bounded child item and drops the transient copy on completion", () => {
		const events: DomainEvent[] = [];
		const projector = new SubagentLiveProjector("parent-session", (event) => events.push(event), CREATED_AT);
		const message: { role: string; content: unknown[]; timestamp: number } = {
			role: "assistant",
			content: [],
			timestamp: Date.parse(CREATED_AT),
		};

		projector.apply("child-session", "child-turn", {
			type: "message_start",
			message,
		} as unknown as SubagentVisibleActivity);
		projector.apply("child-session", "child-turn", {
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "text_delta",
				delta: "x".repeat(MAX_PROJECTED_VISIBLE_TEXT_BYTES + 100),
			},
		} as unknown as SubagentVisibleActivity);

		expect(projector.currentItems("child-session")[0]).toMatchObject({
			sessionId: "child-session",
			turnId: "child-turn",
			state: "streaming",
			content: [{ type: "text", text: "x".repeat(MAX_PROJECTED_VISIBLE_TEXT_BYTES) }],
		});
		expect(events.at(-1)).toMatchObject({
			type: "subagent/item/delta",
			sessionId: "parent-session",
			agentId: "child-session",
			delta: { text: "x".repeat(MAX_PROJECTED_VISIBLE_TEXT_BYTES) },
		});

		message.content = [{ type: "text", text: "done" }];
		projector.apply("child-session", "child-turn", {
			type: "message_end",
			message,
		} as unknown as SubagentVisibleActivity);

		expect(events.at(-1)).toMatchObject({
			type: "subagent/item/completed",
			item: { sessionId: "child-session", state: "completed", content: [{ type: "text", text: "done" }] },
		});
		expect(projector.currentItems("child-session")).toEqual([]);
	});
});
