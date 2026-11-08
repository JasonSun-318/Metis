/**
 * Slash-command recognition for the interactive editor.
 *
 * Command names and argument rules live in one table so the submit handler only
 * dispatches on a stable id; adding a command no longer means adding another
 * `text === ... || text.startsWith(...)` branch.
 */
export type SlashCommandId =
	| "settings"
	| "permissions"
	| "scoped-models"
	| "model"
	| "export"
	| "import"
	| "copy"
	| "name"
	| "session"
	| "hotkeys"
	| "fork"
	| "clone"
	| "tree"
	| "trust"
	| "login"
	| "logout"
	| "add-dir"
	| "remove-dir"
	| "dirs"
	| "new"
	| "compact"
	| "memory"
	| "dream"
	| "schedule"
	| "schedule-usage"
	| "mcp"
	| "mcp-usage"
	| "reload"
	| "debug"
	| "resume"
	| "quit";

const EXACT_COMMANDS: ReadonlyMap<string, SlashCommandId> = new Map([
	["/settings", "settings"],
	["/permissions", "permissions"],
	["/scoped-models", "scoped-models"],
	["/model", "model"],
	["/export", "export"],
	["/import", "import"],
	["/copy", "copy"],
	["/name", "name"],
	["/session", "session"],
	["/hotkeys", "hotkeys"],
	["/fork", "fork"],
	["/clone", "clone"],
	["/tree", "tree"],
	["/trust", "trust"],
	["/login", "login"],
	["/logout", "logout"],
	["/add-dir", "add-dir"],
	["/remove-dir", "remove-dir"],
	["/dirs", "dirs"],
	["/new", "new"],
	["/compact", "compact"],
	["/memory", "memory"],
	["/dream", "dream"],
	["/schedule", "schedule"],
	["/mcp", "mcp"],
	["/reload", "reload"],
	["/debug", "debug"],
	["/resume", "resume"],
	["/quit", "quit"],
]);

// Commands that accept a trailing argument (and the usage-warning variants).
const PREFIX_COMMANDS: ReadonlyArray<readonly [string, SlashCommandId]> = [
	["/model", "model"],
	["/export", "export"],
	["/import", "import"],
	["/name", "name"],
	["/login", "login"],
	["/add-dir", "add-dir"],
	["/remove-dir", "remove-dir"],
	["/dirs", "dirs"],
	["/new", "new"],
	["/compact", "compact"],
	["/memory", "memory"],
	["/dream", "dream"],
	["/schedule", "schedule-usage"],
	["/mcp", "mcp-usage"],
];

export interface SlashCommandMatch {
	readonly id: SlashCommandId;
}

export function matchSlashCommand(text: string): SlashCommandMatch | undefined {
	const exact = EXACT_COMMANDS.get(text);
	if (exact !== undefined) return { id: exact };
	for (const [prefix, id] of PREFIX_COMMANDS) {
		if (text.startsWith(`${prefix} `)) return { id };
	}
	return undefined;
}
