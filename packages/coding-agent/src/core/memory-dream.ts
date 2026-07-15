import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Agent, type AgentMessage, type StreamFn, type ThinkingLevel } from "@arcmind/agent-core";
import type { Model } from "@arcmind/ai/compat";
import lockfile from "proper-lockfile";
import {
	AUTO_MEMORY_MAX_BYTES,
	AUTO_MEMORY_MAX_LINES,
	type AutoMemorySnapshot,
	getAutoMemoryPaths,
	getAutoMemoryRoot,
} from "./auto-memory.ts";
import { serializeConversation } from "./compaction/utils.ts";
import { convertToLlm } from "./messages.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createLsTool } from "./tools/ls.ts";
import { createReadTool } from "./tools/read.ts";

export type DreamScope = "global" | "project";
export type DreamTrigger = "manual" | "threshold" | "overflow";
export type DreamRunStatus = "success" | "skipped" | "failed" | "cancelled";

export interface DreamPlanWrite {
	scope: DreamScope;
	file: string;
	content: string;
}

export interface DreamPlanDelete {
	scope: DreamScope;
	file: string;
}

export interface DreamPlan {
	writes: DreamPlanWrite[];
	deletes: DreamPlanDelete[];
}

export interface DreamScopeChanges {
	created: string[];
	updated: string[];
	deleted: string[];
}

export interface DreamChanges {
	global: DreamScopeChanges;
	project: DreamScopeChanges;
}

export interface DreamActiveRun {
	id: string;
	sessionId: string;
	project: string;
	trigger: DreamTrigger;
	startedAt: string;
}

export interface DreamHistoryRecord extends DreamActiveRun {
	completedAt: string;
	durationMs: number;
	status: DreamRunStatus;
	changes: DreamChanges;
	reason?: string;
}

export interface DreamStatusSnapshot {
	enabled: boolean;
	active?: DreamActiveRun;
	recent: DreamHistoryRecord[];
}

interface DreamScopeSnapshot {
	root: string;
	indexFile: "MEMORY.md" | "project.md";
	files: ReadonlyMap<string, string>;
	fingerprint: string;
}

export interface DreamMemorySnapshot {
	agentDir: string;
	cwd: string;
	global: DreamScopeSnapshot;
	project: DreamScopeSnapshot;
}

export interface PreparedDreamCommit {
	next: {
		global: ReadonlyMap<string, string>;
		project: ReadonlyMap<string, string>;
	};
	changes: DreamChanges;
}

const SAFE_MEMORY_FILE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/;
const INDEX_ENTRY = /^- \[([^\]]+\.md)\]\(\1\) — (.{1,120})$/u;
// ponytail: one memory-root lock keeps global/project commits atomic; split only after measured contention.
const DREAM_LOCK_OPTIONS = {
	realpath: false,
	stale: 10_000,
	retries: { retries: 8, factor: 1.5, minTimeout: 25, maxTimeout: 250, randomize: true },
} as const;

async function releaseDreamLock(release: () => Promise<void>): Promise<void> {
	try {
		await release();
	} catch {
		// Releasing a stale/externally removed lock must not replace the commit result or its original error.
	}
}

export const DREAM_SYSTEM_PROMPT = `You are ArcMind's silent long-term memory maintainer.

Use only verified, durable evidence from explicit user statements or authoritative tool/file results. Assistant proposals are not facts unless the user adopted them. The supplied conversation excludes compaction and branch summaries; never reconstruct or invent missing facts.

Global facts apply across projects. Project facts are useful only in the current project. The current working directory defines the project and need not be software. Put uncertain scope in project memory and never duplicate a fact across scopes.

Inspect the existing indexes first. Use ls only on the two supplied memory directories, grep only on a specific allowed .md file, and read with bounded offset/limit values. Do not read every detail file unless necessary.

Each scope is flat. MEMORY.md and project.md are link-only indexes containing one optional # title, blank lines, then entries in this exact form:
- [file.md](file.md) — an accurate retrieval sentence of at most 120 characters

Store facts only in nonempty detail files, one topic per file. Every detail file has exactly one index entry. Leave no duplicate topics, broken links, or orphan files. Keep each index within 200 lines and 25KB. Never store secrets, guesses, temporary state, raw conversation, raw tool output, system prompts, or unrelated projects.

Return exactly one JSON object and no prose:
{"writes":[{"scope":"global|project","file":"basename.md","content":"complete file content"}],"deletes":[{"scope":"global|project","file":"basename.md"}]}

Use empty arrays when no verified change is needed. Include complete content for every written file. Paths are flat basenames only.`;

export function emptyDreamChanges(): DreamChanges {
	const scope = (): DreamScopeChanges => ({ created: [], updated: [], deleted: [] });
	return { global: scope(), project: scope() };
}

function assertNoSymlink(path: string): void {
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
		throw new Error(`Dream memory path cannot be a symbolic link: ${path}`);
	}
}

function fingerprint(files: ReadonlyMap<string, string>): string {
	const hash = createHash("sha256");
	for (const [file, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(file).update("\0").update(content).update("\0");
	}
	return hash.digest("hex");
}

function snapshotScope(root: string, indexFile: "MEMORY.md" | "project.md"): DreamScopeSnapshot {
	const files = new Map<string, string>();
	if (existsSync(root)) {
		const stat = lstatSync(root);
		if (!stat.isDirectory()) throw new Error(`Dream memory path is not a directory: ${root}`);
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.name.endsWith(".md")) continue;
			const path = join(root, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Dream memory file cannot be a symbolic link: ${path}`);
			if (!entry.isFile()) continue;
			const fileStat = lstatSync(path);
			if (fileStat.isFile() && !fileStat.isSymbolicLink()) files.set(entry.name, readFileSync(path, "utf8"));
		}
	}
	return { root, indexFile, files, fingerprint: fingerprint(files) };
}

export function snapshotDreamMemory(agentDir: string, cwd: string): DreamMemorySnapshot {
	const paths = getAutoMemoryPaths(agentDir, cwd);
	const memoryRoot = getAutoMemoryRoot(agentDir);
	assertNoSymlink(memoryRoot);
	assertNoSymlink(join(memoryRoot, "projects"));
	assertNoSymlink(paths.project.directory);
	return {
		agentDir,
		cwd,
		global: snapshotScope(paths.global.directory, "MEMORY.md"),
		project: snapshotScope(paths.project.directory, "project.md"),
	};
}

function scopeName(scope: DreamScope): "Global" | "Project" {
	return scope === "global" ? "Global" : "Project";
}

function validateScope(scope: DreamScope, files: ReadonlyMap<string, string>, indexFile: string): void {
	const label = scopeName(scope);
	for (const [file, content] of files) {
		if (!content.trim()) throw new Error(`${label} memory file ${file} is empty`);
	}

	const detailFiles = [...files.keys()].filter((file) => file !== indexFile);
	const index = files.get(indexFile);
	if (index === undefined) {
		if (detailFiles.length > 0) {
			throw new Error(`${label} memory detail ${detailFiles.sort()[0]} has no ${indexFile} entry`);
		}
		return;
	}

	const lines = index.split(/\r?\n/);
	if (lines.length > AUTO_MEMORY_MAX_LINES || Buffer.byteLength(index) > AUTO_MEMORY_MAX_BYTES) {
		throw new Error(`${label} memory index exceeds 200 lines or 25KB`);
	}

	const links = new Set<string>();
	let sawContent = false;
	let sawTitle = false;
	for (const line of lines) {
		if (!line.trim()) continue;
		if (line.startsWith("# ")) {
			if (sawContent || sawTitle) throw new Error(`${label} memory index has an invalid title`);
			sawTitle = true;
			sawContent = true;
			continue;
		}
		sawContent = true;
		const match = INDEX_ENTRY.exec(line);
		if (!match) throw new Error(`${label} memory index has an invalid entry: ${line}`);
		const file = match[1]!;
		if (!SAFE_MEMORY_FILE.test(file) || file === indexFile) {
			throw new Error(`${label} memory index has an invalid detail link: ${file}`);
		}
		if (links.has(file)) throw new Error(`${label} memory index links to ${file} more than once`);
		if (!files.has(file)) {
			throw new Error(`${label} memory index links to ${file}, but that detail file does not exist`);
		}
		links.add(file);
	}

	for (const file of detailFiles) {
		if (!links.has(file)) throw new Error(`${label} memory detail ${file} has no ${indexFile} entry`);
	}
}

function diffScope(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): DreamScopeChanges {
	const created: string[] = [];
	const updated: string[] = [];
	const deleted: string[] = [];
	for (const [file, content] of after) {
		if (!before.has(file)) created.push(file);
		else if (before.get(file) !== content) updated.push(file);
	}
	for (const file of before.keys()) if (!after.has(file)) deleted.push(file);
	return { created: created.sort(), updated: updated.sort(), deleted: deleted.sort() };
}

function isDreamScope(value: unknown): value is DreamScope {
	return value === "global" || value === "project";
}

export function prepareDreamCommit(snapshot: DreamMemorySnapshot, plan: DreamPlan): PreparedDreamCommit {
	const next = {
		global: new Map(snapshot.global.files),
		project: new Map(snapshot.project.files),
	};
	const operations = new Set<string>();
	const applyOperation = (scope: unknown, file: unknown, action: "write" | "delete", content?: unknown): void => {
		if (!isDreamScope(scope)) throw new Error("Dream plan contains an unknown scope");
		if (typeof file !== "string" || !SAFE_MEMORY_FILE.test(file)) {
			throw new Error("Dream file names must be flat .md basenames");
		}
		const key = `${scope}:${file}`;
		if (operations.has(key)) throw new Error("Dream plan contains duplicate operations for the same file");
		operations.add(key);
		if (action === "write") {
			if (typeof content !== "string") throw new Error("Dream write content must be a string");
			next[scope].set(file, content);
		} else {
			next[scope].delete(file);
		}
	};

	for (const write of plan.writes) applyOperation(write.scope, write.file, "write", write.content);
	for (const deletion of plan.deletes) applyOperation(deletion.scope, deletion.file, "delete");
	validateScope("global", next.global, snapshot.global.indexFile);
	validateScope("project", next.project, snapshot.project.indexFile);
	return {
		next,
		changes: {
			global: diffScope(snapshot.global.files, next.global),
			project: diffScope(snapshot.project.files, next.project),
		},
	};
}

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function changedFiles(changes: DreamScopeChanges): string[] {
	return [...changes.created, ...changes.updated, ...changes.deleted];
}

function applyScope(scope: DreamScopeSnapshot, next: ReadonlyMap<string, string>, changes: DreamScopeChanges): void {
	const details = changedFiles(changes).filter((file) => file !== scope.indexFile);
	for (const file of details) {
		const content = next.get(file);
		if (content !== undefined) atomicWrite(join(scope.root, file), content);
	}
	if (changedFiles(changes).includes(scope.indexFile)) {
		const index = next.get(scope.indexFile);
		if (index === undefined) rmSync(join(scope.root, scope.indexFile), { force: true });
		else atomicWrite(join(scope.root, scope.indexFile), index);
	}
	for (const file of changes.deleted) {
		if (file !== scope.indexFile) rmSync(join(scope.root, file), { force: true });
	}
}

function restoreScope(scope: DreamScopeSnapshot, changes: DreamScopeChanges): void {
	const files = changedFiles(changes);
	for (const file of files.filter((name) => name !== scope.indexFile)) {
		const content = scope.files.get(file);
		if (content === undefined) rmSync(join(scope.root, file), { force: true });
		else atomicWrite(join(scope.root, file), content);
	}
	if (files.includes(scope.indexFile)) {
		const content = scope.files.get(scope.indexFile);
		if (content === undefined) rmSync(join(scope.root, scope.indexFile), { force: true });
		else atomicWrite(join(scope.root, scope.indexFile), content);
	}
}

export async function commitDreamPlan(
	snapshot: DreamMemorySnapshot,
	prepared: PreparedDreamCommit,
	signal?: AbortSignal,
): Promise<{ status: "success" | "skipped"; changes: DreamChanges; reason?: string }> {
	const root = getAutoMemoryRoot(snapshot.agentDir);
	assertNoSymlink(root);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(root, DREAM_LOCK_OPTIONS);
	try {
		signal?.throwIfAborted();
		const live = snapshotDreamMemory(snapshot.agentDir, snapshot.cwd);
		if (
			live.global.fingerprint !== snapshot.global.fingerprint ||
			live.project.fingerprint !== snapshot.project.fingerprint
		) {
			return {
				status: "skipped",
				changes: emptyDreamChanges(),
				reason: "Memory changed while Dream was running",
			};
		}
		try {
			applyScope(snapshot.global, prepared.next.global, prepared.changes.global);
			applyScope(snapshot.project, prepared.next.project, prepared.changes.project);
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			for (const [scope, changes] of [
				[snapshot.global, prepared.changes.global],
				[snapshot.project, prepared.changes.project],
			] as const) {
				try {
					restoreScope(scope, changes);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError([error, ...rollbackErrors], "Dream commit failed and rollback was incomplete");
			}
			throw error;
		}
		return { status: "success", changes: prepared.changes };
	} finally {
		await releaseDreamLock(release);
	}
}

export function getDreamHistoryPath(agentDir: string): string {
	return join(getAutoMemoryRoot(agentDir), "dream-history.jsonl");
}

export async function appendDreamHistory(agentDir: string, record: DreamHistoryRecord): Promise<void> {
	const root = getAutoMemoryRoot(agentDir);
	assertNoSymlink(root);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(root, DREAM_LOCK_OPTIONS);
	try {
		const path = getDreamHistoryPath(agentDir);
		assertNoSymlink(path);
		appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(path, 0o600);
	} finally {
		await releaseDreamLock(release);
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isScopeChanges(value: unknown): value is DreamScopeChanges {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return isStringArray(record.created) && isStringArray(record.updated) && isStringArray(record.deleted);
}

function parseHistoryRecord(line: string): DreamHistoryRecord | undefined {
	try {
		const value = JSON.parse(line) as Record<string, unknown>;
		if (!value || typeof value !== "object") return undefined;
		const changes = value.changes as Record<string, unknown> | undefined;
		if (
			typeof value.id !== "string" ||
			typeof value.sessionId !== "string" ||
			typeof value.project !== "string" ||
			!isDreamTrigger(value.trigger) ||
			typeof value.startedAt !== "string" ||
			typeof value.completedAt !== "string" ||
			typeof value.durationMs !== "number" ||
			!Number.isFinite(value.durationMs) ||
			value.durationMs < 0 ||
			!isDreamRunStatus(value.status) ||
			!changes ||
			!isScopeChanges(changes.global) ||
			!isScopeChanges(changes.project) ||
			(value.reason !== undefined && typeof value.reason !== "string")
		) {
			return undefined;
		}
		return value as unknown as DreamHistoryRecord;
	} catch {
		return undefined;
	}
}

function isDreamTrigger(value: unknown): value is DreamTrigger {
	return value === "manual" || value === "threshold" || value === "overflow";
}

function isDreamRunStatus(value: unknown): value is DreamRunStatus {
	return value === "success" || value === "skipped" || value === "failed" || value === "cancelled";
}

export function readDreamHistory(agentDir: string, limit = 10): DreamHistoryRecord[] {
	if (!Number.isFinite(limit)) return [];
	const requested = Math.max(0, Math.floor(limit));
	if (requested === 0) return [];
	const path = getDreamHistoryPath(agentDir);
	let fd: number | undefined;
	try {
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) return [];
		const size = statSync(path).size;
		fd = openSync(path, "r");
		let position = size;
		let partialLine: Buffer[] = [];
		const records: DreamHistoryRecord[] = [];
		const addLine = (prefix: Buffer): boolean => {
			const line = partialLine.length > 0 ? Buffer.concat([prefix, ...partialLine.reverse()]) : prefix;
			partialLine = [];
			if (line.length === 0) return false;
			const record = parseHistoryRecord(line.toString("utf8"));
			if (record) records.push(record);
			return records.length === requested;
		};
		while (position > 0) {
			const length = Math.min(64 * 1024, position);
			position -= length;
			const chunk = Buffer.alloc(length);
			const bytesRead = readSync(fd, chunk, 0, length, position);
			let lineEnd = bytesRead;
			for (let index = bytesRead - 1; index >= 0; index--) {
				if (chunk[index] !== 0x0a) continue;
				if (addLine(chunk.subarray(index + 1, lineEnd))) return records;
				lineEnd = index;
			}
			if (lineEnd > 0) partialLine.push(Buffer.from(chunk.subarray(0, lineEnd)));
		}
		addLine(Buffer.alloc(0));
		return records;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function parseDreamPlan(text: string): DreamPlan {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Dream must return exactly one JSON object");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Dream must return exactly one JSON object");
	}
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, ["deletes", "writes"])) throw new Error("Dream plan contains unknown fields");
	if (!Array.isArray(record.writes) || !Array.isArray(record.deletes)) {
		throw new Error("Dream plan writes and deletes must be arrays");
	}
	const writes = record.writes.map((item): DreamPlanWrite => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Dream write is invalid");
		const write = item as Record<string, unknown>;
		if (!exactKeys(write, ["content", "file", "scope"])) throw new Error("Dream plan contains unknown fields");
		if (!isDreamScope(write.scope) || typeof write.file !== "string" || typeof write.content !== "string") {
			throw new Error("Dream write is invalid");
		}
		return { scope: write.scope, file: write.file, content: write.content };
	});
	const deletes = record.deletes.map((item): DreamPlanDelete => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Dream delete is invalid");
		const deletion = item as Record<string, unknown>;
		if (!exactKeys(deletion, ["file", "scope"])) throw new Error("Dream plan contains unknown fields");
		if (!isDreamScope(deletion.scope) || typeof deletion.file !== "string") {
			throw new Error("Dream delete is invalid");
		}
		return { scope: deletion.scope, file: deletion.file };
	});
	return { writes, deletes };
}

export function isAllowedDreamToolPath(
	inputPath: string,
	toolName: "read" | "grep" | "ls",
	paths: AutoMemorySnapshot,
): boolean {
	const path = resolve(isAbsolute(inputPath) ? inputPath : join(paths.global.directory, inputPath));
	const globalDirectory = resolve(paths.global.directory);
	const projectDirectory = resolve(paths.project.directory);
	if (toolName === "ls") return path === globalDirectory || path === projectDirectory;
	if (dirname(path) !== globalDirectory && dirname(path) !== projectDirectory) return false;
	if (!path.endsWith(".md") || !existsSync(path)) return false;
	const stat = lstatSync(path);
	return stat.isFile() && !stat.isSymbolicLink();
}

export interface GenerateMemoryDreamPlanOptions {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	streamFn: StreamFn;
	getApiKey?: Agent["getApiKey"];
	transport?: Agent["transport"];
	thinkingBudgets?: Agent["thinkingBudgets"];
	maxRetryDelayMs?: number;
	sessionId: string;
	cwd: string;
	messages: AgentMessage[];
	paths: AutoMemorySnapshot;
	signal: AbortSignal;
}

export async function generateMemoryDreamPlan(options: GenerateMemoryDreamPlanOptions): Promise<DreamPlan> {
	const memoryRoot = resolve(options.paths.global.directory);
	assertNoSymlink(memoryRoot);
	assertNoSymlink(join(memoryRoot, "projects"));
	assertNoSymlink(resolve(options.paths.project.directory));
	const evidence = options.messages.filter(
		(message) => message.role !== "compactionSummary" && message.role !== "branchSummary",
	);
	const conversation = serializeConversation(convertToLlm(evidence));
	const prompt = `<dream_scope>
Global directory: ${options.paths.global.directory}
Global index: ${options.paths.global.indexPath}
Project directory: ${options.paths.project.directory}
Project index: ${options.paths.project.indexPath}
Current project: ${options.cwd}
</dream_scope>

<conversation_evidence>
${conversation}
</conversation_evidence>`;
	const dreamAgent = new Agent({
		initialState: {
			systemPrompt: DREAM_SYSTEM_PROMPT,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			tools: [
				createReadTool(options.paths.global.directory),
				createGrepTool(options.paths.global.directory),
				createLsTool(options.paths.global.directory),
			],
		},
		streamFn: options.streamFn,
		...(options.getApiKey ? { getApiKey: options.getApiKey } : {}),
		...(options.transport ? { transport: options.transport } : {}),
		...(options.thinkingBudgets ? { thinkingBudgets: options.thinkingBudgets } : {}),
		...(options.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
		sessionId: `${options.sessionId}:dream`,
		toolExecution: "sequential",
		beforeToolCall: async ({ toolCall, args }) => {
			const toolName = toolCall.name;
			const path = (args as { path?: unknown }).path;
			if (
				(toolName !== "read" && toolName !== "grep" && toolName !== "ls") ||
				typeof path !== "string" ||
				!isAllowedDreamToolPath(path, toolName, options.paths)
			) {
				return {
					block: true,
					reason: "Dream can access only global and current-project memory Markdown files",
				};
			}
			return undefined;
		},
	});
	const abort = () => dreamAgent.abort();
	options.signal.throwIfAborted();
	options.signal.addEventListener("abort", abort, { once: true });
	try {
		await dreamAgent.prompt(prompt);
	} finally {
		options.signal.removeEventListener("abort", abort);
	}
	const finalMessage = [...dreamAgent.state.messages].reverse().find((message) => message.role === "assistant");
	if (!finalMessage || finalMessage.stopReason !== "stop") {
		throw new Error("Dream did not finish with a complete response");
	}
	const output = finalMessage.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
	return parseDreamPlan(output);
}

export interface MemoryDreamRunOptions extends DreamActiveRun {
	agentDir: string;
	cwd: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	streamFn: StreamFn;
	getApiKey?: Agent["getApiKey"];
	transport?: Agent["transport"];
	thinkingBudgets?: Agent["thinkingBudgets"];
	maxRetryDelayMs?: number;
	messages: AgentMessage[];
	signal: AbortSignal;
	generatePlan?: typeof generateMemoryDreamPlan;
}

function hasDreamChanges(changes: DreamChanges): boolean {
	return [...changedFiles(changes.global), ...changedFiles(changes.project)].length > 0;
}

function errorReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 500) || "Unknown Dream error";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export async function runMemoryDream(options: MemoryDreamRunOptions): Promise<DreamHistoryRecord> {
	let status: DreamRunStatus = "failed";
	let changes = emptyDreamChanges();
	let reason: string | undefined;
	try {
		options.signal.throwIfAborted();
		const snapshot = snapshotDreamMemory(options.agentDir, options.cwd);
		const plan = await (options.generatePlan ?? generateMemoryDreamPlan)({
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			streamFn: options.streamFn,
			...(options.getApiKey ? { getApiKey: options.getApiKey } : {}),
			...(options.transport ? { transport: options.transport } : {}),
			...(options.thinkingBudgets ? { thinkingBudgets: options.thinkingBudgets } : {}),
			...(options.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
			sessionId: options.sessionId,
			cwd: options.cwd,
			messages: options.messages,
			paths: getAutoMemoryPaths(options.agentDir, options.cwd),
			signal: options.signal,
		});
		options.signal.throwIfAborted();
		const prepared = prepareDreamCommit(snapshot, plan);
		if (!hasDreamChanges(prepared.changes)) {
			status = "skipped";
			reason = "No durable memory changes";
		} else {
			const commit = await commitDreamPlan(snapshot, prepared, options.signal);
			status = commit.status;
			changes = commit.changes;
			reason = commit.reason;
		}
	} catch (error) {
		status = isAbortError(error, options.signal) ? "cancelled" : "failed";
		reason = status === "cancelled" ? "Dream cancelled" : errorReason(error);
	}
	const completedAt = new Date().toISOString();
	const startedAtMs = Date.parse(options.startedAt);
	const record: DreamHistoryRecord = {
		id: options.id,
		sessionId: options.sessionId,
		project: options.project,
		trigger: options.trigger,
		startedAt: options.startedAt,
		completedAt,
		durationMs: Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0,
		status,
		changes,
		...(reason ? { reason } : {}),
	};
	try {
		await appendDreamHistory(options.agentDir, record);
	} catch {
		// Audit failure must not change the memory or Compact result.
	}
	return record;
}
