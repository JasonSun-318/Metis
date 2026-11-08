import { describe, expect, it } from "vitest";
import { createAgentMailboxMessage, planAgentMailboxDelivery } from "../src/core/agent-mailbox.ts";
import type { AgentMailboxEvent } from "../src/core/subagents/types.ts";

function terminal(eventId: string, finalMessage?: string): AgentMailboxEvent {
	return {
		type: "terminal",
		eventId,
		taskId: "task-1",
		agentId: "agent-1",
		parentSessionId: "session-1",
		name: "worker",
		status: "done",
		...(finalMessage === undefined ? {} : { finalMessage }),
		completedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("agent mailbox", () => {
	it("builds a durable custom message for an event", () => {
		const event = terminal("event-1", "done");
		const message = createAgentMailboxMessage(event, 1234);
		expect(message.role).toBe("custom");
		expect(message.customType).toBe("agent_mailbox");
		expect(message.display).toBe(true);
		expect(message.details).toBe(event);
		expect(message.timestamp).toBe(1234);
		expect(message.content.length).toBeGreaterThan(0);
	});

	it("keeps queue order, de-duplicates ids and skips missing events", () => {
		const events = new Map([
			["a", terminal("a")],
			["b", terminal("b")],
		]);
		expect(planAgentMailboxDelivery(["b", "a", "b", "missing"], (id) => events.get(id))).toEqual(["b", "a"]);
	});

	it("caps a batch at eight events", () => {
		const events = new Map(Array.from({ length: 10 }, (_, index) => [`e${index}`, terminal(`e${index}`)]));
		expect(planAgentMailboxDelivery(events.keys(), (id) => events.get(id))).toHaveLength(8);
	});

	it("admits one oversized event, then stops before exceeding the byte budget", () => {
		const huge = terminal("huge", "x".repeat(40_000));
		const small = terminal("small", "y");
		expect(planAgentMailboxDelivery(["huge", "small"], (id) => (id === "huge" ? huge : small))).toEqual(["huge"]);
	});
});
