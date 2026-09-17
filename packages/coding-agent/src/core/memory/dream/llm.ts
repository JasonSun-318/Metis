import type { AgentTool, StreamFn } from "@metis/agent-core";
import { Agent } from "@metis/agent-core";
import type { Api, Model } from "@metis/ai";
import type { ModelRegistry } from "../../model-registry.ts";
import type { DreamPromptFn, DreamPromptRequest } from "./phase1.ts";
import type { DreamPhase2Context, DreamPromptAgent } from "./phase2.ts";
import type { DreamModelRef } from "./types.ts";

/** Default cap on agent turns inside one phase-2 consolidation run. */
export const DREAM_MAX_TURNS = 30;

/**
 * Resolve the model a dream run should use: an explicit `memory.dream.model`
 * override wins (still requires credentials); otherwise pick the credentialed
 * model with the lowest `cost.input`. Returns undefined when nothing is usable.
 */
export function resolveDreamModel(
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
	override?: DreamModelRef | null,
): Model<Api> | undefined {
	const available = registry.getAvailable();
	if (override) {
		return available.find((model) => model.provider === override.provider && model.id === override.modelId);
	}
	let cheapest: Model<Api> | undefined;
	for (const model of available) {
		const input = model.cost?.input ?? Number.POSITIVE_INFINITY;
		const best = cheapest ? (cheapest.cost?.input ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
		if (input < best || (input === best && cheapest !== undefined && model.id < cheapest.id)) {
			cheapest = model;
		}
	}
	return cheapest;
}

export interface DreamLlmDeps {
	model: Model<Api>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Independent session id for cache-aware providers, e.g. `dream-<runId>`. */
	sessionId?: string;
}

/**
 * Every dream LLM call goes through this wrapper: prompt caching is disabled
 * (`cacheRetention: "none"`) because dream prompts are one-off and must not
 * evict the interactive session's cache.
 */
function dreamStreamFn(deps: DreamLlmDeps, extra?: Partial<Parameters<StreamFn>[2]>): StreamFn {
	return (model, context, options) => deps.streamFn(model, context, { ...options, ...extra, cacheRetention: "none" });
}

/**
 * Production phase-1 promptFn: runs a one-shot Agent whose only tool is the
 * `propose_memories` definition from the request, forced via toolChoice.
 * Returns the captured tool arguments; throws when the model errored.
 */
export function createDreamPromptFn(deps: DreamLlmDeps): DreamPromptFn {
	return async (prompt: DreamPromptRequest) => {
		let captured: unknown;
		const captureTool: AgentTool = {
			name: prompt.tool.name,
			label: prompt.tool.name,
			description: prompt.tool.description,
			parameters: prompt.tool.parameters,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				captured = params;
				return {
					content: [{ type: "text", text: "Candidates recorded." }],
					details: { ok: true },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { systemPrompt: prompt.system, tools: [captureTool], model: deps.model },
			streamFn: dreamStreamFn(deps, { toolChoice: prompt.toolChoice }),
			...(deps.getApiKey ? { getApiKey: deps.getApiKey } : {}),
			...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
		});
		const onAbort = () => agent.abort();
		prompt.signal?.addEventListener("abort", onAbort);
		try {
			await agent.prompt(prompt.user);
		} finally {
			prompt.signal?.removeEventListener("abort", onAbort);
		}
		if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
		return captured;
	};
}

/**
 * Production phase-2 promptAgent: a real Agent registered with the DreamToolset's
 * tools. Aborts on the phase signal or after `maxTurns` completed turns.
 */
export function createDreamPromptAgent(deps: DreamLlmDeps & { maxTurns?: number }): DreamPromptAgent {
	// Caller overrides may only tighten the cap, never raise it.
	const requestedTurns = deps.maxTurns ?? DREAM_MAX_TURNS;
	const maxTurns = Number.isFinite(requestedTurns)
		? Math.min(DREAM_MAX_TURNS, Math.max(1, Math.trunc(requestedTurns)))
		: DREAM_MAX_TURNS;
	return async (ctx: DreamPhase2Context) => {
		const agent = new Agent({
			initialState: { systemPrompt: ctx.system, tools: ctx.tools, model: deps.model },
			streamFn: dreamStreamFn(deps),
			...(deps.getApiKey ? { getApiKey: deps.getApiKey } : {}),
			...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
		});
		let turns = 0;
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "turn_end" && ++turns >= maxTurns) agent.abort();
		});
		const onAbort = () => agent.abort();
		ctx.signal.addEventListener("abort", onAbort);
		try {
			await agent.prompt(ctx.user);
		} finally {
			unsubscribe();
			ctx.signal.removeEventListener("abort", onAbort);
		}
		if (agent.state.errorMessage && !ctx.signal.aborted) throw new Error(agent.state.errorMessage);
	};
}
