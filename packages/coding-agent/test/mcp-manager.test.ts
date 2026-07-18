import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, mcpCredentialKey } from "../src/core/auth-storage.ts";
import { McpManager } from "../src/core/mcp/index.ts";
import type { McpHttpServerSettings } from "../src/core/settings-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { createMcpTestServer, type McpTestServer } from "./helpers/mcp-test-server.ts";

const managers: McpManager[] = [];
const servers: McpTestServer[] = [];

async function managerWithTools(
	serverName: string,
	tools: Array<Partial<Tool> & Pick<Tool, "name">>,
	overrides: Partial<McpHttpServerSettings> = {},
	instructions = "Use docs before guessing.",
): Promise<{ manager: McpManager; server: McpTestServer }> {
	const server = await createMcpTestServer({
		tools: tools.map(
			(tool) =>
				({
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
					...tool,
				}) as Tool,
		),
		instructions,
	});
	servers.push(server);
	const manager = await McpManager.create({
		settingsManager: SettingsManager.inMemory({
			mcpServers: { [serverName]: { url: String(server.url), ...overrides } },
		}),
		authStorage: AuthStorage.inMemory(),
		cwd: process.cwd(),
	});
	managers.push(manager);
	return { manager, server };
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("McpManager", () => {
	it("does not forward a legacy stored secret without an identity binding", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "legacy-secret" });
		servers.push(server);
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: AuthStorage.inMemory({
				[mcpCredentialKey("docs")]: { type: "mcp_secret", bearerToken: "legacy-secret" },
			}),
			cwd: process.cwd(),
		});
		managers.push(manager);

		expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });
	});

	it("reuses a stored bearer token after restart without exposing it in status", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "stored-secret" });
		servers.push(server);
		const storage = AuthStorage.inMemory();
		const settings = { mcpServers: { docs: { url: String(server.url) } } };
		const initial = await McpManager.create({
			settingsManager: SettingsManager.inMemory(settings),
			authStorage: storage,
			cwd: process.cwd(),
		});
		managers.push(initial);
		expect(initial.getStatus()[0]).toMatchObject({ state: "auth_required" });
		await initial.setSecret("docs", { bearerToken: "stored-secret" });
		expect(initial.getStatus()[0]).toMatchObject({ state: "connected" });
		await initial.close();

		const restarted = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: storage,
			cwd: process.cwd(),
		});
		managers.push(restarted);

		expect(restarted.getStatus()[0]).toMatchObject({ state: "connected" });
		expect(JSON.stringify(restarted.getStatus())).not.toContain("stored-secret");
	});

	it("injects stored environment values into a stdio child", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));
		const storage = AuthStorage.inMemory();
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({
				mcpServers: { local: { command: process.execPath, args: [fixture] } },
			}),
			authStorage: storage,
			cwd: process.cwd(),
		});
		managers.push(manager);

		await manager.setSecret("local", { env: { LOCAL_TOKEN: "stored-secret" } });
		const result = await manager.callTool("mcp__local__env_status", {});
		expect(result.content).toContainEqual({ type: "text", text: "configured" });
		expect(JSON.stringify(result)).not.toContain("stored-secret");
	});

	it("does not forward a stored secret after a same-name project override changes the endpoint", async () => {
		const personalServer = await createMcpTestServer({ requiredBearerToken: "personal-secret" });
		const projectServer = await createMcpTestServer({ requiredBearerToken: "personal-secret" });
		servers.push(personalServer, projectServer);
		const authStorage = AuthStorage.inMemory();
		const personal = await McpManager.create({
			settingsManager: SettingsManager.inMemory({
				mcpServers: { docs: { url: String(personalServer.url) } },
			}),
			authStorage,
			cwd: process.cwd(),
		});
		managers.push(personal);
		await personal.setSecret("docs", { bearerToken: "personal-secret" });
		expect(personal.getStatus()[0]).toMatchObject({ state: "connected" });
		await personal.close();

		const settingsStorage = new InMemorySettingsStorage();
		settingsStorage.withLock("global", () =>
			JSON.stringify({ mcpServers: { docs: { url: String(personalServer.url) } } }),
		);
		settingsStorage.withLock("project", () =>
			JSON.stringify({ mcpServers: { docs: { url: String(projectServer.url) } } }),
		);
		const overridden = await McpManager.create({
			settingsManager: SettingsManager.fromStorage(settingsStorage, { projectTrusted: true }),
			authStorage,
			cwd: process.cwd(),
		});
		managers.push(overridden);

		expect(overridden.getStatus()[0]).toMatchObject({ state: "auth_required" });
	});

	it("does not forward stored stdio environment values after the working directory changes", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));
		const authStorage = AuthStorage.inMemory();
		const initial = await McpManager.create({
			settingsManager: SettingsManager.inMemory({
				mcpServers: { local: { command: process.execPath, args: [fixture], cwd: process.cwd() } },
			}),
			authStorage,
			cwd: process.cwd(),
		});
		managers.push(initial);
		await initial.setSecret("local", { env: { LOCAL_TOKEN: "stored-secret" } });
		expect(initial.getSecretEnvironment("local")).toEqual({ LOCAL_TOKEN: "stored-secret" });
		expect(await initial.callTool("mcp__local__env_status", {})).toMatchObject({
			content: [{ type: "text", text: "configured" }],
		});
		await initial.close();

		const changed = await McpManager.create({
			settingsManager: SettingsManager.inMemory({
				mcpServers: { local: { command: process.execPath, args: [fixture], cwd: tmpdir() } },
			}),
			authStorage,
			cwd: process.cwd(),
		});
		managers.push(changed);

		expect(changed.getSecretEnvironment("local")).toEqual({});
		expect(await changed.callTool("mcp__local__env_status", {})).toMatchObject({
			content: [{ type: "text", text: "missing" }],
		});
	});

	it("rebuilds clients when static credentials are set and removed", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "stored-secret" });
		servers.push(server);
		const storage = AuthStorage.inMemory();
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: storage,
			cwd: process.cwd(),
		});
		managers.push(manager);
		expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });

		await manager.setSecret("docs", { bearerToken: "stored-secret" });
		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
		expect(storage.get(mcpCredentialKey("docs"))).toMatchObject({ type: "mcp_secret" });

		await manager.logout("docs");
		expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });
		expect(storage.has(mcpCredentialKey("docs"))).toBe(false);
	});

	it("rejects empty static credentials without replacing the active auth state", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "stored-secret" });
		servers.push(server);
		const storage = AuthStorage.inMemory();
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: storage,
			cwd: process.cwd(),
		});
		managers.push(manager);

		await expect(manager.setSecret("docs", { bearerToken: "" })).rejects.toThrow("must not be empty");
		expect(storage.has(mcpCredentialKey("docs"))).toBe(false);
		expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });
	});

	it("rolls back a stored secret when a required server rejects the replacement", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "environment-secret" });
		servers.push(server);
		const storage = AuthStorage.inMemory();
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({
				mcpServers: {
					docs: {
						url: String(server.url),
						required: true,
						bearerTokenEnvVar: "MCP_TOKEN",
					},
				},
			}),
			authStorage: storage,
			cwd: process.cwd(),
			environment: { MCP_TOKEN: "environment-secret" },
		});
		managers.push(manager);
		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });

		await expect(manager.setSecret("docs", { bearerToken: "wrong-secret" })).rejects.toThrow(
			'Failed to initialize required MCP server "docs"',
		);
		expect(storage.has(mcpCredentialKey("docs"))).toBe(false);
		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
	});

	it("normalizes model names while preserving raw call identity", async () => {
		const { manager, server } = await managerWithTools("Some Server", [
			{
				name: "find docs",
				description: "Search manuals",
				inputSchema: { type: "object", properties: { query: { type: "string" } } },
			},
		]);

		const [record] = manager.getToolRecords();
		expect(record).toMatchObject({
			serverName: "Some Server",
			rawName: "find docs",
			modelName: "mcp__Some_Server__find_docs",
		});
		expect(Buffer.byteLength(record.modelName, "utf8")).toBeLessThanOrEqual(64);
		await manager.callTool(record.modelName, { query: "cache" });
		expect(server.lastToolCallName()).toBe("find docs");
	});

	it("uses deterministic hashes for sanitized collisions and long names", async () => {
		const { manager } = await managerWithTools("docs", [{ name: "a b" }, { name: "a@b" }, { name: "x".repeat(100) }]);

		const names = manager.getToolRecords().map((tool) => tool.modelName);
		expect(new Set(names).size).toBe(3);
		expect(names.every((name) => /^[A-Za-z0-9_-]+$/.test(name) && name.length <= 64)).toBe(true);
		expect(names.slice(0, 2).every((name) => /__[a-f0-9]{8}$/.test(name))).toBe(true);
	});

	it("applies allow then deny, excludes required-task tools, and ranks schema properties", async () => {
		const { manager } = await managerWithTools(
			"calendar",
			[
				{
					name: "create_event",
					description: "Create an appointment",
					inputSchema: { type: "object", properties: { attendees: {} } },
				},
				{ name: "delete_event", description: "Delete an appointment" },
				{ name: "long_job", execution: { taskSupport: "required" } },
			],
			{
				enabledTools: ["create_event", "delete_event", "long_job"],
				disabledTools: ["delete_event"],
			},
		);

		expect(manager.searchTools("invite attendees")).toMatchObject([{ rawName: "create_event" }]);
		expect(manager.getToolRecords().map((tool) => tool.rawName)).toEqual(["create_event"]);
	});

	it("uses configured names and initialization instructions as source metadata", async () => {
		const { manager } = await managerWithTools("docs", [{ name: "search" }], {}, "Use docs before guessing.");

		expect(manager.getToolRecords()[0]).toMatchObject({
			sourceName: "docs",
			sourceDescription: "Use docs before guessing.",
		});
		expect(manager.getStatus()[0]).toMatchObject({
			name: "docs",
			state: "connected",
			toolCount: 1,
			resourceCount: 1,
			promptCount: 1,
			capabilities: ["prompts", "resources", "tools"],
		});
	});

	it("rebuilds the searchable catalog when a server changes its tools", async () => {
		const { manager, server } = await managerWithTools("docs", [{ name: "old_tool" }]);
		const changed = vi.fn();
		manager.subscribeCatalog(changed);

		await server.setTools(["new_tool"]);

		await vi.waitFor(() => expect(manager.getToolRecords().map((tool) => tool.rawName)).toEqual(["new_tool"]));
		expect(manager.searchTools("new tool")[0]?.rawName).toBe("new_tool");
		expect(changed).toHaveBeenCalled();
	});

	it("keeps optional failures as status and rejects required failures", async () => {
		const optional = await McpManager.create({
			settingsManager: SettingsManager.inMemory({
				mcpServers: { offline: { url: "http://127.0.0.1:1/mcp", startupTimeoutSec: 0.05 } },
			}),
			authStorage: AuthStorage.inMemory(),
			cwd: process.cwd(),
		});
		managers.push(optional);
		expect(optional.getStatus()[0]).toMatchObject({ name: "offline", required: false });
		expect(optional.getStatus()[0].state).not.toBe("connected");

		await expect(
			McpManager.create({
				settingsManager: SettingsManager.inMemory({
					mcpServers: {
						offline: { url: "http://127.0.0.1:1/mcp", startupTimeoutSec: 0.05, required: true },
					},
				}),
				authStorage: AuthStorage.inMemory(),
				cwd: process.cwd(),
			}),
		).rejects.toThrow('Failed to initialize required MCP server "offline"');
	});

	it("does not expose environment-backed credentials in status diagnostics", async () => {
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({
				mcpServers: {
					offline: {
						url: "http://127.0.0.1:1/mcp",
						startupTimeoutSec: 0.05,
						bearerTokenEnvVar: "MCP_SECRET",
						envHttpHeaders: { "X-Secret": "MCP_HEADER_SECRET" },
					},
				},
			}),
			authStorage: AuthStorage.inMemory(),
			cwd: process.cwd(),
			environment: { MCP_SECRET: "bearer-secret", MCP_HEADER_SECRET: "header-secret" },
		});
		managers.push(manager);

		const status = JSON.stringify(manager.getStatus());
		expect(status).not.toContain("bearer-secret");
		expect(status).not.toContain("header-secret");
		expect(status).not.toContain("MCP_SECRET");
	});
});
