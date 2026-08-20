import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@metis/agent-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentMode } from "../agent-mode.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { writeProjection } from "./memory-projection.ts";
import { looksLikeSecret } from "./memory-secrets.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { MemoryFact, MemoryScope } from "./memory-types.ts";

/** Same basename rule as ingest / projection — flat `.md` only, no traversal. */
export const SAFE_MEMORY_FILE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/;

const FactInputSchema = Type.Object(
	{
		text: Type.String({ minLength: 1 }),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		/** Required for insert; omitted/invalid basenames are dropped (no auto-slug). */
		topicFile: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const CommitFactsParamsSchema = Type.Object(
	{
		facts: Type.Array(FactInputSchema),
	},
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
	{
		oldId: Type.String({ minLength: 1 }),
		newId: Type.String({ minLength: 1 }),
	},
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
		add: Type.Optional(Type.Array(FactInputSchema)),
		moveScope: Type.Optional(Type.Array(MoveScopeEntrySchema)),
	},
	{ additionalProperties: false },
);

export type CommitFactsParams = Static<typeof CommitFactsParamsSchema>;
export type ReconcileFactsParams = Static<typeof ReconcileFactsParamsSchema>;

export interface MemoryToolContext {
	store: MemoryStore;
	agentDir: string;
	cwd: string;
	agentMode: AgentMode;
	/** Encoded project cwd key used for project-scoped inserts. */
	cwdKey: string;
	/** Mode column for project-scoped inserts (usually AgentMode). */
	mode: string;
	sourceTurn: string | null;
	createdAt?: string;
	/** When false, skip markdown projection after a successful write. Default true. */
	projectAfterWrite?: boolean;
	/** Current embedding model id (`provider/model`); used when embedText succeeds. */
	embeddingModel?: string | null;
	/** Best-effort embedder; failures leave embedding NULL. */
	embedText?: (text: string) => Promise<Float32Array | null>;
}

export interface CommitFactsDetails {
	ok: boolean;
	inserted: number;
	error?: string;
}

export interface ReconcileFactsDetails {
	ok: boolean;
	inserted: number;
	superseded: number;
	deleted: number;
	moved: number;
	error?: string;
}

export type ApplyReconcileFactsResult = ReconcileFactsDetails & { facts: MemoryFact[] };

function toolText(text: string, details: CommitFactsDetails | ReconcileFactsDetails): AgentToolResult<typeof details> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function createdAtNow(ctx: MemoryToolContext): string {
	return ctx.createdAt ?? new Date().toISOString();
}

function isSafeTopicFile(topicFile: string): boolean {
	return SAFE_MEMORY_FILE.test(topicFile);
}

/** True when `candidate` is strictly newer than `baseline` by createdAt, then sourceTurn. */
export function isFactNewer(candidate: MemoryFact, baseline: MemoryFact): boolean {
	const byCreated = candidate.createdAt.localeCompare(baseline.createdAt);
	if (byCreated !== 0) return byCreated > 0;
	const left = candidate.sourceTurn ?? "";
	const right = baseline.sourceTurn ?? "";
	return left.localeCompare(right) > 0;
}

function scopeColumns(scope: MemoryScope, ctx: MemoryToolContext): { cwdKey: string | null; mode: string | null } {
	if (scope === "global") return { cwdKey: null, mode: null };
	return { cwdKey: ctx.cwdKey, mode: ctx.mode };
}

function maybeProject(ctx: MemoryToolContext): void {
	if (ctx.projectAfterWrite === false) return;
	writeProjection(ctx.agentDir, ctx.cwd, ctx.agentMode, ctx.store);
}

function insertFactInputs(ctx: MemoryToolContext, inputs: Static<typeof FactInputSchema>[]): MemoryFact[] {
	const inserted: MemoryFact[] = [];
	for (const input of inputs) {
		if (typeof input.topicFile !== "string" || !isSafeTopicFile(input.topicFile)) continue;
		if (looksLikeSecret(input.text)) continue;
		const columns = scopeColumns(input.scope, ctx);
		const fact: MemoryFact = {
			id: randomUUID(),
			scope: input.scope,
			cwdKey: columns.cwdKey,
			mode: columns.mode,
			topicFile: input.topicFile,
			text: input.text,
			status: "active",
			createdAt: createdAtNow(ctx),
			sourceTurn: ctx.sourceTurn,
			embedding: null,
			embeddingModel: null,
		};
		ctx.store.insertFact(fact);
		inserted.push(fact);
	}
	return inserted;
}

async function embedInsertedFacts(ctx: MemoryToolContext, facts: MemoryFact[]): Promise<void> {
	if (!ctx.embedText || !ctx.embeddingModel || facts.length === 0) return;
	for (const fact of facts) {
		try {
			const embedding = await ctx.embedText(fact.text);
			if (embedding) {
				ctx.store.updateFactEmbedding(fact.id, embedding, ctx.embeddingModel);
			}
		} catch {
			// Keep the row with embedding NULL; keyword search / backfill can recover later.
		}
	}
}

export function applyCommitFacts(
	ctx: MemoryToolContext,
	params: unknown,
): CommitFactsDetails & { facts: MemoryFact[] } {
	if (!Value.Check(CommitFactsParamsSchema, params)) {
		return { ok: false, inserted: 0, facts: [], error: "Invalid commit_facts arguments" };
	}
	const facts = insertFactInputs(ctx, params.facts);
	return { ok: true, inserted: facts.length, facts };
}

export function applyReconcileFacts(ctx: MemoryToolContext, params: unknown): ApplyReconcileFactsResult {
	if (!Value.Check(ReconcileFactsParamsSchema, params)) {
		return {
			ok: false,
			inserted: 0,
			superseded: 0,
			deleted: 0,
			moved: 0,
			facts: [],
			error: "Invalid reconcile_facts arguments",
		};
	}

	let inserted = 0;
	let superseded = 0;
	let deleted = 0;
	let moved = 0;
	const rejectReasons: string[] = [];
	let addedFacts: MemoryFact[] = [];

	try {
		ctx.store.runInTransaction(() => {
			for (const entry of params.supersede ?? []) {
				const oldFact = ctx.store.getFactById(entry.oldId);
				const newFact = ctx.store.getFactById(entry.newId);
				if (!oldFact || !newFact) {
					rejectReasons.push(`Unknown supersede ids ${entry.oldId}/${entry.newId}`);
					continue;
				}
				if (!isFactNewer(newFact, oldFact)) {
					rejectReasons.push(
						`Rejected supersede ${entry.oldId}→${entry.newId}: new fact is not newer by createdAt/sourceTurn`,
					);
					continue;
				}
				if (oldFact.status === "active") {
					ctx.store.updateFactStatus(entry.oldId, "superseded");
					superseded++;
				}
			}

			for (const entry of params.merge ?? []) {
				const facts = entry.ids
					.map((id) => ctx.store.getFactById(id))
					.filter((fact): fact is MemoryFact => fact !== null);
				if (facts.length < 2) {
					rejectReasons.push(`Merge requires at least two known ids`);
					continue;
				}
				let survivor: MemoryFact | undefined;
				if (entry.survivorId) {
					survivor = facts.find((fact) => fact.id === entry.survivorId);
					if (!survivor) {
						rejectReasons.push(`Named survivor ${entry.survivorId} not in merge ids`);
						continue;
					}
				} else {
					survivor = facts[0]!;
					for (let i = 1; i < facts.length; i++) {
						const candidate = facts[i]!;
						if (isFactNewer(candidate, survivor)) survivor = candidate;
					}
				}
				for (const fact of facts) {
					if (fact.id === survivor.id) continue;
					if (fact.status === "active") {
						ctx.store.updateFactStatus(fact.id, "superseded");
						superseded++;
					}
				}
			}

			for (const id of params.deleteIds ?? []) {
				const fact = ctx.store.getFactById(id);
				if (!fact) {
					rejectReasons.push(`Unknown delete id ${id}`);
					continue;
				}
				ctx.store.deleteFact(id);
				deleted++;
			}

			for (const entry of params.moveScope ?? []) {
				const fact = ctx.store.getFactById(entry.id);
				if (!fact) {
					rejectReasons.push(`Unknown moveScope id ${entry.id}`);
					continue;
				}
				const columns = scopeColumns(entry.scope, ctx);
				ctx.store.updateFactScope(entry.id, entry.scope, columns.cwdKey, columns.mode);
				moved++;
			}

			if (params.add?.length) {
				addedFacts = insertFactInputs(ctx, params.add);
				inserted = addedFacts.length;
			}

			if (rejectReasons.length > 0 && superseded === 0 && deleted === 0 && moved === 0 && inserted === 0) {
				throw new Error(rejectReasons[0]!);
			}
		});
	} catch (error) {
		return {
			ok: false,
			inserted: 0,
			superseded: 0,
			deleted: 0,
			moved: 0,
			facts: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}

	return { ok: true, inserted, superseded, deleted, moved, facts: addedFacts };
}

export function createCommitFactsTool(ctx: MemoryToolContext): ToolDefinition {
	return defineTool({
		name: "commit_facts",
		label: "Commit facts",
		description:
			"Submit durable memory facts to append. Call with an empty facts array when nothing should be stored.",
		parameters: CommitFactsParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const applied = applyCommitFacts(ctx, params);
			const details: CommitFactsDetails = {
				ok: applied.ok,
				inserted: applied.inserted,
				...(applied.error ? { error: applied.error } : {}),
			};
			if (!applied.ok) {
				return toolText(applied.error ?? "Invalid commit_facts arguments", details);
			}
			await embedInsertedFacts(ctx, applied.facts);
			if (applied.inserted > 0) maybeProject(ctx);
			return toolText(`Committed ${applied.inserted} fact(s)`, details);
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
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const applied = applyReconcileFacts(ctx, params);
			const details: ReconcileFactsDetails = {
				ok: applied.ok,
				inserted: applied.inserted,
				superseded: applied.superseded,
				deleted: applied.deleted,
				moved: applied.moved,
				...(applied.error ? { error: applied.error } : {}),
			};
			if (!applied.ok) {
				return toolText(applied.error ?? "Invalid reconcile_facts arguments", details);
			}
			await embedInsertedFacts(ctx, applied.facts);
			const changed = applied.inserted + applied.superseded + applied.deleted + applied.moved;
			if (changed > 0) maybeProject(ctx);
			return toolText(
				`Reconciled: inserted=${applied.inserted} superseded=${applied.superseded} deleted=${applied.deleted} moved=${applied.moved}`,
				details,
			);
		},
	});
}
