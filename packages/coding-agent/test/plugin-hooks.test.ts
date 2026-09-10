import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { runHookProcess } from "../src/core/hooks/hook-bridge.ts";
import {
	type DeclarativeHook,
	loadEffectiveHooks,
	saveDeclarativeHooks,
	validateDeclarativeHook,
} from "../src/core/index.ts";
import {
	getPluginPackageDir,
	getPluginsDir,
	type NormalizedComponent,
	type NormalizedPluginPackage,
	readPluginRegistry,
} from "../src/core/plugins/registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("Plugin Hooks Runtime Integration", () => {
	let agentDir: string;
	let workspaceDir: string;
	let cleanups: Array<() => Promise<void> | void> = [];

	beforeEach(() => {
		agentDir = join(tmpdir(), `metis-plugin-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspaceDir = join(tmpdir(), `metis-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
	});

	afterEach(async () => {
		for (const cleanup of cleanups.reverse()) {
			await cleanup();
		}
		cleanups = [];
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		if (existsSync(workspaceDir)) rmSync(workspaceDir, { recursive: true, force: true });
	});

	function installPluginFixture(
		agentDir: string,
		options: {
			pluginId: string;
			name: string;
			displayName: string;
			commit: string;
			enabled?: boolean;
			hooks: Array<{
				componentId: string;
				definition: DeclarativeHook;
			}>;
			files?: Record<string, string>;
		},
	): string {
		const pkgDir = getPluginPackageDir(agentDir, options.pluginId, options.commit);
		mkdirSync(pkgDir, { recursive: true });

		if (options.files) {
			for (const [relPath, content] of Object.entries(options.files)) {
				const filePath = join(pkgDir, relPath);
				mkdirSync(join(filePath, ".."), { recursive: true });
				writeFileSync(filePath, content, "utf8");
			}
		}

		const components: NormalizedComponent[] = options.hooks.map((h) => ({
			kind: "hook",
			componentId: h.componentId,
			name: h.definition.name,
			definition: h.definition,
		}));

		const normalized: NormalizedPluginPackage = {
			pluginId: options.pluginId,
			commit: options.commit,
			format: "claude",
			name: options.name,
			displayName: options.displayName,
			description: "Test plugin for hooks",
			components,
			issues: [],
		};

		writeFileSync(join(pkgDir, "normalized.json"), JSON.stringify(normalized, null, 2), "utf8");

		const registry = readPluginRegistry(agentDir);
		const nextInstalled = [
			...registry.installed.filter((p) => p.id !== options.pluginId),
			{
				id: options.pluginId,
				name: options.name,
				displayName: options.displayName,
				format: "claude" as const,
				repository: `anthropics/${options.name}`,
				commit: options.commit,
				installedAt: new Date().toISOString(),
				enabled: options.enabled ?? true,
			},
		];

		writeFileSync(
			join(getPluginsDir(agentDir), "registry.json"),
			JSON.stringify(
				{
					schemaVersion: 1,
					revision: registry.revision + 1,
					markets: registry.markets,
					installed: nextInstalled,
				},
				null,
				2,
			),
			"utf8",
		);

		return pkgDir;
	}

	async function setupSession(agentDir: string, cwd: string) {
		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(metis: any) => {
						metis.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
							models: faux.models.map((m: any) => ({
								id: m.id,
								name: m.name,
								api: m.api,
								reasoning: m.reasoning,
								input: m.input,
								cost: m.cost,
								contextWindow: m.contextWindow,
								maxTokens: m.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};

		const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"), { mode: "code" });
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			sessionManager,
		});

		const notified: Array<{ message: string; type?: string }> = [];
		await runtimeHost.session.bindExtensions({
			uiContext: {
				notify: (message: string, type?: any) => notified.push({ message, type }),
				select: async () => undefined,
				confirm: async () => true,
				input: async () => undefined,
				onTerminalInput: () => () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWorkingVisible: () => {},
				setWorkingIndicator: () => {},
			} as any,
		});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
		});

		return {
			session: runtimeHost.session,
			faux,
			notified,
		};
	}

	it("loads user hooks followed by active plugin hooks with template variable expansion", () => {
		const userHook: DeclarativeHook = {
			id: "user-hook-1",
			name: "User hook",
			enabled: true,
			event: "SessionStart",
			runMode: "shell",
			command: "echo user",
		};
		saveDeclarativeHooks(agentDir, [userHook]);

		const pluginHook: DeclarativeHook = {
			id: "plugin-hook-1",
			name: "Plugin lint hook",
			enabled: true,
			event: "PreToolUse",
			matcher: "bash",
			runMode: "process",
			protocol: "command-v1",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: template placeholder
			command: "${CLAUDE_PLUGIN_ROOT}/bin/lint",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: template placeholder
			args: ["--root", "${CLAUDE_PLUGIN_ROOT}"],
		};

		const pkgDir = installPluginFixture(agentDir, {
			pluginId: "plugin-audit",
			name: "audit",
			displayName: "Audit Plugin",
			commit: "c1",
			hooks: [
				{
					componentId: "lint-hook",
					definition: pluginHook,
				},
			],
		});

		const { hooks, errors } = loadEffectiveHooks(agentDir);
		expect(errors).toHaveLength(0);
		expect(hooks).toHaveLength(2);

		expect(hooks[0]).toEqual(userHook);

		expect(hooks[1].id).toBe("plugin-hook-1");
		expect(hooks[1].name).toBe("Plugin lint hook");
		expect(hooks[1].command).toBe(`${pkgDir}/bin/lint`);
		expect(hooks[1].args).toEqual(["--root", pkgDir]);
		expect(hooks[1].pluginOwner).toEqual({
			pluginId: "plugin-audit",
			displayName: "Audit Plugin",
			componentId: "lint-hook",
		});
		expect(hooks[1].env).toEqual({
			CLAUDE_PLUGIN_ROOT: pkgDir,
			CLAUDE_PLUGIN_DATA: `${agentDir}/plugins/data/plugin-audit`,
			CLAUDE_PROJECT_DIR: "",
		});
	});

	it("disabling a plugin removes its hooks from loadEffectiveHooks", () => {
		const pluginHook: DeclarativeHook = {
			id: "plugin-hook-2",
			name: "Disabled hook",
			enabled: true,
			event: "PreToolUse",
			runMode: "shell",
			command: "echo disabled",
		};

		installPluginFixture(agentDir, {
			pluginId: "plugin-disabled",
			name: "disabled-plug",
			displayName: "Disabled Plugin",
			commit: "c1",
			enabled: false,
			hooks: [{ componentId: "disabled-hook", definition: pluginHook }],
		});

		const { hooks } = loadEffectiveHooks(agentDir);
		expect(hooks.find((h) => h.id === "plugin-hook-2")).toBeUndefined();
	});

	it("runHookProcess injects CLAUDE_PLUGIN_ROOT into environment and passes plugin metadata", async () => {
		const markerFile = join(agentDir, "hook-env-output.json");
		const scriptPath = join(agentDir, "report-env.js");

		writeFileSync(
			scriptPath,
			`
const fs = require('fs');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({
    claudePluginRootEnv: process.env.CLAUDE_PLUGIN_ROOT,
    hookPluginOwner: payload.hook.pluginOwner,
    hookPackageDir: payload.hook.packageDir,
    cwd: payload.cwd,
  }));
  process.exit(0);
});
`,
			"utf8",
		);

		const hook: DeclarativeHook = {
			id: "test-env-hook",
			name: "Env reporter hook",
			enabled: true,
			event: "PreToolUse",
			runMode: "process",
			protocol: "command-v1",
			command: process.execPath,
			args: [scriptPath],
			pluginOwner: {
				pluginId: "test-plug",
				displayName: "Test Plugin",
				componentId: "test-comp",
			},
			env: {
				CLAUDE_PLUGIN_ROOT: "/custom/plugin/package/dir",
			},
		};

		const payload = {
			event: "PreToolUse" as const,
			hook: {
				id: hook.id,
				name: hook.name,
				pluginOwner: hook.pluginOwner,
				packageDir: hook.env?.CLAUDE_PLUGIN_ROOT,
			},
			sessionId: "test-session-123",
			cwd: workspaceDir,
			timestamp: new Date().toISOString(),
		};

		const result = await runHookProcess(hook, payload, { cwd: workspaceDir });
		expect(result.code).toBe(0);

		expect(existsSync(markerFile)).toBe(true);
		const recorded = JSON.parse(readFileSync(markerFile, "utf8"));
		expect(recorded.claudePluginRootEnv).toBe("/custom/plugin/package/dir");
		expect(recorded.hookPluginOwner).toEqual({
			pluginId: "test-plug",
			displayName: "Test Plugin",
			componentId: "test-comp",
		});
		expect(recorded.hookPackageDir).toBe("/custom/plugin/package/dir");
		expect(recorded.cwd).toBe(workspaceDir);
	});

	it("integrates plugin PreToolUse hook to inject context into tool result", async () => {
		const hookScript = `
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const root = process.env.CLAUDE_PLUGIN_ROOT || 'no-root';
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "INJECTED_FROM_PLUGIN_ROOT:" + root
    }
  }));
});
`;

		const pkgDir = installPluginFixture(agentDir, {
			pluginId: "plugin-context",
			name: "ctx-plugin",
			displayName: "Context Plugin",
			commit: "c1",
			files: {
				"hook.js": hookScript,
			},
			hooks: [
				{
					componentId: "ctx-hook",
					definition: {
						id: "hook-ctx-1",
						name: "Plugin Context Hook",
						enabled: true,
						event: "PreToolUse",
						matcher: "bash",
						runMode: "process",
						protocol: "command-v1",
						command: process.execPath,
						// biome-ignore lint/suspicious/noTemplateCurlyInString: template placeholder
						args: ["${CLAUDE_PLUGIN_ROOT}/hook.js"],
					},
				},
			],
		});

		const { session, faux } = await setupSession(agentDir, workspaceDir);

		let secondTurnContext: any;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello" }, { id: "tc-bash-1" })]),
			(turnContext: any) => {
				secondTurnContext = turnContext;
				return fauxAssistantMessage("Tool finished.");
			},
		]);

		await session.prompt("Run bash command");

		expect(secondTurnContext).toBeDefined();
		const toolMessage = secondTurnContext.messages.find((m: any) => m.role === "toolResult");
		expect(toolMessage).toBeDefined();
		const toolResultText = toolMessage.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");

		expect(toolResultText).toContain(`[Hook: Plugin Context Hook]`);
		expect(toolResultText).toContain(`INJECTED_FROM_PLUGIN_ROOT:${pkgDir}`);
	});

	it("integrates plugin PreToolUse hook to block tool execution", async () => {
		const hookScript = `
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny"
  }
}));
`;

		installPluginFixture(agentDir, {
			pluginId: "plugin-guard",
			name: "guard-plugin",
			displayName: "Guard Plugin",
			commit: "c1",
			files: {
				"block.js": hookScript,
			},
			hooks: [
				{
					componentId: "guard-hook",
					definition: {
						id: "hook-guard-1",
						name: "Plugin Guard Hook",
						enabled: true,
						event: "PreToolUse",
						matcher: "bash",
						runMode: "process",
						protocol: "command-v1",
						command: process.execPath,
						// biome-ignore lint/suspicious/noTemplateCurlyInString: template placeholder
						args: ["${CLAUDE_PLUGIN_ROOT}/block.js"],
					},
				},
			],
		});

		const { session, faux } = await setupSession(agentDir, workspaceDir);

		let secondTurnContext: any;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo blocked" }, { id: "tc-bash-block" })]),
			(turnContext: any) => {
				secondTurnContext = turnContext;
				return fauxAssistantMessage("Turn after block.");
			},
		]);

		await session.prompt("Run bash command to block");

		expect(secondTurnContext).toBeDefined();
		const toolMessage = secondTurnContext.messages.find((m: any) => m.role === "toolResult");
		expect(toolMessage).toBeDefined();
		const blockedResultText = toolMessage.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");

		expect(blockedResultText).toContain("blocked by hook");
	});

	it("saveDeclarativeHooks rejects hooks containing pluginOwner", () => {
		const invalidHook: DeclarativeHook = {
			id: "hook-invalid",
			name: "Invalid hook",
			enabled: true,
			event: "SessionStart",
			runMode: "shell",
			command: "echo test",
			pluginOwner: {
				pluginId: "plug-x",
				displayName: "Plugin X",
				componentId: "comp-x",
			},
		};

		expect(() => saveDeclarativeHooks(agentDir, [invalidHook])).toThrow(
			/Plugin hooks cannot be persisted into user hooks\.json/,
		);
	});

	it("validateDeclarativeHook validates pluginOwner and env structures", () => {
		const base: DeclarativeHook = {
			id: "hook-v",
			name: "Hook V",
			enabled: true,
			event: "SessionStart",
			runMode: "shell",
			command: "echo test",
		};

		expect(validateDeclarativeHook(base)).toBeNull();

		expect(
			validateDeclarativeHook({
				...base,
				pluginOwner: "invalid" as any,
			}),
		).toContain("pluginOwner must be an object");

		expect(
			validateDeclarativeHook({
				...base,
				env: "invalid" as any,
			}),
		).toContain("env must be an object");

		expect(
			validateDeclarativeHook({
				...base,
				pluginOwner: { pluginId: "p", displayName: "P", componentId: "c" },
				env: { MY_VAR: "value" },
			}),
		).toBeNull();
	});

	it("loadEffectiveHooks preserves shell hook raw command and injects env with special paths", () => {
		const pluginHook: DeclarativeHook = {
			id: "plugin-shell-hook",
			name: "Shell hook with vars",
			enabled: true,
			event: "SessionStart",
			runMode: "shell",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: template placeholder
			command: 'echo "${CLAUDE_PLUGIN_ROOT}/test $(whoami) 中文"',
		};

		const specialPkgDir = installPluginFixture(agentDir, {
			pluginId: "plugin-special",
			name: "special",
			displayName: "Special Plugin",
			commit: "c-spec",
			hooks: [
				{
					componentId: "shell-comp",
					definition: pluginHook,
				},
			],
		});

		const { hooks, errors } = loadEffectiveHooks(agentDir, { cwd: "/workspace/path with space/中文" });
		expect(errors).toHaveLength(0);
		const target = hooks.find((h) => h.id === "plugin-shell-hook");
		expect(target).toBeDefined();
		// Command must be unmodified string, not text-replaced!
		// biome-ignore lint/suspicious/noTemplateCurlyInString: template placeholder
		expect(target!.command).toBe('echo "${CLAUDE_PLUGIN_ROOT}/test $(whoami) 中文"');
		expect(target!.env).toEqual({
			CLAUDE_PLUGIN_ROOT: specialPkgDir,
			CLAUDE_PLUGIN_DATA: `${agentDir}/plugins/data/plugin-special`,
			CLAUDE_PROJECT_DIR: "/workspace/path with space/中文",
		});
	});
});
