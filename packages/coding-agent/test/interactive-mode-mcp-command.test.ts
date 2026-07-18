import type { Component } from "@arcmind/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const { openBrowser } = vi.hoisted(() => ({ openBrowser: vi.fn() }));
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser }));

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
};

function createContext(
	options: {
		globalServers?: Record<string, object>;
		projectServers?: Record<string, object>;
		statuses?: () => Array<typeof connectedStatus>;
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
		reload: vi.fn().mockResolvedValue(undefined),
		restartMcpServers: vi.fn().mockResolvedValue(undefined),
		logoutMcpServer: vi.fn().mockResolvedValue(undefined),
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
		showMcpLogin: vi.fn().mockResolvedValue(undefined),
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

	it("hands explicit OAuth authorization to the login dialog and restores the editor", async () => {
		const editor = {};
		const loginMcpServer = vi.fn(
			async (_server: string, callbacks: { onAuthorize(url: URL): void; onProgress?(message: string): void }) => {
				callbacks.onAuthorize(new URL("https://auth.example.test/authorize"));
				callbacks.onProgress?.("Loading MCP tools…");
			},
		);
		const target = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: { loginMcpServer } },
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor,
			showStatus: vi.fn(),
			showError: vi.fn(),
		});
		const showLogin = Reflect.get(InteractiveMode.prototype, "showMcpLogin") as (
			this: typeof target,
			server: string,
		) => Promise<void>;

		await showLogin.call(target, "docs");

		expect(loginMcpServer).toHaveBeenCalledWith(
			"docs",
			expect.objectContaining({ signal: expect.any(AbortSignal), onAuthorize: expect.any(Function) }),
		);
		expect(openBrowser).toHaveBeenCalledWith("https://auth.example.test/authorize");
		const dialog = target.editorContainer.addChild.mock.calls[0]?.[0] as Component;
		expect(dialog.render(200).join("\n")).toContain("Loading MCP tools…");
		expect(target.editorContainer.addChild).toHaveBeenLastCalledWith(editor);
		expect(target.showStatus).toHaveBeenCalledWith('Authenticated MCP server "docs"');
		expect(target.showError).not.toHaveBeenCalled();
	});
});
