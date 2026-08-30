import { describe, expect, it, vi } from "vitest";
import { AuthStorage, mcpCredentialKey, mcpVersionedCredentialKey } from "../src/core/auth-storage.ts";
import {
	McpConfigurationConflictError,
	McpConfigurationCoordinator,
	mcpConfigurationRevision,
} from "../src/core/mcp/configuration.ts";
import type { McpManager, McpPreparedConfiguration } from "../src/core/mcp/manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("MCP configuration transaction primitives", () => {
	function runtime(cwd: string, failure?: Error) {
		const prepared = { revision: `prepared:${cwd}` } satisfies McpPreparedConfiguration;
		return {
			configurationCwd: cwd,
			prepareConfigurationChanges: failure
				? vi.fn().mockRejectedValue(failure)
				: vi.fn().mockResolvedValue(prepared),
			activateConfiguration: vi.fn(),
			discardConfiguration: vi.fn().mockResolvedValue(undefined),
		} as unknown as McpManager;
	}

	it("uses an opaque credential version without replacing the legacy scoped key", () => {
		const identity = { scope: "project", name: "docs", cwd: "/work/project" } as const;
		const legacy = mcpCredentialKey(identity);
		const versioned = mcpVersionedCredentialKey(identity, "server-fingerprint", "credential-version");

		expect(legacy).toContain("mcp:v2:project:");
		expect(versioned).toContain("mcp:v3:project:");
		expect(versioned).toContain(":server-fingerprint:credential-version");
		expect(versioned).not.toBe(legacy);
	});

	it("includes the non-secret credential version in the public conflict revision", () => {
		const first = { command: "node", credentialVersion: "first" } as const;
		const second = { command: "node", credentialVersion: "second" } as const;

		expect(mcpConfigurationRevision("user", "docs", first)).not.toBe(
			mcpConfigurationRevision("user", "docs", second),
		);
	});

	it("rejects stale definitions inside the settings write lock", async () => {
		const storage = new InMemorySettingsStorage();
		const writer = SettingsManager.fromStorage(storage);
		const stale = SettingsManager.fromStorage(storage);
		writer.setMcpServer("global", "docs", { command: "node", args: ["first.mjs"] });
		await writer.flushOrThrow();
		await stale.reload();

		const previous = stale.getGlobalSettings().mcpServers?.docs;
		writer.setMcpServer("global", "docs", { command: "node", args: ["second.mjs"] });
		await writer.flushOrThrow();

		const committed = await stale.commitMcpServerChanges(
			"global",
			new Map([["docs", previous]]),
			new Map([["docs", { command: "node", args: ["stale.mjs"] }]]),
		);

		expect(committed).toBe(false);
		expect(SettingsManager.fromStorage(storage).getGlobalSettings().mcpServers?.docs).toEqual({
			command: "node",
			args: ["second.mjs"],
		});
	});

	it("commits a batch only when every expected definition still matches", async () => {
		const storage = new InMemorySettingsStorage();
		const settings = SettingsManager.fromStorage(storage);
		settings.applyMcpServerChanges(
			"global",
			new Map([
				["docs", { command: "node", args: ["docs.mjs"] }],
				["search", { url: "https://mcp.example.test/search" }],
			]),
		);
		await settings.flushOrThrow();
		const current = settings.getGlobalSettings().mcpServers!;

		const committed = await settings.commitMcpServerChanges(
			"global",
			new Map([
				["docs", current.docs],
				["search", current.search],
			]),
			new Map([
				["docs", { command: "node", args: ["next.mjs"] }],
				["search", undefined],
			]),
		);

		expect(committed).toBe(true);
		expect(settings.getGlobalSettings().mcpServers).toEqual({
			docs: { command: "node", args: ["next.mjs"] },
		});
	});

	it("prepares every global runtime and only the matching project runtime", async () => {
		const coordinator = new McpConfigurationCoordinator({ authStorage: AuthStorage.inMemory() });
		const first = runtime("/work/first");
		const second = runtime("/work/second");
		coordinator.register(first);
		coordinator.register(second);
		const settings = SettingsManager.inMemory();

		await coordinator.mutate({
			settingsManager: settings,
			cwd: "/work/first",
			scope: "user",
			changes: [
				{
					name: "docs",
					expectedRevision: null,
					next: { command: "node", enabled: false },
					credential: { action: "preserve" },
				},
			],
		});

		expect(first.prepareConfigurationChanges).toHaveBeenCalledOnce();
		expect(second.prepareConfigurationChanges).toHaveBeenCalledOnce();
		expect(first.activateConfiguration).toHaveBeenCalledOnce();
		expect(second.activateConfiguration).toHaveBeenCalledOnce();

		await coordinator.mutate({
			settingsManager: settings,
			cwd: "/work/first",
			scope: "project",
			changes: [
				{
					name: "local",
					expectedRevision: null,
					next: { command: "node", enabled: false },
					credential: { action: "preserve" },
				},
			],
		});

		expect(first.prepareConfigurationChanges).toHaveBeenCalledTimes(2);
		expect(second.prepareConfigurationChanges).toHaveBeenCalledTimes(1);
	});

	it("keeps settings unchanged when one affected runtime cannot prepare", async () => {
		const coordinator = new McpConfigurationCoordinator({ authStorage: AuthStorage.inMemory() });
		const ready = runtime("/work/project");
		const failed = runtime("/work/other", new Error("required MCP server failed"));
		coordinator.register(ready);
		coordinator.register(failed);
		const settings = SettingsManager.inMemory();

		await expect(
			coordinator.mutate({
				settingsManager: settings,
				cwd: "/work/project",
				scope: "user",
				changes: [
					{
						name: "docs",
						expectedRevision: null,
						next: { command: "node", enabled: false },
						credential: { action: "preserve" },
					},
				],
			}),
		).rejects.toThrow("required MCP server failed");
		expect(settings.getGlobalSettings().mcpServers).toBeUndefined();
		expect(ready.discardConfiguration).toHaveBeenCalledOnce();
		expect(ready.activateConfiguration).not.toHaveBeenCalled();
	});

	it("migrates a touched inline secret into a versioned AuthStorage entry", async () => {
		const authStorage = AuthStorage.inMemory();
		const coordinator = new McpConfigurationCoordinator({ authStorage });
		const settings = SettingsManager.inMemory({
			mcpServers: { local: { command: "node", env: { TOKEN: "literal-secret" } } },
		});
		const current = settings.getGlobalSettings().mcpServers!.local!;

		await coordinator.mutate({
			settingsManager: settings,
			cwd: "/work/project",
			scope: "user",
			changes: [
				{
					name: "local",
					expectedRevision: mcpConfigurationRevision("user", "local", current),
					next: current,
					credential: { action: "preserve" },
				},
			],
		});

		const saved = settings.getGlobalSettings().mcpServers!.local!;
		expect(saved).not.toHaveProperty("env");
		expect(saved).toHaveProperty("credentialVersion");
		expect(JSON.stringify(settings.getGlobalSettings())).not.toContain("literal-secret");
		expect(authStorage.list().filter((key) => key.startsWith("mcp:v3:user:local:"))).toHaveLength(1);
		expect(authStorage.get(authStorage.list()[0]!)).toMatchObject({
			type: "mcp_secret",
			env: { TOKEN: "literal-secret" },
		});
	});

	it("reports a stale public revision as a domain conflict", async () => {
		const coordinator = new McpConfigurationCoordinator({ authStorage: AuthStorage.inMemory() });
		const settings = SettingsManager.inMemory({ mcpServers: { docs: { command: "node" } } });

		await expect(
			coordinator.mutate({
				settingsManager: settings,
				cwd: "/work/project",
				scope: "user",
				changes: [
					{
						name: "docs",
						expectedRevision: "stale",
						next: { command: "node", args: ["next.mjs"] },
						credential: { action: "preserve" },
					},
				],
			}),
		).rejects.toBeInstanceOf(McpConfigurationConflictError);
	});
});
