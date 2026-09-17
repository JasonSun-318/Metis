import type { AgentToolResult } from "@metis/agent-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { permissionClaim, permissionDescriptor } from "../tool-permission-adapter.ts";
import type { MemoryVault, WriteRequest, WriteResult } from "./vault.ts";
import type { MemorySearchIndex, SearchHit } from "./vault-search.ts";
import { CONFIDENCE_LEVELS, type MemoryActor, NOTE_TYPES, type NoteFrontmatter } from "./vault-types.ts";

export interface MemoryToolContext {
	vault: MemoryVault;
	search: MemorySearchIndex;
	actor: () => MemoryActor;
	recordUsage?: boolean;
}

const ScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);
const NoteTypeSchema = Type.Union(NOTE_TYPES.map((type) => Type.Literal(type)));
const PinnedBlockSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("feedback"),
	Type.Literal("project"),
	Type.Literal("active"),
]);

export const SearchParamsSchema = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 500 }),
		scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("all")])),
		type: Type.Optional(NoteTypeSchema),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
	},
	{ additionalProperties: false },
);

export const ReadParamsSchema = Type.Object(
	{
		slug: Type.String({ minLength: 1 }),
		scope: Type.Optional(ScopeSchema),
	},
	{ additionalProperties: false },
);

const WriteTargetSchema = Type.Union([
	Type.Object({ slug: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ block: PinnedBlockSchema }, { additionalProperties: false }),
]);

const WriteFrontmatterSchema = Type.Partial(
	Type.Object({
		name: Type.String({ minLength: 1 }),
		description: Type.String(),
		type: NoteTypeSchema,
		aliases: Type.Array(Type.String({ minLength: 1 })),
		confidence: Type.Union(CONFIDENCE_LEVELS.map((level) => Type.Literal(level))),
		applies_to: Type.Array(Type.String({ minLength: 1 })),
	}),
	{ additionalProperties: false },
);

export const WriteParamsSchema = Type.Object(
	{
		op: Type.Union([
			Type.Literal("create"),
			Type.Literal("append"),
			Type.Literal("replace"),
			Type.Literal("str_replace"),
			Type.Literal("rename"),
			Type.Literal("delete"),
		]),
		scope: ScopeSchema,
		target: WriteTargetSchema,
		newSlug: Type.Optional(Type.String({ minLength: 1 })),
		frontmatter: Type.Optional(WriteFrontmatterSchema),
		content: Type.Optional(Type.String()),
		oldText: Type.Optional(Type.String()),
		newText: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type MemorySearchParams = Static<typeof SearchParamsSchema>;
export type MemoryReadParams = Static<typeof ReadParamsSchema>;
export type MemoryWriteParams = Static<typeof WriteParamsSchema>;

export interface MemorySearchDetails {
	ok: boolean;
	hits: SearchHit[];
	error?: string;
}

export interface MemoryReadDetails {
	ok: boolean;
	scope?: string;
	slug?: string;
	frontmatter?: NoteFrontmatter;
	body?: string;
	links?: string[];
	backlinks?: string[];
	malformed?: boolean;
	error?: string;
}

function toolText<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

function formatHit(hit: SearchHit): string {
	return `- [${hit.scope}/${hit.type}] ${hit.slug} — ${hit.description || hit.name} (score ${hit.score.toFixed(2)}, updated ${hit.updated})`;
}

function createSearchTool(ctx: MemoryToolContext): ToolDefinition {
	return defineTool({
		name: "memory_search",
		label: "Memory search",
		description:
			"Search long-term memory notes by keyword. Use before tasks that may depend on prior work, user preferences, or project conventions.",
		promptSnippet: "Search long-term memory",
		parameters: SearchParamsSchema,
		permission: permissionDescriptor(() => permissionClaim()),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			if (!Value.Check(SearchParamsSchema, params)) {
				return toolText<MemorySearchDetails>("Invalid memory_search arguments", {
					ok: false,
					hits: [],
					error: "invalid arguments",
				});
			}
			const hits = ctx.search.search(params.query, {
				scope: params.scope ?? "all",
				type: params.type,
				limit: params.limit ?? 8,
				recordUsage: ctx.recordUsage,
			});
			const text =
				hits.length === 0
					? "No memory notes matched."
					: `Recalled memory: ${hits.length} note(s) matched:\n${hits.map(formatHit).join("\n")}`;
			return toolText<MemorySearchDetails>(text, { ok: true, hits });
		},
	});
}

function createReadTool(ctx: MemoryToolContext): ToolDefinition {
	return defineTool({
		name: "memory_read",
		label: "Memory read",
		description: "Read a memory note by slug, including its links and backlinks.",
		promptSnippet: "Read a memory note",
		parameters: ReadParamsSchema,
		permission: permissionDescriptor(() => permissionClaim()),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			if (!Value.Check(ReadParamsSchema, params)) {
				return toolText<MemoryReadDetails>("Invalid memory_read arguments", {
					ok: false,
					error: "invalid arguments",
				});
			}
			const scopes = params.scope ? [params.scope] : (["project", "global"] as const);
			for (const scope of scopes) {
				const note = ctx.vault.readNote(scope, params.slug);
				if (!note) continue;
				const details: MemoryReadDetails = {
					ok: true,
					scope: note.scope,
					slug: note.slug,
					frontmatter: note.frontmatter,
					body: note.body,
					links: note.links,
					backlinks: ctx.vault.backlinks(note.scope, note.slug),
					...(note.malformed ? { malformed: true } : {}),
				};
				const text = [
					`# ${note.frontmatter.name} (${note.scope}/${note.slug})`,
					`type: ${note.frontmatter.type} | updated: ${note.frontmatter.updated} | confidence: ${note.frontmatter.confidence}`,
					note.frontmatter.description,
					"",
					note.body,
				].join("\n");
				return toolText<MemoryReadDetails>(text, details);
			}
			throw new Error(`memory note "${params.slug}" not found`);
		},
	});
}

function createWriteTool(ctx: MemoryToolContext): ToolDefinition {
	return defineTool({
		name: "memory_write",
		label: "Memory write",
		description:
			"Create, update, rename, or delete a memory note or pinned block. Write immediately when the user corrects you or states a durable preference or project fact.",
		promptSnippet: "Write to long-term memory",
		parameters: WriteParamsSchema,
		permission: permissionDescriptor(() => permissionClaim({ writePaths: [ctx.vault.root] })),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (!Value.Check(WriteParamsSchema, params)) {
				return toolText<WriteResult>("Invalid memory_write arguments", {
					ok: false,
					error: "invalid arguments",
				});
			}
			const result = await ctx.vault.write(params as WriteRequest, ctx.actor());
			if (!result.ok) return toolText<WriteResult>(`memory_write failed: ${result.error}`, result);
			const target =
				"slug" in result.target ? `note "${result.target.slug}"` : `pinned block "${result.target.block}"`;
			const warning = result.warning ? ` Warning: ${result.warning}.` : "";
			return toolText<WriteResult>(`Saved memory: ${target} (${params.op}).${warning}`, result);
		},
	});
}

export function createMemoryToolDefinitions(ctx: MemoryToolContext): ToolDefinition[] {
	return [createSearchTool(ctx), createReadTool(ctx), createWriteTool(ctx)];
}

/** Builtin memory tool names. Children never receive them (`includeAutoMemory: false`). */
export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(["memory_search", "memory_read", "memory_write"]);
