import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	AbortResult,
	AgentHarness,
	CompactResult,
	NavigateTreeResult,
	QueueUpdateEvent,
	Session,
	SessionContext,
	SessionContextBuildOptions,
} from "../src/harness.ts";
import type {
	Agent,
	AgentMessage,
	AgentQueueIdentity,
	AgentQueueReservation,
	AgentState,
	ReservedAgentQueueItem,
} from "../src/index.ts";

describe("agent public type contracts", () => {
	it("keeps root queue and lifecycle signatures", () => {
		expectTypeOf<Agent["steer"]>().toEqualTypeOf<(message: AgentMessage, identity?: AgentQueueIdentity) => void>();
		expectTypeOf<Agent["followUp"]>().toEqualTypeOf<(message: AgentMessage, identity?: AgentQueueIdentity) => void>();
		expectTypeOf<Agent["continue"]>().toEqualTypeOf<() => Promise<void>>();
		expectTypeOf<AgentState["pendingToolCalls"]>().toEqualTypeOf<ReadonlySet<string>>();
	});

	it("keeps harness result and queue event shapes", () => {
		expectTypeOf<AbortResult>().toEqualTypeOf<{
			clearedSteer: AgentMessage[];
			clearedFollowUp: AgentMessage[];
		}>();
		expectTypeOf<ReturnType<AgentHarness["compact"]>>().toEqualTypeOf<Promise<CompactResult>>();
		expectTypeOf<NavigateTreeResult["cancelled"]>().toEqualTypeOf<boolean>();
		expectTypeOf<QueueUpdateEvent["steer"]>().toEqualTypeOf<AgentMessage[]>();
		expectTypeOf<AgentQueueReservation["items"]>().toEqualTypeOf<readonly ReservedAgentQueueItem[]>();
	});

	it("keeps harness session contracts", () => {
		expectTypeOf<Session["buildContext"]>().toEqualTypeOf<
			(options?: SessionContextBuildOptions) => Promise<SessionContext>
		>();
		expectTypeOf<SessionContext>().toEqualTypeOf<{
			messages: AgentMessage[];
			thinkingLevel: string;
			model: { provider: string; modelId: string } | null;
			activeToolNames: string[] | null;
		}>();
	});

	it("rejects stale result fields", () => {
		// @ts-expect-error AbortResult has no cancelled field.
		const stale: AbortResult = { clearedSteer: [], clearedFollowUp: [], cancelled: true };
		expect(stale.clearedSteer).toEqual([]);
	});
});
