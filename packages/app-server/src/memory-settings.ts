import { randomUUID } from "node:crypto";
import {
	type ClientParams,
	type ClientResult,
	MAX_HISTORY_ITEMS,
	type MemoryChangelogEntryView,
} from "@metis/app-protocol";
import {
	type ChangelogEntry,
	checkDreamGate,
	createDreamPromptAgent,
	createDreamPromptFn,
	type DreamGateReason,
	type DreamLlmDeps,
	type DreamModelRef,
	type DreamPromptAgent,
	type DreamPromptFn,
	type DreamRunResult,
	type DreamSettings,
	filterDreamSessionPaths,
	generateUnifiedPatch,
	getNotePath,
	getPinnedPath,
	getProjectMetaPath,
	getScopeDir,
	getVaultRoot,
	isPinnedBlock,
	isSafeProjectKey,
	isSafeSlug,
	MemoryEvents,
	MemorySearchIndex,
	MemoryVault,
	type ModelRegistry,
	type Note,
	readChangelog,
	readDreamState,
	readSingleLinkTextFileSync,
	readSnapshot,
	resolveDreamModel,
	resolveDreamSettings,
	resolveVaultProject,
	runDream,
	type SettingsManager,
	undoMemoryRun,
	type VaultProjectIdentity,
} from "@metis/coding-agent/host";
import type { SessionCatalog } from "./session-catalog.ts";
import { AppServerError } from "./session-runtime-host.ts";
import type { SessionSubscriptions } from "./subscriptions.ts";

const DREAM_DEFAULTS = { enabled: true, minHours: 24, minSessions: 5, maxUnusedDays: 90 } as const;
/** Background dream check cadence (plan §1.8). */
const DREAM_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const USER_ACTOR = { kind: "user" } as const;

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SESSION_ID_LIKE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const SHA256_LIKE = /^[a-f0-9]{64}$/u;
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u;
const HISTORY_OPS: ReadonlySet<string> = new Set([
	"create",
	"append",
	"replace",
	"str_replace",
	"rename",
	"delete",
	"undo",
	"migrate",
]);

/**
 * Wire view of a vault changelog entry; the internal snapshot path stays
 * server-side. Changelog lines are persisted input: fields are re-validated
 * against the wire contract, and an entry that cannot produce a schema-valid
 * view is dropped rather than poisoning the whole response.
 */
function changelogEntryView(entry: ChangelogEntry): MemoryChangelogEntryView | undefined {
	if (typeof entry.id !== "string" || !UUID_LIKE.test(entry.id)) return undefined;
	if (typeof entry.ts !== "string" || entry.ts.length > 40 || !ISO_LIKE.test(entry.ts)) return undefined;
	const actor = viewActor(entry.actor);
	const target = viewTarget(entry.target);
	if (!actor || !target || !HISTORY_OPS.has(entry.op)) return undefined;
	if (entry.scope !== "global" && entry.scope !== "project") return undefined;
	return {
		id: entry.id,
		ts: entry.ts,
		actor,
		op: entry.op as MemoryChangelogEntryView["op"],
		scope: entry.scope,
		target,
		...(typeof entry.projectKey === "string" && SHA256_LIKE.test(entry.projectKey)
			? { projectKey: entry.projectKey }
			: {}),
		...(typeof entry.newSlug === "string" && isSafeSlug(entry.newSlug) ? { newSlug: entry.newSlug } : {}),
		...(typeof entry.undoes === "string" && UUID_LIKE.test(entry.undoes) ? { undoes: entry.undoes } : {}),
		...(typeof entry.undoneBy === "string" && UUID_LIKE.test(entry.undoneBy) ? { undoneBy: entry.undoneBy } : {}),
	};
}

function viewActor(actor: ChangelogEntry["actor"]): MemoryChangelogEntryView["actor"] | undefined {
	if (typeof actor !== "object" || actor === null) return undefined;
	switch (actor.kind) {
		case "user":
		case "migrate":
			return { kind: actor.kind };
		case "agent":
			return typeof actor.sessionId === "string" && SESSION_ID_LIKE.test(actor.sessionId)
				? { kind: "agent", sessionId: actor.sessionId }
				: undefined;
		case "dream":
			return typeof actor.runId === "string" && actor.runId.length >= 1 && actor.runId.length <= 64
				? { kind: "dream", runId: actor.runId }
				: undefined;
		default:
			return undefined;
	}
}

function viewTarget(target: ChangelogEntry["target"]): MemoryChangelogEntryView["target"] | undefined {
	if (typeof target !== "object" || target === null) return undefined;
	if ("slug" in target && typeof target.slug === "string" && isSafeSlug(target.slug)) {
		return { slug: target.slug };
	}
	if ("block" in target && isPinnedBlock(target.block)) return { block: target.block };
	return undefined;
}

function noteView(note: Note, backlinks: readonly string[]): ClientResult<"memory/notes/read">["note"] {
	return {
		scope: note.scope,
		slug: note.slug,
		name: note.frontmatter.name,
		description: note.frontmatter.description,
		type: note.frontmatter.type,
		...(note.frontmatter.aliases ? { aliases: [...note.frontmatter.aliases] } : {}),
		created: note.frontmatter.created,
		updated: note.frontmatter.updated,
		sources: [...note.frontmatter.sources],
		confidence: note.frontmatter.confidence,
		...(note.frontmatter.applies_to ? { applies_to: [...note.frontmatter.applies_to] } : {}),
		body: note.body,
		links: [...note.links],
		backlinks: [...backlinks],
		...(note.malformed ? { malformed: true } : {}),
	};
}

/** Clamp a settings value into its wire bound; hand-edited settings stay valid. */
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

interface VaultEntry {
	readonly vault: MemoryVault;
	readonly search: MemorySearchIndex;
}

/** LLM dependencies for one dream run; injectable so tests never touch a real model. */
export interface DreamRunDeps {
	/** Resolved model ref; also the gate's model-availability input. */
	readonly model: DreamModelRef;
	readonly promptFn: DreamPromptFn;
	readonly promptAgent: DreamPromptAgent;
}

/** Builds prompt deps for a resolved dream model; undefined means no usable model. */
export type DreamDepsFactory = (settings: DreamSettings) => DreamRunDeps | undefined;

function dreamRunError(result: Extract<DreamRunResult, { ran: false }>): string {
	if (result.reason === "error") return (result.error ?? "Dream failed").slice(0, 500) || "Dream failed";
	const reason: Record<DreamGateReason, string> = {
		disabled: "Memory consolidation is disabled",
		"too-soon": "The last dream ran too recently",
		"insufficient-sessions": "Not enough unprocessed sessions",
		"no-model": "No credentialed model is available",
		locked: "The vault is locked by another memory operation",
	};
	return reason[result.reason];
}

/**
 * Host-facing Memory Vault service. Desktop writes run as actor=user; agent
 * sessions share `this.events` so every vault change broadcasts `memory/changed`.
 */
export class MemoryService {
	/** Shared emitter passed to every session vault so host listeners see all writes. */
	readonly events = new MemoryEvents();
	private readonly agentDir: string;
	private readonly settingsManager: SettingsManager;
	private readonly catalog: SessionCatalog;
	private readonly modelRegistry?: ModelRegistry;
	private readonly dreamDeps?: DreamDepsFactory;
	private readonly vaults = new Map<string, VaultEntry>();

	constructor(options: {
		readonly agentDir: string;
		readonly settingsManager: SettingsManager;
		readonly catalog: SessionCatalog;
		readonly subscriptions: SessionSubscriptions;
		readonly modelRegistry?: ModelRegistry;
		readonly dreamDeps?: DreamDepsFactory;
	}) {
		this.agentDir = options.agentDir;
		this.settingsManager = options.settingsManager;
		this.catalog = options.catalog;
		this.modelRegistry = options.modelRegistry;
		this.dreamDeps = options.dreamDeps;
		this.events.on("changed", (event) => {
			const entry = changelogEntryView(event.entry);
			if (!entry) return;
			options.subscriptions.publishConnectionEvent({ type: "memory/changed", entry });
		});
		this.events.on("dreamCompleted", (event) => {
			options.subscriptions.publishConnectionEvent({ type: "memory/dreamCompleted", ...event });
		});
	}

	private projectForSession(sessionId: string | undefined): VaultProjectIdentity | undefined {
		if (sessionId === undefined) return undefined;
		const summary = this.catalog.get(sessionId).summary;
		if (summary.cwd === null) return undefined;
		return resolveVaultProject(summary.cwd, summary.cwdOrigin);
	}

	private projectForScope(
		sessionId: string | undefined,
		scope: "global" | "project",
	): VaultProjectIdentity | undefined {
		if (scope !== "project") return undefined;
		const project = this.projectForSession(sessionId);
		if (!project) throw new AppServerError("INVALID_REQUEST");
		return project;
	}

	/** Vault+index for a project identity; the "" key is the global-only vault. */
	private entryFor(project: VaultProjectIdentity | undefined): VaultEntry {
		const key = project?.projectKey ?? "";
		let entry = this.vaults.get(key);
		if (!entry) {
			const vault = new MemoryVault({
				agentDir: this.agentDir,
				project,
				activeContextEnabled: () => this.settingsManager.getMemorySettings().activeContext === true,
				events: this.events,
			});
			vault.ensureLayout();
			entry = { vault, search: new MemorySearchIndex(vault) };
			this.vaults.set(key, entry);
		}
		return entry;
	}

	/** Project identity for a project-scope changelog entry, resolved from its recorded root. */
	private projectForEntry(entry: ChangelogEntry): VaultProjectIdentity | undefined {
		if (entry.scope !== "project" || !isSafeProjectKey(entry.projectKey)) {
			return undefined;
		}
		const cached = this.vaults.get(entry.projectKey);
		if (cached?.vault.project) return cached.vault.project;
		const metaPath = getProjectMetaPath(getScopeDir(getVaultRoot(this.agentDir), "project", entry.projectKey));
		const raw = readSingleLinkTextFileSync(metaPath, { maxBytes: 4_096 });
		let parsed: { root?: unknown } | undefined;
		try {
			parsed = raw === undefined ? undefined : (JSON.parse(raw) as { root?: unknown });
		} catch {
			throw new AppServerError("NOT_FOUND");
		}
		const root = parsed?.root;
		if (typeof root !== "string" || root.length === 0) throw new AppServerError("NOT_FOUND");
		return { root, projectKey: entry.projectKey, source: "git" };
	}

	async view(params: ClientParams<"memory/get">): Promise<ClientResult<"memory/get">> {
		const summary = params.sessionId === undefined ? undefined : this.catalog.get(params.sessionId).summary;
		const project =
			summary === undefined || summary.cwd === null
				? undefined
				: resolveVaultProject(summary.cwd, summary.cwdOrigin);
		const root = getVaultRoot(this.agentDir);
		const memory = this.settingsManager.getMemorySettings();
		const dream = memory.dream ?? {};
		const model =
			typeof dream.model?.provider === "string" &&
			dream.model.provider.length > 0 &&
			typeof dream.model.modelId === "string" &&
			dream.model.modelId.length > 0
				? { provider: dream.model.provider, modelId: dream.model.modelId }
				: undefined;
		const dreamSettings = resolveDreamSettings(memory, this.settingsManager.getAutoMemoryEnabled());
		const modelAvailable = this.resolveDreamDeps(dreamSettings) !== undefined;
		// Only pay for the session scan + lock probe when a run could be eligible.
		const nextEligible =
			dreamSettings.enabled &&
			modelAvailable &&
			(
				await checkDreamGate({
					agentDir: this.agentDir,
					settings: dreamSettings,
					sessions: filterDreamSessionPaths(this.catalog.getMemorySessionPaths()).sessions,
					modelAvailable: true,
				})
			).eligible;
		const state = readDreamState(this.agentDir);
		return {
			enabled: this.settingsManager.getAutoMemoryEnabled(),
			dream: {
				enabled: dream.enabled !== false,
				...(model ? { model } : {}),
				minHours: boundedInteger(dream.minHours, DREAM_DEFAULTS.minHours, 1, 8_760),
				minSessions: boundedInteger(dream.minSessions, DREAM_DEFAULTS.minSessions, 1, 100_000),
				maxUnusedDays: boundedInteger(dream.maxUnusedDays, DREAM_DEFAULTS.maxUnusedDays, 1, 3_650),
				...(state.lastRunAt !== undefined ? { lastRunAt: state.lastRunAt } : {}),
				modelAvailable,
				nextEligible,
				...(state.lastRun ? { lastRun: state.lastRun } : {}),
			},
			activeContext: memory.activeContext === true,
			vault: {
				globalDir: getScopeDir(root, "global"),
				...(project
					? { projectDir: getScopeDir(root, "project", project.projectKey), projectRoot: project.root }
					: {}),
			},
			...(summary === undefined
				? {}
				: { session: { useMemory: summary.useMemory, contributeMemory: summary.contributeMemory } }),
		};
	}

	async update(params: ClientParams<"memory/update">): Promise<ClientResult<"memory/get">> {
		if (params.enabled !== undefined) this.settingsManager.setAutoMemoryEnabled(params.enabled);
		if (params.dream !== undefined || params.activeContext !== undefined) {
			const memory = this.settingsManager.getMemorySettings();
			const next = { ...memory };
			if (params.activeContext !== undefined) next.activeContext = params.activeContext;
			if (params.dream !== undefined) {
				const dream = { ...(memory.dream ?? {}) };
				if (params.dream.enabled !== undefined) dream.enabled = params.dream.enabled;
				if (params.dream.model !== undefined) dream.model = params.dream.model ?? undefined;
				if (params.dream.minHours !== undefined) dream.minHours = params.dream.minHours;
				if (params.dream.minSessions !== undefined) dream.minSessions = params.dream.minSessions;
				if (params.dream.maxUnusedDays !== undefined) dream.maxUnusedDays = params.dream.maxUnusedDays;
				if (Object.keys(dream).length > 0) next.dream = dream;
				else delete next.dream;
			}
			this.settingsManager.setMemorySettings(next);
		}
		await this.settingsManager.flushOrThrow();
		return await this.view(params);
	}

	listNotes(params: ClientParams<"memory/notes/list">): ClientResult<"memory/notes/list"> {
		const project =
			params.scope === "project"
				? this.projectForScope(params.sessionId, "project")
				: this.projectForSession(params.sessionId);
		const { vault, search } = this.entryFor(project);
		const limit = params.limit ?? MAX_HISTORY_ITEMS;
		if (params.query !== undefined) {
			return {
				notes: search
					.search(params.query, {
						scope: params.scope ?? "all",
						type: params.type,
						limit,
						recordUsage: false,
					})
					.map((hit) => ({
						scope: hit.scope,
						slug: hit.slug,
						type: hit.type,
						name: hit.name,
						description: hit.description,
						updated: hit.updated,
						snippet: hit.snippet,
						score: hit.score,
					})),
			};
		}
		const scopes = params.scope === undefined ? (["project", "global"] as const) : [params.scope];
		const notes: ClientResult<"memory/notes/list">["notes"] = [];
		for (const scope of scopes) {
			if (!vault.hasScope(scope)) continue;
			for (const note of vault.listNotes(scope)) {
				if (params.type !== undefined && note.frontmatter.type !== params.type) continue;
				notes.push({
					scope: note.scope,
					slug: note.slug,
					type: note.frontmatter.type,
					name: note.frontmatter.name,
					description: note.frontmatter.description,
					updated: note.frontmatter.updated,
				});
			}
		}
		notes.sort((left, right) => right.updated.localeCompare(left.updated) || left.slug.localeCompare(right.slug));
		return { notes: notes.slice(0, limit) };
	}

	readNote(params: ClientParams<"memory/notes/read">): ClientResult<"memory/notes/read"> {
		const project = this.projectForScope(params.sessionId, params.scope);
		const { vault } = this.entryFor(project);
		const note = vault.readNote(params.scope, params.slug);
		if (!note) throw new AppServerError("NOT_FOUND");
		return { note: noteView(note, vault.backlinks(params.scope, params.slug)) };
	}

	async writeNote(params: ClientParams<"memory/notes/write">): Promise<ClientResult<"memory/notes/write">> {
		const project = this.projectForScope(params.sessionId, params.scope);
		const { vault } = this.entryFor(project);
		const { sessionId: _sessionId, ...request } = params;
		const result = await vault.write(request, USER_ACTOR);
		if (!result.ok) return { ok: false, error: result.error };
		return {
			ok: true,
			changeId: result.changeId,
			target: result.target,
			...(result.warning ? { warning: result.warning } : {}),
		};
	}

	history(params: ClientParams<"memory/history/list">): ClientResult<"memory/history/list"> {
		return {
			entries: readChangelog(getVaultRoot(this.agentDir), params.limit ?? 50)
				.map(changelogEntryView)
				.filter((entry): entry is MemoryChangelogEntryView => entry !== undefined),
		};
	}

	/**
	 * Resolve one changelog entry to a display patch: the pre-change snapshot
	 * against the target's current content. The snapshot path stays server-side;
	 * only the entry view and the rendered patch cross the wire.
	 */
	historyRead(params: ClientParams<"memory/history/read">): ClientResult<"memory/history/read"> {
		const root = getVaultRoot(this.agentDir);
		const entry = readChangelog(root).find((candidate) => candidate.id === params.changeId);
		if (!entry) throw new AppServerError("NOT_FOUND");
		const before = typeof entry.snapshot === "string" ? readSnapshot(root, entry.snapshot) : undefined;
		// "after" is the target's current file; a rename's post-change slug wins.
		const target =
			entry.newSlug !== undefined &&
			typeof entry.target === "object" &&
			entry.target !== null &&
			"slug" in entry.target
				? { slug: entry.newSlug }
				: entry.target;
		const scopeDir =
			entry.scope === "project"
				? isSafeProjectKey(entry.projectKey)
					? getScopeDir(root, "project", entry.projectKey)
					: undefined
				: getScopeDir(root, "global");
		// Persisted changelog fields only reach the filesystem after validation.
		const targetPath = (() => {
			if (scopeDir === undefined || typeof target !== "object" || target === null) return undefined;
			if ("slug" in target) {
				return typeof target.slug === "string" && isSafeSlug(target.slug)
					? getNotePath(scopeDir, target.slug)
					: undefined;
			}
			if ("block" in target) {
				return isPinnedBlock(target.block) ? getPinnedPath(scopeDir, target.block) : undefined;
			}
			return undefined;
		})();
		const after = targetPath === undefined ? undefined : readSingleLinkTextFileSync(targetPath);
		const label =
			typeof target === "object" && target !== null
				? "slug" in target
					? `notes/${String(target.slug)}`
					: `_pinned/${String(target.block)}`
				: "unknown";
		const patch =
			before === after || (before === undefined && after === undefined)
				? undefined
				: generateUnifiedPatch(`${entry.scope}/${label}.md`, before ?? "", after ?? "");
		const view = changelogEntryView(entry);
		if (!view) throw new AppServerError("NOT_FOUND");
		return { entry: view, ...(patch === undefined ? {} : { patch }) };
	}

	async undo(params: ClientParams<"memory/undo">): Promise<ClientResult<"memory/undo">> {
		const entries = readChangelog(getVaultRoot(this.agentDir));
		const entry = entries.find((candidate) => candidate.id === params.changeId);
		if (!entry) return { ok: false, error: `unknown change ${params.changeId}` };
		// Route by the operation's primary entry: a rename group's members can be
		// project-scoped legs owned by a different vault than the rename itself.
		const primary = entries.find((candidate) => candidate.id === (entry.operationId ?? entry.id)) ?? entry;
		const { vault } = this.entryFor(this.projectForEntry(primary));
		const result = await vault.undo(params.changeId, USER_ACTOR);
		return result.ok ? { ok: true } : { ok: false, error: result.error };
	}

	async undoRun(params: ClientParams<"memory/undoRun">): Promise<ClientResult<"memory/undoRun">> {
		return await undoMemoryRun({
			agentDir: this.agentDir,
			runId: params.runId,
			actor: USER_ACTOR,
			events: this.events,
		});
	}

	/** Manual `memory/dream/run` trigger: ignores timing/count thresholds, still needs a model and the lock. */
	async dreamRun(_params: ClientParams<"memory/dream/run">): Promise<ClientResult<"memory/dream/run">> {
		const result = await this.executeDream(true);
		if (result.ran) return { ok: true, runId: result.runId };
		return {
			ok: false,
			error: dreamRunError(result),
			...(result.runId !== undefined ? { runId: result.runId } : {}),
		};
	}

	/**
	 * Kick a gated dream check now and every `intervalMs` until the returned stop
	 * runs. Never blocks the caller; a failed run only lands in the server log.
	 */
	startDreamScheduler(intervalMs = DREAM_CHECK_INTERVAL_MS): () => void {
		let stopped = false;
		const tick = () => {
			if (stopped) return;
			void this.executeDream(false).then(
				(result) => {
					if (!result.ran && result.reason === "error") {
						console.error(`Memory dream failed: ${result.error ?? "unknown error"}`);
					}
				},
				(error) => console.error("Memory dream failed:", error),
			);
		};
		tick();
		const interval = setInterval(tick, intervalMs);
		interval.unref();
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	}

	private async executeDream(ignoreGate: boolean): Promise<DreamRunResult> {
		const memory = this.settingsManager.getMemorySettings();
		const settings = resolveDreamSettings(memory, this.settingsManager.getAutoMemoryEnabled());
		const deps = this.resolveDreamDeps(settings);
		if (!deps) return { ran: false, reason: "no-model" };
		if (!ignoreGate && !settings.enabled) return { ran: false, reason: "disabled" };
		// Enumerate from the catalog so a run and the UI agree on the session set.
		await this.catalog.refresh();
		const enumerated = filterDreamSessionPaths(this.catalog.getMemorySessionPaths());
		return await runDream({
			agentDir: this.agentDir,
			settings,
			model: deps.model,
			promptFn: deps.promptFn,
			promptAgent: deps.promptAgent,
			sessions: enumerated.sessions,
			existingIds: enumerated.existingIds,
			events: this.events,
			ignoreGate,
			activeContextEnabled: () => this.settingsManager.getMemorySettings().activeContext === true,
		});
	}

	private resolveDreamDeps(settings: DreamSettings): DreamRunDeps | undefined {
		if (this.dreamDeps) return this.dreamDeps(settings);
		const registry = this.modelRegistry;
		if (!registry) return undefined;
		registry.refresh();
		const model = resolveDreamModel(registry, settings.model);
		if (!model) return undefined;
		const llm: DreamLlmDeps = {
			model,
			streamFn: (m, context, options) => registry.streamSimple(m, context, options),
			getApiKey: (provider) => registry.getApiKeyForProvider(provider),
			sessionId: `dream-${randomUUID()}`,
		};
		return {
			model: { provider: model.provider, modelId: model.id },
			promptFn: createDreamPromptFn(llm),
			promptAgent: createDreamPromptAgent(llm),
		};
	}
}
