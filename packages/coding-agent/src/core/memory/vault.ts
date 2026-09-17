import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import {
	createFileAtomicallySync,
	ensureRealDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
} from "../durable-file.ts";
import { withMemoryRootLock } from "./memory-lock.ts";
import { looksLikeSecret } from "./memory-secrets.ts";
import { MemoryEvents } from "./vault-events.ts";
import { applyVaultFileChanges, type VaultFileChange } from "./vault-file-changes.ts";
import {
	appendChangelog,
	type ChangelogEntry,
	type ChangelogOp,
	readChangelog,
	readSnapshot,
	saveSnapshot,
	serializeUndoCommit,
} from "./vault-history.ts";
import { isSafeProjectKey } from "./vault-identity.ts";
import {
	getChangelogPath,
	getDreamDir,
	getHistoryDir,
	getIndexPath,
	getNotePath,
	getNotesDir,
	getPinnedDir,
	getPinnedPath,
	getProjectMetaPath,
	getScopeDir,
	getVaultRoot,
} from "./vault-paths.ts";
import { listStoredVaultProjects, type VaultProjectIdentity } from "./vault-project.ts";
import {
	actorSource,
	CONFIDENCE_LEVELS,
	type ConfidenceLevel,
	isPinnedBlock,
	isSafeSlug,
	MEMORY_LIMITS,
	type MemoryActor,
	type MemoryScope,
	type MemoryTarget,
	NOTE_TYPES,
	type Note,
	type NoteFrontmatter,
	type NoteType,
	type PinnedBlock,
	pinnedBlockScope,
	targetsEqual,
} from "./vault-types.ts";

export interface WriteRequest {
	op: "create" | "append" | "replace" | "str_replace" | "rename" | "delete";
	scope: MemoryScope;
	target: MemoryTarget;
	newSlug?: string;
	frontmatter?: Partial<
		Pick<NoteFrontmatter, "name" | "description" | "type" | "aliases" | "confidence" | "applies_to">
	>;
	/** Body content for create/append/replace. */
	content?: string;
	oldText?: string;
	newText?: string;
}

export type WriteResult =
	| {
			ok: true;
			changeId: string;
			target: MemoryTarget;
			indexUpdated: boolean;
			bytes: number;
			warning?: string;
	  }
	| { ok: false; error: string };

export interface UndoResult {
	ok: boolean;
	error?: string;
}

export interface UndoRunResult {
	undone: string[];
	skipped: Array<{ changeId: string; reason: string }>;
}

const UNDOABLE_OPS = new Set<ChangelogOp>(["create", "append", "replace", "str_replace", "rename", "delete"]);

const LINK_PATTERN = /\[\[([a-z0-9][a-z0-9._-]*)\]\]/gu;

function todayString(): string {
	return new Date().toISOString().slice(0, 10);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function extractLinks(body: string): string[] {
	const links = new Set<string>();
	for (const match of body.matchAll(LINK_PATTERN)) links.add(match[1]!);
	return [...links];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function asDateString(value: unknown, fallback: string): string {
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value)) return value.slice(0, 10);
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
	return fallback;
}

function sanitizeIndexText(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	const chars = [...flat];
	const clipped = chars.slice(0, MEMORY_LIMITS.descriptionChars).join("");
	return clipped.length > 0 ? clipped : "-";
}

/** Render a note file exactly as `write` does; shared with legacy migration. */
export function serializeNote(frontmatter: NoteFrontmatter, body: string): string {
	const ordered: Record<string, unknown> = {
		name: frontmatter.name,
		description: frontmatter.description,
		type: frontmatter.type,
	};
	if (frontmatter.aliases && frontmatter.aliases.length > 0) ordered.aliases = frontmatter.aliases;
	ordered.created = frontmatter.created;
	ordered.updated = frontmatter.updated;
	ordered.sources = frontmatter.sources;
	ordered.confidence = frontmatter.confidence;
	if (frontmatter.applies_to && frontmatter.applies_to.length > 0) ordered.applies_to = frontmatter.applies_to;
	const trimmedBody = body.replace(/\s+$/u, "");
	return `---\n${stringify(ordered)}---\n${trimmedBody ? `\n${trimmedBody}\n` : ""}`;
}

function appendBody(body: string, content: string): string {
	const trimmed = body.replace(/\s+$/u, "");
	return trimmed ? `${trimmed}\n\n${content}` : content;
}

/** Apply WriteRequest frontmatter overrides onto a note's frontmatter. */
function mergeFrontmatterOverrides(
	base: NoteFrontmatter,
	overrides: WriteRequest["frontmatter"],
	source: string,
	today: string,
): NoteFrontmatter {
	return {
		...base,
		...(overrides?.name !== undefined ? { name: overrides.name } : {}),
		...(overrides?.description !== undefined ? { description: overrides.description } : {}),
		...(overrides?.type !== undefined && NOTE_TYPES.includes(overrides.type) ? { type: overrides.type } : {}),
		...(overrides?.aliases !== undefined ? { aliases: overrides.aliases } : {}),
		...(overrides?.confidence !== undefined && CONFIDENCE_LEVELS.includes(overrides.confidence)
			? { confidence: overrides.confidence }
			: {}),
		...(overrides?.applies_to !== undefined ? { applies_to: overrides.applies_to } : {}),
		updated: today,
		sources: base.sources.includes(source) ? base.sources : [...base.sources, source],
	};
}

interface IndexReport {
	content: string;
	slugs: Set<string>;
	truncated: boolean;
}

/** A planned `[[oldSlug]]` → `[[newSlug]]` rewrite of one note file. */
interface LinkRewrite {
	scope: MemoryScope;
	projectKey?: string;
	dir: string;
	note: Note;
	raw: string;
	after: string;
}

function compareNotesForIndex(left: Note, right: Note): number {
	return right.frontmatter.updated.localeCompare(left.frontmatter.updated) || left.slug.localeCompare(right.slug);
}

/** Whether the target did not exist before this change (undo removes the file). */
function wasAbsentBefore(entry: ChangelogEntry): boolean {
	if (entry.beforeExists !== undefined) return !entry.beforeExists;
	if (entry.op === "create" && entry.snapshot === undefined) return true;
	// Legacy first pinned append/replace writes carried no snapshot field.
	return (
		typeof entry.target === "object" &&
		entry.target !== null &&
		"block" in entry.target &&
		entry.snapshot === undefined &&
		(entry.op === "append" || entry.op === "replace")
	);
}

function requireSnapshot(root: string, entry: ChangelogEntry): string {
	if (!entry.snapshot) throw new Error(`change ${entry.id} has no snapshot`);
	const content = readSnapshot(root, entry.snapshot);
	if (content === undefined) {
		throw new Error(`snapshot ${entry.snapshot} for change ${entry.id} is unavailable`);
	}
	return content;
}

export class MemoryVault {
	readonly root: string;
	readonly events: MemoryEvents;
	readonly project?: VaultProjectIdentity;
	private readonly activeContextEnabled: () => boolean;

	constructor(opts: {
		agentDir: string;
		project?: VaultProjectIdentity;
		activeContextEnabled?: () => boolean;
		events?: MemoryEvents;
	}) {
		this.root = getVaultRoot(opts.agentDir);
		this.project = opts.project;
		this.events = opts.events ?? new MemoryEvents();
		this.activeContextEnabled = opts.activeContextEnabled ?? (() => false);
	}

	ensureLayout(): void {
		ensureRealDirectoryDurablySync(this.root, 0o700);
		chmodSync(this.root, 0o700);
		for (const dir of [
			getScopeDir(this.root, "global"),
			getNotesDir(getScopeDir(this.root, "global")),
			getPinnedDir(getScopeDir(this.root, "global")),
			join(this.root, "projects"),
			getHistoryDir(this.root),
			getDreamDir(this.root),
			join(this.root, ".meta"),
		]) {
			ensureRealDirectoryDurablySync(dir, 0o700);
		}
		if (this.project) {
			const scopeDir = getScopeDir(this.root, "project", this.project.projectKey);
			ensureRealDirectoryDurablySync(scopeDir, 0o700);
			ensureRealDirectoryDurablySync(getNotesDir(scopeDir), 0o700);
			ensureRealDirectoryDurablySync(getPinnedDir(scopeDir), 0o700);
			const metaPath = getProjectMetaPath(scopeDir);
			// Migrated orphan project dirs carry `{root: null}`; repair them on attach.
			let existingRoot: unknown;
			try {
				const raw = readSingleLinkTextFileSync(metaPath);
				existingRoot = raw ? (JSON.parse(raw) as { root?: unknown }).root : undefined;
			} catch {
				existingRoot = undefined;
			}
			if (this.project.root.length > 0 && (typeof existingRoot !== "string" || existingRoot.length === 0)) {
				replaceFileAtomicallySync(
					metaPath,
					JSON.stringify({ root: this.project.root, createdAt: new Date().toISOString() }),
					{ mode: 0o600 },
				);
			}
		}
	}

	hasScope(scope: MemoryScope): boolean {
		return scope === "global" || this.project !== undefined;
	}

	private scopeDir(scope: MemoryScope): string | undefined {
		if (scope === "project" && !this.project) return undefined;
		return getScopeDir(this.root, scope, this.project?.projectKey);
	}

	private readTextFile(path: string): string | undefined {
		try {
			return readSingleLinkTextFileSync(path, { maxBytes: 1024 * 1024 });
		} catch {
			return undefined;
		}
	}

	readNote(scope: MemoryScope, slug: string): Note | undefined {
		const dir = this.scopeDir(scope);
		if (!dir || !isSafeSlug(slug)) return undefined;
		const path = getNotePath(dir, slug);
		const raw = this.readTextFile(path);
		if (raw === undefined) return undefined;
		return this.parseNote(scope, slug, path, raw);
	}

	private parseNote(scope: MemoryScope, slug: string, path: string, raw: string): Note {
		let fallbackDate = todayString();
		try {
			fallbackDate = statSync(path).mtime.toISOString().slice(0, 10);
		} catch {
			// Keep today as the fallback.
		}
		let parsed: Record<string, unknown> = {};
		let body = raw;
		let malformed = false;
		try {
			const result = parseFrontmatter(raw);
			parsed = result.frontmatter;
			body = result.body;
			if (Object.keys(parsed).length === 0) malformed = true;
		} catch {
			malformed = true;
		}

		const name = asString(parsed.name);
		const type = NOTE_TYPES.includes(parsed.type as NoteType) ? (parsed.type as NoteType) : undefined;
		const description = asString(parsed.description);
		if (name === undefined || type === undefined || description === undefined) malformed = true;

		const confidence = CONFIDENCE_LEVELS.includes(parsed.confidence as ConfidenceLevel)
			? (parsed.confidence as ConfidenceLevel)
			: "medium";
		const firstLine = body.split("\n").find((line) => line.trim().length > 0) ?? "";
		const frontmatter: NoteFrontmatter = {
			name: name ?? slug,
			description: description ?? firstLine.replace(/^#+\s*/u, "").trim(),
			type: type ?? "reference",
			aliases: asStringArray(parsed.aliases),
			created: asDateString(parsed.created, fallbackDate),
			updated: asDateString(parsed.updated, fallbackDate),
			sources: asStringArray(parsed.sources) ?? [],
			confidence,
			applies_to: asStringArray(parsed.applies_to),
		};
		return { scope, slug, frontmatter, body, path, links: extractLinks(body), malformed };
	}

	listNotes(scope: MemoryScope): Note[] {
		const dir = this.scopeDir(scope);
		return dir ? this.listNotesIn(scope, dir) : [];
	}

	/** List notes under an explicit scope dir; used for other projects' scopes too. */
	private listNotesIn(scope: MemoryScope, dir: string): Note[] {
		const notesDir = getNotesDir(dir);
		let files: string[];
		try {
			files = readdirSync(notesDir);
		} catch {
			return [];
		}
		const notes: Note[] = [];
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const slug = file.slice(0, -3);
			if (!isSafeSlug(slug)) continue;
			const path = getNotePath(dir, slug);
			const raw = this.readTextFile(path);
			if (raw === undefined) continue;
			notes.push(this.parseNote(scope, slug, path, raw));
		}
		return notes.sort((left, right) => left.slug.localeCompare(right.slug));
	}

	readPinned(scope: MemoryScope, block: PinnedBlock): string {
		const dir = this.scopeDir(scope);
		if (!dir || pinnedBlockScope(block) !== scope) return "";
		return this.readTextFile(getPinnedPath(dir, block)) ?? "";
	}

	readIndex(scope: MemoryScope): string {
		const dir = this.scopeDir(scope);
		if (!dir) return "";
		return this.readTextFile(getIndexPath(dir)) ?? "";
	}

	private buildIndex(scope: MemoryScope): IndexReport {
		return this.buildIndexFromNotes(this.listNotes(scope));
	}

	private buildIndexFromNotes(notes: readonly Note[]): IndexReport {
		const sorted = [...notes].sort(compareNotesForIndex);
		const lines: string[] = [];
		const slugs = new Set<string>();
		let bytes = 0;
		let truncated = false;
		for (const note of sorted) {
			const description = sanitizeIndexText(note.frontmatter.description || note.frontmatter.name);
			const line = `- [${note.frontmatter.type}] [${note.slug}](notes/${note.slug}.md) — ${description}`;
			const lineBytes = Buffer.byteLength(line, "utf8") + 1;
			if (lines.length >= MEMORY_LIMITS.indexLines || bytes + lineBytes > MEMORY_LIMITS.indexBytes) {
				truncated = true;
				continue;
			}
			lines.push(line);
			slugs.add(note.slug);
			bytes += lineBytes;
		}
		return { content: lines.length > 0 ? `${lines.join("\n")}\n` : "", slugs, truncated };
	}

	private rebuildIndexWithReport(scope: MemoryScope): IndexReport {
		const report = this.buildIndex(scope);
		const dir = this.scopeDir(scope);
		if (!dir) return report;
		const indexPath = getIndexPath(dir);
		if (this.readTextFile(indexPath) !== report.content) {
			replaceFileAtomicallySync(indexPath, report.content, { mode: 0o600 });
		}
		return report;
	}

	/** Rebuild MEMORY.md from the notes on disk: updated desc, <=200 lines / 25KB. */
	rebuildIndex(scope: MemoryScope): void {
		this.rebuildIndexWithReport(scope);
	}

	private record(entry: ChangelogEntry): void {
		appendChangelog(this.root, entry);
		this.events.emit("changed", { entry });
	}

	private newEntry(
		op: ChangelogOp,
		scope: MemoryScope,
		target: MemoryTarget,
		actor: MemoryActor,
		extra: Partial<ChangelogEntry> = {},
	): ChangelogEntry {
		return {
			id: randomUUID(),
			ts: new Date().toISOString(),
			actor,
			op,
			scope,
			target,
			...(scope === "project" ? { projectKey: this.project?.projectKey } : {}),
			...extra,
		};
	}

	/**
	 * Whether a changelog entry belongs to this vault's project scope. The changelog
	 * is shared across projects, so "project"-scope entries are only undoable by —
	 * and only conflict with — entries written under the same projectKey.
	 */
	private ownsEntry(entry: ChangelogEntry): boolean {
		return entry.scope !== "project" || entry.projectKey === this.project?.projectKey;
	}

	private validateWrite(req: WriteRequest): string | undefined {
		if (req.scope !== "global" && req.scope !== "project") return `invalid scope ${String(req.scope)}`;
		if (req.scope === "project" && !this.project) {
			return "project memory is unavailable for this workspace";
		}
		const target = req.target;
		if ("slug" in target) {
			if (!isSafeSlug(target.slug)) return `invalid slug "${target.slug}"`;
		} else if ("block" in target) {
			if (!isPinnedBlock(target.block)) return `invalid pinned block "${String(target.block)}"`;
			const blockScope = pinnedBlockScope(target.block);
			if (blockScope !== req.scope) {
				return `pinned block "${target.block}" belongs to the ${blockScope} scope`;
			}
			if (target.block === "active" && !this.activeContextEnabled()) {
				return 'the "active" pinned block requires memory.activeContext to be enabled';
			}
		} else {
			return "target must be a slug or a pinned block";
		}

		const isSlug = "slug" in target;
		if ((req.op === "create" || req.op === "rename" || req.op === "delete") && !isSlug) {
			return `op "${req.op}" requires a slug target`;
		}
		if (req.op === "create" && !NOTE_TYPES.includes(req.frontmatter?.type as NoteType)) {
			return 'op "create" requires frontmatter.type';
		}
		if ((req.op === "append" || req.op === "replace") && typeof req.content !== "string") {
			return `op "${req.op}" requires content`;
		}
		if (req.op === "str_replace" && (typeof req.oldText !== "string" || typeof req.newText !== "string")) {
			return 'op "str_replace" requires oldText and newText';
		}
		if (req.op === "rename" && (typeof req.newSlug !== "string" || !isSafeSlug(req.newSlug))) {
			return 'op "rename" requires a valid newSlug';
		}
		if (req.op !== "rename" && req.newSlug !== undefined) return "newSlug is only valid for rename";
		if (!isSlug && req.frontmatter !== undefined) return "frontmatter is only valid for slug targets";

		const description = req.frontmatter?.description;
		if (description !== undefined && [...description].length > MEMORY_LIMITS.descriptionChars) {
			return `description exceeds ${MEMORY_LIMITS.descriptionChars} characters`;
		}

		const limit = isSlug ? MEMORY_LIMITS.noteBodyBytes : MEMORY_LIMITS.pinnedBytes[target.block];
		if (
			(req.op === "create" || req.op === "replace") &&
			typeof req.content === "string" &&
			Buffer.byteLength(req.content, "utf8") > limit
		) {
			return `content exceeds the ${limit} byte limit for this target; split it into smaller pieces`;
		}
		if (req.op === "str_replace" && typeof req.newText === "string") {
			const growth = Buffer.byteLength(req.newText, "utf8") - Buffer.byteLength(req.oldText ?? "", "utf8");
			if (growth > limit) return `content exceeds the ${limit} byte limit for this target`;
		}

		const candidates = [
			req.content,
			req.newText,
			req.frontmatter?.name,
			req.frontmatter?.description,
			...(req.frontmatter?.aliases ?? []),
			...(req.frontmatter?.applies_to ?? []),
		];
		for (const candidate of candidates) {
			if (typeof candidate === "string" && looksLikeSecret(candidate)) {
				return "content looks like a secret; refusing to store it in memory";
			}
		}
		return undefined;
	}

	async write(req: WriteRequest, actor: MemoryActor): Promise<WriteResult> {
		const invalid = this.validateWrite(req);
		if (invalid) return { ok: false, error: invalid };
		try {
			return await withMemoryRootLock(this.root, () => this.applyWrite(req, actor));
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	private applyWrite(req: WriteRequest, actor: MemoryActor): WriteResult {
		this.ensureLayout();
		if ("slug" in req.target) return this.applySlugWrite(req, req.target.slug, actor);
		return this.applyBlockWrite(req, req.target.block, actor);
	}

	private applySlugWrite(req: WriteRequest, slug: string, actor: MemoryActor): WriteResult {
		const dir = this.scopeDir(req.scope)!;
		const path = getNotePath(dir, slug);
		const existingRaw = this.readTextFile(path);
		const source = actorSource(actor);
		const today = todayString();
		let bytes = 0;
		let primary: ChangelogEntry;
		let indexReport: IndexReport | undefined;
		const extra: ChangelogEntry[] = [];

		switch (req.op) {
			case "create": {
				if (existingRaw !== undefined) return { ok: false, error: `note "${slug}" already exists` };
				const frontmatter: NoteFrontmatter = {
					name: req.frontmatter?.name ?? slug,
					description: req.frontmatter?.description ?? "",
					type: req.frontmatter!.type!,
					aliases: req.frontmatter?.aliases,
					created: today,
					updated: today,
					sources: [source],
					confidence: req.frontmatter?.confidence ?? "medium",
					applies_to: req.frontmatter?.applies_to,
				};
				const serialized = serializeNote(frontmatter, req.content ?? "");
				createFileAtomicallySync(path, serialized, { mode: 0o600 });
				bytes = Buffer.byteLength(serialized, "utf8");
				primary = this.newEntry("create", req.scope, { slug }, actor, { beforeExists: false });
				break;
			}
			case "append":
			case "replace":
			case "str_replace": {
				if (existingRaw === undefined) return { ok: false, error: `note "${slug}" not found` };
				const note = this.parseNote(req.scope, slug, path, existingRaw);
				let body: string;
				if (req.op === "append") body = appendBody(note.body, req.content!);
				else if (req.op === "replace") body = req.content!;
				else {
					const index = note.body.indexOf(req.oldText!);
					if (index < 0) return { ok: false, error: "oldText not found in note body" };
					const occurrences = note.body.split(req.oldText!).length - 1;
					if (occurrences > 1) {
						return { ok: false, error: `oldText occurs ${occurrences} times; provide more context` };
					}
					body = note.body.slice(0, index) + req.newText! + note.body.slice(index + req.oldText!.length);
				}
				if (Buffer.byteLength(body, "utf8") > MEMORY_LIMITS.noteBodyBytes) {
					return {
						ok: false,
						error: `note body exceeds the ${MEMORY_LIMITS.noteBodyBytes} byte limit; split it into smaller notes`,
					};
				}
				const merged = mergeFrontmatterOverrides(note.frontmatter, req.frontmatter, source, today);
				if ([...merged.description].length > MEMORY_LIMITS.descriptionChars) {
					return { ok: false, error: `description exceeds ${MEMORY_LIMITS.descriptionChars} characters` };
				}
				const snapshot = saveSnapshot(this.root, req.scope, { slug }, existingRaw, this.project?.projectKey);
				replaceFileAtomicallySync(path, serializeNote(merged, body), { mode: 0o600 });
				bytes = Buffer.byteLength(serializeNote(merged, body), "utf8");
				primary = this.newEntry(req.op, req.scope, { slug }, actor, { snapshot, beforeExists: true });
				break;
			}
			case "rename": {
				if (existingRaw === undefined) return { ok: false, error: `note "${slug}" not found` };
				const newSlug = req.newSlug!;
				const newPath = getNotePath(dir, newSlug);
				if (this.readTextFile(newPath) !== undefined) {
					return { ok: false, error: `note "${newSlug}" already exists` };
				}
				const note = this.parseNote(req.scope, slug, path, existingRaw);
				const frontmatter = mergeFrontmatterOverrides(note.frontmatter, req.frontmatter, source, today);
				if ([...frontmatter.description].length > MEMORY_LIMITS.descriptionChars) {
					return { ok: false, error: `description exceeds ${MEMORY_LIMITS.descriptionChars} characters` };
				}
				// Plan every backlink rewrite first; shadowing or size violations
				// reject the rename before any file is touched.
				const rewrites = this.planLinkRewrites(req.scope, slug, newSlug, path);
				if (!rewrites.ok) return { ok: false, error: rewrites.error };
				const snapshot = saveSnapshot(this.root, req.scope, { slug }, existingRaw, this.project?.projectKey);
				const serialized = serializeNote(frontmatter, note.body);
				bytes = Buffer.byteLength(serialized, "utf8");
				const changes: VaultFileChange[] = [
					{ path, before: existingRaw, after: undefined },
					{ path: newPath, before: undefined, after: serialized },
				];
				const referrerLegs: Array<{ scope: MemoryScope; slug: string; projectKey?: string; snapshot?: string }> =
					[];
				for (const rewrite of rewrites.files) {
					referrerLegs.push({
						scope: rewrite.scope,
						slug: rewrite.note.slug,
						projectKey: rewrite.projectKey,
						snapshot: saveSnapshot(
							this.root,
							rewrite.scope,
							{ slug: rewrite.note.slug },
							rewrite.raw,
							rewrite.projectKey,
						),
					});
					changes.push({ path: rewrite.note.path, before: rewrite.raw, after: rewrite.after });
				}
				// Project the index of every touched scope from disk plus planned writes.
				const touchedDirs = new Map<string, MemoryScope>([[dir, req.scope]]);
				for (const rewrite of rewrites.files) touchedDirs.set(rewrite.dir, rewrite.scope);
				for (const [scopeDir, touchedScope] of touchedDirs) {
					const projected = new Map(this.listNotesIn(touchedScope, scopeDir).map((n) => [n.slug, n]));
					if (scopeDir === dir) {
						projected.delete(slug);
						projected.set(newSlug, this.parseNote(req.scope, newSlug, newPath, serialized));
					}
					for (const rewrite of rewrites.files) {
						if (rewrite.dir !== scopeDir) continue;
						projected.set(
							rewrite.note.slug,
							this.parseNote(rewrite.scope, rewrite.note.slug, rewrite.note.path, rewrite.after),
						);
					}
					const report = this.buildIndexFromNotes([...projected.values()]);
					if (scopeDir === dir) indexReport = report;
					const indexPath = getIndexPath(scopeDir);
					changes.push({ path: indexPath, before: this.readCurrentStrict(indexPath), after: report.content });
				}
				applyVaultFileChanges(changes);
				primary = this.newEntry("rename", req.scope, { slug }, actor, {
					newSlug,
					snapshot,
					beforeExists: true,
				});
				primary.operationId = primary.id;
				// Second leg: the new note appears as a create in the same operation.
				extra.push(
					this.newEntry("create", req.scope, { slug: newSlug }, actor, {
						snapshot,
						beforeExists: false,
						operationId: primary.id,
					}),
				);
				for (const leg of referrerLegs) {
					extra.push(
						this.newEntry("replace", leg.scope, { slug: leg.slug }, actor, {
							snapshot: leg.snapshot,
							beforeExists: true,
							operationId: primary.id,
							...(leg.projectKey !== undefined ? { projectKey: leg.projectKey } : {}),
						}),
					);
				}
				break;
			}
			case "delete": {
				if (existingRaw === undefined) return { ok: false, error: `note "${slug}" not found` };
				const snapshot = saveSnapshot(this.root, req.scope, { slug }, existingRaw, this.project?.projectKey);
				rmSync(path, { force: true });
				primary = this.newEntry("delete", req.scope, { slug }, actor, { snapshot, beforeExists: true });
				break;
			}
		}

		const index = indexReport ?? this.rebuildIndexWithReport(req.scope);
		const indexSlug = req.op === "rename" ? req.newSlug! : slug;
		const indexUpdated = req.op === "delete" ? true : index.slugs.has(indexSlug);
		this.record(primary);
		for (const entry of extra) this.record(entry);
		return {
			ok: true,
			changeId: primary.id,
			target: req.target,
			indexUpdated,
			bytes,
			...(index.truncated ? { warning: "index full" } : {}),
		};
	}

	/**
	 * Collect the backlink rewrites a rename needs, following link-resolution
	 * rules: a project rename only affects its own project; a global rename
	 * affects global notes plus project notes whose `[[oldSlug]]` resolved to
	 * the global note (no local shadow). A project with a local `newSlug`
	 * note and live `[[oldSlug]]` links would re-point them to the wrong note,
	 * so the rename is refused up front.
	 */
	private planLinkRewrites(
		scope: MemoryScope,
		oldSlug: string,
		newSlug: string,
		renamedPath: string,
	): { ok: true; files: LinkRewrite[] } | { ok: false; error: string } {
		const pattern = new RegExp(`\\[\\[${oldSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`, "gu");
		if (scope === "project") {
			const dir = this.scopeDir("project")!;
			return this.linkRewritesIn("project", this.project!.projectKey, dir, pattern, oldSlug, newSlug, renamedPath);
		}
		const planned = this.linkRewritesIn(
			"global",
			undefined,
			this.scopeDir("global")!,
			pattern,
			oldSlug,
			newSlug,
			renamedPath,
		);
		if (!planned.ok) return planned;
		const files = [...planned.files];
		for (const project of listStoredVaultProjects(this.root)) {
			const dir = getScopeDir(this.root, "project", project.projectKey);
			// A local note with the old slug shadows the renamed global note.
			if (existsSync(getNotePath(dir, oldSlug))) continue;
			const projectPlan = this.linkRewritesIn(
				"project",
				project.projectKey,
				dir,
				pattern,
				oldSlug,
				newSlug,
				renamedPath,
			);
			if (!projectPlan.ok) return projectPlan;
			if (projectPlan.files.length > 0 && existsSync(getNotePath(dir, newSlug))) {
				return {
					ok: false,
					error: `rename would repoint [[${oldSlug}]] links in project ${project.projectKey} to a local note`,
				};
			}
			files.push(...projectPlan.files);
		}
		return { ok: true, files };
	}

	/** `[[oldSlug]]` rewrites for notes in one scope dir; no writes, only a plan. */
	private linkRewritesIn(
		scope: MemoryScope,
		projectKey: string | undefined,
		dir: string,
		pattern: RegExp,
		oldSlug: string,
		newSlug: string,
		renamedPath: string,
	): { ok: true; files: LinkRewrite[] } | { ok: false; error: string } {
		const files: LinkRewrite[] = [];
		for (const note of this.listNotesIn(scope, dir)) {
			if (note.path === renamedPath || note.slug === newSlug) continue;
			if (!note.links.includes(oldSlug)) continue;
			const raw = this.readTextFile(note.path);
			if (raw === undefined) continue;
			const body = note.body.replace(pattern, `[[${newSlug}]]`);
			if (Buffer.byteLength(body, "utf8") > MEMORY_LIMITS.noteBodyBytes) {
				return {
					ok: false,
					error: `rewriting [[${oldSlug}]] in "${note.slug}" would exceed the note body limit`,
				};
			}
			files.push({
				scope,
				projectKey,
				dir,
				note,
				raw,
				after: serializeNote({ ...note.frontmatter, updated: todayString() }, body),
			});
		}
		return { ok: true, files };
	}

	private applyBlockWrite(req: WriteRequest, block: PinnedBlock, actor: MemoryActor): WriteResult {
		const dir = this.scopeDir(req.scope)!;
		const path = getPinnedPath(dir, block);
		const existingRaw = this.readTextFile(path);
		const limit = MEMORY_LIMITS.pinnedBytes[block];
		let content: string;
		switch (req.op) {
			case "append":
				content = existingRaw === undefined ? req.content! : appendBody(existingRaw, req.content!);
				break;
			case "replace":
				content = req.content!;
				break;
			case "str_replace": {
				if (existingRaw === undefined) return { ok: false, error: `pinned block "${block}" not found` };
				const index = existingRaw.indexOf(req.oldText!);
				if (index < 0) return { ok: false, error: "oldText not found in pinned block" };
				const occurrences = existingRaw.split(req.oldText!).length - 1;
				if (occurrences > 1) {
					return { ok: false, error: `oldText occurs ${occurrences} times; provide more context` };
				}
				content = existingRaw.slice(0, index) + req.newText! + existingRaw.slice(index + req.oldText!.length);
				break;
			}
			default:
				return { ok: false, error: `op "${req.op}" requires a slug target` };
		}
		if (Buffer.byteLength(content, "utf8") > limit) {
			return {
				ok: false,
				error: `pinned block "${block}" exceeds the ${limit} byte limit`,
			};
		}
		const snapshot = saveSnapshot(this.root, req.scope, { block }, existingRaw, this.project?.projectKey);
		replaceFileAtomicallySync(path, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
		const entry = this.newEntry(req.op, req.scope, { block }, actor, {
			snapshot,
			beforeExists: existingRaw !== undefined,
		});
		this.record(entry);
		return {
			ok: true,
			changeId: entry.id,
			target: req.target,
			indexUpdated: true,
			bytes: Buffer.byteLength(content, "utf8"),
		};
	}

	async undo(changeId: string, actor: MemoryActor): Promise<UndoResult> {
		try {
			return await withMemoryRootLock(this.root, () => this.applyUndo(changeId, actor));
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	private applyUndo(changeId: string, actor: MemoryActor): UndoResult {
		const entries = readChangelog(this.root); // newest first
		const entry = entries.find((candidate) => candidate.id === changeId);
		if (!entry) return { ok: false, error: `unknown change ${changeId}` };
		if (!UNDOABLE_OPS.has(entry.op)) return { ok: false, error: `change ${changeId} is not undoable` };
		const group = this.operationEntries(entry, entries);
		if (group.some((c) => c.undoneBy)) {
			return { ok: false, error: `change ${changeId} was already undone` };
		}
		// A crafted group member must not pull the undo into another project's scope.
		if (group.some((member) => !this.ownsEntry(member))) {
			return { ok: false, error: "change belongs to a different project" };
		}
		// A change on any member target outside the group conflicts the whole undo.
		const groupIds = new Set(group.map((c) => c.id));
		for (const member of group) {
			const latest = entries.find(
				(candidate) =>
					candidate.scope === member.scope &&
					(member.scope === "global" || candidate.projectKey === member.projectKey) &&
					targetsEqual(candidate.target, member.target) &&
					UNDOABLE_OPS.has(candidate.op) &&
					!candidate.undoneBy,
			);
			if (latest && !groupIds.has(latest.id)) {
				return {
					ok: false,
					error: `a newer change ${latest.id} exists for this target; undo it first`,
				};
			}
		}
		return this.performUndo(entry, actor, group);
	}

	/**
	 * All changelog entries belonging to the same write operation. Grouped
	 * renames share `operationId`; entries written before grouping falls back
	 * to the rename/create pair that shared one snapshot.
	 */
	private operationEntries(entry: ChangelogEntry, entries: ChangelogEntry[]): ChangelogEntry[] {
		if (entry.operationId) {
			return entries.filter((candidate) => candidate.operationId === entry.operationId);
		}
		const pair = this.findRenamePair(entry, entries);
		return pair ? [entry, pair] : [entry];
	}

	/** The two rename legs share one snapshot: `rename` (old slug) + `create` (new slug). */
	private findRenamePair(entry: ChangelogEntry, entries: ChangelogEntry[]): ChangelogEntry | undefined {
		if (entry.op === "rename" && entry.newSlug) {
			return entries.find(
				(candidate) =>
					candidate.op === "create" &&
					typeof candidate.target === "object" &&
					candidate.target !== null &&
					"slug" in candidate.target &&
					candidate.target.slug === entry.newSlug &&
					candidate.scope === entry.scope &&
					candidate.snapshot === entry.snapshot &&
					!candidate.undoneBy,
			);
		}
		if (
			entry.op === "create" &&
			typeof entry.target === "object" &&
			entry.target !== null &&
			"slug" in entry.target &&
			entry.snapshot !== undefined
		) {
			return entries.find(
				(candidate) =>
					candidate.op === "rename" &&
					candidate.newSlug === (entry.target as { slug: string }).slug &&
					candidate.scope === entry.scope &&
					candidate.snapshot === entry.snapshot &&
					!candidate.undoneBy,
			);
		}
		return undefined;
	}

	/**
	 * Scope dir for a changelog entry; project entries resolve by their recorded
	 * projectKey. Changelog fields are persisted input: only safe segment keys may
	 * form paths, so a tampered entry resolves to undefined instead of escaping
	 * the vault.
	 */
	private entryScopeDir(entry: ChangelogEntry): string | undefined {
		if (entry.scope === "global") return getScopeDir(this.root, "global");
		const projectKey = entry.projectKey ?? this.project?.projectKey;
		if (projectKey === undefined || !isSafeProjectKey(projectKey)) return undefined;
		return getScopeDir(this.root, "project", projectKey);
	}

	private entryTargetPath(entry: ChangelogEntry, target: MemoryTarget = entry.target): string | undefined {
		const dir = this.entryScopeDir(entry);
		if (!dir || typeof target !== "object" || target === null) return undefined;
		if ("slug" in target) {
			return typeof target.slug === "string" && isSafeSlug(target.slug) ? getNotePath(dir, target.slug) : undefined;
		}
		return isPinnedBlock(target.block) ? getPinnedPath(dir, target.block) : undefined;
	}

	/** Read current file content for `before`: absent files read as undefined, unreadable ones throw. */
	private readCurrentStrict(path: string): string | undefined {
		return readSingleLinkTextFileSync(path, { maxBytes: 1024 * 1024 });
	}

	/**
	 * Resolve every file change an undo needs before touching disk: snapshots
	 * are loaded, current contents captured for rollback, and the projected
	 * index plus the changelog commit appended as trailing changes.
	 */
	private prepareUndoChanges(
		entry: ChangelogEntry,
		group: ChangelogEntry[],
		actor: MemoryActor,
	): { changes: VaultFileChange[]; undoEntry: ChangelogEntry } {
		// Rename legs first so old paths are restored before new ones are removed.
		const ordered = [...group].sort(
			(left, right) =>
				(left.op === "rename" ? 0 : left.op === "create" ? 1 : 2) -
				(right.op === "rename" ? 0 : right.op === "create" ? 1 : 2),
		);
		const renamedTo = new Set(
			ordered.filter((item) => item.op === "rename" && item.newSlug).map((item) => `${item.scope}:${item.newSlug}`),
		);
		const restores = new Map<string, string | undefined>();
		const setRestore = (path: string, after: string | undefined): void => {
			if (restores.has(path) && restores.get(path) !== after) {
				throw new Error(`conflicting restore contents for ${path}`);
			}
			restores.set(path, after);
		};
		for (const item of ordered) {
			const path = this.entryTargetPath(item);
			if (!path) throw new Error(`change ${item.id} is malformed or out of scope for this workspace`);
			const isRenameLeg = "slug" in item.target && renamedTo.has(`${item.scope}:${item.target.slug}`);
			if (item.op === "create" && (wasAbsentBefore(item) || isRenameLeg)) {
				// A rename leg or a plain create: the file did not exist before.
				setRestore(path, undefined);
				continue;
			}
			if (item.op === "rename") {
				if (!item.newSlug) throw new Error(`rename change ${item.id} is missing newSlug`);
				setRestore(path, requireSnapshot(this.root, item));
				const newPath = this.entryTargetPath(item, { slug: item.newSlug });
				if (!newPath) throw new Error(`change ${item.id} is malformed or out of scope for this workspace`);
				setRestore(newPath, undefined);
				continue;
			}
			setRestore(path, wasAbsentBefore(item) ? undefined : requireSnapshot(this.root, item));
		}

		const changes: VaultFileChange[] = [];
		const byPath = new Map<string, VaultFileChange>();
		for (const [path, after] of restores) {
			const change: VaultFileChange = { path, before: this.readCurrentStrict(path), after };
			changes.push(change);
			byPath.set(path, change);
		}

		// Project the post-undo index per affected scope from current notes plus
		// planned changes, without reading stale files mid-transaction.
		const slugChanges = new Map<string, { scope: MemoryScope; dir: string; map: Map<string, VaultFileChange> }>();
		for (const item of ordered) {
			if (!("slug" in item.target)) continue;
			const dir = this.entryScopeDir(item);
			if (!dir) throw new Error(`change ${item.id} is malformed or out of scope for this workspace`);
			let bucket = slugChanges.get(dir);
			if (!bucket) {
				bucket = { scope: item.scope, dir, map: new Map() };
				slugChanges.set(dir, bucket);
			}
			const change = byPath.get(this.entryTargetPath(item)!);
			if (change) bucket.map.set(item.target.slug, change);
			if (item.op === "rename" && item.newSlug) {
				const renamed = byPath.get(getNotePath(dir, item.newSlug));
				if (renamed) bucket.map.set(item.newSlug, renamed);
			}
		}
		for (const bucket of slugChanges.values()) {
			const projected = new Map(this.listNotesIn(bucket.scope, bucket.dir).map((note) => [note.slug, note]));
			for (const [slug, change] of bucket.map) {
				if (change.after === undefined) projected.delete(slug);
				else projected.set(slug, this.parseNote(bucket.scope, slug, change.path, change.after));
			}
			const report = this.buildIndexFromNotes([...projected.values()]);
			const indexPath = getIndexPath(bucket.dir);
			changes.push({ path: indexPath, before: this.readCurrentStrict(indexPath), after: report.content });
		}

		const primary = group.find((c) => c.id === (entry.operationId ?? entry.id)) ?? entry;
		const undoEntry = this.newEntry("undo", primary.scope, primary.target, actor, { undoes: primary.id });
		const logPath = getChangelogPath(this.root);
		const logBefore = readSingleLinkTextFileSync(logPath, { maxBytes: 8 * 1024 * 1024 });
		changes.push({
			path: logPath,
			before: logBefore,
			after: serializeUndoCommit(
				logBefore,
				undoEntry,
				ordered.map((item) => item.id),
			),
		});
		return { changes, undoEntry };
	}

	private performUndo(entry: ChangelogEntry, actor: MemoryActor, group: ChangelogEntry[]): UndoResult {
		let undoEntry: ChangelogEntry;
		try {
			const prepared = this.prepareUndoChanges(entry, group, actor);
			applyVaultFileChanges(prepared.changes);
			undoEntry = prepared.undoEntry;
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
		this.events.emit("changed", { entry: undoEntry });
		return { ok: true };
	}

	async undoRun(runId: string, actor: MemoryActor): Promise<UndoRunResult> {
		try {
			return await withMemoryRootLock(this.root, () => {
				const inRun = (entry: ChangelogEntry) => entry.actor?.kind === "dream" && entry.actor.runId === runId;
				const runIds = readChangelog(this.root)
					.filter((entry) => inRun(entry) && UNDOABLE_OPS.has(entry.op))
					.map((entry) => entry.id); // newest first
				const undone: string[] = [];
				const skipped: Array<{ changeId: string; reason: string }> = [];
				for (const changeId of runIds) {
					const fresh = readChangelog(this.root); // newest first
					const entry = fresh.find((candidate) => candidate.id === changeId);
					// Already rolled back as part of a group (e.g. a rename leg).
					if (!entry || entry.undoneBy) continue;
					const group = this.operationEntries(entry, fresh);
					if (group.some((member) => !this.ownsEntry(member))) {
						skipped.push({ changeId: entry.id, reason: "change belongs to a different project" });
						continue;
					}
					const groupIds = new Set(group.map((c) => c.id));
					const position = fresh.findIndex((candidate) => candidate.id === entry.id);
					let conflict: ChangelogEntry | undefined;
					for (const member of group) {
						conflict = fresh
							.slice(0, position)
							.find(
								(candidate) =>
									!groupIds.has(candidate.id) &&
									candidate.scope === member.scope &&
									(member.scope === "global" || candidate.projectKey === member.projectKey) &&
									targetsEqual(candidate.target, member.target) &&
									UNDOABLE_OPS.has(candidate.op) &&
									!inRun(candidate) &&
									!candidate.undoneBy,
							);
						if (conflict) break;
					}
					if (conflict) {
						skipped.push({
							changeId: entry.id,
							reason: `target has a newer change ${conflict.id} outside this run`,
						});
						continue;
					}
					const result = this.performUndo(entry, actor, group);
					if (result.ok) undone.push(entry.id);
					else skipped.push({ changeId: entry.id, reason: result.error ?? "undo failed" });
				}
				return { undone, skipped };
			});
		} catch (error) {
			return { undone: [], skipped: [{ changeId: "", reason: errorMessage(error) }] };
		}
	}

	history(limit = 50): ChangelogEntry[] {
		return readChangelog(this.root, limit);
	}

	/**
	 * Slugs of notes whose `[[slug]]` actually resolves to this note: global
	 * notes always count; project notes count for a global target only when
	 * their project has no local note with that slug, and for a project
	 * target only when they sit in the same project.
	 */
	backlinks(scope: MemoryScope, slug: string): string[] {
		const found = new Set<string>();
		for (const note of this.listNotesIn("global", getScopeDir(this.root, "global"))) {
			if (scope === "global" && note.slug === slug) continue;
			if (note.links.includes(slug)) found.add(note.slug);
		}
		if (scope === "project") {
			const dir = this.scopeDir("project");
			if (dir) {
				for (const note of this.listNotesIn("project", dir)) {
					if (note.slug !== slug && note.links.includes(slug)) found.add(note.slug);
				}
			}
		} else {
			for (const project of listStoredVaultProjects(this.root)) {
				const dir = getScopeDir(this.root, "project", project.projectKey);
				if (existsSync(getNotePath(dir, slug))) continue;
				for (const note of this.listNotesIn("project", dir)) {
					if (note.links.includes(slug)) found.add(note.slug);
				}
			}
		}
		return [...found].sort();
	}
}
