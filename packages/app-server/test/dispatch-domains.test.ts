import { ClientRequestMethods, type ClientRpcRequest } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { dispatchAgentTypeRequest, isAgentTypeRequest } from "../src/dispatch/agent-types.ts";
import { dispatchHooksRequest, isHooksRequest } from "../src/dispatch/hooks.ts";
import { dispatchPersonalizationRequest, isPersonalizationRequest } from "../src/dispatch/personalization.ts";
import { dispatchPlanRequest, isPlanRequest } from "../src/dispatch/plan.ts";
import { dispatchProfileRequest, isProfileRequest } from "../src/dispatch/profile.ts";
import { dispatchSkillsRequest, isSkillsRequest } from "../src/dispatch/skills.ts";
import { dispatchWebSearchRequest, isWebSearchRequest } from "../src/dispatch/web-search.ts";
import type { HooksService } from "../src/hooks.ts";
import type { PersonalizationService } from "../src/personalization.ts";
import type { ProfileSummaryCache } from "../src/profile-summary.ts";
import type { SessionRegistry } from "../src/session-registry.ts";
import type { SessionRef } from "../src/session-runtime-host.ts";
import type { WebSearchService } from "../src/web-search.ts";

function request(method: string, params: unknown = {}): ClientRpcRequest {
	return { jsonrpc: "2.0", id: "req-1", method, params } as ClientRpcRequest;
}

function replayTracker() {
	const mutations: string[] = [];
	return {
		mutations,
		replayMutation: async (replayRequest: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown> => {
			mutations.push(replayRequest.method);
			return await run();
		},
	};
}

function profileContext() {
	const refs = [{ summary: { sessionId: "s1" } }] as unknown as SessionRef[];
	const profileSummary = {
		summarize: vi.fn(() => ({ sessions: refs.length })),
		usage: vi.fn(() => ({ sessions: refs.length })),
	} as unknown as ProfileSummaryCache;
	return { refs, profileSummary, context: { profileSummary, allSessionRefs: () => refs } };
}

function personalizationContext() {
	const personalization = {
		view: vi.fn(() => ({ language: "zh" })),
		update: vi.fn(async (input: unknown) => input),
	} as unknown as PersonalizationService;
	return { personalization, context: { personalization, ...replayTracker() } };
}

function hooksContext() {
	const hooks = {
		view: vi.fn(() => ({ hooks: [] })),
		upsert: vi.fn(async (input: unknown) => input),
		delete: vi.fn(async (input: unknown) => input),
	} as unknown as HooksService;
	return { hooks, context: { hooks, ...replayTracker() } };
}

function webSearchContext() {
	const webSearch = {
		view: vi.fn(() => ({ provider: "brave" })),
		reveal: vi.fn((input: unknown) => input),
		update: vi.fn(async (input: unknown) => input),
	} as unknown as WebSearchService;
	const refreshOpenWebSearchSettings = vi.fn(async () => undefined);
	return {
		webSearch,
		refreshOpenWebSearchSettings,
		context: { webSearch, ...replayTracker(), refreshOpenWebSearchSettings },
	};
}

function agentTypeContext() {
	const registry = {
		listAgentTypes: vi.fn(async () => ({ agentTypes: [] })),
		upsertAgentType: vi.fn(async (input: unknown) => input),
		removeAgentType: vi.fn(async (input: unknown) => input),
	} as unknown as SessionRegistry;
	return { registry, context: { registry, ...replayTracker() } };
}

function skillsContext() {
	const runtime = { listSkills: vi.fn(async () => ({ skills: [] })) };
	const ref = { summary: { sessionId: "s1" } } as unknown as SessionRef;
	const registry = {
		run: vi.fn(async (_ref: SessionRef, run: (runtime: unknown) => Promise<unknown>) => await run(runtime)),
		listDraftSkills: vi.fn(async () => ({ skills: [] })),
		getDraftSkill: vi.fn(async (input: unknown) => input),
		upsertDraftSkill: vi.fn(async (input: unknown) => input),
		removeDraftSkill: vi.fn(async (input: unknown) => input),
		inspectDraftSkillImport: vi.fn(async (input: unknown) => input),
		importDraftSkills: vi.fn(async (input: unknown) => input),
	} as unknown as SessionRegistry;
	return { runtime, registry, context: { registry, runtimeRef: () => ref, ...replayTracker() } };
}

function planContext() {
	const runtime = {
		startPlanExecution: vi.fn(async (input: unknown) => input),
		cancelPlan: vi.fn(async (input: unknown) => input),
	};
	const ref = { summary: { sessionId: "s1" } } as unknown as SessionRef;
	const registry = {
		run: vi.fn(async (_ref: SessionRef, run: (runtime: unknown) => Promise<unknown>) => await run(runtime)),
	} as unknown as SessionRegistry;
	return { runtime, registry, context: { registry, runtimeRef: () => ref, ...replayTracker() } };
}

const DOMAINS = [
	{
		owns: (method: string) => method.startsWith("profile/") || method.startsWith("usage/"),
		recognized: isProfileRequest,
		dispatch: dispatchProfileRequest,
		context: profileContext,
	},
	{
		owns: (method: string) => method.startsWith("personalization/"),
		recognized: isPersonalizationRequest,
		dispatch: dispatchPersonalizationRequest,
		context: personalizationContext,
	},
	{
		owns: (method: string) => method.startsWith("hooks/"),
		recognized: isHooksRequest,
		dispatch: dispatchHooksRequest,
		context: hooksContext,
	},
	{
		owns: (method: string) => method.startsWith("webSearch/"),
		recognized: isWebSearchRequest,
		dispatch: dispatchWebSearchRequest,
		context: webSearchContext,
	},
	{
		owns: (method: string) => method.startsWith("agentType/"),
		recognized: isAgentTypeRequest,
		dispatch: dispatchAgentTypeRequest,
		context: agentTypeContext,
	},
	{
		owns: (method: string) => method.startsWith("skill/"),
		recognized: isSkillsRequest,
		dispatch: dispatchSkillsRequest,
		context: skillsContext,
	},
	{
		owns: (method: string) => method.startsWith("plan/"),
		recognized: isPlanRequest,
		dispatch: dispatchPlanRequest,
		context: planContext,
	},
] as const;

describe("dispatcher domain matrix", () => {
	it("every extracted prefix recognizes exactly the protocol methods it owns", () => {
		const methods = Object.keys(ClientRequestMethods);
		for (const domain of DOMAINS) {
			const owned = methods.filter((method) => domain.owns(method));
			expect(owned.length).toBeGreaterThan(0);
			for (const method of methods) {
				expect(domain.recognized(request(method))).toBe(domain.owns(method));
			}
		}
	});

	it("every protocol method in an extracted domain is handled by its module", async () => {
		for (const domain of DOMAINS) {
			const built = domain.context();
			for (const method of Object.keys(ClientRequestMethods)) {
				if (!domain.owns(method)) continue;
				await expect(domain.dispatch(request(method), built.context as never)).resolves.not.toThrow();
			}
		}
	});

	it("delegates profile and usage requests with the session refs", async () => {
		const { refs, profileSummary, context } = profileContext();
		await expect(dispatchProfileRequest(request("profile/get"), context)).resolves.toEqual({ sessions: 1 });
		await expect(dispatchProfileRequest(request("usage/get", { rangeDays: 7 }), context)).resolves.toEqual({
			sessions: 1,
		});
		expect(profileSummary.summarize).toHaveBeenCalledWith(refs);
		expect(profileSummary.usage).toHaveBeenCalledWith(refs, 7);
	});

	it("routes personalization, hooks and web search mutations through replay", async () => {
		const personalization = personalizationContext();
		await dispatchPersonalizationRequest(
			request("personalization/update", { language: "en" }),
			personalization.context,
		);
		expect(personalization.personalization.update).toHaveBeenCalledWith({ language: "en" });
		expect(personalization.context.mutations).toEqual(["personalization/update"]);

		const hooks = hooksContext();
		await dispatchHooksRequest(request("hooks/upsert", { name: "lint" }), hooks.context);
		await dispatchHooksRequest(request("hooks/delete", { name: "lint" }), hooks.context);
		expect(hooks.context.mutations).toEqual(["hooks/upsert", "hooks/delete"]);

		const webSearch = webSearchContext();
		await dispatchWebSearchRequest(request("webSearch/update", { provider: "tavily" }), webSearch.context);
		expect(webSearch.webSearch.update).toHaveBeenCalledWith({ provider: "tavily" });
		expect(webSearch.refreshOpenWebSearchSettings).toHaveBeenCalledOnce();
		expect(webSearch.context.mutations).toEqual(["webSearch/update"]);
	});

	it("routes skill reads by scope and skill mutations through replay", async () => {
		const skills = skillsContext();
		await dispatchSkillsRequest(request("skill/list", { cwd: "/work" }), skills.context);
		await dispatchSkillsRequest(request("skill/list", { sessionId: "s1" }), skills.context);
		await dispatchSkillsRequest(request("skill/upsert", { name: "lint" }), skills.context);
		await dispatchSkillsRequest(request("skill/import", { source: "git" }), skills.context);
		expect(skills.registry.listDraftSkills).toHaveBeenCalledWith("/work");
		expect(skills.runtime.listSkills).toHaveBeenCalledOnce();
		expect(skills.context.mutations).toEqual(["skill/upsert", "skill/import"]);
	});

	it("runs plan mutations through replay and the session runtime", async () => {
		const plan = planContext();
		await dispatchPlanRequest(request("plan/startExecution", { sessionId: "s1" }), plan.context);
		await dispatchPlanRequest(request("plan/cancel", { sessionId: "s1" }), plan.context);
		expect(plan.runtime.startPlanExecution).toHaveBeenCalledOnce();
		expect(plan.runtime.cancelPlan).toHaveBeenCalledOnce();
		expect(plan.context.mutations).toEqual(["plan/startExecution", "plan/cancel"]);
	});

	it("keeps agent-type mutations replay-routed and reads direct", async () => {
		const agentTypes = agentTypeContext();
		await dispatchAgentTypeRequest(request("agentType/list"), agentTypes.context);
		await dispatchAgentTypeRequest(request("agentType/upsert", { id: "a" }), agentTypes.context);
		await dispatchAgentTypeRequest(request("agentType/remove", { id: "a" }), agentTypes.context);
		expect(agentTypes.context.mutations).toEqual(["agentType/upsert", "agentType/remove"]);
		expect(agentTypes.registry.listAgentTypes).toHaveBeenCalledOnce();
	});
});
