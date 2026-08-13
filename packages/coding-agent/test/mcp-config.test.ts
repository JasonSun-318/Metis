import { describe, expect, it } from "vitest";
import { resolveMcpServerSettings, resolveMcpSettings } from "../src/core/mcp/config.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("MCP settings", () => {
	it("resolves one server with the production validation rules", () => {
		const resolved = resolveMcpServerSettings(
			"docs",
			{ command: "node", args: ["server.mjs"], envVars: ["DOCS_TOKEN"] },
			"/repo",
			{ DOCS_TOKEN: "secret" },
		);

		expect(resolved).toMatchObject({
			name: "docs",
			transport: "stdio",
			command: "node",
			args: ["server.mjs"],
			env: { DOCS_TOKEN: "secret" },
		});
	});

	it("normalizes an optional bounded description", () => {
		expect(
			resolveMcpServerSettings(
				"docs",
				{ url: "https://example.test/mcp", description: "  Use for documentation lookup.  " },
				"/repo",
			),
		).toMatchObject({
			description: "Use for documentation lookup.",
			enabled: true,
			required: false,
			enabledTools: undefined,
			disabledTools: [],
		});
		expect(() =>
			resolveMcpServerSettings("docs", { url: "https://example.test/mcp", description: "界".repeat(1366) }, "/repo"),
		).toThrow("4096 UTF-8 bytes");
	});

	it("rejects one invalid server before persistence", () => {
		expect(() => resolveMcpServerSettings("docs", { url: "file:///tmp/mcp" }, "/repo", {})).toThrow("http or https");
	});

	it("merges trusted server entries and resolves safe defaults", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				mcpServers: {
					docs: {
						command: "npx",
						args: ["-y", "docs-mcp"],
						env: { LITERAL: "value" },
						envVars: ["DOCS_TOKEN", "MISSING"],
					},
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				mcpServers: {
					figma: { url: "https://mcp.figma.example/mcp", required: true },
				},
			}),
		);
		const manager = SettingsManager.fromStorage(storage, { projectTrusted: true });

		expect(resolveMcpSettings(manager, "/repo", { DOCS_TOKEN: "secret" }).servers).toEqual([
			expect.objectContaining({
				name: "docs",
				credentialIdentity: { scope: "user", name: "docs" },
				transport: "stdio",
				startupTimeoutMs: 10_000,
				toolTimeoutMs: 60_000,
				env: { DOCS_TOKEN: "secret", LITERAL: "value" },
				enabledTools: undefined,
				disabledTools: [],
			}),
			expect.objectContaining({
				name: "figma",
				credentialIdentity: { scope: "project", name: "figma", cwd: "/repo" },
				transport: "http",
				required: true,
			}),
		]);
	});

	it("retains project scope when it overrides a same-name user server", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ mcpServers: { github: { url: "https://user.example.test/mcp" } } }),
		);
		storage.withLock("project", () =>
			JSON.stringify({ mcpServers: { github: { url: "https://project.example.test/mcp" } } }),
		);
		const manager = SettingsManager.fromStorage(storage, { projectTrusted: true });

		expect(resolveMcpSettings(manager, "/repo", {}).servers).toEqual([
			expect.objectContaining({
				name: "github",
				credentialIdentity: { scope: "project", name: "github", cwd: "/repo" },
				url: new URL("https://project.example.test/mcp"),
			}),
		]);
	});

	it("ignores project MCP servers before trust", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ mcpServers: { local: { command: "node" } } }));
		const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });

		expect(resolveMcpSettings(manager, "/repo", {}).servers).toEqual([]);
	});

	it("resolves HTTP secrets from environment names without retaining those names", () => {
		const manager = SettingsManager.inMemory({
			mcpServers: {
				docs: {
					url: "https://mcp.example.test/mcp",
					bearerTokenEnvVar: "MCP_TOKEN",
					envHttpHeaders: { "X-Tenant": "MCP_TENANT" },
				},
			},
		});

		expect(
			resolveMcpSettings(manager, "/repo", { MCP_TOKEN: "token", MCP_TENANT: "tenant" }).servers[0],
		).toMatchObject({
			bearerToken: "token",
			httpHeaders: { "X-Tenant": "tenant" },
		});
	});

	it.each([
		[{ command: "node", url: "https://example.test/mcp" }, "exactly one of command or url"],
		[{ url: "file:///tmp/mcp" }, "http or https"],
		[{ command: "" }, "non-empty command"],
		[{ command: "node", startupTimeoutSec: 0 }, "startupTimeoutSec"],
	])("rejects invalid server configuration %#", (server, message) => {
		const manager = SettingsManager.inMemory({ mcpServers: { broken: server as never } });
		expect(() => resolveMcpSettings(manager, "/repo", {})).toThrow(message);
	});
});
