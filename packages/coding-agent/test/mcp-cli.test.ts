import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage, mcpCredentialKey } from "../src/core/auth-storage.ts";
import { McpManager } from "../src/core/mcp/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { handleMcpCliCommand } from "../src/mcp-cli.ts";
import { createMcpTestServer } from "./helpers/mcp-test-server.ts";

describe("MCP CLI", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	function readGlobalSettings(): { mcpServers?: Record<string, unknown> } {
		return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `metis-mcp-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		process.chdir(projectDir);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("adds stdio and HTTP definitions without literal secrets", async () => {
		expect(
			await handleMcpCliCommand(["mcp", "add", "local", "--env", "LOCAL_TOKEN", "--", "node", "server.mjs"]),
		).toBe(true);
		await handleMcpCliCommand([
			"mcp",
			"add",
			"docs",
			"--url",
			"https://mcp.example.test/mcp",
			"--bearer-token-env-var",
			"DOCS_TOKEN",
		]);

		expect(readGlobalSettings().mcpServers).toEqual({
			local: { command: "node", args: ["server.mjs"], envVars: ["LOCAL_TOKEN"] },
			docs: { url: "https://mcp.example.test/mcp", bearerTokenEnvVar: "DOCS_TOKEN" },
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("refuses invalid, duplicate, and secret-bearing add arguments without changing settings", async () => {
		await handleMcpCliCommand(["mcp", "add", "docs", "--url", "https://mcp.example.test/mcp"]);
		const saved = readFileSync(join(agentDir, "settings.json"), "utf8");

		for (const args of [
			["mcp", "add", "bad", "--url", "file:///tmp/mcp"],
			["mcp", "add", "docs", "--url", "https://other.example/mcp"],
			["mcp", "add", "secret", "--token", "literal-secret", "--url", "https://mcp.example/mcp"],
			["mcp", "add", "env-secret", "--env", "TOKEN=literal-secret", "--", "node", "server.mjs"],
			["mcp", "add", "unknown", "--wat"],
		]) {
			process.exitCode = undefined;
			await handleMcpCliCommand(args);
			expect(process.exitCode).toBe(1);
			expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(saved);
		}
	});

	it("requires trust for project writes and accepts explicit approval", async () => {
		mkdirSync(join(projectDir, ".metis"), { recursive: true });
		writeFileSync(join(projectDir, ".metis", "settings.json"), "{}");

		await handleMcpCliCommand(["mcp", "add", "local", "--scope", "project", "--", "node", "server.mjs"]);
		expect(process.exitCode).toBe(1);
		expect(JSON.parse(readFileSync(join(projectDir, ".metis", "settings.json"), "utf8"))).toEqual({});

		process.exitCode = undefined;
		await handleMcpCliCommand(["mcp", "add", "local", "--scope", "project", "--approve", "--", "node", "server.mjs"]);
		expect(process.exitCode).toBeUndefined();
		expect(JSON.parse(readFileSync(join(projectDir, ".metis", "settings.json"), "utf8"))).toMatchObject({
			mcpServers: { local: { command: "node", args: ["server.mjs"], envVars: [] } },
		});
	});

	it("removes the selected definition and its namespaced credential", async () => {
		await handleMcpCliCommand(["mcp", "add", "docs", "--url", "https://mcp.example.test/mcp"]);
		const auth = AuthStorage.create(join(agentDir, "auth.json"));
		auth.set(mcpCredentialKey("docs"), { type: "mcp_secret", bearerToken: "stored-secret" });

		await handleMcpCliCommand(["mcp", "remove", "docs"]);

		expect(readGlobalSettings().mcpServers?.docs).toBeUndefined();
		expect(AuthStorage.create(join(agentDir, "auth.json")).has(mcpCredentialKey("docs"))).toBe(false);
	});

	it("lists and gets configuration without reading auth.json or printing env values", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mcpServers: { local: { command: "node", env: { LOCAL_TOKEN: "settings-secret" } } },
			}),
		);
		writeFileSync(join(agentDir, "auth.json"), "not valid json");

		await expect(handleMcpCliCommand(["mcp", "list"])).resolves.toBe(true);
		await expect(handleMcpCliCommand(["mcp", "get", "local"])).resolves.toBe(true);

		const output = vi
			.mocked(console.log)
			.mock.calls.map(([message]) => String(message))
			.join("\n");
		expect(output).toContain("local");
		expect(output).toContain("<redacted>");
		expect(output).not.toContain("settings-secret");
		expect(process.exitCode).toBeUndefined();
	});

	it("writes a stdio definition that the production runtime starts and calls", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));
		await handleMcpCliCommand(["mcp", "add", "fixture", "--", process.execPath, fixture]);
		const manager = await McpManager.create({
			settingsManager: SettingsManager.create(projectDir, agentDir),
			authStorage: AuthStorage.inMemory(),
			cwd: projectDir,
		});

		try {
			expect(manager.getStatus()[0]).toMatchObject({ state: "connected", toolCount: 3 });
			const result = await manager.callTool("mcp__fixture__echo", { value: "configured-by-cli" });
			expect(result.content).toContainEqual({ type: "text", text: "configured-by-cli" });
		} finally {
			await manager.close();
		}
	});

	it("closes the stored-token HTTP lifecycle without exposing or orphaning the secret", async () => {
		const secret = "stored-secret";
		const server = await createMcpTestServer({ requiredBearerToken: secret });
		const authPath = join(agentDir, "auth.json");
		const authStorage = AuthStorage.create(authPath);
		await handleMcpCliCommand(["mcp", "add", "protected", "--url", String(server.url)]);
		let manager = await McpManager.create({
			settingsManager: SettingsManager.create(projectDir, agentDir),
			authStorage,
			cwd: projectDir,
		});

		try {
			expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });
			expect(JSON.stringify(manager.getStatus())).not.toContain(secret);

			await manager.setSecret("protected", { bearerToken: secret });
			expect(manager.getStatus()[0]).toMatchObject({ state: "connected" });
			const result = await manager.callTool("mcp__protected__search_docs", { query: "closed loop" });
			expect(result.content).toContainEqual({ type: "text", text: "match:closed loop" });
			expect(JSON.stringify({ status: manager.getStatus(), result })).not.toContain(secret);

			await manager.logout("protected");
			expect(manager.getStatus()[0]).toMatchObject({ state: "auth_required" });
			expect(authStorage.has(mcpCredentialKey("protected"))).toBe(false);

			await manager.setSecret("protected", { bearerToken: secret });
			expect(authStorage.has(mcpCredentialKey("protected"))).toBe(true);
			await manager.close();
			await handleMcpCliCommand(["mcp", "remove", "protected"]);

			manager = await McpManager.create({
				settingsManager: SettingsManager.create(projectDir, agentDir),
				authStorage: AuthStorage.create(authPath),
				cwd: projectDir,
			});
			expect(manager.getStatus()).toEqual([]);
			expect(AuthStorage.create(authPath).has(mcpCredentialKey("protected"))).toBe(false);
			expect(readFileSync(join(agentDir, "settings.json"), "utf8")).not.toContain(secret);
		} finally {
			await manager.close();
			await server.close();
		}
	});
});
