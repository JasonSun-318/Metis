/**
 * Declarative user-level hooks ("hooks.json").
 *
 * A declarative hook binds a lifecycle event to an external command: when the
 * event fires, the bridge extension spawns the command as a child process and
 * feeds the event payload as JSON on stdin. This module owns the config file
 * format (read/validate/write); the runtime mapping lives in hook-bridge.ts.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileAtomicallySync } from "../durable-file.ts";
import { validateHookMatcher } from "./hook-protocol.ts";

export const HOOKS_CONFIG_FILENAME = "hooks.json";

/** Lifecycle events a declarative hook can bind to. */
export const HOOK_EVENT_NAMES = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** How the configured command is spawned. */
export const HOOK_RUN_MODES = ["process", "shell"] as const;
export type HookRunMode = (typeof HOOK_RUN_MODES)[number];

export const HOOK_PROTOCOLS = ["legacy", "command-v1"] as const;
export type HookProtocol = (typeof HOOK_PROTOCOLS)[number];

export const HOOK_DEFAULT_TIMEOUT_SECONDS = 60;
export const HOOK_MAX_TIMEOUT_SECONDS = 600;

export interface DeclarativeHook {
	/** Stable identifier used for update/delete. */
	id: string;
	/** Display name shown in the hooks list. */
	name: string;
	/** Disabled hooks stay configured but never run. */
	enabled: boolean;
	/** Lifecycle event this hook binds to. See HOOK_EVENT_NAMES. */
	event: HookEventName;
	/** Only meaningful for tool events; comma/space separated tool names, empty = all tools. */
	matcher?: string;
	/** See HOOK_RUN_MODES. */
	runMode: HookRunMode;
	/**
	 * Execution protocol.
	 * - undefined | "legacy": preserves historical behavior (tool list matcher, stdout logs, exit 2).
	 * - "command-v1": structured JSON output, regex matcher, context injection and blocking/continuation decisions.
	 */
	protocol?: HookProtocol;
	/** process mode: executable; shell mode: full command line. */
	command: string;
	/** process mode only: argv entries. */
	args?: string[];
	/** Kill the hook process after this many seconds. */
	timeoutSeconds?: number;
	/** Free-form note shown in status surfaces; also passed to the hook payload. */
	statusMessage?: string;
	/** Free-form JSON passed through to the hook payload. */
	metadata?: Record<string, unknown>;
}

export interface DeclarativeHooksConfig {
	hooks: DeclarativeHook[];
}

export function isHookEventName(value: string): value is HookEventName {
	return (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

export function isHookProtocol(value: string): value is HookProtocol {
	return (HOOK_PROTOCOLS as readonly string[]).includes(value as HookProtocol);
}

export function isHookRunMode(value: string): value is HookRunMode {
	return (HOOK_RUN_MODES as readonly string[]).includes(value);
}

/** Split a matcher into normalized tool names; empty result means "match all". */
export function parseHookMatcher(matcher: string | undefined): string[] {
	if (!matcher) return [];
	return matcher
		.split(/[,;\s]+/u)
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

export function hookMatchesTool(hook: DeclarativeHook, toolName: string): boolean {
	const names = parseHookMatcher(hook.matcher);
	if (names.length === 0) return true;
	return names.includes(toolName.toLowerCase());
}

export function createHookId(): string {
	return randomUUID();
}

export function validateDeclarativeHook(hook: DeclarativeHook): string | null {
	if (typeof hook.id !== "string" || hook.id.length === 0 || hook.id.length > 128) {
		return "Hook id must be a non-empty string (max 128 chars)";
	}
	if (typeof hook.name !== "string" || hook.name.trim().length === 0 || hook.name.length > 200) {
		return "Hook name must be a non-empty string (max 200 chars)";
	}
	if (typeof hook.enabled !== "boolean") return "Hook enabled must be a boolean";
	if (!isHookEventName(hook.event)) {
		return `Hook event must be one of: ${HOOK_EVENT_NAMES.join(", ")}`;
	}
	if (!isHookRunMode(hook.runMode)) {
		return `Hook runMode must be one of: ${HOOK_RUN_MODES.join(", ")}`;
	}
	if (typeof hook.command !== "string" || hook.command.trim().length === 0 || hook.command.length > 4096) {
		return "Hook command must be a non-empty string (max 4096 chars)";
	}
	if (hook.args !== undefined) {
		if (!Array.isArray(hook.args) || hook.args.some((arg) => typeof arg !== "string")) {
			return "Hook args must be an array of strings";
		}
		if (hook.args.length > 64) return "Hook args must contain at most 64 entries";
	}
	if (
		hook.timeoutSeconds !== undefined &&
		(!Number.isInteger(hook.timeoutSeconds) ||
			hook.timeoutSeconds < 1 ||
			hook.timeoutSeconds > HOOK_MAX_TIMEOUT_SECONDS)
	) {
		return `Hook timeoutSeconds must be an integer between 1 and ${HOOK_MAX_TIMEOUT_SECONDS}`;
	}
	if (hook.protocol !== undefined && (typeof hook.protocol !== "string" || !isHookProtocol(hook.protocol))) {
		return `Hook protocol must be one of: ${HOOK_PROTOCOLS.join(", ")}`;
	}
	if (hook.matcher !== undefined && typeof hook.matcher !== "string") {
		return "Hook matcher must be a string";
	}
	const matcherError = validateHookMatcher(hook);
	if (matcherError) {
		return matcherError;
	}
	if (
		hook.statusMessage !== undefined &&
		(typeof hook.statusMessage !== "string" || hook.statusMessage.length > 500)
	) {
		return "Hook statusMessage must be a string (max 500 chars)";
	}
	if (hook.metadata !== undefined) {
		if (typeof hook.metadata !== "object" || hook.metadata === null || Array.isArray(hook.metadata)) {
			return "Hook metadata must be an object";
		}
		if (JSON.stringify(hook.metadata).length > 8192) return "Hook metadata must stay under 8KB";
	}
	return null;
}

function coerceHook(value: unknown): DeclarativeHook | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	const event = typeof raw.event === "string" ? raw.event : "";
	const runMode = typeof raw.runMode === "string" ? raw.runMode : "";
	if (!isHookEventName(event) || !isHookRunMode(runMode)) return null;
	return {
		id: typeof raw.id === "string" ? raw.id : "",
		name: typeof raw.name === "string" ? raw.name : "",
		enabled: raw.enabled !== false,
		event,
		...(typeof raw.matcher === "string" ? { matcher: raw.matcher } : {}),
		runMode,
		...(raw.protocol !== undefined ? { protocol: raw.protocol as HookProtocol } : {}),
		command: typeof raw.command === "string" ? raw.command : "",
		...(Array.isArray(raw.args) ? { args: raw.args.filter((arg): arg is string => typeof arg === "string") } : {}),
		...(typeof raw.timeoutSeconds === "number" ? { timeoutSeconds: raw.timeoutSeconds } : {}),
		...(typeof raw.statusMessage === "string" ? { statusMessage: raw.statusMessage } : {}),
		...(typeof raw.metadata === "object" && raw.metadata !== null && !Array.isArray(raw.metadata)
			? { metadata: raw.metadata as Record<string, unknown> }
			: {}),
	};
}

export function hooksConfigPath(agentDir: string): string {
	return join(agentDir, HOOKS_CONFIG_FILENAME);
}

/**
 * Read and validate hooks.json. Returns invalid entries' error strings instead
 * of throwing so a corrupt file never blocks session startup.
 */
export function loadDeclarativeHooks(agentDir: string): { hooks: DeclarativeHook[]; errors: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(hooksConfigPath(agentDir), "utf8"));
	} catch {
		return { hooks: [], errors: [] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { hooks: [], errors: [] };
	}
	const rawHooks = (parsed as { hooks?: unknown }).hooks;
	if (!Array.isArray(rawHooks)) return { hooks: [], errors: [] };

	const hooks: DeclarativeHook[] = [];
	const errors: string[] = [];
	for (const [index, entry] of rawHooks.entries()) {
		const hook = coerceHook(entry);
		if (!hook) {
			errors.push(`hooks[${index}]: invalid hook entry`);
			continue;
		}
		const error = validateDeclarativeHook(hook);
		if (error) {
			errors.push(`${hook.name || hook.id || `hooks[${index}]`}: ${error}`);
			continue;
		}
		hooks.push(hook);
	}
	return { hooks, errors };
}

/** Validate and persist hooks.json atomically. Throws on validation failure. */
export function saveDeclarativeHooks(agentDir: string, hooks: DeclarativeHook[]): void {
	if (hooks.length > 100) throw new Error("At most 100 hooks can be configured");
	const seen = new Set<string>();
	for (const hook of hooks) {
		const error = validateDeclarativeHook(hook);
		if (error) throw new Error(error);
		if (seen.has(hook.id)) throw new Error(`Duplicate hook id: ${hook.id}`);
		seen.add(hook.id);
	}
	replaceFileAtomicallySync(hooksConfigPath(agentDir), `${JSON.stringify({ hooks }, null, "\t")}\n`);
}
