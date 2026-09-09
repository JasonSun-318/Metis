import { type DeclarativeHook, hookMatchesTool } from "./declarative-hooks.ts";
import type { HookPayload, HookRunResult } from "./hook-bridge.ts";

export const MAX_PIPE_BUFFER_BYTES = 32768; // 32 KiB
export const MAX_HOOK_CONTEXT_BYTES = 8192; // 8 KiB
export const MAX_EVENT_TOTAL_CONTEXT_BYTES = 32768; // 32 KiB

export const COMPATIBLE_TOOL_ALIASES: Readonly<Record<string, string>> = {
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Glob",
};

export interface HookEffect {
	context?: string;
	blockReason?: string;
	continueReason?: string;
	diagnostic?: string;
}

export const HOOK_CONTEXT_TRUNCATED_MARKER = "\n[Hook context truncated to 8 KiB]";
export const EVENT_CONTEXT_TRUNCATED_MARKER = "\n[Total hook context truncated to 32 KiB]";

/**
 * Safely truncate a UTF-8 string to stay within maxBytes without breaking code units or surrogate pairs.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) {
		return { text, truncated: false };
	}
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end--;
	}
	return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Truncate a single hook's context to maxBytes (default 8 KiB) and append a truncation note if truncated.
 */
export function truncateHookContext(text: string, maxBytes = MAX_HOOK_CONTEXT_BYTES): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) {
		return text;
	}
	const marker = HOOK_CONTEXT_TRUNCATED_MARKER;
	const markerBytes = Buffer.byteLength(marker, "utf8");
	const targetBytes = Math.max(0, maxBytes - markerBytes);
	const truncated = truncateUtf8Bytes(text, targetBytes).text;
	return `${truncated}${marker}`;
}

/**
 * Merge multiple hook contexts into a single formatted string, respecting the total event byte budget.
 */
export function mergeEventContexts(
	entries: Array<{ hookName: string; context: string }>,
	maxTotalBytes = MAX_EVENT_TOTAL_CONTEXT_BYTES,
): string | undefined {
	if (entries.length === 0) return undefined;

	const formattedList: string[] = [];
	let currentBytes = 0;
	const marker = EVENT_CONTEXT_TRUNCATED_MARKER;
	const markerBytes = Buffer.byteLength(marker, "utf8");

	for (const entry of entries) {
		const itemText = `[Hook: ${entry.hookName}]\n${truncateHookContext(entry.context, MAX_HOOK_CONTEXT_BYTES)}`;
		const separator = formattedList.length > 0 ? "\n\n" : "";
		const separatorBytes = Buffer.byteLength(separator, "utf8");
		const itemBytes = Buffer.byteLength(itemText, "utf8");

		if (currentBytes + separatorBytes + itemBytes <= maxTotalBytes) {
			formattedList.push(itemText);
			currentBytes += separatorBytes + itemBytes;
		} else {
			const remainingForThisItem = maxTotalBytes - currentBytes - separatorBytes - markerBytes;
			if (remainingForThisItem > 0) {
				const truncatedItem = truncateUtf8Bytes(itemText, remainingForThisItem).text;
				formattedList.push(`${truncatedItem}${marker}`);
			} else if (formattedList.length > 0) {
				const currentJoined = formattedList.join("\n\n");
				const availableForMarker = maxTotalBytes - Buffer.byteLength(currentJoined, "utf8");
				if (availableForMarker >= markerBytes) {
					formattedList.push(marker.trimStart());
				} else {
					const truncatedAll = truncateUtf8Bytes(currentJoined, Math.max(0, maxTotalBytes - markerBytes)).text;
					return `${truncatedAll}${marker}`;
				}
			} else {
				return truncateUtf8Bytes(marker, maxTotalBytes).text;
			}
			break;
		}
	}

	const result = formattedList.join("\n\n");
	if (Buffer.byteLength(result, "utf8") > maxTotalBytes) {
		return truncateUtf8Bytes(result, maxTotalBytes).text;
	}
	return result;
}

/**
 * Maps known tool parameters to vendor-compatible parameter names (e.g. path -> file_path).
 * Does not fabricate missing parameters or unsupported patch formats.
 */
export function mapToolInput(toolName: string | undefined, input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return input;
	}
	const raw = input as Record<string, unknown>;
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		if (raw.path !== undefined) {
			const { path, ...rest } = raw;
			return { file_path: path, ...rest };
		}
	}
	return input;
}

/**
 * Build the JSON payload to feed on stdin.
 * command-v1 supplies both original camelCase and compatibility snake_case fields.
 */
export function buildCommandHookPayload(hook: DeclarativeHook, payload: HookPayload): Record<string, unknown> {
	const base: Record<string, unknown> = {
		event: payload.event,
		hook: payload.hook,
		sessionId: payload.sessionId,
		cwd: payload.cwd,
		timestamp: payload.timestamp,
		...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
		...(payload.toolCallId !== undefined ? { toolCallId: payload.toolCallId } : {}),
		...(payload.input !== undefined ? { input: payload.input } : {}),
		...(payload.reason !== undefined ? { reason: payload.reason } : {}),
		...(payload.text !== undefined ? { text: payload.text } : {}),
		...(payload.source !== undefined ? { source: payload.source } : {}),
		...(payload.content !== undefined ? { content: payload.content } : {}),
		...(payload.details !== undefined ? { details: payload.details } : {}),
		...(payload.isError !== undefined ? { isError: payload.isError } : {}),
	};

	if (hook.protocol !== "command-v1") {
		return base;
	}

	const toolNameCompat = payload.toolName
		? (COMPATIBLE_TOOL_ALIASES[payload.toolName] ?? payload.toolName)
		: undefined;
	const toolInputCompat = payload.input !== undefined ? mapToolInput(payload.toolName, payload.input) : undefined;

	return {
		...base,
		hook_event_name: payload.event,
		session_id: payload.sessionId,
		cwd: payload.cwd,
		...(toolNameCompat !== undefined ? { tool_name: toolNameCompat } : {}),
		...(toolInputCompat !== undefined ? { tool_input: toolInputCompat } : {}),
		...(payload.toolCallId !== undefined ? { tool_use_id: payload.toolCallId } : {}),
		...(payload.event === "UserPromptSubmit" && payload.text !== undefined ? { prompt: payload.text } : {}),
		...(payload.content !== undefined || payload.details !== undefined || payload.isError !== undefined
			? {
					tool_response: {
						content: payload.content,
						details: payload.details,
						isError: payload.isError ?? false,
					},
				}
			: {}),
		...(payload.error !== undefined ? { error: payload.error } : {}),
		...(payload.stopHookActive !== undefined ? { stop_hook_active: payload.stopHookActive } : {}),
		...(payload.lastAssistantMessage !== undefined ? { last_assistant_message: payload.lastAssistantMessage } : {}),
	};
}

/**
 * Validate the matcher string according to hook protocol and event.
 */
export function validateHookMatcher(hook: Pick<DeclarativeHook, "protocol" | "event" | "matcher">): string | null {
	if (hook.protocol !== "command-v1") {
		return null;
	}
	if (hook.event === "Stop" || hook.event === "UserPromptSubmit") {
		if (hook.matcher !== undefined && hook.matcher.trim().length > 0) {
			return `Hook matcher is not applicable to ${hook.event} in command-v1`;
		}
		return null;
	}
	if (hook.matcher !== undefined && hook.matcher.trim().length > 0 && hook.matcher.trim() !== "*") {
		try {
			new RegExp(hook.matcher);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return `Invalid matcher regex: ${message}`;
		}
	}
	return null;
}

/**
 * Determine if a hook matches a given event context.
 */
export function matchHook(hook: DeclarativeHook, context: { toolName?: string; reason?: string }): boolean {
	if (hook.protocol !== "command-v1") {
		if (hook.event === "PreToolUse" || hook.event === "PostToolUse" || hook.event === "PostToolUseFailure") {
			return hookMatchesTool(hook, context.toolName ?? "");
		}
		return true;
	}

	if (hook.event === "Stop" || hook.event === "UserPromptSubmit") {
		return true;
	}

	if (hook.event === "SessionStart") {
		if (!hook.matcher || hook.matcher.trim() === "" || hook.matcher.trim() === "*") {
			return true;
		}
		try {
			const regex = new RegExp(hook.matcher);
			return regex.test(context.reason ?? "");
		} catch {
			return false;
		}
	}

	// Tool events: PreToolUse, PostToolUse, PostToolUseFailure
	if (!hook.matcher || hook.matcher.trim() === "" || hook.matcher.trim() === "*") {
		return true;
	}
	const tool = context.toolName;
	if (!tool) return true;

	const candidates = [tool];
	const alias = COMPATIBLE_TOOL_ALIASES[tool];
	if (alias && !candidates.includes(alias)) {
		candidates.push(alias);
	}
	for (const [k, v] of Object.entries(COMPATIBLE_TOOL_ALIASES)) {
		if (tool === v && !candidates.includes(k)) {
			candidates.push(k);
		}
	}

	try {
		const regex = new RegExp(hook.matcher);
		return candidates.some((candidate) => regex.test(candidate));
	} catch {
		return false;
	}
}

function defaultBlockReason(hook: DeclarativeHook, run: HookRunResult): string {
	const output = (run.stderr.trim() || run.stdout.trim()).split("\n")[0]?.trim();
	const suffix = output ? `: ${output}` : "";
	return `Blocked by hook ${hook.name}${suffix}`;
}

/**
 * Pure interpreter of hook execution results into domain effects.
 * Never spawns, never persists, never calls model.
 */
export function interpretHookResult(
	hook: DeclarativeHook,
	run: HookRunResult & { stdoutTruncated?: boolean },
): HookEffect {
	if (hook.protocol !== "command-v1") {
		if (run.code === 2 && hook.event === "PreToolUse") {
			return { blockReason: defaultBlockReason(hook, run) };
		}
		return {};
	}

	if (run.spawnError) {
		return { diagnostic: `Hook "${hook.name}" failed to spawn: ${run.spawnError}` };
	}
	if (run.timedOut) {
		return { diagnostic: `Hook "${hook.name}" timed out` };
	}
	if (run.aborted) {
		return { diagnostic: `Hook "${hook.name}" was aborted` };
	}

	// Exit code 2 takes precedence over stdout JSON
	if (run.code === 2) {
		const reason = run.stderr.trim() || run.stdout.trim() || `Blocked by hook ${hook.name}`;
		if (hook.event === "UserPromptSubmit") {
			return { blockReason: reason };
		}
		if (hook.event === "PreToolUse") {
			return { blockReason: reason };
		}
		if (hook.event === "Stop") {
			if (run.stderr.trim() || run.stdout.trim()) {
				return { continueReason: reason };
			}
			return { diagnostic: `Hook "${hook.name}" exited with code 2 without reason` };
		}
		return { diagnostic: `Hook "${hook.name}" exited with code 2: ${reason}` };
	}

	if (run.code !== 0) {
		return { diagnostic: `Hook "${hook.name}" exited with code ${run.code ?? run.signal}` };
	}

	// Exit code 0
	const cleanStdout = run.stdout.replace(/^\uFEFF/, "").trim();
	if (cleanStdout === "") {
		return {};
	}

	const isJsonCandidate = cleanStdout.startsWith("{") || cleanStdout.startsWith("[");
	if (isJsonCandidate) {
		if (run.stdoutTruncated) {
			return { diagnostic: `Hook "${hook.name}" output was truncated; cannot parse partial JSON` };
		}
		if (cleanStdout.startsWith("[")) {
			return { diagnostic: `Hook "${hook.name}" returned a JSON array, expected object` };
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(cleanStdout);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { diagnostic: `Hook "${hook.name}" output invalid JSON: ${message}` };
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { diagnostic: `Hook "${hook.name}" returned non-object JSON` };
		}

		const raw = parsed as Record<string, unknown>;
		const hookSpecific =
			typeof raw.hookSpecificOutput === "object" &&
			raw.hookSpecificOutput !== null &&
			!Array.isArray(raw.hookSpecificOutput)
				? (raw.hookSpecificOutput as Record<string, unknown>)
				: undefined;

		const outputEventName =
			(typeof raw.hookEventName === "string" ? raw.hookEventName : undefined) ??
			(typeof hookSpecific?.hookEventName === "string" ? hookSpecific.hookEventName : undefined);
		if (outputEventName !== undefined && outputEventName !== hook.event) {
			return { diagnostic: `Hook event name mismatch: expected ${hook.event}, got ${outputEventName}` };
		}

		const diagnostics: string[] = [];

		const permDecision =
			(typeof raw.permissionDecision === "string" ? raw.permissionDecision : undefined) ??
			(typeof hookSpecific?.permissionDecision === "string" ? hookSpecific.permissionDecision : undefined);
		if (permDecision === "allow" || permDecision === "ask") {
			diagnostics.push(`permissionDecision "${permDecision}" is not supported`);
		}

		if (raw.updatedInput !== undefined || hookSpecific?.updatedInput !== undefined) {
			diagnostics.push("updatedInput is not supported");
		}
		if (raw.continue === false || hookSpecific?.continue === false) {
			diagnostics.push("continue:false is not supported");
		}
		if (raw.async === true || raw.actions !== undefined || raw.commands !== undefined) {
			diagnostics.push("unsupported control fields in hook output");
		}

		const decision = typeof raw.decision === "string" ? raw.decision : undefined;
		const reason =
			(typeof raw.reason === "string" ? raw.reason : undefined) ??
			(typeof hookSpecific?.permissionDecisionReason === "string"
				? hookSpecific.permissionDecisionReason
				: undefined) ??
			(typeof hookSpecific?.reason === "string" ? hookSpecific.reason : undefined);

		const rawContext =
			(typeof raw.additionalContext === "string" ? raw.additionalContext : undefined) ??
			(typeof hookSpecific?.additionalContext === "string" ? hookSpecific.additionalContext : undefined);

		const context = rawContext !== undefined ? truncateHookContext(rawContext) : undefined;

		const effect: HookEffect = {};
		if (context) effect.context = context;

		if (hook.event === "UserPromptSubmit") {
			if (decision === "block") {
				effect.blockReason = reason || "Request blocked by hook";
			}
		} else if (hook.event === "PreToolUse") {
			if (decision === "block" || permDecision === "deny") {
				effect.blockReason = reason || "Tool execution blocked by hook";
			}
		} else if (hook.event === "Stop") {
			if (decision === "block") {
				if (reason && reason.trim().length > 0) {
					effect.continueReason = truncateUtf8Bytes(reason, MAX_HOOK_CONTEXT_BYTES).text;
				} else {
					diagnostics.push("Stop hook requested continuation without a valid reason");
				}
			}
		} else if (hook.event === "SessionStart") {
			if (decision === "block") {
				diagnostics.push("blocking is not supported for SessionStart");
			}
		} else if (hook.event === "PostToolUse") {
			if (decision === "block") {
				diagnostics.push("blocking is not supported for PostToolUse");
			}
		} else if (hook.event === "PostToolUseFailure") {
			if (decision === "block") {
				diagnostics.push("blocking is not supported for PostToolUseFailure");
			}
		}

		if (diagnostics.length > 0) {
			effect.diagnostic = diagnostics.join("; ");
		}
		return effect;
	}

	// Plain text stdout
	if (hook.event === "SessionStart" || hook.event === "UserPromptSubmit") {
		return { context: truncateHookContext(cleanStdout) };
	}

	return { diagnostic: `Hook "${hook.name}" output plain text: ${cleanStdout.slice(0, 100)}` };
}
