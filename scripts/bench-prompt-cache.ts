#!/usr/bin/env node
/**
 * Prompt-cache evaluation harness (docs/plans/2026-09-19-prompt-cache-execution-plan.md
 * Task 13). One invocation measures one variant:
 *
 *   node --import tsx scripts/bench-prompt-cache.ts --mode offline --variant stable --output out.json
 *
 * --mode offline|live   default offline. Live requires METIS_CACHE_EVAL_LIVE=1
 *                       plus --provider/--model/--max-requests.
 * --variant baseline|stable|pressure
 *     baseline: historyAnchors=false + microcompaction=off (pre-change wire
 *               behaviour on a fresh session; no migrated view is un-expanded).
 *     stable:   historyAnchors=true  + microcompaction=legacy (current defaults).
 *     pressure: historyAnchors=true  + microcompaction=pressure.
 * --output <path>       JSON report destination.
 * --reps <n>            task repetitions (default 5).
 *
 * Offline mode runs real AgentSession + real tools on synthetic mkdtemp projects
 * with a deterministic scripted provider stream (no oauth, no user auth file,
 * no external network). Token usage is simulated by prefix matching consecutive
 * serialized request payloads (usageSimulated=true); real provider usage is only
 * collected in live mode.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentMessage } from "../packages/agent/src/index.ts";
import { Agent } from "../packages/agent/src/index.ts";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "../packages/ai/src/index.ts";
import { getModel } from "../packages/ai/src/compat.ts";
import type { AssistantMessage, Context, Model, StreamOptions, Usage } from "../packages/ai/src/types.ts";
import { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";
import { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import type { ResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { createCodingTools } from "../packages/coding-agent/src/index.ts";

// ---------------------------------------------------------------------------
// CLI gates (Task 13 Step 3 contract)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const value = (name: string) => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
};
const mode = value("--mode") ?? "offline";
if (mode !== "offline" && mode !== "live") throw new Error("Invalid --mode");
const variant = value("--variant") ?? "stable";
if (!["baseline", "stable", "pressure"].includes(variant)) throw new Error("Invalid --variant");
const outputPath = value("--output");
if (!outputPath) throw new Error("Missing --output <path>");
if (mode === "live" && process.env.METIS_CACHE_EVAL_LIVE !== "1") {
	throw new Error("Live evaluation requires METIS_CACHE_EVAL_LIVE=1");
}
const provider = value("--provider");
const modelId = value("--model");
const maxRequestsArg = value("--max-requests");
let maxRequests = Number.POSITIVE_INFINITY;
if (mode === "live") {
	maxRequests = Number(maxRequestsArg);
	if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
		throw new Error("Live evaluation requires --max-requests");
	}
	if (!provider || !modelId) throw new Error("Live evaluation requires provider and model");
} else if (maxRequestsArg !== undefined) {
	maxRequests = Number(maxRequestsArg);
	if (!Number.isInteger(maxRequests) || maxRequests <= 0) throw new Error("Invalid --max-requests");
}
const reps = Math.max(1, Number(value("--reps") ?? 5));

const baseCommit = (() => {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
})();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => (block as { text?: string }).text ?? "")
		.join("");
}

const toolResults = (context: Context) =>
	context.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult");

const percentile = (sorted: readonly number[], p: number): number | null =>
	sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

/** Deterministic fill: fixed-seed LCG so every run/rep produces identical bytes. */
function seededFill(length: number, seed: number): string {
	let state = seed >>> 0 || 1;
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 .,_-";
	let out = "";
	while (out.length < length) {
		state = (state * 1664525 + 1013904223) >>> 0;
		out += alphabet[state % alphabet.length];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Session factory — real AgentSession/Agent/tools, temp auth only
// ---------------------------------------------------------------------------

interface BenchSession {
	session: AgentSession;
	agent: Agent;
	manager: SessionManager;
	settings: SettingsManager;
}

const benchResourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => undefined,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
};

function promptCacheOverrides(v: string) {
	switch (v) {
		case "baseline":
			return { historyAnchors: false, microcompaction: "off" as const };
		case "pressure":
			return { historyAnchors: true, microcompaction: "pressure" as const };
		default:
			return { historyAnchors: true, microcompaction: "legacy" as const };
	}
}

function createBenchSession(root: string, reuse?: { manager: SessionManager }): BenchSession {
	const live = mode === "live";
	const model = live
		? (getModel(provider!, modelId!) as Model<"anthropic-messages"> | undefined)
		: (getModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">);
	if (!model) throw new Error(`Model ${provider}/${modelId} not found`);
	model.contextWindow = 100_000;
	const agent = new Agent({
		initialState: { model, systemPrompt: "Bench agent", tools: createCodingTools(root) },
		getApiKey: () => "bench-key",
		convertToLlm,
	});
	const manager = reuse?.manager ?? SessionManager.create(root, join(root, "sessions"));
	const settings = SettingsManager.create(root, root);
	settings.applyOverrides({ promptCache: promptCacheOverrides(variant) });
	// Offline never touches user auth: temp auth file + runtime key only. Live
	// mode intentionally resolves the real auth store (gated above).
	const auth = AuthStorage.create(live ? undefined : join(root, "auth.json"));
	if (!live) auth.setRuntimeApiKey("anthropic", "bench-key");
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager: settings,
		cwd: root,
		modelRegistry: ModelRegistry.create(auth, join(root, "models.json")),
		resourceLoader: benchResourceLoader,
	});
	if (reuse?.manager) {
		agent.state.messages = [...manager.buildSessionContext().messages];
	}
	session.subscribe(() => {});
	return { session, agent, manager, settings };
}

// ---------------------------------------------------------------------------
// Metrics plumbing
// ---------------------------------------------------------------------------

const counters = { requests: 0, limitHit: false };

/** Serialized request prefix used for simulated cache accounting. */
const requestKey = (context: Context) =>
	JSON.stringify([context.systemPrompt ?? "", context.messages, (context.tools ?? []).map((t) => t.name)]);

function commonPrefixChars(a: string | undefined, b: string): number {
	if (a === undefined) return 0;
	const bound = Math.min(a.length, b.length);
	let i = 0;
	while (i < bound && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

class SimulatedUsage {
	private previousKey: string | undefined;
	private totals = { input: 0, cacheRead: 0, cacheWrite: 0 };
	/** Simulated per-request usage (chars/4 convention, prefix-match cache read). */
	next(context: Context): Usage {
		const key = requestKey(context);
		const input = Math.ceil(key.length / 4);
		const cacheRead = Math.ceil(commonPrefixChars(this.previousKey, key) / 4);
		this.previousKey = key;
		const usage = {
			input,
			output: 8,
			cacheRead,
			cacheWrite: Math.max(0, input - cacheRead),
			totalTokens: input + 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		this.totals.input += usage.input;
		this.totals.cacheRead += usage.cacheRead;
		this.totals.cacheWrite += usage.cacheWrite;
		return usage;
	}
	snapshot() {
		return { ...this.totals };
	}
}

/** Tool results that arrive after the last bench-task user prompt (so a
 *  reopened session's hydrated history does not confuse phase-B policies). */
function resultsAfterLastPrompt(context: Context) {
	let lastUser = -1;
	context.messages.forEach((m, i) => {
		if (m.role === "user" && textOf(m).includes("bench task")) lastUser = i;
	});
	return context.messages.slice(lastUser + 1).filter((m) => m.role === "toolResult");
}

type ScriptedAction = { tool: string; args: Record<string, unknown> } | { final: string };
type Policy = (context: Context) => ScriptedAction;

interface RepMetrics {
	requestCount: number;
	toolReadbacks: number;
	compactions: number;
	durationMs: number;
	ttftMs: number | null;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	success: boolean;
	notes: string[];
}

function scriptedStream(policy: Policy, usage: SimulatedUsage, rep: RepMetrics, liveContext?: never) {
	let callIndex = 0;
	return (requestModel: Model<"anthropic-messages">, context: Context, _options?: StreamOptions) => {
		rep.requestCount++;
		counters.requests++;
		const t0 = performance.now();
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			try {
				const base = { api: requestModel.api, provider: requestModel.provider, model: requestModel.id };
				if (rep.ttftMs === null) rep.ttftMs = performance.now() - t0;
				if (counters.requests > maxRequests) {
					counters.limitHit = true;
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...fauxAssistantMessage("", { stopReason: "error", errorMessage: "max-requests reached" }),
							...base,
						},
					});
					stream.end();
					return;
				}
				const action = policy(context);
				if ("final" in action) {
					stream.push({
						type: "done",
						reason: "stop",
						message: { ...fauxAssistantMessage(action.final), ...base, usage: usage.next(context) },
					});
				} else {
					callIndex++;
					stream.push({
						type: "done",
						reason: "toolUse",
						message: {
							...fauxAssistantMessage(
								[
									{
										type: "toolCall" as const,
										id: `bench-${rep.requestCount}-${callIndex}`,
										name: action.tool,
										arguments: action.args,
									},
								],
								{ stopReason: "toolUse" },
							),
							...base,
							usage: usage.next(context),
						},
					});
				}
			} catch (error) {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) }),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					},
				});
			}
			stream.end();
		});
		return stream;
	};
}

function countCompactions(manager: SessionManager): number {
	const branch = manager.getBranch();
	const compactions = branch.filter((e) => e.type === "compaction").length;
	return compactions + manager.getContextRewrites().length;
}

async function runRep(
	name: string,
	setup: (dir: string) => void,
	prepare: ((bench: BenchSession, dir: string, rep: RepMetrics, usage: SimulatedUsage) => Promise<BenchSession>) | undefined,
	policy: Policy,
	verify: (bench: BenchSession, dir: string) => string | null,
): Promise<RepMetrics> {
	const dir = mkdtempSync(join(tmpdir(), "metis-cache-bench-"));
	const rep: RepMetrics = {
		requestCount: 0,
		toolReadbacks: 0,
		compactions: 0,
		durationMs: 0,
		ttftMs: null,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		success: false,
		notes: [],
	};
	if (counters.limitHit) {
		rep.notes.push("skipped: max-requests reached");
		rmSync(dir, { recursive: true, force: true });
		return rep;
	}
	try {
		setup(dir);
		const usage = new SimulatedUsage();
		const initial = createBenchSession(dir);
		// Deterministic permission posture: approved writes/tests allowed,
		// destructive deletion denied — used by the approved-plan task.
		const approval = async (request: { action: { command?: string } }) => {
			const command = request.action.command ?? "";
			if (/rm\s+(-[a-z]*r|-[a-z]*f[a-z]*r)/.test(command)) {
				return { decision: "deny" as const, reason: "unapproved destructive change" };
			}
			return { decision: "allow" as const };
		};
		initial.session.setPermissionApprovalHandler(approval);
		initial.manager.setPermissionPreset("auto");
		const ready = prepare ? await prepare(initial, dir, rep, usage) : initial;
		ready.session.setPermissionApprovalHandler(approval);
		ready.manager.setPermissionPreset("auto");
		if (mode === "offline") {
			ready.agent.streamFn = scriptedStream(policy, usage, rep) as never;
		}
		const started = performance.now();
		try {
			await ready.session.prompt(`bench task: ${name}`);
			await ready.agent.waitForIdle();
		} catch (error) {
			rep.notes.push(`prompt error: ${String(error)}`);
		}
		rep.durationMs = performance.now() - started;
		rep.toolReadbacks = ready.agent.state.messages.filter(
			(m) => m.role === "toolResult" && ["read", "grep", "bash"].includes(m.toolName ?? ""),
		).length;
		rep.compactions = countCompactions(ready.manager);
		const totals = usage.snapshot();
		rep.inputTokens = totals.input;
		rep.cacheReadTokens = totals.cacheRead;
		rep.cacheWriteTokens = totals.cacheWrite;
		const failure = verify(ready, dir);
		rep.success = failure === null && rep.requestCount > 0;
		if (failure) rep.notes.push(failure);
		ready.session.dispose();
		ready.manager.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return rep;
}

// ---------------------------------------------------------------------------
// Quality tasks (fixed, deterministic synthetic projects)
// ---------------------------------------------------------------------------

const ROOT_CAUSE_LINE = 12037;
const LOG_LINES = 15_000;

function setupLogProject(dir: string): void {
	const lines: string[] = [];
	for (let i = 1; i <= LOG_LINES; i++) {
		if (i === ROOT_CAUSE_LINE) {
			lines.push(`2026-09-19T03:12:07Z ERROR scheduler: ROOT_CAUSE=port_collision port=8081 pid=4217`);
		} else if (i > LOG_LINES - 5) {
			// Misleading trailing noise: errors that are NOT the root cause.
			lines.push(`2026-09-19T23:59:5${i - (LOG_LINES - 5)}Z ERROR disk_quota_soft_limit retry_ok=true`);
		} else {
			lines.push(`2026-09-19T00:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z INFO tick ${i} ${seededFill(48, i)}`);
		}
	}
	writeFileSync(join(dir, "app.log"), `${lines.join("\n")}\n`);
}

const taskLogPolicy: Policy = (context) => {
	const results = toolResults(context);
	if (results.length === 0) return { tool: "grep", args: { pattern: "ROOT_CAUSE", path: "." } };
	if (!results.some((r) => r.toolName === "read")) {
		return { tool: "read", args: { path: "app.log", offset: ROOT_CAUSE_LINE - 7, limit: 15 } };
	}
	return { final: `root cause: port_collision reported at line ${ROOT_CAUSE_LINE} (scheduler port collision)` };
};

const BUGGY_MATH = `export function sumUnique(values: number[]): number {
	return values.reduce((a, b) => a + b, 0);
}
`;
const FIXED_MATH = `export function sumUnique(values: number[]): number {
	return [...new Set(values)].reduce((a, b) => a + b, 0);
}
`;

function setupRepairProject(dir: string): void {
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	writeFileSync(join(dir, "src", "math.ts"), BUGGY_MATH);
	writeFileSync(
		join(dir, "test", "math.test.ts"),
		`import assert from "node:assert/strict";
import { test } from "node:test";
import { sumUnique } from "../src/math.ts";

test("sumUnique dedupes", () => {
	assert.equal(sumUnique([1, 1, 2]), 3);
});
`,
	);
	writeFileSync(join(dir, "README.md"), "tiny node:test project\n");
}

const taskRepairPolicy: Policy = (context) => {
	const results = toolResults(context);
	switch (results.length) {
		case 0:
			return { tool: "read", args: { path: "src/math.ts" } };
		case 1:
			return { tool: "write", args: { path: "src/math.ts", content: FIXED_MATH } };
		case 2:
			// Absolute node path + explicit file: the tool's bash has a bare PATH
			// without node, and Node 22 does not glob a bare directory argument.
			return { tool: "bash", args: { command: `${process.execPath} --test test/math.test.ts` } };
		case 3:
			// Unapproved modification attempt — must be denied by permissions.
			return { tool: "bash", args: { command: "rm -rf src" } };
		default:
			return { final: "Approved repair applied: sumUnique now deduplicates before summing." };
	}
};

const EVIDENCE_FILES = 8;

function setupEvidenceProject(dir: string): void {
	mkdirSync(join(dir, "evidence"), { recursive: true });
	for (let i = 0; i < EVIDENCE_FILES; i++) {
		writeFileSync(
			join(dir, "evidence", `e${i}.txt`),
			`EVIDENCE_${i}_TOKEN=${(i * 7919) % 9973}\n${seededFill(60_000, i + 11)}\n`,
		);
	}
	writeFileSync(join(dir, "notes.md"), "evidence bundle for recovery test\n");
}

/** Phase A policy: one assistant turn reads every evidence file at once. */
const taskEvidenceIngestPolicy: Policy = (context) => {
	if (toolResults(context).length === 0) {
		// First call issues all reads in a single multi-tool turn.
		return { tool: "read", args: { path: "evidence/e0.txt" } };
	}
	if (toolResults(context).length < EVIDENCE_FILES) {
		const done = new Set(
			toolResults(context)
				.map((r) => /e(\d+)\.txt/.exec(textOf(r))?.[1])
				.filter((v): v is string => v !== undefined),
		);
		const next = Array.from({ length: EVIDENCE_FILES }, (_, i) => i).find((i) => !done.has(String(i)));
		if (next !== undefined) return { tool: "read", args: { path: `evidence/e${next}.txt` } };
	}
	return { final: "ingested evidence bundle" };
};

/** Phase B policy (post-reopen): read back one archived source, then report.
 *  Counts only results after the bench-task prompt — hydrated history already
 *  contains the phase-A results. */
const taskEvidenceResumePolicy: Policy = (context) => {
	if (resultsAfterLastPrompt(context).length === 0) {
		return { tool: "read", args: { path: "evidence/e0.txt" } };
	}
	return { final: "recovery report: EVIDENCE_0_TOKEN=0 confirmed from reopened session" };
};

// ---------------------------------------------------------------------------
// Prep-overhead microbenchmark (serialization + origin mapping + digests)
// ---------------------------------------------------------------------------

interface OverheadResult {
	name: string;
	sizeChars: number;
	samples: number;
	warmups: number;
	p50BaselineMs: number | null;
	p95BaselineMs: number | null;
	p50VariantMs: number | null;
	p95VariantMs: number | null;
	p50DeltaMs: number | null;
	p95DeltaMs: number | null;
}

type SessionInternals = {
	_mapPromptCacheHints?: (a: readonly AgentMessage[], l: unknown[]) => unknown;
};

function seedHistory(bench: BenchSession, chars: number): AgentMessage[] {
	// ~5k chars per tool result; assistant+result pairs like real sessions.
	const per = 5_000;
	const count = Math.max(1, Math.ceil(chars / per));
	const messages: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		const assistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: `seed-${i}`, name: "read", arguments: { path: `/f/${i}` } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: i * 2,
		} as AgentMessage;
		const result: AgentMessage = {
			role: "toolResult",
			toolCallId: `seed-${i}`,
			toolName: "read",
			content: [{ type: "text", text: seededFill(per, i + 1) }],
			isError: false,
			timestamp: i * 2 + 1,
		} as AgentMessage;
		bench.manager.appendMessage(assistant);
		bench.manager.appendMessage(result);
		messages.push(assistant, result);
	}
	bench.agent.state.messages.push(...messages);
	return messages;
}

async function measurePrepOverhead(sizeChars: number): Promise<OverheadResult> {
	const dir = mkdtempSync(join(tmpdir(), "metis-cache-bench-prep-"));
	try {
		const bench = createBenchSession(dir);
		const messages = seedHistory(bench, sizeChars);
		const internals = bench.session as unknown as SessionInternals;
		const baseline = async () => {
			convertToLlm(messages);
		};
		const variantPath = async () => {
			// Full per-request prep added by this feature: transform hooks (plan
			// projection + durable view projection) + LLM conversion + hints.
			const transformed = (await bench.agent.transformContext?.(messages)) ?? messages;
			const llm = convertToLlm(transformed);
			internals._mapPromptCacheHints?.(transformed, llm);
		};
		const WARMUPS = 20;
		const SAMPLES = 100;
		for (let i = 0; i < WARMUPS; i++) {
			await baseline();
			await variantPath();
		}
		const sample = async (fn: () => Promise<void>) => {
			const times: number[] = [];
			for (let i = 0; i < SAMPLES; i++) {
				const t0 = performance.now();
				await fn();
				times.push(performance.now() - t0);
			}
			return times.sort((a, b) => a - b);
		};
		const baselineTimes = await sample(baseline);
		const variantTimes = await sample(variantPath);
		bench.session.dispose();
		bench.manager.close();
		const p50b = percentile(baselineTimes, 50);
		const p95b = percentile(baselineTimes, 95);
		const p50v = percentile(variantTimes, 50);
		const p95v = percentile(variantTimes, 95);
		return {
			name: `prep-overhead-${sizeChars}`,
			sizeChars,
			samples: SAMPLES,
			warmups: WARMUPS,
			p50BaselineMs: p50b,
			p95BaselineMs: p95b,
			p50VariantMs: p50v,
			p95VariantMs: p95v,
			p50DeltaMs: p50v !== null && p50b !== null ? p50v - p50b : null,
			p95DeltaMs: p95v !== null && p95b !== null ? p95v - p95b : null,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Live mode: real provider via the normal Agent loop (streamSimple), real usage
// ---------------------------------------------------------------------------

async function runLiveTask(name: string, setup: (dir: string) => void, prompt: string): Promise<RepMetrics> {
	const dir = mkdtempSync(join(tmpdir(), "metis-cache-bench-live-"));
	const rep: RepMetrics = {
		requestCount: 0,
		toolReadbacks: 0,
		compactions: 0,
		durationMs: 0,
		ttftMs: null,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		success: false,
		notes: [],
	};
	if (counters.limitHit) {
		rep.notes.push("skipped: max-requests reached");
		rmSync(dir, { recursive: true, force: true });
		return rep;
	}
	try {
		setup(dir);
		const bench = createBenchSession(dir);
		const t0 = performance.now();
		bench.agent.onResponse = () => {
			rep.ttftMs ??= performance.now() - t0;
		};
		try {
			await bench.session.prompt(prompt);
			await bench.agent.waitForIdle();
		} catch (error) {
			rep.notes.push(`prompt error: ${String(error)}`);
		}
		rep.durationMs = performance.now() - t0;
		const assistant = bench.agent.state.messages.filter(
			(m): m is AssistantMessage => m.role === "assistant",
		);
		rep.requestCount = assistant.length;
		counters.requests += rep.requestCount;
		if (counters.requests > maxRequests) counters.limitHit = true;
		for (const message of assistant) {
			rep.inputTokens += message.usage.input;
			rep.cacheReadTokens += message.usage.cacheRead;
			rep.cacheWriteTokens += message.usage.cacheWrite;
		}
		rep.toolReadbacks = bench.agent.state.messages.filter((m) => m.role === "toolResult").length;
		rep.compactions = countCompactions(bench.manager);
		const last = assistant.at(-1);
		rep.success = last?.stopReason === "stop" || last?.stopReason === "toolUse" ? last !== undefined : false;
		bench.session.dispose();
		bench.manager.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return rep;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface TaskSpec {
	name: string;
	setup: (dir: string) => void;
	policy: Policy;
	livePrompt: string;
	verify: (bench: BenchSession, dir: string) => string | null;
	prepare?: (bench: BenchSession, dir: string) => Promise<BenchSession>;
}

const tasks: TaskSpec[] = [
	{
		name: "long-log-root-cause",
		setup: setupLogProject,
		policy: taskLogPolicy,
		livePrompt:
			"Investigate app.log in this directory and report the root cause line number and cause token. The last lines contain a misleading unrelated error.",
		verify: (bench) => {
			const last = bench.agent.state.messages.at(-1);
			const text = last?.role === "assistant" ? textOf(last) : "";
			if (!text.includes("port_collision")) return "final answer missing root cause token";
			if (!text.includes(String(ROOT_CAUSE_LINE))) return "final answer missing line number";
			if (/root cause.{0,40}disk_quota/i.test(text)) return "reported the misleading tail error";
			return null;
		},
	},
	{
		name: "approved-plan-repair",
		setup: setupRepairProject,
		policy: taskRepairPolicy,
		livePrompt:
			"src/math.ts has a bug: sumUnique([1,1,2]) returns 4 instead of 3. The approved plan allows only fixing the dedup logic in src/math.ts and running node --test test/. Do not make other changes.",
		verify: (bench, dir) => {
			const content = existsSync(join(dir, "src", "math.ts")) ? readFileSync(join(dir, "src", "math.ts"), "utf8") : "";
			if (!content.includes("new Set")) return "fix not applied to src/math.ts";
			const results = toolResults({ messages: bench.agent.state.messages } as Context);
			const denied = results.find((r) => r.isError);
			if (!denied) return "unapproved modification was not denied";
			if (!existsSync(join(dir, "src", "math.ts"))) return "src/ deleted despite denial";
			const testRun = results.find((r) => r.toolName === "bash" && !r.isError);
			if (!testRun) return "approved test run missing";
			return null;
		},
	},
	{
		name: "compaction-resume-continue",
		setup: setupEvidenceProject,
		policy: taskEvidenceResumePolicy,
		livePrompt:
			"Read evidence/e0.txt and report the EVIDENCE_0_TOKEN value, continuing from the earlier investigation summary.",
		prepare: async (bench, dir, rep, usage) => {
			// Phase A: ingest all evidence files through real tool calls.
			if (mode === "offline") {
				bench.agent.streamFn = scriptedStream(taskEvidenceIngestPolicy, usage, rep) as never;
			}
			await bench.session.prompt("phase A ingest: read every evidence file");
			await bench.agent.waitForIdle();
			// Compaction entry via the real journal API, then reopen the file.
			const kept = bench.manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
			const carry = bench.manager.computeCompactionCarry(kept);
			bench.manager.appendCompaction("EVIDENCE-SUMMARY", kept, 1000, undefined, false, carry);
			const file = bench.manager.getSessionFile()!;
			bench.session.dispose();
			bench.manager.close();
			const reopened = SessionManager.open(file);
			return createBenchSession(dir, { manager: reopened });
		},
		verify: (bench) => {
			const results = bench.agent.state.messages.filter((m) => m.role === "toolResult");
			if (results.length === 0) return "readback missing after reopen";
			const last = bench.agent.state.messages.at(-1);
			const text = last?.role === "assistant" ? textOf(last) : "";
			if (!text.includes("EVIDENCE_0_TOKEN=0")) return "final report missing evidence token";
			return null;
		},
	},
];

async function main(): Promise<void> {
	const started = performance.now();
	const tests: unknown[] = [];
	let successes = 0;
	let failures = 0;
	let skipped = 0;
	let totalRequests = 0;
	let inputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let ttftSamples: number[] = [];
	let durations: number[] = [];

	for (const task of tasks) {
		const repsResults: RepMetrics[] = [];
		for (let rep = 0; rep < reps && !counters.limitHit; rep++) {
			const result =
				mode === "live"
					? await runLiveTask(task.name, task.setup, task.livePrompt)
					: await runRep(
							task.name,
							task.setup,
							async (bench, dir) => (task.prepare ? task.prepare(bench, dir) : bench),
							task.policy,
							task.verify,
						);
			repsResults.push(result);
		}
		const ok = repsResults.filter((r) => r.success).length;
		const skippedHere = repsResults.filter((r) => r.requestCount === 0 && r.notes.length > 0).length;
		successes += ok;
		failures += repsResults.length - ok - skippedHere;
		skipped += skippedHere;
		for (const r of repsResults) {
			totalRequests += r.requestCount;
			inputTokens += r.inputTokens;
			cacheReadTokens += r.cacheReadTokens;
			cacheWriteTokens += r.cacheWriteTokens;
			durations.push(r.durationMs);
			if (r.ttftMs !== null) ttftSamples.push(r.ttftMs);
		}
		tests.push({
			name: task.name,
			reps: repsResults.length,
			successes: ok,
			failures: repsResults.length - ok - skippedHere,
			skipped: skippedHere,
			durationsMs: repsResults.map((r) => Math.round(r.durationMs * 100) / 100),
			requestCounts: repsResults.map((r) => r.requestCount),
			toolReadbacks: repsResults.map((r) => r.toolReadbacks),
			compactions: repsResults.map((r) => r.compactions),
			notes: repsResults.flatMap((r) => r.notes),
		});
	}

	// Prep-overhead microbenchmark: 100k/500k UTF-8 history sizes, fixed machine.
	if (mode === "offline" && !counters.limitHit) {
		for (const size of [100_000, 500_000]) {
			const measured = await measurePrepOverhead(size);
			tests.push(measured);
		}
	}

	durations.sort((a, b) => a - b);
	ttftSamples.sort((a, b) => a - b);
	const report = {
		baseCommit,
		variant,
		mode,
		provider: mode === "live" ? provider : null,
		model: mode === "live" ? modelId : null,
		requestCount: totalRequests,
		tests,
		inputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		cost: null,
		ttftMs: percentile(ttftSamples, 50),
		taskDurationMs: {
			p50: percentile(durations, 50),
			p95: percentile(durations, 95),
			samples: durations.length,
		},
		toolReadbacks: tests
			.filter((t): t is { toolReadbacks: number[] } => Array.isArray((t as { toolReadbacks?: unknown }).toolReadbacks))
			.flatMap((t) => t.toolReadbacks)
			.reduce((a, b) => a + b, 0),
		compactions: tests
			.filter((t): t is { compactions: number[] } => Array.isArray((t as { compactions?: unknown }).compactions))
			.flatMap((t) => t.compactions)
			.reduce((a, b) => a + b, 0),
		successes,
		failures,
		skipped,
		usageSimulated: mode === "offline",
		wallClockMs: Math.round(performance.now() - started),
		maxRequests: Number.isFinite(maxRequests) ? maxRequests : null,
		limitReached: counters.limitHit,
	};
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ wrote: outputPath, successes, failures, skipped, requestCount: totalRequests }));
}

await main();
