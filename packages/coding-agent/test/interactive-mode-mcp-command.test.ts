import type { Component } from "@arcmind/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const { openBrowser } = vi.hoisted(() => ({ openBrowser: vi.fn() }));
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser }));

function context() {
	return {
		session: {
			getMcpStatus: () => [
				{
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
				},
			],
			restartMcpServers: vi.fn().mockResolvedValue(undefined),
			logoutMcpServer: vi.fn().mockResolvedValue(undefined),
		},
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		guardSessionMutation: vi.fn(() => false),
		showMcpLogin: vi.fn().mockResolvedValue(undefined),
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
	};
}

const handler = Reflect.get(InteractiveMode.prototype, "handleMcpCommand") as (
	this: ReturnType<typeof context>,
	text: string,
) => Promise<void>;

describe("InteractiveMode /mcp", () => {
	beforeAll(() => initTheme("dark"));

	it("renders connection state and catalog counts", async () => {
		const target = context();
		await handler.call(target, "/mcp");
		const rendered = target.chatContainer.addChild.mock.calls
			.map(([component]) => component as Component)
			.flatMap((component) => component.render(200))
			.join("\n");

		expect(rendered).toContain("MCP servers");
		expect(rendered).toContain("docs");
		expect(rendered).toContain("connected");
		expect(rendered).toContain("3 tools");
		expect(rendered).not.toContain("docs-server/1.0.0");
	});

	it("adds server details and capabilities in verbose mode", async () => {
		const target = context();
		await handler.call(target, "/mcp verbose");
		const rendered = target.chatContainer.addChild.mock.calls
			.map(([component]) => component as Component)
			.flatMap((component) => component.render(200))
			.join("\n");

		expect(rendered).toContain("docs-server/1.0.0");
		expect(rendered).toContain("tools,resources,prompts");
	});

	it("routes restart, logout, and login to one server", async () => {
		const target = context();

		await handler.call(target, "/mcp restart docs");
		await handler.call(target, "/mcp logout docs");
		await handler.call(target, "/mcp login docs");

		expect(target.session.restartMcpServers).toHaveBeenCalledWith("docs");
		expect(target.session.logoutMcpServer).toHaveBeenCalledWith("docs");
		expect(target.showMcpLogin).toHaveBeenCalledWith("docs");
		expect(target.showStatus).toHaveBeenCalledWith('Restarted MCP server "docs"');
		expect(target.showStatus).toHaveBeenCalledWith('Logged out MCP server "docs"');
	});

	it("restarts every server without a name and validates incomplete commands", async () => {
		const target = context();

		await handler.call(target, "/mcp restart");
		await handler.call(target, "/mcp login");

		expect(target.session.restartMcpServers).toHaveBeenCalledWith(undefined);
		expect(target.showStatus).toHaveBeenCalledWith("Restarted MCP servers");
		expect(target.showWarning).toHaveBeenCalledWith(
			"Usage: /mcp [verbose|login <server>|logout <server>|restart [server]]",
		);
	});

	it("hands explicit OAuth authorization to the login dialog and restores the editor", async () => {
		const editor = {};
		const loginMcpServer = vi.fn(async (_server: string, callbacks: { onAuthorize(url: URL): void }) => {
			callbacks.onAuthorize(new URL("https://auth.example.test/authorize"));
		});
		const target = {
			session: { loginMcpServer },
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor,
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
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
		expect(target.editorContainer.addChild).toHaveBeenLastCalledWith(editor);
		expect(target.showStatus).toHaveBeenCalledWith('Authenticated MCP server "docs"');
		expect(target.showError).not.toHaveBeenCalled();
	});
});
