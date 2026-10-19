/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@metis/agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import { type AgentMode, isAgentMode } from "../core/agent-mode.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import { isPermissionPreset, type PermissionPreset } from "../core/permissions/settings.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	agentMode?: AgentMode;
	cwd?: string;
	permissionPreset?: PermissionPreset;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	verbose?: boolean;
	projectTrustOverride?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_SELECTIONS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return (VALID_THINKING_SELECTIONS as readonly string[]).includes(level);
}

/**
 * Short options that the parser recognizes. Required values may legitimately
 * begin with a dash (negative numbers, YAML frontmatter, free text), so only
 * exact aliases are treated as options when looking ahead.
 */
const KNOWN_SHORT_OPTIONS = new Set([
	"-h",
	"-v",
	"-c",
	"-r",
	"-n",
	"-nt",
	"-nbt",
	"-t",
	"-xt",
	"-p",
	"-e",
	"-ne",
	"-ns",
	"-np",
	"-nc",
	"-a",
	"-na",
]);

function takeRequiredValue(
	args: string[],
	index: number,
	option: string,
	requirement: string,
	result: Args,
): { value: string; index: number } | undefined {
	const value = args[index + 1];
	const optionName = value?.split("=", 1)[0];
	// Long option names never contain whitespace and cannot begin with a dash
	// after the prefix, which keeps `---frontmatter` usable as a value.
	const looksLikeOption =
		value !== undefined &&
		(KNOWN_SHORT_OPTIONS.has(value) ||
			(optionName !== undefined &&
				optionName.length > 2 &&
				optionName.startsWith("--") &&
				optionName[2] !== "-" &&
				!/\s/u.test(optionName)));
	if (value === undefined || looksLikeOption) {
		result.diagnostics.push({ type: "error", message: `${option} requires ${requirement}` });
		return undefined;
	}
	return { value, index: index + 1 };
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode") {
			const consumed = takeRequiredValue(args, i, "--mode", "text, json, or rpc", result);
			if (consumed) {
				i = consumed.index;
				if (consumed.value === "text" || consumed.value === "json" || consumed.value === "rpc") {
					result.mode = consumed.value;
				} else {
					result.diagnostics.push({
						type: "error",
						message: `Invalid mode "${consumed.value}". Valid values: text, json, rpc`,
					});
				}
			}
		} else if (arg === "--agent-mode") {
			const mode = args[i + 1];
			if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--agent-mode requires chat or code" });
			} else {
				i++;
				if (isAgentMode(mode)) {
					result.agentMode = mode;
				} else {
					result.diagnostics.push({
						type: "error",
						message: `Invalid agent mode "${mode}". Valid values: chat, code`,
					});
				}
			}
		} else if (arg === "--cwd") {
			const path = args[i + 1];
			if (path === undefined || path.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--cwd requires a directory path" });
			} else {
				result.cwd = path;
				i++;
			}
		} else if (arg === "--permission-preset") {
			const mode = args[i + 1];
			if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--permission-preset requires ask, auto, or full" });
			} else {
				i++;
				if (isPermissionPreset(mode)) {
					result.permissionPreset = mode;
				} else {
					result.diagnostics.push({
						type: "error",
						message: `Invalid permission preset "${mode}". Valid values: ask, auto, full`,
					});
				}
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.provider = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--model") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.model = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--api-key") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.apiKey = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--system-prompt") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.systemPrompt = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--append-system-prompt") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.appendSystemPrompt = result.appendSystemPrompt ?? [];
				result.appendSystemPrompt.push(consumed.value);
				i = consumed.index;
			}
		} else if (arg === "--name" || arg === "-n") {
			const consumed = takeRequiredValue(args, i, "--name", "a value", result);
			if (consumed) {
				result.name = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.session = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--session-id") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.sessionId = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--fork") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.fork = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--session-dir") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.sessionDir = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--models") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.models = consumed.value.split(",").map((s) => s.trim());
				i = consumed.index;
			}
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if (arg === "--tools" || arg === "-t") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.tools = consumed.value
					.split(",")
					.map((s) => s.trim())
					.filter((name) => name.length > 0);
				i = consumed.index;
			}
		} else if (arg === "--exclude-tools" || arg === "-xt") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.excludeTools = consumed.value
					.split(",")
					.map((s) => s.trim())
					.filter((name) => name.length > 0);
				i = consumed.index;
			}
		} else if (arg === "--thinking") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				i = consumed.index;
				if (isValidThinkingLevel(consumed.value)) {
					result.thinking = consumed.value;
				} else {
					result.diagnostics.push({
						type: "warning",
						message: `Invalid thinking level "${consumed.value}". Valid values: ${VALID_THINKING_SELECTIONS.join(", ")}`,
					});
				}
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.export = consumed.value;
				i = consumed.index;
			}
		} else if (arg === "--extension" || arg === "-e") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.extensions = result.extensions ?? [];
				result.extensions.push(consumed.value);
				i = consumed.index;
			}
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.skills = result.skills ?? [];
				result.skills.push(consumed.value);
				i = consumed.index;
			}
		} else if (arg === "--prompt-template") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.promptTemplates = result.promptTemplates ?? [];
				result.promptTemplates.push(consumed.value);
				i = consumed.index;
			}
		} else if (arg === "--theme") {
			const consumed = takeRequiredValue(args, i, arg, "a value", result);
			if (consumed) {
				result.themes = result.themes ?? [];
				result.themes.push(consumed.value);
				i = consumed.index;
			}
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	console.log(`${chalk.bold(APP_NAME)} - General-purpose AI agent with read, grep, bash, edit, write, web_fetch, web_search tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|metis] Update packages (CLI self-update is disabled)
  ${APP_NAME} list                      List user and project packages
  ${APP_NAME} config [-l]               Open TUI to enable/disable package resources (Tab switches scope)
  ${APP_NAME} mcp <add|list|get|remove>  Manage MCP server configuration
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list/config/mcp

${chalk.bold("Options:")}
  --provider <name>              Provider name (default: google)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: general-purpose agent prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --agent-mode <mode>            New-session classification: chat or code (default: code)
  --cwd <path>                   Bind a new session to an existing directory
  --permission-preset <ask|auto|full> New-session permission preset (default: auto)
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path|id>            Use specific session file or partial UUID
  --session-id <id>              Use exact project session ID, creating it if missing
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --name, -n <name>              Set session display name
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to built-in, extension, and custom tools
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names to disable
                                 Applies to built-in, extension, and custom tools
  --thinking <level>             Set thinking: off, minimal, low, medium, high, xhigh, max
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --approve, -a                  Trust project-local files for this run
  --no-approve, -na              Ignore project-local files for this run
  --offline                      Disable startup network operations (same as METIS_OFFLINE=1)
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Examples:")}
  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Start a named session
  ${APP_NAME} --name "Refactor auth module"

  # Start a chat session
  ${APP_NAME} --agent-mode chat "Compare these proposals"

  # Use different model
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "github-copilot/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # Disable one tool while keeping the rest available
  ${APP_NAME} --exclude-tools ask_question

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANT_LING_API_KEY                 - Ant Ling API key
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  NVIDIA_API_KEY                   - NVIDIA NIM API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  TOGETHER_API_KEY                 - Together AI API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI Coding Plan API key (Global)
  ZAI_CODING_CN_API_KEY            - ZAI Coding Plan API key (China)
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  METIS_PACKAGE_DIR                     - Override package directory (for Nix/Guix store paths)
  METIS_OFFLINE                         - Disable startup network operations when set to 1/true/yes
  METIS_PROVIDER_ATTRIBUTION            - Enable provider attribution headers with 1/true/yes
${chalk.bold("Built-in Tool Names:")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
`);
}
