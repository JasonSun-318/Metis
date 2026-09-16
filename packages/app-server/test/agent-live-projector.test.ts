import type { DomainEvent } from "@metis/app-protocol";
import type { AgentVisibleActivity } from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import { AgentLiveProjector } from "../src/agent-live-projector.ts";
import { MAX_PROJECTED_VISIBLE_TEXT_BYTES } from "../src/item-projection.ts";

const CREATED_AT = "2026-08-06T00:00:00.000Z";

describe("AgentLiveProjector", () => {
	it("streams a bounded child item and drops the transient copy on completion", () => {
		const events: DomainEvent[] = [];
		const projector = new AgentLiveProjector("parent-session", (event) => events.push(event), CREATED_AT);
		const message: { role: string; content: unknown[]; timestamp: number } = {
			role: "assistant",
			content: [],
			timestamp: Date.parse(CREATED_AT),
		};

		projector.apply("child-session", "child-turn", {
			type: "message_start",
			message,
		} as unknown as AgentVisibleActivity);
		projector.apply("child-session", "child-turn", {
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "text_delta",
				delta: "x".repeat(MAX_PROJECTED_VISIBLE_TEXT_BYTES + 100),
			},
		} as unknown as AgentVisibleActivity);

		expect(projector.currentItems("child-session")[0]).toMatchObject({
			sessionId: "child-session",
			turnId: "child-turn",
			state: "streaming",
			content: [{ type: "text", text: "x".repeat(MAX_PROJECTED_VISIBLE_TEXT_BYTES) }],
		});
		expect(events.at(-1)).toMatchObject({
			type: "agent/item/delta",
			sessionId: "parent-session",
			agentId: "child-session",
			delta: { text: "x".repeat(MAX_PROJECTED_VISIBLE_TEXT_BYTES) },
		});

		message.content = [{ type: "text", text: "done" }];
		projector.apply("child-session", "child-turn", {
			type: "message_end",
			message,
		} as unknown as AgentVisibleActivity);

		expect(events.at(-1)).toMatchObject({
			type: "agent/item/completed",
			item: { sessionId: "child-session", state: "completed", content: [{ type: "text", text: "done" }] },
		});
		expect(projector.currentItems("child-session")).toEqual([]);
	});
});
