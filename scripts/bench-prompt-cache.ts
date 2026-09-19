#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentMessage } from "../packages/agent/src/index.ts";
import { Agent } from "../packages/agent/src/index.ts";
import { stream as anthropicStream } from "../packages/ai/src/api/anthropic-messages.ts";
import { getModel } from "../packages/ai/src/compat.ts";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "../packages/ai/src/index.ts";
import type { AssistantMessage, Context, Model, StreamOptions, Usage } from "../packages/ai/src/types.ts";
import { captureWire } from "../packages/ai/test-support/prompt-cache-wire.ts";
import { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";
import { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import type { ResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { createCodingTools } from "../packages/coding-agent/src/index.ts";
import { createToolResultMicrocompactor as createBaselineMicrocompactor } from "./fixtures/prompt-cache-baseline.ts";
/**
 * Prompt-cache evaluation harness (docs/plans/2026-09-19-prompt-cache-execution-plan.md
 * Task 13). One invocation measures one variant:
 *
 *   node --import tsx scripts/bench-prompt-cache.ts --mode offline --variant stable --output out.json
 *
 * --mode offline|live   default offline. Live requires METIS_CACHE_EVAL_LIVE=1
 *                       plus --provider/--model/--max-requests.
 * --variant baseline|stable|pressure
 *     baseline: historyAnchors=false + frozen 1447e9f microcompaction fixture.
 *     stable:   historyAnchors=true  + microcompaction=legacy (current defaults).
 *     pressure: historyAnchors=true  + microcompaction=pressure.
 * --output <path>       JSON report destination.
 * --reps <n>            task repetitions (default 5).
 *
 * Offline mode runs real AgentSession + real tools on synthetic mkdtemp projects
 * with a deterministic scripted provider stream (no oauth, no user auth file,
 * no external network). Real provider serialization is exercised through loopback HTTP. Offline
 * token estimates only drive context pressure; cache usage/cost stay null.
 * Actual provider usage is collected only in live mode.
 */
import { assertTaskOutcome, snapshotProject, unapprovedProjectChanges } from "./lib/prompt-cache-quality.ts";

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
const requestedOutputPath = value("--output");
if (!requestedOutputPath) throw new Error("Missing --output <path>");
const outputPath: string = requestedOutputPath;
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
const reps = Number(value("--reps") ?? 5);
if (!Number.isInteger(reps) || reps < 1) throw new Error("Invalid --reps");

const baseCommit = (() => {
	try {
		return execFileSync("git", ["rev-parse", "1447e9f"], { encoding: "utf8" }).trim();
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
	const selectedModel = live
		? (getModel(provider!, modelId!) as Model<"anthropic-messages"> | undefined)
		: (getModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">);
	if (!selectedModel) throw new Error(`Model ${provider}/${modelId} not found`);
	const model = structuredClone(selectedModel);
	model.contextWindow = 96_000;
	const agent = new Agent({
		initialState: { model, systemPrompt: "Bench agent", tools: createCodingTools(root) },
		getApiKey: async () => {
			if (!live) return "bench-key";
			const result = await modelRegistry.getApiKeyAndHeaders(model);
			if (!result.ok) throw new Error(result.error);
			return result.apiKey;
		},
		convertToLlm,
	});
	const harnessRoot = join(root, ".bench");
	mkdirSync(harnessRoot, { recursive: true });
	const manager = reuse?.manager ?? SessionManager.create(root, join(harnessRoot, "sessions"));
	const settings = SettingsManager.create(root, harnessRoot);
	settings.applyOverrides({ promptCache: promptCacheOverrides(variant), compaction: { enabled: false } });
	// Offline never touches user auth: temp auth file + runtime key only. Live
	// mode intentionally resolves the real auth store (gated above).
	const auth = AuthStorage.create(live ? undefined : join(harnessRoot, "auth.json"));
	if (!live) auth.setRuntimeApiKey("anthropic", "bench-key");
	const modelRegistry = ModelRegistry.create(auth, join(harnessRoot, "models.json"));
	if (live) {
		// Enforce --max-requests before every model call: the agent loop,
		// compaction/summary requests (agent.streamFn), and the permission
		// reviewer (modelRegistry.streamSimple) all pass through here.
		const stream = agent.streamFn;
		agent.streamFn = gatedLiveStream(async (m, c, o) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(m);
			if (!auth.ok) throw new Error(auth.error);
			return stream(m, c, { ...o, apiKey: auth.apiKey, headers: { ...auth.headers, ...o?.headers }, env: auth.env });
		});
		const registryStream = modelRegistry.streamSimple.bind(modelRegistry);
		modelRegistry.streamSimple = (m, c, o) =>
			gatedLiveStream(registryStream)(m, c, o) as ReturnType<typeof registryStream>;
	}
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager: settings,
		cwd: root,
		modelRegistry,
		resourceLoader: benchResourceLoader,
	});
	if (reuse?.manager) {
		agent.state.messages = [...manager.buildSessionContext().messages];
	}
	if (variant === "baseline") {
		// Replace the entire transform: the baseline must not run new source
		// mapping, artifact replay or durable pruning before its frozen fixture.
		agent.transformContext = createBaselineMicrocompactor({
			outputDir: manager.getToolOutputDir()!,
			isBuiltinTool: () => true,
		});
	}
	return { session, agent, manager, settings };
}

// ---------------------------------------------------------------------------
// Metrics plumbing
// ---------------------------------------------------------------------------

const counters = {
	requests: 0,
	limitHit: false,
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	missingCacheUsage: 0,
	pendingUsage: [] as Promise<void>[],
};

class SimulatedUsage {
	private input = 0;
	next(context: Context): Usage {
		const input = Math.ceil(JSON.stringify(context.messages).length / 4);
		this.input += input;
		return {
			input,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			cacheReported: false,
			totalTokens: input + 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}
	snapshot() {
		return { input: this.input, cacheRead: 0, cacheWrite: 0 };
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
	cost?: number;
	cacheReported?: boolean;
	notes: string[];
}

function scriptedStream(policy: Policy, usage: SimulatedUsage, rep: RepMetrics) {
	let callIndex = 0;
	return (requestModel: Model<"anthropic-messages">, context: Context, _options?: StreamOptions) => {
		if (counters.requests >= maxRequests) {
			counters.limitHit = true;
			throw new Error("max-requests reached");
		}
		rep.requestCount++;
		counters.requests++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				await captureWire("anthropic-messages", context, {
					cacheRetention: "short",
					onPromptCachePrepared: _options?.onPromptCachePrepared,
				});
				const base = { api: requestModel.api, provider: requestModel.provider, model: requestModel.id };
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

/** Live-mode wrapper: counts every model call and fails it before any network
 *  traffic once --max-requests is exhausted. */
function gatedLiveStream(
	inner: import("../packages/agent/src/types.ts").StreamFn,
): import("../packages/agent/src/types.ts").StreamFn {
	return (requestModel, context, options) => {
		if (counters.requests >= maxRequests) {
			counters.limitHit = true;
			const stream = createAssistantMessageEventStream();
			const base = requestModel;
			queueMicrotask(() => {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...fauxAssistantMessage("", { stopReason: "error", errorMessage: "max-requests reached" }),
						api: base.api,
						provider: base.provider,
						model: base.id,
					},
				});
				stream.end();
			});
			return stream;
		}
		counters.requests++;
		const result = inner(requestModel, context, { ...options, maxRetries: 0 });
		counters.pendingUsage.push(
			Promise.resolve(result)
				.then((stream) => stream.result())
				.then(
					(message) => {
						counters.input += message.usage.input;
						counters.cacheRead += message.usage.cacheRead;
						counters.cacheWrite += message.usage.cacheWrite;
						counters.cost += message.usage.cost.total;
						if (message.usage.cacheReported !== true) counters.missingCacheUsage++;
					},
					() => {
						counters.missingCacheUsage++;
					},
				),
		);
		return result;
	};
}

function countCompactions(manager: SessionManager): number {
	const branch = manager.getBranch();
	const compactions = branch.filter((e) => e.type === "compaction").length;
	return compactions;
}

async function runRep(task: TaskSpec): Promise<RepMetrics> {
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
	const started = performance.now();
	const requestsBefore = counters.requests;
	const usageBefore = {
		input: counters.input,
		cacheRead: counters.cacheRead,
		cacheWrite: counters.cacheWrite,
		cost: counters.cost,
		missing: counters.missingCacheUsage,
	};
	let bench: BenchSession | undefined;
	try {
		task.setup(dir);
		const projectBefore = snapshotProject(dir);
		bench = createBenchSession(dir);
		const usage = new SimulatedUsage();
		const configure = (current: BenchSession) => {
			current.session.setPermissionApprovalHandler(async (request) => {
				const command = (request.action as { command?: string }).command ?? "";
				return /rm\s+(-[a-z]*r|-[a-z]*f[a-z]*r)/.test(command)
					? { decision: "deny", reason: "unapproved destructive change" }
					: { decision: "allow" };
			});
			current.manager.setPermissionPreset("auto");
		};
		configure(bench);
		const observe = (current: BenchSession) =>
			current.session.subscribe((event) => {
				if (mode === "live" && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
					rep.ttftMs ??= performance.now() - started;
				if (event.type !== "message_end") return;
				if (event.message.role === "toolResult" && event.message.toolName === "read" && !event.message.isError)
					rep.toolReadbacks++;
			});
		observe(bench);
		if (task.prepare) {
			const prepared = await task.prepare(bench, dir, rep, usage);
			if (prepared !== bench) {
				configure(prepared);
				observe(prepared);
			}
			bench = prepared;
		}
		if (mode === "offline") bench.agent.streamFn = scriptedStream(task.policy, usage, rep) as never;
		await bench.session.prompt(`bench task: ${task.name}\n${task.livePrompt}`);
		await bench.agent.waitForIdle();
		const ready = bench;
		assertTaskOutcome(bench.agent.state.messages, () => task.verify(ready, dir, projectBefore));
		rep.compactions = countCompactions(bench.manager);
		if (mode === "offline") rep.inputTokens = usage.snapshot().input;
		rep.success = true;
	} catch (error) {
		rep.notes.push(String(error));
	} finally {
		await Promise.all(counters.pendingUsage.splice(0));
		if (mode === "live") {
			rep.inputTokens = counters.input - usageBefore.input;
			rep.cacheReadTokens = counters.cacheRead - usageBefore.cacheRead;
			rep.cacheWriteTokens = counters.cacheWrite - usageBefore.cacheWrite;
			rep.cost = counters.cost - usageBefore.cost;
			rep.cacheReported = counters.missingCacheUsage === usageBefore.missing;
		}
		rep.requestCount = counters.requests - requestsBefore;
		rep.durationMs = performance.now() - started;
		bench?.session.dispose();
		bench?.manager.close();
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
			lines.push(
				`2026-09-19T00:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z INFO tick ${i} ${seededFill(48, i)}`,
			);
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

const REPAIR_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { sumUnique } from "../src/math.ts";

test("sumUnique dedupes", () => {
	assert.equal(sumUnique([1, 1, 2]), 3);
});
`;

function setupRepairProject(dir: string): void {
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	writeFileSync(join(dir, "src", "math.ts"), BUGGY_MATH);
	writeFileSync(join(dir, "test", "math.test.ts"), REPAIR_TEST);
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

const EVIDENCE_FILES = 13;

function setupEvidenceProject(dir: string): void {
	mkdirSync(join(dir, "evidence"), { recursive: true });
	for (let i = 0; i < EVIDENCE_FILES; i++) {
		writeFileSync(
			join(dir, "evidence", `e${i}.txt`),
			`EVIDENCE_${i}_TOKEN=${(i * 7919) % 9973}\n${seededFill(i < 8 ? 40_000 : 100, i + 11)}\n`,
		);
	}
	writeFileSync(join(dir, "notes.md"), "evidence bundle for recovery test\n");
}

/** Phase A policy: read every evidence file over real tool round trips. */
const taskEvidenceIngestPolicy: Policy = (context) => {
	const count = toolResults(context).length;
	return count < EVIDENCE_FILES
		? { tool: "read", args: { path: `evidence/e${count}.txt` } }
		: { final: "ingested evidence bundle" };
};

/** Phase B policy (post-reopen): read back one archived source, then report.
 *  Counts only results after the bench-task prompt — hydrated history already
 *  contains the phase-A results. */
const taskEvidenceResumePolicy: Policy = (context) => {
	if (resultsAfterLastPrompt(context).length === 0) {
		const archive = context.messages
			.map(textOf)
			.join("\n")
			.match(/Tool result saved to: (.+)/)?.[1];
		if (!archive) throw new Error("No archived evidence reference after reopen");
		return { tool: "read", args: { path: archive } };
	}
	const evidence = resultsAfterLastPrompt(context)
		.map(textOf)
		.join("\n")
		.match(/EVIDENCE_0_TOKEN=\d+/)?.[0];
	if (!evidence) throw new Error("Archived readback did not contain the expected evidence");
	return { final: `recovery report: ${evidence} confirmed from reopened session` };
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
	stages?: Record<string, { p50: number | null; p95: number | null }>;
}

type SessionInternals = {
	_mapPromptCacheHints: (a: readonly AgentMessage[], l: Context["messages"]) => Context["cacheHints"];
};

function seedHistory(bench: BenchSession, chars: number): AgentMessage[] {
	// ~5k chars per tool result; assistant+result pairs like real sessions.
	const per = 5_000;
	const count = Math.max(1, Math.ceil(chars / per));
	const messages: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		const assistant: AssistantMessage = {
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
		};
		const result: Extract<AgentMessage, { role: "toolResult" }> = {
			role: "toolResult",
			toolCallId: `seed-${i}`,
			toolName: "read",
			content: [{ type: "text", text: seededFill(per, i + 1) }],
			isError: false,
			timestamp: i * 2 + 1,
		};
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
		if (typeof internals._mapPromptCacheHints !== "function")
			throw new Error("Preparation benchmark requires AgentSession cache-origin mapping");
		// Compare the same fixed-length history, independent of variant pruning.
		if (variant === "baseline") bench.agent.transformContext = undefined;
		// Measure the full actual provider preparation, including hook validation
		// and SDK JSON serialization. The fetch boundary is local and never sends.
		bench.settings.applyOverrides({ promptCache: { microcompaction: "off" } });
		const model = { ...bench.agent.state.model!, baseUrl: "http://127.0.0.1:9" } as Model<"anthropic-messages">;
		const prepare = async (context: Context) => {
			const originalFetch = globalThis.fetch;
			let captured = false;
			let checkpoint = false;
			globalThis.fetch = async () => {
				captured = true;
				return new Response("", { headers: { "content-type": "text/event-stream" } });
			};
			try {
				await anthropicStream(model, context, {
					apiKey: "bench-key",
					cacheRetention: "short",
					maxRetries: 0,
					onPayload: () => undefined,
					onPromptCachePrepared: (observation) => {
						checkpoint = observation.checkpoint !== undefined;
					},
				}).result();
				if (!captured) throw new Error("Preparation benchmark did not reach the serialized fetch boundary");
				if (context.cacheHints && !checkpoint)
					throw new Error("Preparation benchmark silently fell back without a cache checkpoint");
			} finally {
				globalThis.fetch = originalFetch;
			}
		};
		const baseline = async () =>
			prepare({
				systemPrompt: bench.agent.state.systemPrompt,
				tools: bench.agent.state.tools,
				messages: convertToLlm(messages),
			});
		const stages = { view: [] as number[], mapping: [] as number[], provider: [] as number[] };
		const variantPath = async () => {
			const start = performance.now();
			const transformed = (await bench.agent.transformContext?.(messages)) ?? messages;
			const afterView = performance.now();
			const llm = convertToLlm(transformed);
			const cacheHints = internals._mapPromptCacheHints(transformed, llm);
			const afterMapping = performance.now();
			await prepare({
				systemPrompt: bench.agent.state.systemPrompt,
				tools: bench.agent.state.tools,
				messages: llm,
				cacheHints,
			});
			stages.view.push(afterView - start);
			stages.mapping.push(afterMapping - afterView);
			stages.provider.push(performance.now() - afterMapping);
		};
		const WARMUPS = 20;
		const SAMPLES = 100;
		for (let i = 0; i < WARMUPS; i++) {
			await baseline();
			await variantPath();
		}
		for (const values of Object.values(stages)) values.length = 0;
		const baselineTimes: number[] = [];
		const variantTimes: number[] = [];
		const sample = async (fn: () => Promise<void>, into: number[]) => {
			const start = performance.now();
			await fn();
			into.push(performance.now() - start);
		};
		for (let i = 0; i < SAMPLES; i++) {
			if (i % 2 === 0) {
				await sample(baseline, baselineTimes);
				await sample(variantPath, variantTimes);
			} else {
				await sample(variantPath, variantTimes);
				await sample(baseline, baselineTimes);
			}
		}
		baselineTimes.sort((a, b) => a - b);
		variantTimes.sort((a, b) => a - b);
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
			stages: Object.fromEntries(
				Object.entries(stages).map(([key, values]) => {
					values.sort((a, b) => a - b);
					return [key, { p50: percentile(values, 50), p95: percentile(values, 95) }];
				}),
			),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface TaskSpec {
	name: string;
	setup: (dir: string) => void;
	policy: Policy;
	livePrompt: string;
	verify: (bench: BenchSession, dir: string, projectBefore: ReadonlyMap<string, string>) => string | null;
	prepare?: (bench: BenchSession, dir: string, rep: RepMetrics, usage: SimulatedUsage) => Promise<BenchSession>;
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
			const results = toolResults({ messages: convertToLlm(bench.agent.state.messages) });
			for (const name of ["grep", "read"])
				if (
					!results.some(
						(result) =>
							result.toolName === name &&
							!result.isError &&
							textOf(result).includes("ROOT_CAUSE=port_collision"),
					)
				)
					return `verified ${name} root-cause evidence missing`;
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
		prepare: async (bench) => {
			await bench.session.setCollaborationMode("plan");
			const plan = bench.manager.submitPlan({
				title: "Repair sumUnique",
				markdown: "Fix only src/math.ts deduplication. Run test/math.test.ts. Preserve all other project files.",
			});
			bench.manager.acceptPlan({ planId: plan.planId, revision: plan.revision });
			await bench.session.setCollaborationMode("default");
			return bench;
		},
		livePrompt:
			"src/math.ts has a bug: sumUnique([1,1,2]) returns 4 instead of 3. The approved plan allows only fixing the dedup logic in src/math.ts and running node --test test/math.test.ts. Do not make other changes.",
		verify: (bench, dir, projectBefore) => {
			const changed = unapprovedProjectChanges(projectBefore, snapshotProject(dir), new Set(["src/math.ts"]));
			if (changed.length) return `unapproved project changes: ${changed.join(", ")}`;
			if (!bench.manager.getPlanState().plans.some((plan) => plan.status === "accepted"))
				return "approved plan missing";
			const content = existsSync(join(dir, "src", "math.ts"))
				? readFileSync(join(dir, "src", "math.ts"), "utf8")
				: "";
			if (content === BUGGY_MATH) return "fix not applied to src/math.ts";
			try {
				execFileSync(process.execPath, ["--test", "test/math.test.ts"], { cwd: dir, stdio: "pipe" });
			} catch {
				return "repaired project tests failed";
			}
			const results = toolResults({ messages: convertToLlm(bench.agent.state.messages) });
			const calls = bench.agent.state.messages.flatMap((message) =>
				message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
			);
			const testCommands = new Set([
				"node --test test/math.test.ts",
				`${process.execPath} --test test/math.test.ts`,
			]);
			let ranTests = false;
			for (const call of calls) {
				const result = results.find((result) => result.toolCallId === call.id);
				const isTest = call.name === "bash" && testCommands.has(String(call.arguments.command).trim());
				const allowed =
					["read", "grep", "find", "ls"].includes(call.name) ||
					isTest ||
					(["edit", "write"].includes(call.name) &&
						resolve(dir, String(call.arguments.path)) === join(dir, "src/math.ts"));
				if (!allowed && !result?.isError) return `unapproved operation was not denied: ${call.name}`;
				if (isTest && result && !result.isError) ranTests = true;
			}
			if (!ranTests) return "approved test run missing";
			return null;
		},
	},
	{
		name: "prune-resume-continue",
		setup: setupEvidenceProject,
		policy: taskEvidenceResumePolicy,
		livePrompt:
			"Continue the earlier investigation. The original evidence/e0.txt is no longer available. Read its archived tool-result file referenced in the history and report the EVIDENCE_0_TOKEN value.",
		prepare: async (bench, dir, rep, usage) => {
			// Phase A: ingest all evidence files through real tool calls.
			if (mode === "offline") {
				bench.agent.streamFn = scriptedStream(taskEvidenceIngestPolicy, usage, rep) as never;
			}
			await bench.session.prompt("phase A ingest: read every evidence file");
			await bench.agent.waitForIdle();
			assertTaskOutcome(bench.agent.state.messages);
			const readCalls = bench.agent.state.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content
							.filter((block) => block.type === "toolCall" && block.name === "read")
							.map((block) => (block as { arguments: { path?: string } }).arguments.path)
					: [],
			);
			for (let i = 0; i < EVIDENCE_FILES; i++)
				if (!readCalls.some((path) => path?.endsWith(`e${i}.txt`)))
					throw new Error(`Evidence e${i}.txt was not read before resume`);
			if (variant !== "baseline" && bench.manager.getContextRewrites().length === 0)
				throw new Error("No durable pruning batch before resume");
			rmSync(join(dir, "evidence", "e0.txt"));
			const file = bench.manager.getSessionFile()!;
			bench.session.dispose();
			bench.manager.close();
			const reopened = SessionManager.open(file);
			return createBenchSession(dir, { manager: reopened });
		},
		verify: (bench) => {
			const results = resultsAfterLastPrompt({ messages: convertToLlm(bench.agent.state.messages) });
			if (
				!results.some(
					(result) =>
						result.toolName === "read" && !result.isError && textOf(result).includes("EVIDENCE_0_TOKEN=0"),
				)
			)
				return "verified evidence readback missing after reopen";
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
	let cost = 0;
	let cacheReported = true;
	const ttftSamples: number[] = [];
	const durations: number[] = [];

	for (const task of tasks) {
		const repsResults: RepMetrics[] = [];
		for (let rep = 0; rep < reps && !counters.limitHit; rep++) {
			const result = await runRep(task);
			repsResults.push(result);
		}
		const ok = repsResults.filter((r) => r.success).length;
		const skippedHere = reps - repsResults.length;
		successes += ok;
		failures += repsResults.length - ok;
		skipped += skippedHere;
		for (const r of repsResults) {
			totalRequests += r.requestCount;
			inputTokens += r.inputTokens;
			cacheReadTokens += r.cacheReadTokens;
			cacheWriteTokens += r.cacheWriteTokens;
			cost += r.cost ?? 0;
			cacheReported &&= r.cacheReported === true;
			durations.push(r.durationMs);
			if (r.ttftMs !== null) ttftSamples.push(r.ttftMs);
		}
		tests.push({
			name: task.name,
			reps: repsResults.length,
			successes: ok,
			failures: repsResults.length - ok,
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
		inputTokens: mode === "live" ? inputTokens : null,
		cacheReadTokens: mode === "live" && cacheReported ? cacheReadTokens : null,
		cacheWriteTokens: mode === "live" && cacheReported ? cacheWriteTokens : null,
		estimatedInputTokens: mode === "offline" ? inputTokens : null,
		cost: mode === "live" ? cost : null,
		ttftMs: mode === "live" ? percentile(ttftSamples, 50) : null,
		taskDurationMs: {
			p50: percentile(durations, 50),
			p95: percentile(durations, 95),
			samples: durations.length,
		},
		toolReadbacks: tests
			.filter((t): t is { toolReadbacks: number[] } =>
				Array.isArray((t as { toolReadbacks?: unknown }).toolReadbacks),
			)
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
	if (failures > 0) process.exitCode = 1;
}

await main();
