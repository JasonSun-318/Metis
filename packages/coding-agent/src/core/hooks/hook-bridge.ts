/**
 * Bridge extension that runs declarative user-level hooks.
 *
 * Registered as an inline extension whenever ~/.metis/agent/hooks.json exists
 * with at least one hook. Maps each declarative event to the corresponding
 * extension event, spawns the configured command as a child process, and feeds
 * the event payload as JSON on stdin.
 *
 * Containment rules (a broken hook must never break the session):
 * - Handlers never throw; spawn failures and timeouts resolve into a result
 *   object and are dropped.
 * - Only PreToolUse can influence execution: exit code 2 blocks the tool call
 *   (Claude Code-compatible). All other events are observers.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getShellEnv, killProcessTree } from "../../utils/shell.ts";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "../extensions/types.ts";
import {
	type DeclarativeHook,
	HOOK_DEFAULT_TIMEOUT_SECONDS,
	type HookEventName,
	loadDeclarativeHooks,
} from "./declarative-hooks.ts";
import {
	buildCommandHookPayload,
	type HookEffect,
	interpretHookResult,
	MAX_PIPE_BUFFER_BYTES,
	matchHook,
	mergeEventContexts,
} from "./hook-protocol.ts";

/**
 * Declarative event -> extension event it binds to:
 * SessionStart -> session_start, UserPromptSubmit -> input,
 * PreToolUse -> tool_call, PostToolUse/PostToolUseFailure -> tool_result,
 * Stop -> agent_settled.
 */

/** Exit code a PreToolUse hook uses to block the tool call. */
export const HOOK_BLOCK_EXIT_CODE = 2;
export const HOOK_STDOUT_LIMIT = 8192;
export const HOOK_KILL_GRACE_MS = 1000;
export const EXIT_STDIO_GRACE_MS = 500;
export { MAX_PIPE_BUFFER_BYTES };

export interface HookRunResult {
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	spawnError: string | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	durationMs: number;
}

export interface HookPayloadBase {
	event: HookEventName;
	hook: {
		id: string;
		name: string;
		statusMessage?: string;
		metadata?: Record<string, unknown>;
	};
	sessionId: string;
	cwd: string;
	timestamp: string;
	toolName?: string;
	toolCallId?: string;
	input?: unknown;
	reason?: string;
	text?: string;
	source?: string;
	content?: unknown;
	details?: unknown;
	isError?: boolean;
	error?: string;
	stopHookActive?: boolean;
	lastAssistantMessage?: string;
}

/** JSON written to the hook process's stdin. */
export type HookPayload = HookPayloadBase;

/** Spawn a hook process, write the payload JSON to stdin, enforce the timeout. Never rejects. */
export function runHookProcess(
	hook: DeclarativeHook,
	payload: HookPayload,
	options: { cwd: string; signal?: AbortSignal },
): Promise<HookRunResult> {
	return new Promise((resolve) => {
		const startTime = Date.now();

		if (options.signal?.aborted) {
			resolve({
				code: null,
				signal: null,
				timedOut: false,
				aborted: true,
				spawnError: null,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				durationMs: 0,
			});
			return;
		}

		const timeoutMs = (hook.timeoutSeconds ?? HOOK_DEFAULT_TIMEOUT_SECONDS) * 1000;
		let timedOut = false;
		let aborted = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let stdout = "";
		let stderr = "";
		let closeCode: number | null = null;
		let closeSignal: string | null = null;
		let spawnError: string | null = null;
		let exitTimer: NodeJS.Timeout | undefined;
		let finished = false;

		const env = getShellEnv();

		let child: ChildProcess;
		try {
			child =
				hook.runMode === "shell"
					? spawn(hook.command, {
							cwd: options.cwd,
							env,
							shell: true,
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
							detached: process.platform !== "win32",
						})
					: spawn(hook.command, hook.args ?? [], {
							cwd: options.cwd,
							env,
							shell: false,
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
							detached: process.platform !== "win32",
						});
		} catch (err) {
			resolve({
				code: null,
				signal: null,
				timedOut: false,
				aborted: false,
				spawnError: err instanceof Error ? err.message : String(err),
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				durationMs: Math.max(0, Date.now() - startTime),
			});
			return;
		}

		const childPid = child.pid;
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");

		let killTimer: NodeJS.Timeout | undefined;
		let forceKillTimer: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;

		const cleanup = () => {
			clearTimeout(killTimer);
			clearTimeout(forceKillTimer);
			clearTimeout(exitTimer);
			if (abortListener) options.signal?.removeEventListener("abort", abortListener);
		};

		const terminateChildTree = () => {
			if (childPid) {
				killProcessTree(childPid);
			}
			try {
				child.kill("SIGKILL");
			} catch {}
		};

		const finish = (result: Partial<HookRunResult>) => {
			if (finished) return;
			finished = true;
			if (timedOut || aborted) {
				terminateChildTree();
			}
			cleanup();
			stdout += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({
				code: spawnError ? null : (result.code ?? closeCode),
				signal: result.signal ?? closeSignal,
				timedOut,
				aborted,
				spawnError,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
				durationMs: Math.max(0, Date.now() - startTime),
			});
		};

		killTimer = setTimeout(() => {
			timedOut = true;
			try {
				if (childPid && process.platform !== "win32") {
					process.kill(-childPid, "SIGTERM");
				} else {
					child.kill("SIGTERM");
				}
			} catch {
				try {
					child.kill("SIGTERM");
				} catch {}
			}
			forceKillTimer = setTimeout(() => {
				terminateChildTree();
				finish({});
			}, HOOK_KILL_GRACE_MS);
		}, timeoutMs);

		if (options.signal) {
			abortListener = () => {
				aborted = true;
				try {
					if (childPid && process.platform !== "win32") {
						process.kill(-childPid, "SIGTERM");
					} else {
						child.kill("SIGTERM");
					}
				} catch {
					try {
						child.kill("SIGTERM");
					} catch {}
				}
				forceKillTimer = setTimeout(() => {
					terminateChildTree();
					finish({});
				}, HOOK_KILL_GRACE_MS);
			};
			options.signal.addEventListener("abort", abortListener, { once: true });
		}

		child.on("error", (error) => {
			spawnError = error instanceof Error ? error.message : String(error);
		});

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutBytes < MAX_PIPE_BUFFER_BYTES) {
				const remaining = MAX_PIPE_BUFFER_BYTES - stdoutBytes;
				if (chunk.length <= remaining) {
					stdout += stdoutDecoder.write(chunk);
					stdoutBytes += chunk.length;
				} else {
					stdout += stdoutDecoder.write(chunk.subarray(0, remaining));
					stdoutBytes = MAX_PIPE_BUFFER_BYTES;
					stdoutTruncated = true;
				}
			} else {
				stdoutTruncated = true;
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrBytes < MAX_PIPE_BUFFER_BYTES) {
				const remaining = MAX_PIPE_BUFFER_BYTES - stderrBytes;
				if (chunk.length <= remaining) {
					stderr += stderrDecoder.write(chunk);
					stderrBytes += chunk.length;
				} else {
					stderr += stderrDecoder.write(chunk.subarray(0, remaining));
					stderrBytes = MAX_PIPE_BUFFER_BYTES;
					stderrTruncated = true;
				}
			} else {
				stderrTruncated = true;
			}
		});

		child.on("exit", (code, signal) => {
			closeCode = code;
			closeSignal = signal;
			if (timedOut || aborted) {
				terminateChildTree();
			}
			// Arm grace timer to release if grandchild holds stdio
			exitTimer = setTimeout(() => {
				terminateChildTree();
				finish({});
			}, EXIT_STDIO_GRACE_MS);
		});

		child.on("close", (code, signal) => {
			if (code !== null) closeCode = code;
			if (signal !== null) closeSignal = signal;
			finish({});
		});

		// EPIPE when the hook exits without reading stdin; never fail the run for it.
		child.stdin?.on("error", () => undefined);
		try {
			const jsonPayload = buildCommandHookPayload(hook, payload);
			child.stdin?.end(`${JSON.stringify(jsonPayload)}\n`);
		} catch {
			// Ignore sync write failures; the close handler still resolves.
		}
	});
}

function basePayload(hook: DeclarativeHook, ctx: ExtensionContext): HookPayloadBase {
	return {
		event: hook.event,
		hook: {
			id: hook.id,
			name: hook.name,
			...(hook.statusMessage !== undefined ? { statusMessage: hook.statusMessage } : {}),
			...(hook.metadata !== undefined ? { metadata: hook.metadata } : {}),
		},
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		timestamp: new Date().toISOString(),
	};
}

/** Run every enabled hook bound to this occurrence, in config order. Never throws. */
async function runMatchingHooks(
	hooks: readonly DeclarativeHook[],
	event: HookEventName,
	ctx: ExtensionContext,
	extra: () => Partial<HookPayloadBase>,
): Promise<Array<{ hook: DeclarativeHook; result: HookRunResult; effect: HookEffect }>> {
	const details = extra();
	const results: Array<{ hook: DeclarativeHook; result: HookRunResult; effect: HookEffect }> = [];
	for (const hook of hooks) {
		if (!hook.enabled || hook.event !== event) continue;
		if (!matchHook(hook, { toolName: details.toolName, reason: details.reason })) continue;
		const payload: HookPayload = { ...basePayload(hook, ctx), ...details };
		try {
			const result = await runHookProcess(hook, payload, { cwd: ctx.cwd, signal: ctx.signal });
			const effect = interpretHookResult(hook, result);
			if (effect.diagnostic && ctx.ui?.notify) {
				ctx.ui.notify(`[Hook: ${hook.name}] ${effect.diagnostic}`, "warning");
			}
			if (effect.blockReason && ctx.ui?.notify) {
				ctx.ui.notify(`[Hook: ${hook.name}] ${effect.blockReason}`, "warning");
			}
			if (effect.continueReason && ctx.ui?.notify) {
				ctx.ui.notify(`[Hook: ${hook.name}] ${effect.continueReason}`, "info");
			}
			results.push({ hook, result, effect });
			// Short-circuit on explicit block or continuation
			if (
				(effect.blockReason &&
					(hook.event === "UserPromptSubmit" ||
						(hook.event === "PreToolUse" && hook.protocol === "command-v1"))) ||
				(effect.continueReason && hook.event === "Stop")
			) {
				break;
			}
		} catch {
			// runHookProcess never rejects; this is belt-and-braces containment.
		}
	}
	return results;
}

/**
 * Build the inline extension that binds declarative hooks to session events.
 * Returns undefined when hooks.json is absent or empty so sessions without
 * hooks keep a zero-extension runtime (required for unattended execution).
 */
export function createDeclarativeHooksBridge(agentDir: string): InlineExtension | undefined {
	const { hooks } = loadDeclarativeHooks(agentDir);
	if (hooks.length === 0) return undefined;

	return {
		name: "hooks",
		factory: (metis: ExtensionAPI) => {
			// Reload so config edits land on new sessions without restarting the host.
			const { hooks: allHooks } = loadDeclarativeHooks(agentDir);
			if (allHooks.length === 0) return;

			const toolHooks = allHooks.filter((hook) => hook.event === "PreToolUse");
			const resultHooks = allHooks.filter(
				(hook) => hook.event === "PostToolUse" || hook.event === "PostToolUseFailure",
			);
			const startHooks = allHooks.filter((hook) => hook.event === "SessionStart");
			const inputHooks = allHooks.filter((hook) => hook.event === "UserPromptSubmit");
			const commandStopHooks = allHooks.filter((hook) => hook.event === "Stop" && hook.protocol === "command-v1");
			const legacyStopHooks = allHooks.filter((hook) => hook.event === "Stop" && hook.protocol !== "command-v1");

			const preToolContexts = new Map<string, string>();

			if (toolHooks.length > 0) {
				metis.on("tool_call", async (event, ctx) => {
					const results = await runMatchingHooks(toolHooks, "PreToolUse", ctx, () => ({
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						input: event.input,
					}));
					for (const { hook, effect } of results) {
						if (effect?.blockReason) {
							preToolContexts.delete(event.toolCallId);
							const reason = effect.context
								? `${effect.blockReason}\n\n[Hook: ${hook.name}]\n${effect.context}`
								: effect.blockReason;
							return { block: true, reason };
						}
					}
					const entries = results
						.map((r) => (r.effect?.context ? { hookName: r.hook.name, context: r.effect.context } : undefined))
						.filter((c): c is { hookName: string; context: string } => Boolean(c));
					const context = mergeEventContexts(entries);
					if (context) {
						preToolContexts.set(event.toolCallId, context);
					}
					return undefined;
				});
			}

			if (resultHooks.length > 0 || toolHooks.length > 0) {
				metis.on("tool_result", async (event, ctx) => {
					const preContext = preToolContexts.get(event.toolCallId);
					preToolContexts.delete(event.toolCallId);

					const results =
						resultHooks.length > 0
							? await runMatchingHooks(
									resultHooks,
									event.isError ? "PostToolUseFailure" : "PostToolUse",
									ctx,
									() => ({
										toolName: event.toolName,
										toolCallId: event.toolCallId,
										input: event.input,
										content: event.content,
										details: event.details,
										isError: event.isError,
									}),
								)
							: [];

					const entries = results
						.map((r) => (r.effect?.context ? { hookName: r.hook.name, context: r.effect.context } : undefined))
						.filter((c): c is { hookName: string; context: string } => Boolean(c));

					const allEntries: Array<{ hookName: string; context: string }> = [];
					if (preContext) {
						allEntries.push({ hookName: "PreToolUse", context: preContext });
					}
					allEntries.push(...entries);
					const combined = mergeEventContexts(allEntries);
					if (combined) {
						return {
							content: [...event.content, { type: "text" as const, text: combined }],
						};
					}
					return undefined;
				});
			}

			if (startHooks.length > 0) {
				metis.on("session_start", async (event, ctx) => {
					const results = await runMatchingHooks(startHooks, "SessionStart", ctx, () => ({
						reason: event.reason,
					}));
					const entries = results
						.map((r) => (r.effect?.context ? { hookName: r.hook.name, context: r.effect.context } : undefined))
						.filter((c): c is { hookName: string; context: string } => Boolean(c));
					const context = mergeEventContexts(entries);
					return context ? { context } : undefined;
				});
			}

			if (inputHooks.length > 0) {
				metis.on("input", async (event, ctx) => {
					const results = await runMatchingHooks(inputHooks, "UserPromptSubmit", ctx, () => ({
						text: event.text,
						source: event.source,
					}));
					for (const { effect } of results) {
						if (effect?.blockReason) {
							return { action: "block", reason: effect.blockReason };
						}
					}
					const entries = results
						.map((r) => (r.effect?.context ? { hookName: r.hook.name, context: r.effect.context } : undefined))
						.filter((c): c is { hookName: string; context: string } => Boolean(c));
					const context = mergeEventContexts(entries);
					return {
						action: "continue",
						...(context ? { context } : {}),
					};
				});
			}

			if (commandStopHooks.length > 0) {
				metis.on("before_agent_stop", async (event, ctx) => {
					const results = await runMatchingHooks(commandStopHooks, "Stop", ctx, () => ({
						lastAssistantMessage: event.lastAssistantMessage,
						stopHookActive: event.stopHookActive,
					}));
					for (const { hook, effect } of results) {
						if (effect?.continueReason) {
							return {
								continueReason: effect.continueReason,
								context: effect.context ? `[Hook: ${hook.name}]\n${effect.context}` : undefined,
							};
						}
					}
					return undefined;
				});
			}

			if (legacyStopHooks.length > 0 || toolHooks.length > 0 || commandStopHooks.length > 0) {
				metis.on("agent_settled", async (_event, ctx) => {
					preToolContexts.clear();
					if (legacyStopHooks.length > 0) {
						await runMatchingHooks(legacyStopHooks, "Stop", ctx, () => ({}));
					}
				});
			}
		},
	};
}
