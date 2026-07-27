import { APP_NAME } from "../config.ts";
import type { AgentMode } from "./agent-mode.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	modes?: readonly AgentMode[];
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "permissions", description: "Set this session's approval mode" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session", argumentHint: "[chat|code]" },
	{
		name: "add-dir",
		description: "Add a working directory to this Code session",
		argumentHint: "<path>",
		modes: ["code"],
	},
	{
		name: "remove-dir",
		description: "Remove an added working directory",
		argumentHint: "<path>",
		modes: ["code"],
	},
	{ name: "dirs", description: "List this Code session's working directories", modes: ["code"] },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "memory", description: "Show or toggle long-term memory", argumentHint: "[on|off]" },
	{ name: "dream", description: "Show Dream status and recent memory-maintenance history" },
	{ name: "schedule", description: "Manage scheduled tasks" },
	{ name: "mcp", description: "Open MCP server manager" },
	{ name: "reload", description: "Reload resources, context files, and memory" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

export function getBuiltinSlashCommands(mode: AgentMode): readonly BuiltinSlashCommand[] {
	return BUILTIN_SLASH_COMMANDS.filter((command) => !command.modes || command.modes.includes(mode));
}
