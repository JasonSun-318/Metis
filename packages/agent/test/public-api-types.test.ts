import type {
	BranchSummaryGenerationOptions as RootBranchSummaryGenerationOptions,
	GenerateBranchSummaryOptions as RootLegacyBranchSummaryOptions,
	generateBranchSummary as rootGenerateBranchSummary,
} from "@metis/agent-core";
import type {
	BranchSummaryGenerationOptions,
	GenerateBranchSummaryOptions,
	generateBranchSummary as harnessGenerateBranchSummary,
	SessionTreeEntry,
} from "@metis/agent-core/harness";
import type {
	BranchSummaryGenerationOptions as NodeBranchSummaryGenerationOptions,
	generateBranchSummary as nodeGenerateBranchSummary,
} from "@metis/agent-core/node";
import type { Api, Model, Models } from "@metis/ai";
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

// The root type check compiles these calls; the helper is never executed by Vitest.
function compileBranchSummaryCalls(
	models: Models,
	model: Model<Api>,
	signal: AbortSignal,
	entries: SessionTreeEntry[],
	rootGenerate: typeof rootGenerateBranchSummary,
	harnessGenerate: typeof harnessGenerateBranchSummary,
	nodeGenerate: typeof nodeGenerateBranchSummary,
) {
	const minimal: RootBranchSummaryGenerationOptions = { models, model, signal };
	const full: BranchSummaryGenerationOptions = {
		...minimal,
		customInstructions: "Focus on the regression.",
		replaceInstructions: false,
		reserveTokens: 4096,
	};
	const nodeOptions: NodeBranchSummaryGenerationOptions = minimal;
	void rootGenerate(entries, minimal);
	void harnessGenerate(entries, full);
	void nodeGenerate(entries, nodeOptions);

	interface ExtendedLegacyOptions extends GenerateBranchSummaryOptions {
		traceId: string;
	}
	const legacy: RootLegacyBranchSummaryOptions = { model, apiKey: "legacy-key", signal };
	const extended: ExtendedLegacyOptions = {
		...legacy,
		headers: { "x-metis-test": "legacy" },
		customInstructions: "Focus on the regression.",
		replaceInstructions: true,
		reserveTokens: 4096,
		traceId: "trace-1",
	};
	void rootGenerate(entries, { ...legacy, models });
	void harnessGenerate(entries, { ...extended, models });

	// @ts-expect-error The existing implementation requires models, even for legacy options.
	void rootGenerate(entries, legacy);
	// @ts-expect-error The harness entry also rejects legacy options without models.
	void harnessGenerate(entries, legacy);
	// @ts-expect-error Models remains mandatory in the public options type.
	const missingModels: BranchSummaryGenerationOptions = { model, signal };
	// @ts-expect-error Signal remains mandatory in the public options type.
	const missingSignal: RootBranchSummaryGenerationOptions = { models, model };
	// @ts-expect-error A model object is required.
	const invalidModel: BranchSummaryGenerationOptions = { models, model: "invalid", signal };
	// @ts-expect-error The token reserve must be numeric.
	void nodeGenerate(entries, { ...minimal, reserveTokens: "many" });
	void [missingModels, missingSignal, invalidModel];
}
void compileBranchSummaryCalls;

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

	it("exports callable branch summary options from every public entry", () => {
		expectTypeOf<BranchSummaryGenerationOptions>().toEqualTypeOf<
			Parameters<typeof harnessGenerateBranchSummary>[1]
		>();
		expectTypeOf<RootBranchSummaryGenerationOptions>().toEqualTypeOf<
			Parameters<typeof rootGenerateBranchSummary>[1]
		>();
		expectTypeOf<NodeBranchSummaryGenerationOptions>().toEqualTypeOf<
			Parameters<typeof nodeGenerateBranchSummary>[1]
		>();
		expectTypeOf<RootBranchSummaryGenerationOptions>().toEqualTypeOf<BranchSummaryGenerationOptions>();
		expectTypeOf<NodeBranchSummaryGenerationOptions>().toEqualTypeOf<BranchSummaryGenerationOptions>();
	});

	it("keeps required provider inputs and optional summary instructions", () => {
		expectTypeOf<BranchSummaryGenerationOptions["models"]>().toEqualTypeOf<Models>();
		expectTypeOf<BranchSummaryGenerationOptions["signal"]>().toEqualTypeOf<AbortSignal>();
		expectTypeOf<BranchSummaryGenerationOptions["customInstructions"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<BranchSummaryGenerationOptions["replaceInstructions"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<BranchSummaryGenerationOptions["reserveTokens"]>().toEqualTypeOf<number | undefined>();
	});

	it("retains the legacy branch summary interface", () => {
		expectTypeOf<RootLegacyBranchSummaryOptions>().toEqualTypeOf<GenerateBranchSummaryOptions>();
		expectTypeOf<GenerateBranchSummaryOptions["apiKey"]>().toEqualTypeOf<string>();
		expectTypeOf<GenerateBranchSummaryOptions["headers"]>().toEqualTypeOf<Record<string, string> | undefined>();
		expectTypeOf<GenerateBranchSummaryOptions["signal"]>().toEqualTypeOf<AbortSignal>();
	});
});
