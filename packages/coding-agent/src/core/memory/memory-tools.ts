import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@metis/agent-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { permissionClaim, permissionDescriptor } from "../tool-permission-adapter.ts";
import { writeProjection } from "./memory-projection.ts";
import { looksLikeSecret } from "./memory-secrets.ts";
import type { MemoryStore } from "./memory-store.ts";
import {
	isManagedProjectionTopicFile,
	isSafeTopicFile,
	MAX_FACT_TEXT_CHARS,
	MAX_FACTS_PER_MUTATION,
	MAX_ORDINARY_TOPICS_PER_CONTEXT,
	MAX_RECONCILE_OPERATIONS,
	type MemoryFact,
	type MemoryScope,
	memoryFactFingerprint,
	memoryHealthError,
} from "./memory-types.ts";

/** @deprecated Use isSafeTopicFile; retained for extension compatibility. */
export const SAFE_MEMORY_FILE = /^(?!.*\.\.)[a-z0-9][a-z0-9._-]{0,119}\.md$/u;

const FactInputSchema = Type.Object(
	{
		text: Type.String({ minLength: 1, maxLength: MAX_FACT_TEXT_CHARS }),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		topicFile: Type.String({ minLength: 1, maxLength: 123 }),
	},
	{ additionalProperties: false },
);

export const CommitFactsParamsSchema = Type.Object(
	{ facts: Type.Array(FactInputSchema, { maxItems: MAX_FACTS_PER_MUTATION }) },
	{ additionalProperties: false },
);

const MergeEntrySchema = Type.Object(
	{
		ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }),
		survivorId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
const SupersedeEntrySchema = Type.Object(
	{ oldId: Type.String({ minLength: 1 }), newId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const MoveScopeEntrySchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
	},
	{ additionalProperties: false },
);

export const ReconcileFactsParamsSchema = Type.Object(
	{
		merge: Type.Optional(Type.Array(MergeEntrySchema)),
		supersede: Type.Optional(Type.Array(SupersedeEntrySchema)),
		deleteIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		add: Type.Optional(Type.Array(FactInputSchema, { maxItems: MAX_FACTS_PER_MUTATION })),
		moveScope: Type.Optional(Type.Array(MoveScopeEntrySchema)),
	},
	{ additionalProperties: false },
);

export type CommitFactsParams = Static<typeof CommitFactsParamsSchema>;
export type ReconcileFactsParams = Static<typeof ReconcileFactsParamsSchema>;

export interface MemoryToolContext {
	store: MemoryStore;
	agentDir: string;
	projectKey: string;
	sourceTurn: string | null;
	createdAt?: string;
	projectAfterWrite?: boolean;
	signal?: AbortSignal;
	embeddingKey?: string | null;
	embedTexts?: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>;
}

export interface CommitFactsDetails {
	ok: boolean;
	inserted: number;
	omittedSensitive: number;
	remappedTopicLimit: number;
	error?: string;
}
export interface ReconcileFactsDetails {
	ok: boolean;
	inserted: number;
	superseded: number;
	deleted: number;
	moved: number;
	remappedTopicLimit: number;
	error?: string;
}
export type ApplyReconcileFactsResult = ReconcileFactsDetails & { facts: MemoryFact[] };

function toolText(text: string, details: CommitFactsDetails | ReconcileFactsDetails): AgentToolResult<typeof details> {
	return { content: [{ type: "text", text }], details };
}

function recency(left: MemoryFact, right: MemoryFact): number {
	return (
		left.createdAt.localeCompare(right.createdAt) ||
		(left.sourceTurn ?? "").localeCompare(right.sourceTurn ?? "") ||
		left.id.localeCompare(right.id)
	);
}

export function isFactNewer(candidate: MemoryFact, baseline: MemoryFact): boolean {
	return recency(candidate, baseline) > 0;
}

function scopeColumns(scope: MemoryScope, ctx: MemoryToolContext) {
	return scope === "global" ? { cwdKey: null, mode: null } : { cwdKey: ctx.projectKey, mode: null };
}

function contextKey(scope: MemoryScope, cwdKey: string | null): string {
	return `${scope}\0${cwdKey ?? ""}`;
}

function isFactVisible(ctx: MemoryToolContext, fact: MemoryFact): boolean {
	return (
		(fact.scope === "global" && fact.cwdKey === null && fact.mode === null) ||
		(fact.scope === "project" && fact.cwdKey === ctx.projectKey && fact.mode === null)
	);
}

function normalizedInput(input: Static<typeof FactInputSchema>): Static<typeof FactInputSchema> {
	const text = input.text.trim();
	const topicFile = input.topicFile;
	if (!text || [...text].length > MAX_FACT_TEXT_CHARS || !isSafeTopicFile(topicFile)) {
		throw new Error("Invalid memory fact text or topicFile");
	}
	return { ...input, text, topicFile };
}

function allocateTopics(
	ctx: MemoryToolContext,
	inputs: Static<typeof FactInputSchema>[],
	known = currentTopicSets(ctx),
): { inputs: Static<typeof FactInputSchema>[]; remapped: number } {
	let remapped = 0;
	return {
		inputs: inputs.map((raw) => {
			const input = normalizedInput(raw);
			const columns = scopeColumns(input.scope, ctx);
			const topics = known.get(contextKey(input.scope, columns.cwdKey))!;
			if (topics.has(input.topicFile)) return input;
			if (topics.size < MAX_ORDINARY_TOPICS_PER_CONTEXT) {
				topics.add(input.topicFile);
				return input;
			}
			remapped++;
			return { ...input, topicFile: "overflow.md" };
		}),
		remapped,
	};
}

function currentTopicSets(ctx: MemoryToolContext, facts?: MemoryFact[]): Map<string, Set<string>> {
	const known = new Map<string, Set<string>>();
	for (const scope of ["global", "project"] as const) {
		const cwdKey = scope === "global" ? null : ctx.projectKey;
		const contextFacts =
			facts?.filter((fact) => fact.scope === scope && fact.cwdKey === cwdKey) ??
			ctx.store.listActiveFacts(scope, cwdKey, null);
		known.set(
			contextKey(scope, cwdKey),
			new Set(
				contextFacts
					.map((fact) => fact.topicFile)
					.filter((topic) => topic !== "overflow.md" && topic !== "legacy-overflow.md"),
			),
		);
	}
	return known;
}

function newFact(ctx: MemoryToolContext, input: Static<typeof FactInputSchema>): MemoryFact {
	const columns = scopeColumns(input.scope, ctx);
	return {
		id: randomUUID(),
		scope: input.scope,
		cwdKey: columns.cwdKey,
		mode: null,
		topicFile: input.topicFile,
		text: input.text,
		fingerprint: memoryFactFingerprint(input.text),
		status: "active",
		createdAt: ctx.createdAt ?? new Date().toISOString(),
		sourceTurn: ctx.sourceTurn,
		embedding: null,
		embeddingModel: null,
	};
}

export function applyCommitFacts(
	ctx: MemoryToolContext,
	params: unknown,
): CommitFactsDetails & { facts: MemoryFact[] } {
	if (!Value.Check(CommitFactsParamsSchema, params)) {
		return {
			ok: false,
			inserted: 0,
			omittedSensitive: 0,
			remappedTopicLimit: 0,
			facts: [],
			error: "Invalid commit_facts arguments",
		};
	}
	try {
		const safe = params.facts.filter((input) => !looksLikeSecret(input.text));
		const result = ctx.store.runInTransaction(() => {
			const { inputs, remapped } = allocateTopics(ctx, safe);
			const candidates = inputs.map((input) => newFact(ctx, input));
			const facts: MemoryFact[] = [];
			for (const fact of candidates) if (ctx.store.insertFact(fact)) facts.push(fact);
			return { facts, remapped };
		});
		return {
			ok: true,
			inserted: result.facts.length,
			omittedSensitive: params.facts.length - safe.length,
			remappedTopicLimit: result.remapped,
			facts: result.facts,
		};
	} catch (error) {
		return {
			ok: false,
			inserted: 0,
			omittedSensitive: 0,
			remappedTopicLimit: 0,
			facts: [],
			error: errorMessage(error),
		};
	}
}

function referencedFact(ctx: MemoryToolContext, id: string): MemoryFact {
	const fact = ctx.store.getFactById(id);
	if (!fact || !isFactVisible(ctx, fact)) throw new Error(`Unknown memory fact id ${id}`);
	if (!isManagedProjectionTopicFile(fact.topicFile)) throw new Error(`Memory fact ${id} has an unsafe topic`);
	return fact;
}

function assertUnique(values: string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate ids`);
}

export function applyReconcileFacts(ctx: MemoryToolContext, params: unknown): ApplyReconcileFactsResult {
	const empty = {
		ok: false as const,
		inserted: 0,
		superseded: 0,
		deleted: 0,
		moved: 0,
		remappedTopicLimit: 0,
		facts: [],
	};
	if (!Value.Check(ReconcileFactsParamsSchema, params))
		return { ...empty, error: "Invalid reconcile_facts arguments" };
	const operationCount =
		(params.merge?.length ?? 0) +
		(params.supersede?.length ?? 0) +
		(params.deleteIds?.length ?? 0) +
		(params.add?.length ?? 0) +
		(params.moveScope?.length ?? 0);
	if (operationCount > MAX_RECONCILE_OPERATIONS) return { ...empty, error: "Reconcile operation limit exceeded" };

	try {
		return ctx.store.runInTransaction(() => {
			if (params.add?.some((input) => looksLikeSecret(input.text)))
				throw new Error("Sensitive memory additions are not allowed during reconcile");
			const destructive = new Set<string>();
			const markDestructive = (id: string) => {
				if (destructive.has(id)) throw new Error(`Fact ${id} is used destructively more than once`);
				destructive.add(id);
			};
			const status = new Map<string, MemoryFact["status"]>();
			const moves = new Map<string, MemoryScope>();
			const movedFacts = new Map<string, MemoryFact>();
			let superseded = 0;
			let deleted = 0;

			for (const entry of params.supersede ?? []) {
				if (entry.oldId === entry.newId) throw new Error("Supersede ids must differ");
				const oldFact = referencedFact(ctx, entry.oldId);
				const newFact = referencedFact(ctx, entry.newId);
				if (oldFact.status !== "active" || newFact.status !== "active")
					throw new Error("Supersede requires active facts");
				if (contextKey(oldFact.scope, oldFact.cwdKey) !== contextKey(newFact.scope, newFact.cwdKey))
					throw new Error("Supersede facts must share one context");
				if (!isFactNewer(newFact, oldFact)) throw new Error("Rejected supersede: proposed fact is not newer");
				markDestructive(oldFact.id);
				status.set(oldFact.id, "superseded");
				superseded++;
			}

			for (const entry of params.merge ?? []) {
				assertUnique(entry.ids, "merge");
				const facts = entry.ids.map((id) => referencedFact(ctx, id));
				if (facts.some((fact) => fact.status !== "active")) throw new Error("Merge requires active facts");
				if (new Set(facts.map((fact) => contextKey(fact.scope, fact.cwdKey))).size !== 1)
					throw new Error("Merge facts must share one context");
				const newest = [...facts].sort(recency).at(-1)!;
				const survivor = entry.survivorId ? facts.find((fact) => fact.id === entry.survivorId) : newest;
				if (!survivor) throw new Error("Named survivor is not in merge ids");
				if (survivor.id !== newest.id) throw new Error("Merge survivor must be the newest fact");
				for (const fact of facts) {
					if (fact.id === survivor.id) continue;
					markDestructive(fact.id);
					status.set(fact.id, "superseded");
					superseded++;
				}
			}

			assertUnique(params.deleteIds ?? [], "deleteIds");
			for (const id of params.deleteIds ?? []) {
				const fact = referencedFact(ctx, id);
				if (fact.status !== "active" && fact.status !== "superseded")
					throw new Error("Delete requires active or superseded facts");
				markDestructive(id);
				status.set(id, "deleted");
				deleted++;
			}

			assertUnique(
				(params.moveScope ?? []).map((entry) => entry.id),
				"moveScope",
			);
			for (const entry of params.moveScope ?? []) {
				const fact = referencedFact(ctx, entry.id);
				if (fact.status !== "active") throw new Error("moveScope requires an active fact");
				markDestructive(entry.id);
				moves.set(entry.id, entry.scope);
				movedFacts.set(entry.id, fact);
			}

			const visible = [
				...ctx.store.listActiveFacts("global", null, null),
				...ctx.store.listActiveFacts("project", ctx.projectKey, null),
			];
			const stationary = visible.filter(
				(fact) => (status.get(fact.id) ?? fact.status) === "active" && !moves.has(fact.id),
			);
			const knownTopics = currentTopicSets(ctx, stationary);
			const moveTopics = new Map<string, string>();
			let remappedMoves = 0;
			for (const entry of params.moveScope ?? []) {
				const fact = movedFacts.get(entry.id)!;
				let topicFile = fact.topicFile;
				if (topicFile !== "overflow.md" && topicFile !== "legacy-overflow.md") {
					const columns = scopeColumns(entry.scope, ctx);
					const topics = knownTopics.get(contextKey(entry.scope, columns.cwdKey))!;
					if (!topics.has(topicFile)) {
						if (topics.size < MAX_ORDINARY_TOPICS_PER_CONTEXT) topics.add(topicFile);
						else {
							topicFile = "overflow.md";
							remappedMoves++;
						}
					}
				}
				moveTopics.set(entry.id, topicFile);
			}
			const allocated = allocateTopics(ctx, params.add ?? [], knownTopics);
			const additions = allocated.inputs.map((input) => newFact(ctx, input));
			const fingerprints = new Set<string>();
			for (const fact of [...visible, ...additions]) {
				if ((status.get(fact.id) ?? fact.status) !== "active") continue;
				const scope = moves.get(fact.id) ?? fact.scope;
				const cwdKey = scope === "global" ? null : ctx.projectKey;
				const key = `${contextKey(scope, cwdKey)}\0${fact.fingerprint ?? memoryFactFingerprint(fact.text)}`;
				if (fingerprints.has(key)) throw new Error("Reconcile would create an active fingerprint duplicate");
				fingerprints.add(key);
			}

			const inserted: MemoryFact[] = [];
			for (const [id, next] of status) ctx.store.updateFactStatus(id, next!);
			for (const id of moves.keys()) ctx.store.updateFactStatus(id, "superseded");
			for (const [id, scope] of moves) {
				const columns = scopeColumns(scope, ctx);
				ctx.store.updateFactScope(id, scope, columns.cwdKey, null);
				ctx.store.updateFactTopic(id, moveTopics.get(id)!);
			}
			for (const id of moves.keys()) ctx.store.updateFactStatus(id, "active");
			for (const fact of additions) {
				if (!ctx.store.insertFact(fact)) throw new Error("Reconcile insert conflicted");
				inserted.push(fact);
			}
			return {
				ok: true,
				inserted: inserted.length,
				superseded,
				deleted,
				moved: moves.size,
				remappedTopicLimit: remappedMoves + allocated.remapped,
				facts: inserted,
			};
		});
	} catch (error) {
		return { ...empty, error: errorMessage(error) };
	}
}

async function embedInsertedFacts(ctx: MemoryToolContext, facts: MemoryFact[], signal?: AbortSignal): Promise<void> {
	const embeddingKey = ctx.embeddingKey ?? null;
	if (!embeddingKey || facts.length === 0 || !ctx.embedTexts) return;
	const now = new Date().toISOString();
	try {
		signal?.throwIfAborted();
		const vectors = await ctx.embedTexts(
			facts.map((fact) => fact.text),
			signal,
		);
		signal?.throwIfAborted();
		if (vectors.length !== facts.length || vectors.some((vector) => vector.length === 0))
			throw new Error("Embedding batch size mismatch");
		ctx.store.runInTransaction(() => {
			for (let i = 0; i < facts.length; i++) ctx.store.updateFactEmbedding(facts[i]!.id, vectors[i]!, embeddingKey);
			ctx.store.recordHealth({ operation: "embedding", status: "ok", updatedAt: now, reason: null });
		});
	} catch (error) {
		ctx.store.recordHealth(memoryHealthError("embedding", error, [], now));
		if (signal?.aborted) throw error;
	}
}

async function maybeProject(ctx: MemoryToolContext): Promise<void> {
	if (ctx.projectAfterWrite === false) return;
	await writeProjection(ctx.agentDir, ctx.projectKey, ctx.store);
}

export function createCommitFactsTool(ctx: MemoryToolContext): ToolDefinition {
	return defineTool({
		name: "commit_facts",
		label: "Commit facts",
		description:
			"Submit durable memory facts to append. Call with an empty facts array when nothing should be stored.",
		parameters: CommitFactsParamsSchema,
		permission: permissionDescriptor(() => permissionClaim({ writePaths: [ctx.agentDir] })),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const executionSignal = signal ?? ctx.signal;
			executionSignal?.throwIfAborted();
			const applied = applyCommitFacts(ctx, params);
			const { facts, ...details } = applied;
			if (!details.ok) return toolText(details.error ?? "Invalid commit_facts arguments", details);
			await embedInsertedFacts(ctx, facts, executionSignal);
			executionSignal?.throwIfAborted();
			if (details.inserted > 0) await maybeProject(ctx);
			return toolText(`Committed ${details.inserted} fact(s)`, details);
		},
	});
}

export function createReconcileFactsTool(ctx: MemoryToolContext): ToolDefinition {
	return defineTool({
		name: "reconcile_facts",
		label: "Reconcile facts",
		description:
			"Reconcile durable memory: merge, supersede, delete, add, or moveScope. Recency is enforced in code.",
		parameters: ReconcileFactsParamsSchema,
		permission: permissionDescriptor(() => permissionClaim({ writePaths: [ctx.agentDir] })),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const executionSignal = signal ?? ctx.signal;
			executionSignal?.throwIfAborted();
			const applied = applyReconcileFacts(ctx, params);
			const { facts, ...details } = applied;
			if (!details.ok) return toolText(details.error ?? "Invalid reconcile_facts arguments", details);
			await embedInsertedFacts(ctx, facts, executionSignal);
			executionSignal?.throwIfAborted();
			if (details.inserted + details.superseded + details.deleted + details.moved > 0) await maybeProject(ctx);
			return toolText(
				`Reconciled: inserted=${details.inserted} superseded=${details.superseded} deleted=${details.deleted} moved=${details.moved}`,
				details,
			);
		},
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
