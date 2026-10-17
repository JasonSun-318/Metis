import { describe, expect, it, vi } from "vitest";
import {
	AuthStorage,
	InMemoryAuthStorageBackend,
	legacyMcpCredentialKey,
	mcpCredentialKey,
	mcpVersionedCredentialKey,
} from "../src/core/auth-storage.ts";
import { mcpServerFingerprint, resolveMcpServerSettings } from "../src/core/mcp/config.ts";
import {
	McpConfigurationConflictError,
	McpConfigurationCoordinator,
	mcpConfigurationRevision,
	mcpCredentialState,
} from "../src/core/mcp/configuration.ts";
import { McpManager, type McpPreparedConfiguration } from "../src/core/mcp/manager.ts";
import {
	InMemorySettingsStorage,
	SettingsManager,
	type SettingsScope,
	type SettingsStorage,
} from "../src/core/settings-manager.ts";

describe("MCP configuration transaction primitives", () => {
	class PublishThenThrowSettingsStorage implements SettingsStorage {
		private global: string | undefined;
		private failAfterPublish = true;
		private readonly supersede?: (published: string) => string;

		constructor(supersede?: (published: string) => string) {
			this.supersede = supersede;
		}

		withLock(_scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
			const next = fn(this.global);
			if (next !== undefined) this.global = next;
		}

		withWriteLock(_scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
			const next = fn(this.global);
			if (next !== undefined) this.global = this.supersede?.(next) ?? next;
			if (!this.failAfterPublish) return;
			this.failAfterPublish = false;
			throw new Error("directory sync failed after rename");
		}
	}

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

	it("drains post-commit activation errors once", async () => {
		const coordinator = new McpConfigurationCoordinator({ authStorage: AuthStorage.inMemory() });
		const manager = runtime("/work/project");
		const failure = new Error("activation failed");
		vi.mocked(manager.activateConfiguration).mockImplementation(() => {
			throw failure;
		});
		coordinator.register(manager);
		await coordinator.mutate({
			settingsManager: SettingsManager.inMemory(),
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
		});
		expect(coordinator.drainDiagnostics()).toEqual([failure]);
		expect(coordinator.drainDiagnostics()).toEqual([]);
	});

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

	it("reconciles a settings write that was published before directory sync reported failure", async () => {
		const storage = new PublishThenThrowSettingsStorage();
		const settings = SettingsManager.fromStorage(storage);
		const next = { command: "node", args: ["next.mjs"], credentialVersion: "version-1" };

		await expect(
			settings.commitMcpServerChanges("global", new Map([["docs", undefined]]), new Map([["docs", next]])),
		).resolves.toBe(true);
		expect(settings.getGlobalSettings().mcpServers?.docs).toEqual(next);
	});

	it("retains a staged credential when a same-server successor supersedes an ambiguous settings commit", async () => {
		const storage = new PublishThenThrowSettingsStorage((published) => {
			const settings = JSON.parse(published) as { mcpServers: { docs: Record<string, unknown> } };
			settings.mcpServers.docs.enabled = true;
			return JSON.stringify(settings, null, 2);
		});
		const settings = SettingsManager.fromStorage(storage);
		const authStorage = AuthStorage.inMemory();
		const coordinator = new McpConfigurationCoordinator({ authStorage });

		await expect(
			coordinator.mutate({
				settingsManager: settings,
				cwd: "/work/project",
				scope: "user",
				changes: [
					{
						name: "docs",
						expectedRevision: null,
						next: { command: "node", args: ["docs.mjs"], env: { DOCS_TOKEN: "secret" }, enabled: false },
						credential: { action: "preserve" },
					},
				],
			}),
		).rejects.toThrow("directory sync failed after rename");

		const current = settings.getGlobalSettings().mcpServers?.docs;
		expect(current?.enabled).toBe(true);
		expect(current?.credentialVersion).toBeDefined();
		expect(mcpCredentialState(authStorage, "/work/project", "user", "docs", current!)).toBe(
			current?.credentialVersion,
		);
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

	it("activates one global mutation in every registered real manager", async () => {
		const storage = new InMemorySettingsStorage();
		const authStorage = AuthStorage.inMemory();
		const coordinator = new McpConfigurationCoordinator({ authStorage });
		const first = await McpManager.create({
			settingsManager: SettingsManager.fromStorage(storage),
			authStorage,
			cwd: "/work/first",
			configurationCoordinator: coordinator,
		});
		const second = await McpManager.create({
			settingsManager: SettingsManager.fromStorage(storage),
			authStorage,
			cwd: "/work/second",
			configurationCoordinator: coordinator,
		});

		try {
			await coordinator.mutate({
				settingsManager: SettingsManager.fromStorage(storage),
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

			expect(first.getStatus()).toMatchObject([{ name: "docs", state: "disabled" }]);
			expect(second.getStatus()).toMatchObject([{ name: "docs", state: "disabled" }]);
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
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

		const result = await coordinator.mutate({
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
		expect(result.entries[0]).toMatchObject({
			credentialConfigured: true,
			revision: mcpConfigurationRevision("user", "local", saved, saved.credentialVersion),
		});
	});

	it("keeps a shared legacy credential available to the other scope during migration", async () => {
		const storage = new InMemorySettingsStorage();
		const settings = SettingsManager.fromStorage(storage);
		const server = { command: "node", args: ["server.mjs"] };
		settings.applyMcpServerChanges("global", new Map([["shared", server]]));
		settings.applyMcpServerChanges("project", new Map([["shared", server]]));
		await settings.flushOrThrow();

		const authStorage = AuthStorage.inMemory();
		const legacyKey = legacyMcpCredentialKey("shared");
		authStorage.set(legacyKey, {
			type: "mcp_secret",
			env: { TOKEN: "shared-secret" },
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("shared", server, "/work/project", process.env),
			),
		});
		const coordinator = new McpConfigurationCoordinator({ authStorage });

		await coordinator.mutate({
			settingsManager: settings,
			cwd: "/work/project",
			scope: "user",
			changes: [
				{
					name: "shared",
					expectedRevision: mcpConfigurationRevision("user", "shared", server, "legacy"),
					next: server,
					credential: { action: "preserve" },
				},
			],
		});

		expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "shared-secret" } });
		const project = settings.getProjectSettings().mcpServers!.shared!;
		await expect(
			coordinator.mutate({
				settingsManager: settings,
				cwd: "/work/project",
				scope: "project",
				changes: [
					{
						name: "shared",
						expectedRevision: mcpConfigurationRevision("project", "shared", project, "legacy"),
						next: project,
						credential: { action: "preserve" },
					},
				],
			}),
		).resolves.toMatchObject({ entries: [{ credentialConfigured: true }] });
	});

	it("shadows an explicitly removed legacy credential without deleting the shared secret", async () => {
		const server = { command: "node", args: ["server.mjs"] };
		const settings = SettingsManager.inMemory({ mcpServers: { docs: server } });
		const authStorage = AuthStorage.inMemory();
		const legacyKey = legacyMcpCredentialKey("docs");
		authStorage.set(legacyKey, {
			type: "mcp_secret",
			env: { TOKEN: "legacy-secret" },
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("docs", server, "/work/project", process.env),
			),
		});
		const coordinator = new McpConfigurationCoordinator({ authStorage });

		const removed = await coordinator.mutate({
			settingsManager: settings,
			cwd: "/work/project",
			scope: "user",
			changes: [
				{
					name: "docs",
					expectedRevision: mcpConfigurationRevision("user", "docs", server, "legacy"),
					next: server,
					credential: { action: "remove" },
				},
			],
		});

		expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "legacy-secret" } });
		expect(
			authStorage
				.list()
				.map((key) => authStorage.get(key))
				.find((credential) => credential?.type === "mcp_revoked"),
		).toMatchObject({ type: "mcp_revoked" });
		expect(removed.entries).toMatchObject([{ credentialConfigured: false }]);
		await expect(
			coordinator.mutate({
				settingsManager: settings,
				cwd: "/work/project",
				scope: "user",
				changes: [
					{
						name: "docs",
						expectedRevision: removed.entries[0]!.revision!,
						next: server,
						credential: { action: "preserve" },
					},
				],
			}),
		).resolves.toMatchObject({ entries: [{ credentialConfigured: false }] });
	});

	it("prepares a credential revocation through a private overlay", async () => {
		const server = { command: "node", args: ["server.mjs"] };
		const settings = SettingsManager.inMemory({ mcpServers: { docs: server } });
		const authStorage = AuthStorage.inMemory();
		const legacyKey = legacyMcpCredentialKey("docs");
		authStorage.set(legacyKey, {
			type: "mcp_secret",
			env: { TOKEN: "legacy-secret" },
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("docs", server, "/work/project", process.env),
			),
		});
		const coordinator = new McpConfigurationCoordinator({ authStorage });
		const manager = runtime("/work/project");
		vi.mocked(manager.prepareConfigurationChanges).mockImplementation(async (_scope, _changes, overlay) => {
			expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "legacy-secret" } });
			expect([...overlay!.values()].find((credential) => credential?.type === "mcp_revoked")).toMatchObject({
				type: "mcp_revoked",
			});
			return { revision: "prepared-without-secret" };
		});
		coordinator.register(manager);

		await coordinator.mutate({
			settingsManager: settings,
			cwd: "/work/project",
			scope: "user",
			changes: [
				{
					name: "docs",
					expectedRevision: mcpConfigurationRevision("user", "docs", server, "legacy"),
					next: server,
					credential: { action: "remove" },
				},
			],
		});

		expect(manager.activateConfiguration).toHaveBeenCalledOnce();
		expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "legacy-secret" } });
	});

	it("fails credential removal when durable revocation cannot be written", async () => {
		const server = { command: "node", args: ["server.mjs"] };
		const settings = SettingsManager.inMemory({ mcpServers: { docs: server } });
		const authStorage = AuthStorage.inMemory();
		const legacyKey = legacyMcpCredentialKey("docs");
		authStorage.set(legacyKey, {
			type: "mcp_secret",
			env: { TOKEN: "legacy-secret" },
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("docs", server, "/work/project", process.env),
			),
		});
		const coordinator = new McpConfigurationCoordinator({ authStorage });
		vi.spyOn(authStorage, "applyChanges").mockImplementationOnce(() => {
			throw new Error("auth storage is read-only");
		});

		await expect(
			coordinator.mutate({
				settingsManager: settings,
				cwd: "/work/project",
				scope: "user",
				changes: [
					{
						name: "docs",
						expectedRevision: mcpConfigurationRevision("user", "docs", server, "legacy"),
						next: server,
						credential: { action: "remove" },
					},
				],
			}),
		).rejects.toThrow("auth storage is read-only");
		expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "legacy-secret" } });
		expect(settings.getGlobalSettings().mcpServers?.docs).toEqual(server);
	});

	it("does not expose an uncommitted revocation when runtime preparation fails", async () => {
		const server = { command: "node", args: ["server.mjs"] };
		const settings = SettingsManager.inMemory({ mcpServers: { docs: server } });
		const backend = new InMemoryAuthStorageBackend();
		const authStorage = AuthStorage.fromStorage(backend);
		const observer = AuthStorage.fromStorage(backend);
		const legacyKey = legacyMcpCredentialKey("docs");
		authStorage.set(legacyKey, {
			type: "mcp_secret",
			env: { TOKEN: "legacy-secret" },
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("docs", server, "/work/project", process.env),
			),
		});
		const coordinator = new McpConfigurationCoordinator({ authStorage });
		const failed = runtime("/work/project");
		vi.mocked(failed.prepareConfigurationChanges).mockImplementation(async () => {
			observer.reload();
			expect(observer.get(legacyKey)).toMatchObject({ env: { TOKEN: "legacy-secret" } });
			throw new Error("runtime prepare failed");
		});
		coordinator.register(failed);

		await expect(
			coordinator.mutate({
				settingsManager: settings,
				cwd: "/work/project",
				scope: "user",
				changes: [
					{
						name: "docs",
						expectedRevision: mcpConfigurationRevision("user", "docs", server, "legacy"),
						next: server,
						credential: { action: "remove" },
					},
				],
			}),
		).rejects.toThrow("runtime prepare failed");
		expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "legacy-secret" } });
		expect(settings.getGlobalSettings().mcpServers?.docs).toEqual(server);
	});

	it("keeps a shared legacy credential available when one scope revokes it", async () => {
		const storage = new InMemorySettingsStorage();
		const settings = SettingsManager.fromStorage(storage);
		const server = { command: "node", args: ["server.mjs"] };
		settings.applyMcpServerChanges("global", new Map([["shared", server]]));
		settings.applyMcpServerChanges("project", new Map([["shared", server]]));
		await settings.flushOrThrow();
		const authStorage = AuthStorage.inMemory();
		const legacyKey = legacyMcpCredentialKey("shared");
		authStorage.set(legacyKey, {
			type: "mcp_secret",
			env: { TOKEN: "shared-secret" },
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("shared", server, "/work/project", process.env),
			),
		});

		await new McpConfigurationCoordinator({ authStorage }).mutate({
			settingsManager: settings,
			cwd: "/work/project",
			scope: "user",
			changes: [
				{
					name: "shared",
					expectedRevision: mcpConfigurationRevision("user", "shared", server, "legacy"),
					next: server,
					credential: { action: "remove" },
				},
			],
		});

		const userServer = settings.getGlobalSettings().mcpServers!.shared!;
		const userState = mcpCredentialState(authStorage, "/work/project", "user", "shared", userServer);
		expect(userState).toEqual(expect.any(String));
		expect(userState).not.toBe("legacy");
		expect(mcpCredentialState(authStorage, "/work/project", "project", "shared", server)).toBe("legacy");
		expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "shared-secret" } });
	});

	it("does not inherit another scope's legacy credential when an existing definition changes", async () => {
		const storage = new InMemorySettingsStorage();
		const settings = SettingsManager.fromStorage(storage);
		const previous = { command: "node", args: ["old.mjs"] };
		const next = { command: "node", args: ["shared.mjs"] };
		settings.applyMcpServerChanges("global", new Map([["docs", previous]]));
		settings.applyMcpServerChanges("project", new Map([["docs", next]]));
		await settings.flushOrThrow();
		const authStorage = AuthStorage.inMemory();
		const legacyKey = legacyMcpCredentialKey("docs");
		authStorage.set(legacyKey, {
			type: "mcp_secret",
			env: { TOKEN: "project-secret" },
			serverFingerprint: mcpServerFingerprint(resolveMcpServerSettings("docs", next, "/work/project", process.env)),
		});

		await new McpConfigurationCoordinator({ authStorage }).mutate({
			settingsManager: settings,
			cwd: "/work/project",
			scope: "user",
			changes: [
				{
					name: "docs",
					expectedRevision: mcpConfigurationRevision("user", "docs", previous),
					next,
					credential: { action: "preserve" },
				},
			],
		});

		const saved = settings.getGlobalSettings().mcpServers!.docs!;
		const userState = mcpCredentialState(authStorage, "/work/project", "user", "docs", saved);
		expect(userState).toEqual(expect.any(String));
		expect(userState).not.toBe("legacy");
		expect(mcpCredentialState(authStorage, "/work/project", "project", "docs", next)).toBe("legacy");
		expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "project-secret" } });
	});

	it("keeps a scoped revocation when the same definition is removed and added again", async () => {
		const server = { command: "node", args: ["server.mjs"] };
		const settings = SettingsManager.inMemory({ mcpServers: { docs: server } });
		const authStorage = AuthStorage.inMemory();
		const legacyKey = legacyMcpCredentialKey("docs");
		authStorage.set(legacyKey, {
			type: "mcp_secret",
			env: { TOKEN: "legacy-secret" },
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("docs", server, "/work/project", process.env),
			),
		});
		const coordinator = new McpConfigurationCoordinator({ authStorage });

		await coordinator.mutate({
			settingsManager: settings,
			cwd: "/work/project",
			scope: "user",
			changes: [
				{
					name: "docs",
					expectedRevision: mcpConfigurationRevision("user", "docs", server, "legacy"),
					next: undefined,
					credential: { action: "remove" },
				},
			],
		});
		const added = await coordinator.mutate({
			settingsManager: settings,
			cwd: "/work/project",
			scope: "user",
			changes: [
				{
					name: "docs",
					expectedRevision: null,
					next: server,
					credential: { action: "preserve" },
				},
			],
		});

		const saved = settings.getGlobalSettings().mcpServers!.docs!;
		const credentialState = mcpCredentialState(authStorage, "/work/project", "user", "docs", saved);
		expect(added.entries).toMatchObject([{ credentialConfigured: false }]);
		expect(credentialState).toEqual(expect.any(String));
		expect(credentialState).not.toBe("legacy");
		expect(authStorage.get(legacyKey)).toMatchObject({ env: { TOKEN: "legacy-secret" } });
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
