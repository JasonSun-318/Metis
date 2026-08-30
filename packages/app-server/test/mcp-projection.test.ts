import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthStorage,
	mcpCredentialKey,
	mcpServerFingerprint,
	mcpVersionedCredentialKey,
	ProjectTrustStore,
	resolveMcpServerSettings,
	SettingsManager,
} from "@metis/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";
import { CredentialCoordinator } from "../src/credential-coordinator.ts";
import { AppServerError } from "../src/session-runtime-host.ts";

const REQUEST_A = "10000000-0000-4000-8000-000000000001";
const REQUEST_B = "10000000-0000-4000-8000-000000000002";
const REQUEST_C = "10000000-0000-4000-8000-000000000003";

describe("MCP settings projection", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-mcp-projection-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("lists settings without starting MCP and keeps hidden values out of public rows", async () => {
		const marker = join(root, "must-not-run");
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		settings.setMcpServer("global", "docs", {
			command: "/usr/bin/touch",
			args: [marker],
			env: { LEGACY_TOKEN: "legacy-secret" },
		});
		settings.setMcpServer("project", "docs", {
			url: "https://mcp.example.test/project",
			description: "  Project documentation.  ",
			envHttpHeaders: { "X-Legacy": "legacy-secret" },
		});
		await settings.flush();
		new ProjectTrustStore(agentDir).set(cwd, true);

		const host = new AgentSessionRuntimeHost({ agentDir });
		const listed = await host.listMcpServers(cwd);

		expect(existsSync(marker)).toBe(false);
		expect(listed.servers).toHaveLength(2);
		expect(listed.servers[0]).toMatchObject({
			scope: "project",
			description: "Project documentation.",
			effective: true,
			state: "inactive",
		});
		expect(listed.servers[0]?.envHttpHeaders).toEqual({});
		expect(listed.servers[1]).toMatchObject({
			scope: "user",
			effective: false,
			state: "shadowed",
			inlineEnvKeys: ["LEGACY_TOKEN"],
		});
		expect(JSON.stringify(listed)).not.toContain("legacy-secret");
		expect(listed.servers[1]).not.toHaveProperty("env");
		expect(await host.getMcpServer({ cwd, scope: "project", name: "docs" })).toMatchObject({
			server: { name: "docs" },
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		});
	});

	it("preserves hidden stdio env on edit, drops it on transport change, and rejects stale or unsafe writes", async () => {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		settings.setMcpServer("global", "local", { command: "node", env: { TOKEN: "hidden" } });
		await settings.flush();
		const host = new AgentSessionRuntimeHost({ agentDir });
		const first = (await host.listMcpServers(null)).servers[0]!;

		const edited = await host.upsertMcpServer({
			cwd: null,
			scope: "user",
			name: "local",
			requestId: REQUEST_A,
			expectedRevision: first.revision,
			server: { transport: "stdio", command: "node", args: ["server.mjs"] },
		});
		const saved = SettingsManager.create(cwd, agentDir).getGlobalSettings().mcpServers?.local;
		expect(saved).not.toHaveProperty("env");
		expect(saved?.credentialVersion).toEqual(expect.any(String));
		const migrated = AuthStorage.create(join(agentDir, "auth.json"));
		expect(migrated.get(migrated.list().find((key) => key.startsWith("mcp:v3:user:local:"))!)).toMatchObject({
			type: "mcp_secret",
			env: { TOKEN: "hidden" },
		});

		await expect(
			host.upsertMcpServer({
				cwd: null,
				scope: "user",
				name: "local",
				requestId: REQUEST_B,
				expectedRevision: first.revision,
				server: { transport: "stdio", command: "node" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		await host.upsertMcpServer({
			cwd: null,
			scope: "user",
			name: "local",
			requestId: REQUEST_C,
			expectedRevision: edited.servers[0]!.revision,
			server: { transport: "http", url: "https://mcp.example.test/rpc" },
		});
		expect(SettingsManager.create(cwd, agentDir).getGlobalSettings().mcpServers?.local).not.toHaveProperty("env");

		await expect(
			host.upsertMcpServer({
				cwd: null,
				scope: "user",
				name: "unsafe",
				requestId: "10000000-0000-4000-8000-000000000004",
				expectedRevision: null,
				server: { transport: "http", url: "https://user:password@mcp.example.test/rpc" },
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
	});

	it("serializes concurrent writes so only one stale revision can commit", async () => {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		settings.setMcpServer("global", "local", { command: "node" });
		await settings.flush();
		const host = new AgentSessionRuntimeHost({ agentDir });
		const revision = (await host.listMcpServers(null)).servers[0]!.revision;
		const write = (requestId: string, arg: string) =>
			host.upsertMcpServer({
				cwd: null,
				scope: "user",
				name: "local",
				requestId,
				expectedRevision: revision,
				server: { transport: "stdio", command: "node", args: [arg] },
			});

		const results = await Promise.allSettled([write(REQUEST_A, "a.mjs"), write(REQUEST_B, "b.mjs")]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			status: "rejected",
			reason: { code: "CONFLICT" },
		});
	});

	it("refreshes draft credentials written by another process before projecting a revision", async () => {
		const server = { url: "https://mcp.example.test/shared", enabled: false };
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		settings.setMcpServer("global", "shared", server);
		await settings.flush();
		const host = new AgentSessionRuntimeHost({ agentDir });
		expect((await host.listMcpServers(null)).servers[0]?.credentialConfigured).toBe(false);

		const credentialVersion = "20000000-0000-4000-8000-000000000001";
		const identity = { scope: "user", name: "shared" } as const;
		const fingerprint = mcpServerFingerprint(resolveMcpServerSettings("shared", server, cwd, process.env, identity));
		const externalAuth = AuthStorage.create(join(agentDir, "auth.json"));
		externalAuth.set(mcpVersionedCredentialKey(identity, fingerprint, credentialVersion), {
			type: "mcp_secret",
			serverFingerprint: fingerprint,
			bearerToken: "external-secret",
		});
		const externalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		externalSettings.setMcpServer("global", "shared", { ...server, credentialVersion });
		await externalSettings.flush();

		const refreshed = (await host.listMcpServers(null)).servers[0]!;
		expect(refreshed.credentialConfigured).toBe(true);
		await expect(
			host.upsertMcpServer({
				cwd: null,
				scope: "user",
				name: "shared",
				requestId: REQUEST_A,
				expectedRevision: refreshed.revision,
				server: { transport: "http", url: server.url, enabled: true },
			}),
		).resolves.toMatchObject({ servers: [expect.objectContaining({ name: "shared" })] });
	});

	it("isolates same-name User and Project credentials and enforces project trust", async () => {
		const credentials = new CredentialCoordinator({ agentDir });
		const auth = credentials.createView();
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const userServer = { command: "node", args: ["user.mjs"] };
		const projectServer = { url: "https://mcp.example.test/project" };
		settings.setMcpServer("global", "docs", userServer);
		settings.setMcpServer("project", "docs", projectServer);
		await settings.flush();
		const trust = new ProjectTrustStore(agentDir);
		trust.set(cwd, true);
		const host = new AgentSessionRuntimeHost({ agentDir, credentials });
		const userIdentity = { scope: "user", name: "docs" } as const;
		const projectIdentity = { scope: "project", name: "docs", cwd } as const;
		auth.set(mcpCredentialKey(userIdentity), {
			type: "mcp_secret",
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("docs", userServer, cwd, process.env, userIdentity),
			),
			env: { TOKEN: "user-secret" },
		});
		auth.set(mcpCredentialKey(projectIdentity), {
			type: "mcp_secret",
			serverFingerprint: mcpServerFingerprint(
				resolveMcpServerSettings("docs", projectServer, cwd, process.env, projectIdentity),
			),
			bearerToken: "stored-secret",
		});

		const listed = await host.listMcpServers(cwd);
		const user = listed.servers.find((server) => server.scope === "user")!;
		const project = listed.servers.find((server) => server.scope === "project")!;
		expect(project.credentialConfigured).toBe(true);
		expect(user.credentialConfigured).toBe(true);

		await host.removeMcpServer({
			cwd,
			scope: "user",
			name: "docs",
			requestId: REQUEST_A,
			expectedRevision: user.revision,
		});
		expect(auth.has(mcpCredentialKey(userIdentity))).toBe(false);
		expect(auth.has(mcpCredentialKey(projectIdentity))).toBe(true);

		await host.removeMcpServer({
			cwd,
			scope: "project",
			name: "docs",
			requestId: REQUEST_B,
			expectedRevision: project.revision,
		});
		expect(auth.has(mcpCredentialKey(projectIdentity))).toBe(false);

		settings.setMcpServer("project", "blocked", { command: "node" });
		await settings.flush();
		trust.set(cwd, false);
		await expect(
			host.upsertMcpServer({
				cwd,
				scope: "project",
				name: "new",
				requestId: REQUEST_C,
				expectedRevision: null,
				server: { transport: "stdio", command: "node" },
			}),
		).rejects.toBeInstanceOf(AppServerError);
	});
});
