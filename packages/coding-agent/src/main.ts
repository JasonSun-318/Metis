/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@metis/ai";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
import { getAgentDir, getMetisEnv, getPackageDir, getSessionDirOverride, VERSION } from "./config.ts";
import { DEFAULT_AGENT_MODE } from "./core/agent-mode.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { McpConfigurationCoordinator } from "./core/mcp/configuration.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import {
	createScheduledRunExecutor,
	installScheduleHost,
	isScheduleSessionEligible,
	readScheduledSessionView,
	SCHEDULE_MAIN_PROMPT,
	ScheduleManager,
} from "./core/schedules/index.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import { pruneStaleSessionWorkDirs } from "./core/session-attachments.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { createSessionId } from "./core/session-id.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { removeOwnedManagedWorkspace, resolveNewSessionWorkspace } from "./core/session-workspace.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { buildChildSystemPrompt } from "./core/subagents/prompts.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { handleMcpCliCommand } from "./mcp-cli.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

const EXTENSION_LOAD_FAILURE_HINT = 'Hint: Start without extensions using "metis -ne".';

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function prepareInitialMessage(
	parsed: Args,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs);
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ type: "local"; path: string } | undefined> {
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id === sessionId);
	return localMatch ? { type: "local", path: localMatch.path } : undefined;
}

async function findSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ path: string } | undefined> {
	const localMatch = await findLocalSessionByExactId(sessionId, cwd, sessionDir);
	if (localMatch) return localMatch;
	const globalMatch = (await SessionManager.listAll(sessionDir)).find((session) => session.id === sessionId);
	return globalMatch ? { path: globalMatch.path } : undefined;
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch =
		localSessions.find((s) => s.id === sessionArg) ?? localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function validateCreationOnlyFlags(parsed: Args): void {
	if (parsed.help || parsed.listModels !== undefined) return;
	const selectedExistingSession = parsed.session || parsed.resume || parsed.fork || parsed.continue;
	if (!selectedExistingSession) return;

	const conflictingFlags = [
		parsed.cwd !== undefined ? "--cwd" : undefined,
		parsed.permissionPreset !== undefined ? "--permission-preset" : undefined,
		parsed.agentMode !== undefined && !parsed.continue ? "--agent-mode" : undefined,
	].filter((flag): flag is string => flag !== undefined);
	if (conflictingFlags.length === 0) return;

	console.error(
		chalk.red(
			`Error: ${conflictingFlags.join(", ")} ${conflictingFlags.length === 1 ? "is" : "are"} only valid when creating a new session`,
		),
	);
	process.exit(1);
}

function rejectCreationOverridesForExistingSession(parsed: Args): void {
	const conflictingFlags = [
		parsed.agentMode !== undefined ? "--agent-mode" : undefined,
		parsed.cwd !== undefined ? "--cwd" : undefined,
		parsed.permissionPreset !== undefined ? "--permission-preset" : undefined,
	].filter((flag): flag is string => flag !== undefined);
	if (conflictingFlags.length === 0) return;
	console.error(
		chalk.red(`Error: ${conflictingFlags.join(", ")} cannot override an existing session selected by --session-id`),
	);
	process.exit(1);
}

function openSessionOrExit(path: string, sessionDir: string | undefined, hasInitialInput: boolean): SessionManager {
	try {
		if (SessionManager.isScheduledSession(path)) {
			if (hasInitialInput) {
				throw new Error("Scheduled execution sessions are read-only and cannot accept new messages");
			}
			const view = readScheduledSessionView(path);
			writeSync(
				process.stdout.fd,
				`Scheduled execution\nTask instructions: ${view.instruction}\n\nResult:\n${view.result}\n`,
			);
			process.exit(0);
		}
		return SessionManager.open(path, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
	agentDir: string,
	hasInitialInput: boolean,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		const ephemeralCwd = parsed.cwd
			? resolveNewSessionWorkspace({
					id: parsed.sessionId ?? createSessionId(),
					mode: parsed.agentMode ?? DEFAULT_AGENT_MODE,
					requestedCwd: parsed.cwd,
					hostCwd: cwd,
					agentDir,
				}).cwd
			: cwd;
		return SessionManager.inMemory(ephemeralCwd, {
			id: parsed.sessionId,
			mode: parsed.agentMode,
			permissionPreset: parsed.permissionPreset,
		});
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir, hasInitialInput);

			case "global": {
				if (SessionManager.isScheduledSession(resolved.path)) {
					return openSessionOrExit(resolved.path, sessionDir, hasInitialInput);
				}
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress) => SessionManager.listAll(sessionDir, onProgress),
				settingsManager,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return openSessionOrExit(selectedPath, sessionDir, hasInitialInput);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir, { mode: parsed.agentMode });
	}

	if (parsed.sessionId) {
		const existingSession = await findSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			rejectCreationOverridesForExistingSession(parsed);
			return openSessionOrExit(existingSession.path, sessionDir, hasInitialInput);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	const mode = parsed.agentMode ?? DEFAULT_AGENT_MODE;
	const sessionId = parsed.sessionId ?? createSessionId();
	const workspace = resolveNewSessionWorkspace({
		id: sessionId,
		mode,
		requestedCwd: parsed.cwd,
		hostCwd: cwd,
		agentDir,
	});
	try {
		return SessionManager.create(workspace.cwd, sessionDir, {
			id: sessionId,
			mode,
			cwdOrigin: workspace.cwdOrigin,
			permissionPreset: parsed.permissionPreset,
		});
	} catch (error) {
		if (workspace.cwdOrigin === "managed") {
			removeOwnedManagedWorkspace({
				id: sessionId,
				cwd: workspace.cwd,
				cwdOrigin: workspace.cwdOrigin,
				agentDir,
			});
		}
		throw error;
	}
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

function closeSessionManagerQuietly(sessionManager: SessionManager): void {
	try {
		sessionManager.close();
	} catch {
		try {
			sessionManager.close();
		} catch {
			// An exit path must preserve its original exit status.
		}
	}
}

async function disposeRuntimeQuietly(runtime: AgentSessionRuntime): Promise<void> {
	try {
		await runtime.dispose();
	} catch {
		try {
			await runtime.dispose();
		} catch {
			// An exit path must preserve its original exit status.
		}
	}
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(getMetisEnv("OFFLINE"));
	if (offlineMode) {
		process.env.METIS_OFFLINE = "1";
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	pruneStaleSessionWorkDirs(agentDir);
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();
	if (await handleMcpCliCommand(args, { extensionFactories: options?.extensionFactories })) return;

	if (await handlePackageCommand(args, { extensionFactories: options?.extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `metis update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(args, { extensionFactories: options?.extensionFactories })) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);
	validateCreationOnlyFlags(parsed);

	const readStdinBeforeSession =
		appMode !== "rpc" &&
		!parsed.help &&
		parsed.listModels === undefined &&
		(parsed.session !== undefined || parsed.sessionId !== undefined || parsed.resume === true);
	let stdinContent: string | undefined;
	if (readStdinBeforeSession) {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
		time("readPipedStdin");
	}

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = getSessionDirOverride();
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		envSessionDir ??
		startupSettingsManager.getSessionDir();
	const hasInitialInput = parsed.messages.length > 0 || parsed.fileArgs.length > 0 || stdinContent !== undefined;
	let sessionManager = await createSessionManager(
		parsed,
		cwd,
		sessionDir,
		startupSettingsManager,
		agentDir,
		hasInitialInput,
	);
	let runtimeOwnsSessionManager = false;
	let scheduleManager: ScheduleManager | undefined;
	try {
		const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
		if (missingSessionCwdIssue) {
			if (appMode === "interactive") {
				const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
				if (!selectedCwd) {
					closeSessionManagerQuietly(sessionManager);
					process.exit(0);
				}
				// Reopening the same journal with a cwd override must first release the
				// lifetime writer lease held by the initial manager.
				sessionManager.close();
				sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
			} else {
				console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
				closeSessionManagerQuietly(sessionManager);
				process.exit(1);
			}
		}
		if (parsed.name !== undefined) {
			const name = parsed.name.trim();
			if (!name) {
				console.error(chalk.red("Error: --name requires a non-empty value"));
				closeSessionManagerQuietly(sessionManager);
				process.exit(1);
			}
			sessionManager.appendSessionInfo(name);
		}
		time("createSessionManager");
		if (!parsed.help && parsed.listModels === undefined) {
			scheduleManager = ScheduleManager.create({
				agentDir,
				execute: createScheduledRunExecutor({ agentDir }),
			});
			await scheduleManager.start();
			try {
				await scheduleManager.list({ limit: 1 });
			} catch (error) {
				console.error(chalk.yellow(`Warning: ${error instanceof Error ? error.message : String(error)}`));
			}
		}

		const trustStore = new ProjectTrustStore(agentDir);
		const mcpConfigurationCoordinator = new McpConfigurationCoordinator({ authStorage: AuthStorage.create() });
		const sessionCwd = sessionManager.getCwd();
		const autoTrustOnReloadCwd =
			parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
				? sessionCwd
				: undefined;
		const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
		const projectTrustByCwd = new Map<string, boolean>();

		const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
		const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
		const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
		const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
			projectTrustContext,
			childConfig,
			permissionSettingsCeiling,
		}) => {
			if (childConfig && !permissionSettingsCeiling)
				throw new Error("Child runtime is missing its permission ceiling");
			// Credentials remain shared through the locked auth file, while OAuth provider
			// routing stays owned by this runtime's AuthStorage instance.
			const authStorage = AuthStorage.create();
			const isInitialRuntime = sessionStartEvent === undefined;
			const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
			const cachedProjectTrust = projectTrustByCwd.get(cwd);
			const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
			const shouldResolveProjectTrust =
				parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
			const projectTrusted = shouldResolveProjectTrust
				? false
				: (cachedProjectTrust ??
					parsed.projectTrustOverride ??
					(!hasTrustRequiringResources || trustStore.get(cwd) === true));
			const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				isolatedChild: childConfig?.writePolicy === "deny",
				authStorage,
				settingsManager: runtimeSettingsManager,
				mcpConfigurationCoordinator,
				extensionFlagValues: parsed.unknownFlags,
				resourceLoaderReloadOptions: shouldResolveProjectTrust
					? {
							resolveProjectTrust: async ({ extensionsResult }) => {
								const trusted = await resolveProjectTrusted({
									cwd,
									trustStore,
									trustOverride: parsed.projectTrustOverride,
									defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
									extensionsResult,
									projectTrustContext:
										projectTrustContext ??
										createProjectTrustContext({
											cwd,
											mode: isInitialRuntime ? trustPromptMode : appMode,
											settingsManager: startupSettingsManager,
											hasUI: isInitialRuntime && trustPromptMode === "interactive",
										}),
									onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
								});
								projectTrustByCwd.set(cwd, trusted);
								return trusted;
							},
						}
					: undefined,
				resourceLoaderOptions: {
					additionalExtensionPaths: resolvedExtensionPaths,
					additionalSkillPaths: childConfig ? [] : resolvedSkillPaths,
					additionalPromptTemplatePaths: childConfig ? [] : resolvedPromptTemplatePaths,
					additionalThemePaths: childConfig ? [] : resolvedThemePaths,
					noExtensions: childConfig?.writePolicy === "deny" ? true : parsed.noExtensions,
					noSkills: childConfig ? true : parsed.noSkills,
					noPromptTemplates: childConfig ? true : parsed.noPromptTemplates,
					noThemes: childConfig ? true : parsed.noThemes,
					noContextFiles: parsed.noContextFiles,
					systemPrompt: childConfig ? undefined : parsed.systemPrompt,
					appendSystemPrompt: childConfig ? undefined : parsed.appendSystemPrompt,
					extensionFactories: childConfig?.writePolicy === "deny" ? [] : options?.extensionFactories,
					...(childConfig
						? {
								systemPromptOverride: () => undefined,
								appendSystemPromptOverride: () => [],
							}
						: {}),
				},
			});
			let servicesTransferred = false;
			try {
				const { settingsManager, modelRegistry, resourceLoader } = services;
				const diagnostics: AgentSessionRuntimeDiagnostic[] = [
					...projectTrustDiagnostics,
					...services.diagnostics,
					...collectSettingsDiagnostics(settingsManager, "runtime creation"),
					...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
						type: "error" as const,
						message: `Failed to load extension "${path}": ${error}`,
					})),
				];

				const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
				const scopedModels =
					modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
				const {
					options: sessionOptions,
					cliThinkingFromModel,
					diagnostics: sessionOptionDiagnostics,
				} = buildSessionOptions(
					parsed,
					scopedModels,
					sessionManager.buildSessionContext().messages.length > 0,
					modelRegistry,
					settingsManager,
				);
				diagnostics.push(...sessionOptionDiagnostics);

				if (parsed.apiKey) {
					if (!sessionOptions.model) {
						diagnostics.push({
							type: "error",
							message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
						});
					} else {
						authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
					}
				}

				const childModel = childConfig
					? modelRegistry.find(childConfig.model.provider, childConfig.model.modelId)
					: undefined;
				if (childConfig && (!childModel || !modelRegistry.hasConfiguredAuth(childModel))) {
					throw new Error(
						`Child model is unavailable: ${childConfig.model.provider}/${childConfig.model.modelId}`,
					);
				}
				const scheduleEligible =
					!childConfig && scheduleManager !== undefined && isScheduleSessionEligible(sessionManager);
				const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: childModel ?? sessionOptions.model,
					thinkingLevel: childConfig?.thinkingLevel ?? sessionOptions.thinkingLevel,
					thinkingSelection: childConfig ? undefined : sessionOptions.thinkingSelection,
					scopedModels: childConfig ? [] : sessionOptions.scopedModels,
					tools: childConfig ? [...childConfig.tools] : sessionOptions.tools,
					excludeTools: childConfig
						? [...new Set([...(childConfig.writePolicy === "deny" ? (["edit", "write"] as const) : [])])]
						: sessionOptions.excludeTools,
					noTools: childConfig ? undefined : sessionOptions.noTools,
					customTools: childConfig ? [] : sessionOptions.customTools,
					...(childConfig
						? {
								additionalSystemPrompt: buildChildSystemPrompt(childConfig),
								workspaceWritePolicy: childConfig.writePolicy,
							}
						: scheduleEligible
							? { additionalSystemPrompt: SCHEDULE_MAIN_PROMPT }
							: {}),
					includeAutoMemory: childConfig ? false : undefined,
					permissionSettingsCeiling,
				});
				servicesTransferred = true;
				try {
					if (scheduleEligible) {
						installScheduleHost({
							session: created.session,
							manager: scheduleManager!,
							timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
						});
					}
					const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
					if (created.session.model && cliThinkingOverride) {
						created.session.setThinkingLevel(created.session.thinkingLevel);
					}

					return {
						...created,
						services,
						diagnostics,
					};
				} catch (error) {
					created.session.dispose();
					throw error;
				}
			} finally {
				if (!servicesTransferred) services.resourceLoader.dispose?.();
			}
		};
		time("createRuntime");
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
		});
		runtimeOwnsSessionManager = true;
		try {
			time("createAgentSessionRuntime");
			const { services, session, modelFallbackMessage } = runtime;
			const { settingsManager, modelRegistry, resourceLoader } = services;
			applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
			configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

			if (parsed.help) {
				const extensionFlags = resourceLoader
					.getExtensions()
					.extensions.flatMap((extension) => Array.from(extension.flags.values()));
				printHelp(extensionFlags);
				await disposeRuntimeQuietly(runtime);
				process.exit(0);
			}

			if (parsed.listModels !== undefined) {
				const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
				await listModels(modelRegistry, searchPattern);
				await disposeRuntimeQuietly(runtime);
				process.exit(0);
			}

			if (appMode !== "rpc" && !readStdinBeforeSession) {
				stdinContent = await readPipedStdin();
				if (stdinContent !== undefined && appMode === "interactive") {
					appMode = "print";
				}
				time("readPipedStdin");
			}

			const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);
			time("prepareInitialMessage");
			initTheme(settingsManager.getTheme(), appMode === "interactive");
			time("initTheme");

			// Show deprecation warnings in interactive mode
			if (appMode === "interactive" && deprecationWarnings.length > 0) {
				await showDeprecationWarnings(deprecationWarnings);
			}

			time("resolveModelScope");
			reportDiagnostics(runtime.diagnostics);
			if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
				if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
					console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
				}
				await disposeRuntimeQuietly(runtime);
				process.exit(1);
			}
			time("createAgentSession");

			if (appMode !== "interactive" && !session.model) {
				console.error(chalk.red(formatNoModelsAvailableMessage()));
				await disposeRuntimeQuietly(runtime);
				process.exit(1);
			}

			const startupBenchmark = isTruthyEnvFlag(getMetisEnv("STARTUP_BENCHMARK"));
			if (startupBenchmark && appMode !== "interactive") {
				console.error(chalk.red("Error: METIS_STARTUP_BENCHMARK only supports interactive mode"));
				await disposeRuntimeQuietly(runtime);
				process.exit(1);
			}

			if (appMode === "rpc") {
				printTimings();
				await runRpcMode(runtime);
			} else if (appMode === "interactive") {
				const interactiveMode = new InteractiveMode(runtime, {
					scheduleManager,
					migratedProviders,
					modelFallbackMessage,
					autoTrustOnReloadCwd,
					initialMessage,
					initialImages,
					initialMessages: parsed.messages,
					verbose: parsed.verbose,
				});
				if (startupBenchmark) {
					await interactiveMode.init();
					time("interactiveMode.init");
					// Give the TUI's stdin handler a brief chance to consume terminal query replies
					// (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
					await new Promise((resolve) => setTimeout(resolve, 150));
					interactiveMode.stop();
					stopThemeWatcher();
					printTimings();
					if (process.stdout.writableLength > 0) {
						await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
					}
					if (process.stderr.writableLength > 0) {
						await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
					}
					await runtime.dispose();
					return;
				}

				printTimings();
				await interactiveMode.run();
			} else {
				printTimings();
				const exitCode = await runPrintMode(runtime, {
					mode: toPrintOutputMode(appMode),
					messages: parsed.messages,
					initialMessage,
					initialImages,
				});
				stopThemeWatcher();
				restoreStdout();
				if (exitCode !== 0) {
					process.exitCode = exitCode;
				}
				return;
			}
		} finally {
			await scheduleManager?.stop();
			scheduleManager = undefined;
			await runtime.dispose();
		}
	} finally {
		await scheduleManager?.stop();
		if (!runtimeOwnsSessionManager) closeSessionManagerQuietly(sessionManager);
	}
}
