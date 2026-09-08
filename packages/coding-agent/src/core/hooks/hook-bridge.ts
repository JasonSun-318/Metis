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

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "../extensions/types.ts";
import {
	type DeclarativeHook,
	HOOK_DEFAULT_TIMEOUT_SECONDS,
	type HookEventName,
	hookMatchesTool,
	loadDeclarativeHooks,
} from "./declarative-hooks.ts";

/**
 * Declarative event -> extension event it binds to:
 * SessionStart -> session_start, UserPromptSubmit -> input,
 * PreToolUse -> tool_call, PostToolUse/PostToolUseFailure -> tool_result,
 * Stop -> agent_settled.
 */

/** Exit code a PreToolUse hook uses to block the tool call. */
const HOOK_BLOCK_EXIT_CODE = 2;
const HOOK_STDOUT_LIMIT = 8192;
const HOOK_KILL_GRACE_MS = 5000;

export interface HookRunResult {
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	spawnError: string | null;
	stdout: string;
	stderr: string;
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
}

/** JSON written to the hook process's stdin. */
export type HookPayload = HookPayloadBase;

function truncate(text: string): string {
	return text.length > HOOK_STDOUT_LIMIT ? `${text.slice(0, HOOK_STDOUT_LIMIT)}…` : text;
}

/** Spawn a hook process, write the payload JSON to stdin, enforce the timeout. Never rejects. */
export function runHookProcess(
	hook: DeclarativeHook,
	payload: HookPayload,
	options: { cwd: string; signal?: AbortSignal },
): Promise<HookRunResult> {
	return new Promise((resolve) => {
		const timeoutMs = (hook.timeoutSeconds ?? HOOK_DEFAULT_TIMEOUT_SECONDS) * 1000;
		let timedOut = false;
		let stdout = "";
		let stderr = "";
		let closeCode: number | null = null;
		let closeSignal: string | null = null;
		let spawnError: string | null = null;

		const child =
			hook.runMode === "shell"
				? spawn(hook.command, {
						cwd: options.cwd,
						shell: true,
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
					})
				: spawn(hook.command, hook.args ?? [], {
						cwd: options.cwd,
						shell: false,
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
					});

		let killTimer: NodeJS.Timeout | undefined;
		let forceKillTimer: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		let finished = false;

		const finish = (result: Partial<HookRunResult>) => {
			if (finished) return;
			finished = true;
			clearTimeout(killTimer);
			clearTimeout(forceKillTimer);
			if (abortListener) options.signal?.removeEventListener("abort", abortListener);
			resolve({
				code: result.code ?? closeCode,
				signal: result.signal ?? closeSignal,
				timedOut,
				aborted: options.signal?.aborted === true,
				spawnError,
				stdout: truncate(stdout),
				stderr: truncate(stderr),
			});
		};

		killTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => child.kill("SIGKILL"), HOOK_KILL_GRACE_MS);
		}, timeoutMs);

		if (options.signal) {
			abortListener = () => {
				child.kill("SIGTERM");
				forceKillTimer = setTimeout(() => child.kill("SIGKILL"), HOOK_KILL_GRACE_MS);
			};
			options.signal.addEventListener("abort", abortListener, { once: true });
		}

		child.on("error", (error) => {
			spawnError = error instanceof Error ? error.message : String(error);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < HOOK_STDOUT_LIMIT * 2) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < HOOK_STDOUT_LIMIT * 2) stderr += chunk.toString("utf8");
		});
		child.on("close", (code, signal) => {
			closeCode = code;
			closeSignal = signal;
			// Give buffered stdout/stderr data events a tick to land before resolving.
			setImmediate(() => finish({}));
		});

		// EPIPE when the hook exits without reading stdin; never fail the run for it.
		child.stdin?.on("error", () => undefined);
		try {
			child.stdin?.end(`${JSON.stringify(payload)}\n`);
		} catch {
			// Ignore sync write failures; the close handler still resolves.
		}
	});
}

function blockReason(hook: DeclarativeHook, result: HookRunResult): string {
	const output = (result.stdout.trim() || result.stderr.trim()).split("\n")[0]?.trim();
	const suffix = output ? `: ${output}` : "";
	return `Blocked by hook ${hook.name}${suffix}`;
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
): Promise<Array<{ hook: DeclarativeHook; result: HookRunResult }>> {
	const details = extra();
	const results: Array<{ hook: DeclarativeHook; result: HookRunResult }> = [];
	for (const hook of hooks) {
		if (!hook.enabled || hook.event !== event) continue;
		if (details.toolName !== undefined && !hookMatchesTool(hook, details.toolName)) continue;
		const payload: HookPayload = { ...basePayload(hook, ctx), ...details };
		try {
			results.push({ hook, result: await runHookProcess(hook, payload, { cwd: ctx.cwd, signal: ctx.signal }) });
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

			const toolHooks = allHooks.filter((hook) => hook.event === "PreToolUse");
			const resultHooks = allHooks.filter(
				(hook) => hook.event === "PostToolUse" || hook.event === "PostToolUseFailure",
			);
			const startHooks = allHooks.filter((hook) => hook.event === "SessionStart");
			const inputHooks = allHooks.filter((hook) => hook.event === "UserPromptSubmit");
			const stopHooks = allHooks.filter((hook) => hook.event === "Stop");

			if (toolHooks.length > 0) {
				metis.on("tool_call", async (event, ctx) => {
					const results = await runMatchingHooks(toolHooks, "PreToolUse", ctx, () => ({
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						input: event.input,
					}));
					for (const { hook, result } of results) {
						if (result.code === HOOK_BLOCK_EXIT_CODE) {
							return { block: true, reason: blockReason(hook, result) };
						}
					}
					return undefined;
				});
			}

			if (resultHooks.length > 0) {
				metis.on("tool_result", async (event, ctx) => {
					await runMatchingHooks(resultHooks, event.isError ? "PostToolUseFailure" : "PostToolUse", ctx, () => ({
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						input: event.input,
						content: event.content,
						details: event.details,
						isError: event.isError,
					}));
					return undefined;
				});
			}

			if (startHooks.length > 0) {
				metis.on("session_start", async (event, ctx) => {
					await runMatchingHooks(startHooks, "SessionStart", ctx, () => ({ reason: event.reason }));
				});
			}

			if (inputHooks.length > 0) {
				// Observer-only: hook exit codes never transform or swallow user input.
				metis.on("input", async (event, ctx) => {
					await runMatchingHooks(inputHooks, "UserPromptSubmit", ctx, () => ({
						text: event.text,
						source: event.source,
					}));
					return undefined;
				});
			}

			if (stopHooks.length > 0) {
				metis.on("agent_settled", async (_event, ctx) => {
					await runMatchingHooks(stopHooks, "Stop", ctx, () => ({}));
				});
			}
		},
	};
}
