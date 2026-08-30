import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AuthStorage,
	InMemoryAuthStorageBackend,
	legacyMcpCredentialKey,
	mcpCredentialKey,
	mcpVersionedCredentialPrefix,
} from "../src/core/auth-storage.ts";
import {
	McpConfigurationCoordinator,
	McpManager,
	McpServerClient,
	mcpConfigurationRevision,
	mcpServerFingerprint,
	resolveMcpServerSettings,
} from "../src/core/mcp/index.ts";
import type { McpHttpServerSettings } from "../src/core/settings-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { createMcpTestServer, type McpTestServer } from "./helpers/mcp-test-server.ts";

const managers: McpManager[] = [];
const servers: McpTestServer[] = [];
const userMcpKey = (name: string) => mcpCredentialKey({ scope: "user", name });
const hasVersionedUserCredential = (storage: AuthStorage, name: string) =>
	storage.list().some((key) => key.startsWith(mcpVersionedCredentialPrefix({ scope: "user", name })));

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
	it("lets an active tool call finish on the retired client generation", async () => {
		const previousServer = await createMcpTestServer({ callDelayMs: 150 });
		const nextServer = await createMcpTestServer();
		servers.push(previousServer, nextServer);
		const settings = SettingsManager.inMemory({
			mcpServers: { docs: { url: String(previousServer.url) } },
		});
		const manager = await McpManager.create({
			settingsManager: settings,
			authStorage: AuthStorage.inMemory(),
			cwd: process.cwd(),
		});
		managers.push(manager);

		const active = manager.callTool("mcp__docs__search_docs", { query: "old generation" });
		await vi.waitFor(() => expect(previousServer.toolCallCount()).toBe(1));
		settings.setMcpServer("global", "docs", { url: String(nextServer.url) });
		await settings.flushOrThrow();
		await manager.reload();

		await expect(active).resolves.toMatchObject({
			content: [{ type: "text", text: "match:old generation" }],
		});
		await expect(manager.callTool("mcp__docs__search_docs", { query: "new generation" })).resolves.toMatchObject({
			content: [{ type: "text", text: "match:new generation" }],
		});
	});

	it("refreshes an externally changed definition at the next explicit boundary", async () => {
		const storage = new InMemorySettingsStorage();
		const runtimeSettings = SettingsManager.fromStorage(storage);
		const writer = SettingsManager.fromStorage(storage);
		const manager = await McpManager.create({
			settingsManager: runtimeSettings,
			authStorage: AuthStorage.inMemory(),
			cwd: process.cwd(),
		});
		managers.push(manager);
		expect(manager.getStatus()).toEqual([]);

		writer.setMcpServer("global", "external", { command: "node", enabled: false });
		await writer.flushOrThrow();
		await manager.ensureCurrent();

		expect(manager.getStatus()).toMatchObject([{ name: "external", state: "disabled" }]);
	});

	it("refreshes an externally changed credential at the next tool boundary", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "external-secret" });
		servers.push(server);
		const definition = { url: String(server.url) };
		const settingsStorage = new InMemorySettingsStorage();
		const writerSettings = SettingsManager.fromStorage(settingsStorage);
		writerSettings.setMcpServer("global", "docs", definition);
		await writerSettings.flushOrThrow();
		const authBackend = new InMemoryAuthStorageBackend();
		const runtimeAuth = AuthStorage.fromStorage(authBackend);
		const writerAuth = AuthStorage.fromStorage(authBackend);
		const manager = await McpManager.create({
			settingsManager: SettingsManager.fromStorage(settingsStorage),
			authStorage: runtimeAuth,
			cwd: process.cwd(),
		});
		managers.push(manager);
		expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });

		await new McpConfigurationCoordinator({ authStorage: writerAuth }).mutate({
			settingsManager: writerSettings,
			cwd: process.cwd(),
			scope: "user",
			changes: [
				{
					name: "docs",
					expectedRevision: mcpConfigurationRevision("user", "docs", definition),
					next: definition,
					credential: { action: "replace", bearerToken: "external-secret" },
				},
			],
		});

		await expect(manager.callTool("mcp__docs__search_docs", { query: "lazy refresh" })).resolves.toMatchObject({
			content: [{ type: "text", text: "match:lazy refresh" }],
		});
		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
	});

	it("exposes only safe selected-server catalog names and fingerprint-bound credential state", async () => {
		const server = await createMcpTestServer({
			resources: [
				{ uri: "docs://index", name: "Docs index" },
				{ uri: "docs://mirror", name: "Docs index" },
			],
			resourceTemplates: [{ uriTemplate: "docs://{slug}", name: "" }],
			prompts: [{ name: "summarize_docs" }],
		});
		servers.push(server);
		const authStorage = AuthStorage.inMemory();
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage,
			cwd: process.cwd(),
			configurationCoordinator: new McpConfigurationCoordinator({ authStorage }),
		});
		managers.push(manager);

		await manager.setSecret("docs", { bearerToken: "secret-value" });
		expect(manager.hasCredential("docs")).toBe(true);
		expect(manager.getCatalog("docs")).toEqual({
			tools: [{ id: "search_docs", name: "Search docs", description: "Search product documentation" }],
			resources: [
				{ id: "docs://index", name: "Docs index" },
				{ id: "docs://mirror", name: "Docs index" },
			],
			resourceTemplates: [{ id: "docs://{slug}", name: "docs://{slug}" }],
			prompts: [{ id: "summarize_docs", name: "summarize_docs" }],
		});
		expect(manager.getCatalogItem("docs", "tool", "search_docs")).toMatchObject({
			kind: "tool",
			id: "search_docs",
			name: "Search docs",
			inputSchema: expect.stringContaining('"query"'),
		});
		expect(manager.getCatalogItem("docs", "resource", "docs://mirror")).toMatchObject({
			kind: "resource",
			id: "docs://mirror",
			uri: "docs://mirror",
		});
		expect(() => manager.getCatalogItem("docs", "prompt", "missing")).toThrow("Unknown MCP prompt");
		expect(JSON.stringify(manager.getCatalog("docs"))).not.toContain("secret-value");

		const first = resolveMcpServerSettings("docs", { url: "https://example.test/one" }, process.cwd());
		const changed = resolveMcpServerSettings("docs", { url: "https://example.test/two" }, process.cwd());
		expect(mcpServerFingerprint(first)).not.toBe(mcpServerFingerprint(changed));
	});

	it("keeps oversized resource identities stable and selectable", async () => {
		const longUri = `docs://${"x".repeat(16_001)}`;
		const server = await createMcpTestServer({ resources: [{ uri: longUri, name: "Large resource" }] });
		servers.push(server);
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: AuthStorage.inMemory(),
			cwd: process.cwd(),
		});
		managers.push(manager);

		const [entry] = manager.getCatalog("docs").resources;
		expect(entry?.id).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(manager.getCatalogItem("docs", "resource", entry!.id)).toMatchObject({
			kind: "resource",
			id: entry!.id,
			name: "Large resource",
		});
	});

	it("does not forward a legacy stored secret without an identity binding", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "legacy-secret" });
		servers.push(server);
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: AuthStorage.inMemory({
				[legacyMcpCredentialKey("docs")]: { type: "mcp_secret", bearerToken: "legacy-secret" },
			}),
			cwd: process.cwd(),
		});
		managers.push(manager);

		expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });
	});

	it("reads a fingerprint-matched legacy credential without migrating an untouched definition", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "legacy-secret" });
		servers.push(server);
		const fingerprint = mcpServerFingerprint(
			resolveMcpServerSettings("docs", { url: String(server.url) }, process.cwd()),
		);
		const storage = AuthStorage.inMemory({
			[legacyMcpCredentialKey("docs")]: {
				type: "mcp_secret",
				serverFingerprint: fingerprint,
				bearerToken: "legacy-secret",
			},
		});

		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: storage,
			cwd: process.cwd(),
		});
		managers.push(manager);

		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
		expect(storage.has(legacyMcpCredentialKey("docs"))).toBe(true);
		expect(storage.get(userMcpKey("docs"))).toBeUndefined();
		expect(storage.get(legacyMcpCredentialKey("docs"))).toMatchObject({
			type: "mcp_secret",
			bearerToken: "legacy-secret",
		});
	});

	it("keeps same-name user and project credentials isolated", async () => {
		const userServer = await createMcpTestServer({ requiredBearerToken: "user-secret" });
		const projectServer = await createMcpTestServer({ requiredBearerToken: "project-secret" });
		servers.push(userServer, projectServer);
		const cwd = process.cwd();
		const storage = AuthStorage.inMemory({
			[userMcpKey("docs")]: {
				type: "mcp_secret",
				serverFingerprint: mcpServerFingerprint(
					resolveMcpServerSettings("docs", { url: String(userServer.url) }, cwd),
				),
				bearerToken: "user-secret",
			},
			[mcpCredentialKey({ scope: "project", name: "docs", cwd })]: {
				type: "mcp_secret",
				serverFingerprint: mcpServerFingerprint(
					resolveMcpServerSettings("docs", { url: String(projectServer.url) }, cwd),
				),
				bearerToken: "project-secret",
			},
		});
		const settingsStorage = new InMemorySettingsStorage();
		settingsStorage.withLock("global", () =>
			JSON.stringify({ mcpServers: { docs: { url: String(userServer.url) } } }),
		);
		settingsStorage.withLock("project", () =>
			JSON.stringify({ mcpServers: { docs: { url: String(projectServer.url) } } }),
		);

		const manager = await McpManager.create({
			settingsManager: SettingsManager.fromStorage(settingsStorage, { projectTrusted: true }),
			authStorage: storage,
			cwd,
		});
		managers.push(manager);

		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
		expect(storage.get(userMcpKey("docs"))).toMatchObject({ bearerToken: "user-secret" });
		expect(storage.get(mcpCredentialKey({ scope: "project", name: "docs", cwd }))).toMatchObject({
			bearerToken: "project-secret",
		});
	});

	it("reuses a stored bearer token after restart without exposing it in status", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "stored-secret" });
		servers.push(server);
		const storage = AuthStorage.inMemory();
		const settings = SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } });
		const initial = await McpManager.create({
			settingsManager: settings,
			authStorage: storage,
			cwd: process.cwd(),
			configurationCoordinator: new McpConfigurationCoordinator({ authStorage: storage }),
		});
		managers.push(initial);
		expect(initial.getStatus()[0]).toMatchObject({ state: "auth_required" });
		await initial.setSecret("docs", { bearerToken: "stored-secret" });
		expect(initial.getStatus()[0]).toMatchObject({ state: "connected" });
		await initial.close();

		const restarted = await McpManager.create({
			settingsManager: settings,
			authStorage: storage,
			cwd: process.cwd(),
		});
		managers.push(restarted);

		expect(restarted.getStatus()[0]).toMatchObject({ state: "connected" });
		expect(JSON.stringify(restarted.getStatus())).not.toContain("stored-secret");
	});

	it("injects stored environment values into HTTP headers", async () => {
		const server = await createMcpTestServer({ requiredHeaders: { "x-tenant": "stored-tenant" } });
		servers.push(server);
		const cwd = process.cwd();
		const definition = { url: String(server.url), envHttpHeaders: { "X-Tenant": "TENANT_SECRET" } };
		const identity = { scope: "user", name: "docs" } as const;
		const storage = AuthStorage.inMemory({
			[mcpCredentialKey(identity)]: {
				type: "mcp_secret",
				serverFingerprint: mcpServerFingerprint(resolveMcpServerSettings("docs", definition, cwd, {}, identity)),
				env: { TENANT_SECRET: "stored-tenant" },
			},
		});
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: definition } }),
			authStorage: storage,
			cwd,
			environment: {},
		});
		managers.push(manager);

		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
		expect(JSON.stringify(manager.getStatus())).not.toContain("stored-tenant");
	});

	it("injects a stored environment value into an HTTP bearer token", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "stored-bearer" });
		servers.push(server);
		const cwd = process.cwd();
		const definition = { url: String(server.url), bearerTokenEnvVar: "BEARER_SECRET" };
		const identity = { scope: "user", name: "docs" } as const;
		const storage = AuthStorage.inMemory({
			[mcpCredentialKey(identity)]: {
				type: "mcp_secret",
				serverFingerprint: mcpServerFingerprint(resolveMcpServerSettings("docs", definition, cwd, {}, identity)),
				env: { BEARER_SECRET: "stored-bearer" },
			},
		});
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: definition } }),
			authStorage: storage,
			cwd,
			environment: {},
		});
		managers.push(manager);

		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
		expect(JSON.stringify(manager.getStatus())).not.toContain("stored-bearer");
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
			configurationCoordinator: new McpConfigurationCoordinator({ authStorage: storage }),
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
			configurationCoordinator: new McpConfigurationCoordinator({ authStorage }),
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
			configurationCoordinator: new McpConfigurationCoordinator({ authStorage }),
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
			configurationCoordinator: new McpConfigurationCoordinator({ authStorage: storage }),
		});
		managers.push(manager);
		expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });

		await manager.setSecret("docs", { bearerToken: "stored-secret" });
		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
		expect(hasVersionedUserCredential(storage, "docs")).toBe(true);

		await manager.logout("docs");
		expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });
		expect(hasVersionedUserCredential(storage, "docs")).toBe(false);
	});

	it("rejects empty static credentials without replacing the active auth state", async () => {
		const server = await createMcpTestServer({ requiredBearerToken: "stored-secret" });
		servers.push(server);
		const storage = AuthStorage.inMemory();
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: storage,
			cwd: process.cwd(),
			configurationCoordinator: new McpConfigurationCoordinator({ authStorage: storage }),
		});
		managers.push(manager);

		await expect(manager.setSecret("docs", { bearerToken: "" })).rejects.toThrow("must not be empty");
		expect(hasVersionedUserCredential(storage, "docs")).toBe(false);
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
			configurationCoordinator: new McpConfigurationCoordinator({ authStorage: storage }),
		});
		managers.push(manager);
		expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });

		await expect(manager.setSecret("docs", { bearerToken: "wrong-secret" })).rejects.toThrow(
			'Failed to initialize required MCP server "docs"',
		);
		expect(hasVersionedUserCredential(storage, "docs")).toBe(false);
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
		const { manager } = await managerWithTools(
			"docs",
			[{ name: "search" }],
			{ description: "Repository handbook lookup." },
			"Use docs before guessing.",
		);

		expect(manager.getToolRecords()[0]).toMatchObject({
			sourceName: "docs",
			sourceDescription: "Repository handbook lookup.\n\nUse docs before guessing.",
		});
		expect(manager.searchTools("handbook")[0]?.rawName).toBe("search");
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

	it("does not wait for optional MCP startup", async () => {
		const start = vi.spyOn(McpServerClient.prototype, "start").mockReturnValue(new Promise(() => {}));
		let manager: McpManager;
		try {
			manager = await McpManager.create({
				settingsManager: SettingsManager.inMemory({
					mcpServers: { slow: { url: "https://example.test/mcp" } },
				}),
				authStorage: AuthStorage.inMemory(),
				cwd: process.cwd(),
				backgroundOptionalStartup: true,
			});
		} finally {
			start.mockRestore();
		}
		managers.push(manager);
		expect(manager.getStatus()[0]).toMatchObject({ name: "slow", required: false });
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
