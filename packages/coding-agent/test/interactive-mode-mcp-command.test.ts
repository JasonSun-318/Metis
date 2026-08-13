import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "@metis/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage, type McpSecretCredential } from "../src/core/auth-storage.ts";
import { McpManager, type McpServerStatus } from "../src/core/mcp/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createMcpTestServer } from "./helpers/mcp-test-server.ts";

const connectedStatus = {
	name: "docs",
	transport: "http" as const,
	state: "connected" as const,
	required: false,
	serverInfo: { name: "docs-server", version: "1.0.0" },
	toolCount: 3,
	resourceCount: 1,
	resourceTemplateCount: 0,
	promptCount: 1,
	capabilities: ["tools", "resources", "prompts"],
} satisfies McpServerStatus;

function createContext(
	options: {
		globalServers?: Record<string, object>;
		projectServers?: Record<string, object>;
		statuses?: () => McpServerStatus[];
	} = {},
) {
	const globalSettings = { mcpServers: { ...(options.globalServers ?? {}) } };
	const projectSettings = { mcpServers: { ...(options.projectServers ?? {}) } };
	const credentials = new Map<string, unknown>();
	const settingsManager = {
		isProjectTrusted: vi.fn(() => true),
		getGlobalSettings: vi.fn(() => globalSettings),
		getProjectSettings: vi.fn(() => projectSettings),
		setMcpServer: vi.fn((scope: "global" | "project", name: string, server: object) => {
			const settings = scope === "global" ? globalSettings : projectSettings;
			settings.mcpServers[name] = server;
		}),
		removeMcpServer: vi.fn((scope: "global" | "project", name: string) => {
			const settings = scope === "global" ? globalSettings : projectSettings;
			return delete settings.mcpServers[name];
		}),
		flush: vi.fn().mockResolvedValue(undefined),
		drainErrors: vi.fn(() => []),
	};
	const session = {
		settingsManager,
		getMcpStatus: vi.fn(options.statuses ?? (() => (globalSettings.mcpServers.docs ? [connectedStatus] : []))),
		hasMcpCredential: vi.fn((name: string) => credentials.has(`mcp:${name}`)),
		reload: vi.fn().mockResolvedValue(undefined),
		restartMcpServers: vi.fn().mockResolvedValue(undefined),
		logoutMcpServer: vi.fn(async (name: string) => {
			credentials.delete(`mcp:${name}`);
		}),
		getMcpSecretEnvironment: vi.fn((name: string) => {
			const credential = credentials.get(`mcp:${name}`);
			return credential !== null && typeof credential === "object" && "env" in credential
				? { ...((credential as { env?: Record<string, string> }).env ?? {}) }
				: {};
		}),
		setMcpSecret: vi.fn(async (name: string, credential: object) => {
			credentials.set(`mcp:${name}`, { type: "mcp_secret", ...credential });
		}),
		deleteMcpCredential: vi.fn((name: string) => credentials.delete(`mcp:${name}`)),
		modelRegistry: {
			authStorage: {
				has: vi.fn((key: string) => credentials.has(key)),
				get: vi.fn((key: string) => credentials.get(key)),
			},
		},
	};
	const target = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session },
		chatContainer: { addChild: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		guardSessionMutation: vi.fn(() => false),
		showExtensionSelector: vi.fn(),
		showExtensionInput: vi.fn(),
		showExtensionConfirm: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
	});
	return { target, session, settingsManager, globalSettings, projectSettings, credentials };
}

const handler = Reflect.get(InteractiveMode.prototype, "handleMcpCommand") as (this: object) => Promise<void>;

describe("InteractiveMode /mcp", () => {
	beforeAll(() => initTheme("dark"));

	it("adds and connects an HTTP server from the unified manager", async () => {
		const context = createContext();
		context.target.showExtensionSelector
			.mockResolvedValueOnce("Add server")
			.mockResolvedValueOnce("Personal")
			.mockResolvedValueOnce("Remote URL (HTTP)")
			.mockResolvedValueOnce("Close");
		context.target.showExtensionInput.mockResolvedValueOnce("docs").mockResolvedValueOnce("https://docs.example/mcp");

		await handler.call(context.target);

		expect(context.settingsManager.setMcpServer).toHaveBeenCalledWith("global", "docs", {
			url: "https://docs.example/mcp",
		});
		expect(context.settingsManager.flush).toHaveBeenCalledOnce();
		expect(context.session.reload).toHaveBeenCalledOnce();
		expect(context.target.showStatus).toHaveBeenCalledWith('Connected MCP server "docs"');
	});

	it("returns from a server submenu to the manager when Escape is pressed", async () => {
		const context = createContext({ globalServers: { docs: { url: "https://docs.example/mcp" } } });
		context.target.showExtensionSelector
			.mockResolvedValueOnce("docs · connected · http · 3 tools")
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce("Close");

		await handler.call(context.target);

		expect(context.target.showExtensionSelector.mock.calls.map(([title]: [string]) => title)).toEqual([
			"MCP servers",
			"MCP server · docs",
			"MCP servers",
		]);
		expect(context.settingsManager.setMcpServer).not.toHaveBeenCalled();
		expect(context.session.setMcpSecret).not.toHaveBeenCalled();
	});

	it("returns one level at a time when secret entry is cancelled", async () => {
		const context = createContext({ globalServers: { docs: { url: "https://docs.example/mcp" } } });
		context.target.showExtensionSelector
			.mockResolvedValueOnce("docs · connected · http · 3 tools")
			.mockResolvedValueOnce("Authentication")
			.mockResolvedValueOnce("Enter token")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Close");
		context.target.showExtensionInput.mockResolvedValueOnce(undefined);

		await handler.call(context.target);

		expect(context.target.showExtensionSelector.mock.calls.map(([title]: [string]) => title)).toEqual([
			"MCP servers",
			"MCP server · docs",
			"MCP authentication · docs",
			"MCP authentication · docs",
			"MCP server · docs",
			"MCP servers",
		]);
		expect(context.target.showExtensionInput).toHaveBeenCalledWith("Access token", undefined, { secret: true });
		expect(context.target.showExtensionSelector.mock.calls[2]?.[1]).toEqual([
			"Enter token",
			"Use environment variable",
			"No authentication",
			"Back",
		]);
		expect(context.settingsManager.setMcpServer).not.toHaveBeenCalled();
		expect(context.session.setMcpSecret).not.toHaveBeenCalled();
	});

	it("walks back through each stdio credential form level on Escape", async () => {
		const context = createContext({ globalServers: { docs: { command: "npx", args: ["docs-server"] } } });
		context.target.showExtensionSelector
			.mockResolvedValueOnce("docs · connected · http · 3 tools")
			.mockResolvedValueOnce("Authentication")
			.mockResolvedValueOnce("Set environment variable")
			.mockResolvedValueOnce("Enter value")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Close");
		context.target.showExtensionInput
			.mockResolvedValueOnce("MCP_TOKEN")
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined);

		await handler.call(context.target);

		expect(context.target.showExtensionSelector.mock.calls.map(([title]: [string]) => title)).toEqual([
			"MCP servers",
			"MCP server · docs",
			"MCP authentication · docs",
			"Environment value · MCP_TOKEN",
			"Environment value · MCP_TOKEN",
			"MCP authentication · docs",
			"MCP server · docs",
			"MCP servers",
		]);
		expect(context.settingsManager.setMcpServer).not.toHaveBeenCalled();
		expect(context.session.setMcpSecret).not.toHaveBeenCalled();
	});

	it("stores an entered token only in credential storage", async () => {
		const context = createContext({
			globalServers: { docs: { url: "https://docs.example/mcp", bearerTokenEnvVar: "OLD_TOKEN" } },
		});
		context.target.showExtensionSelector
			.mockResolvedValueOnce("docs · connected · http · 3 tools")
			.mockResolvedValueOnce("Authentication")
			.mockResolvedValueOnce("Enter token")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Close");
		context.target.showExtensionInput.mockResolvedValueOnce("super-secret-value");

		await handler.call(context.target);

		expect(context.settingsManager.setMcpServer).toHaveBeenCalledWith("global", "docs", {
			url: "https://docs.example/mcp",
		});
		expect(context.session.setMcpSecret).toHaveBeenCalledWith("docs", { bearerToken: "super-secret-value" });
		expect(JSON.stringify(context.globalSettings)).not.toContain("super-secret-value");
		expect(JSON.stringify(context.target.showStatus.mock.calls)).not.toContain("super-secret-value");
		expect(JSON.stringify(context.target.showError.mock.calls)).not.toContain("super-secret-value");
	});

	it("keeps the old credential when environment settings fail to persist", async () => {
		const context = createContext({ globalServers: { docs: { url: "https://docs.example/mcp" } } });
		context.credentials.set("mcp:docs", { type: "mcp_secret", bearerToken: "old-secret" });
		context.settingsManager.flush.mockRejectedValueOnce(new Error("disk full"));
		context.target.showExtensionSelector
			.mockResolvedValueOnce("docs · connected · http · 3 tools")
			.mockResolvedValueOnce("Authentication")
			.mockResolvedValueOnce("Use environment variable")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Close");
		context.target.showExtensionInput.mockResolvedValueOnce("MCP_TOKEN");

		await handler.call(context.target);

		expect(context.session.deleteMcpCredential).not.toHaveBeenCalled();
		expect(context.session.logoutMcpServer).not.toHaveBeenCalled();
		expect(context.credentials.get("mcp:docs")).toMatchObject({ bearerToken: "old-secret" });
		expect(context.target.showError).toHaveBeenCalledWith("disk full");
	});

	it("does not report success when an entered token is rejected", async () => {
		const authRequiredStatus = {
			...connectedStatus,
			state: "auth_required" as const,
			toolCount: 0,
		};
		const context = createContext({
			globalServers: { docs: { url: "https://docs.example/mcp" } },
			statuses: () => [authRequiredStatus],
		});
		context.target.showExtensionSelector
			.mockResolvedValueOnce("docs · auth_required · http · 0 tools")
			.mockResolvedValueOnce("Authentication")
			.mockResolvedValueOnce("Enter token")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Close");
		context.target.showExtensionInput.mockResolvedValueOnce("wrong-token");

		await handler.call(context.target);

		expect(context.target.showWarning).toHaveBeenCalledWith('Authentication failed for MCP server "docs"');
		expect(context.target.showStatus).not.toHaveBeenCalledWith('Updated authentication for MCP server "docs"');
	});

	it("removes a definition and its credential after confirmation", async () => {
		const context = createContext({ globalServers: { docs: { url: "https://docs.example/mcp" } } });
		context.credentials.set("mcp:docs", { type: "mcp_secret", bearerToken: "hidden" });
		context.target.showExtensionSelector
			.mockResolvedValueOnce("docs · connected · http · 3 tools")
			.mockResolvedValueOnce("Remove")
			.mockResolvedValueOnce("Close");
		context.target.showExtensionConfirm.mockResolvedValueOnce(true);

		await handler.call(context.target);

		expect(context.settingsManager.removeMcpServer).toHaveBeenCalledWith("global", "docs");
		expect(context.session.deleteMcpCredential).toHaveBeenCalledWith("docs");
		expect(context.session.reload).toHaveBeenCalledOnce();
		expect(context.target.showStatus).toHaveBeenCalledWith('Removed MCP server "docs"');
	});

	it("renders server details from the cached catalog metadata", async () => {
		const context = createContext({ globalServers: { docs: { url: "https://docs.example/mcp" } } });
		context.target.showExtensionSelector
			.mockResolvedValueOnce("docs · connected · http · 3 tools")
			.mockResolvedValueOnce("Details")
			.mockResolvedValueOnce("Back")
			.mockResolvedValueOnce("Close");

		await handler.call(context.target);

		const rendered = context.target.chatContainer.addChild.mock.calls
			.map(([component]: [Component]) => component)
			.flatMap((component: Component) => component.render(200))
			.join("\n");
		expect(rendered).toContain("docs-server/1.0.0");
		expect(rendered).toContain("Capabilities: tools, resources, prompts");
	});

	it("persists a TUI-entered token and reconnects after restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-mcp-tui-"));
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });
		const server = await createMcpTestServer({ requiredBearerToken: "persisted-secret" });
		let manager: McpManager | undefined;

		try {
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			manager = await McpManager.create({ settingsManager, authStorage, cwd: projectDir });
			const context = createContext();
			Object.assign(context.target.runtimeHost.session, {
				settingsManager,
				getMcpStatus: () => manager!.getStatus(),
				hasMcpCredential: (name: string) => manager!.hasCredential(name),
				reload: () => manager!.reload(),
				restartMcpServers: (name?: string) => manager!.restart(name),
				logoutMcpServer: (name: string) => manager!.logout(name),
				getMcpSecretEnvironment: (name: string) => manager!.getSecretEnvironment(name),
				setMcpSecret: (name: string, credential: Omit<McpSecretCredential, "type">) =>
					manager!.setSecret(name, credential),
				deleteMcpCredential: (name: string) => manager!.deleteCredential(name),
				modelRegistry: { authStorage },
			});
			context.target.showExtensionSelector
				.mockResolvedValueOnce("Add server")
				.mockResolvedValueOnce("Personal")
				.mockResolvedValueOnce("Remote URL (HTTP)")
				.mockResolvedValueOnce("Enter token")
				.mockResolvedValueOnce("Close");
			context.target.showExtensionInput
				.mockResolvedValueOnce("docs")
				.mockResolvedValueOnce(String(server.url))
				.mockResolvedValueOnce("persisted-secret");

			await handler.call(context.target);

			expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
			expect(await manager.callTool("mcp__docs__search_docs", { query: "before restart" })).toMatchObject({
				content: [{ type: "text", text: "match:before restart" }],
			});
			const settingsText = readFileSync(join(agentDir, "settings.json"), "utf8");
			const authText = readFileSync(join(agentDir, "auth.json"), "utf8");
			expect(settingsText).not.toContain("persisted-secret");
			expect(authText).toContain("persisted-secret");
			expect(authText).toContain("serverFingerprint");
			expect(statSync(join(agentDir, "auth.json")).mode & 0o777).toBe(0o600);

			await manager.close();
			const restartedSettings = SettingsManager.create(projectDir, agentDir);
			const restartedAuth = AuthStorage.create(join(agentDir, "auth.json"));
			manager = await McpManager.create({
				settingsManager: restartedSettings,
				authStorage: restartedAuth,
				cwd: projectDir,
			});
			expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
			expect(await manager.callTool("mcp__docs__search_docs", { query: "after restart" })).toMatchObject({
				content: [{ type: "text", text: "match:after restart" }],
			});
		} finally {
			await manager?.close();
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
