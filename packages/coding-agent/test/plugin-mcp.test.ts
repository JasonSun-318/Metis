import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { McpServerClient } from "../src/core/mcp/client.ts";
import { resolveMcpServerSettings } from "../src/core/mcp/config.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createMcpTestServer, type McpTestServer } from "./helpers/mcp-test-server.ts";

const tempDirs: string[] = [];
const managers: McpManager[] = [];
const httpServers: McpTestServer[] = [];

function createTempDir(prefix = "metis-plugin-mcp-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const manager of managers) {
		await manager.close();
	}
	managers.length = 0;
	for (const server of httpServers) {
		await server.close();
	}
	httpServers.length = 0;
	for (const dir of tempDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
	tempDirs.length = 0;
});

const ECHO_SERVER_CODE = `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    const res = {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-server", version: "1.0.0" }
      }
    };
    process.stdout.write(JSON.stringify(res) + "\\n");
  } else if (msg.method === "notifications/initialized") {
    // notification, no response
  } else if (msg.method === "tools/list") {
    const res = {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{
          name: "echo_plugin",
          description: "Echo plugin tool",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"]
          }
        }]
      }
    };
    process.stdout.write(JSON.stringify(res) + "\\n");
  } else if (msg.method === "tools/call") {
    const text = msg.params?.arguments?.text ?? "";
    const res = {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{
          type: "text",
          text: \`echo:\${text}:\${process.env.CLAUDE_PLUGIN_ROOT ?? ""}:\${process.env.TEST_CWD ?? ""}\`
        }]
      }
    };
    process.stdout.write(JSON.stringify(res) + "\\n");
  }
});
`;

function setupPluginDir(
	agentDir: string,
	options: {
		pluginId: string;
		commit: string;
		enabled?: boolean;
		components: unknown[];
	},
): string {
	const enabled = options.enabled ?? true;
	const packageDir = join(agentDir, "plugins", "packages", options.pluginId, options.commit);
	mkdirSync(packageDir, { recursive: true });

	const normalized = {
		pluginId: options.pluginId,
		commit: options.commit,
		format: "claude",
		name: "test-plugin",
		displayName: "Test Plugin",
		description: "A test plugin",
		components: options.components,
		issues: [],
	};
	writeFileSync(join(packageDir, "normalized.json"), JSON.stringify(normalized, null, 2));

	const registry = {
		schemaVersion: 1,
		revision: 1,
		markets: [],
		installed: [
			{
				id: options.pluginId,
				name: "test-plugin",
				displayName: "Test Plugin",
				format: "claude",
				repository: "https://github.com/example/test-plugin",
				subdir: "",
				commit: options.commit,
				sourceId: "source-1",
				enabled,
				installedAt: new Date().toISOString(),
				issues: [],
			},
		],
	};
	writeFileSync(join(agentDir, "plugins", "registry.json"), JSON.stringify(registry, null, 2));
	return packageDir;
}

describe("Plugin MCP servers", () => {
	it("starts stdio MCP server fixture, resolves variables, injects env, and executes echo_plugin tool", async () => {
		const agentDir = createTempDir("agent-");
		const cwd = createTempDir("workspace-");

		const packageDir = setupPluginDir(agentDir, {
			pluginId: "plugin-echo-id",
			commit: "c1",
			components: [
				{
					kind: "mcp",
					componentId: "echo_server",
					name: "p-echo-echo_server",
					originalName: "echo_server",
					definition: {
						command: process.execPath,
						// biome-ignore lint/suspicious/noTemplateCurlyInString: template variable syntax in fixture
						args: ["${CLAUDE_PLUGIN_ROOT}/echo-server.mjs"],
						// biome-ignore lint/suspicious/noTemplateCurlyInString: template variable syntax in fixture
						cwd: "${CLAUDE_PLUGIN_ROOT}",
						env: {
							// biome-ignore lint/suspicious/noTemplateCurlyInString: template variable syntax in fixture
							TEST_CWD: "${cwd}",
						},
					},
				},
			],
		});

		writeFileSync(join(packageDir, "echo-server.mjs"), ECHO_SERVER_CODE);

		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory(),
			authStorage: AuthStorage.inMemory(),
			cwd,
			agentDir,
		});
		managers.push(manager);

		const statuses = manager.getStatus();
		const pluginStatus = statuses.find((s) => s.name === "p-echo-echo_server");
		expect(pluginStatus).toBeDefined();
		expect(pluginStatus).toMatchObject({
			name: "p-echo-echo_server",
			originalName: "echo_server",
			transport: "stdio",
			state: "connected",
			toolCount: 1,
			pluginOwner: {
				pluginId: "plugin-echo-id",
				displayName: "Test Plugin",
				componentId: "echo_server",
			},
		});

		const tools = manager.getToolRecords();
		expect(tools).toHaveLength(1);
		expect(tools[0].tool.name).toBe("echo_plugin");

		const result = await manager.callTool(tools[0].modelName, { text: "hello" });
		expect(result).toMatchObject({
			content: [
				{
					type: "text",
					text: `echo:hello:${packageDir}:${cwd}`,
				},
			],
		});
	});

	it("manual server with same originalName shadows the plugin MCP server", async () => {
		const agentDir = createTempDir("agent-");
		const cwd = createTempDir("workspace-");

		const packageDir = setupPluginDir(agentDir, {
			pluginId: "plugin-shadow-id",
			commit: "c1",
			components: [
				{
					kind: "mcp",
					componentId: "echo_server",
					name: "p-shadow-echo_server",
					originalName: "echo_server",
					definition: {
						command: process.execPath,
						// biome-ignore lint/suspicious/noTemplateCurlyInString: template variable syntax in fixture
						args: ["${CLAUDE_PLUGIN_ROOT}/echo-server.mjs"],
					},
				},
			],
		});
		writeFileSync(join(packageDir, "echo-server.mjs"), ECHO_SERVER_CODE);

		const testServer = await createMcpTestServer();
		httpServers.push(testServer);

		// Manual server in settings has name 'echo_server'
		const settingsManager = SettingsManager.inMemory({
			mcpServers: {
				echo_server: {
					url: testServer.url.href,
				},
			},
		});

		const manager = await McpManager.create({
			settingsManager,
			authStorage: AuthStorage.inMemory(),
			cwd,
			agentDir,
		});
		managers.push(manager);

		const statuses = manager.getStatus();
		// Plugin server must NOT be mounted
		expect(statuses.find((s) => s.name === "p-shadow-echo_server")).toBeUndefined();
		// Manual server is mounted
		const manualStatus = statuses.find((s) => s.name === "echo_server");
		expect(manualStatus).toBeDefined();
		expect(manualStatus?.pluginOwner).toBeUndefined();
	});

	it("HTTP MCP server with missing bearerTokenEnvVar sets auth_required and does not connect", async () => {
		const agentDir = createTempDir("agent-");
		const cwd = createTempDir("workspace-");

		const testServer = await createMcpTestServer();
		httpServers.push(testServer);

		setupPluginDir(agentDir, {
			pluginId: "plugin-http-id",
			commit: "c1",
			components: [
				{
					kind: "mcp",
					componentId: "remote_api",
					name: "p-http-remote_api",
					originalName: "remote_api",
					definition: {
						url: testServer.url.href,
						bearerTokenEnvVar: "NON_EXISTENT_PLUGIN_AUTH_VAR_12345",
					},
				},
			],
		});

		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory(),
			authStorage: AuthStorage.inMemory(),
			cwd,
			agentDir,
		});
		managers.push(manager);

		const status = manager.getStatus().find((s) => s.name === "p-http-remote_api");
		expect(status).toBeDefined();
		expect(status?.state).toBe("auth_required");
		expect(testServer.toolCallCount()).toBe(0);
	});

	it("disabling plugin shuts down and unmounts the MCP server on ensureCurrent", async () => {
		const agentDir = createTempDir("agent-");
		const cwd = createTempDir("workspace-");

		const packageDir = setupPluginDir(agentDir, {
			pluginId: "plugin-disable-id",
			commit: "c1",
			enabled: true,
			components: [
				{
					kind: "mcp",
					componentId: "echo_server",
					name: "p-disable-echo_server",
					originalName: "echo_server",
					definition: {
						command: process.execPath,
						// biome-ignore lint/suspicious/noTemplateCurlyInString: template variable syntax in fixture
						args: ["${CLAUDE_PLUGIN_ROOT}/echo-server.mjs"],
					},
				},
			],
		});
		writeFileSync(join(packageDir, "echo-server.mjs"), ECHO_SERVER_CODE);

		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory(),
			authStorage: AuthStorage.inMemory(),
			cwd,
			agentDir,
		});
		managers.push(manager);

		expect(manager.getStatus().find((s) => s.name === "p-disable-echo_server")).toBeDefined();

		// Disable plugin in registry
		const registryPath = join(agentDir, "plugins", "registry.json");
		const registry = JSON.parse(readFileSync(registryPath, "utf8"));
		registry.installed[0].enabled = false;
		registry.revision += 1;
		writeFileSync(registryPath, JSON.stringify(registry, null, 2));

		await manager.ensureCurrent();

		expect(manager.getStatus().find((s) => s.name === "p-disable-echo_server")).toBeUndefined();
	});

	it("redacts environment-backed HTTP header values and bearer token from errors", () => {
		const client = new McpServerClient(
			resolveMcpServerSettings(
				"plugin_http",
				{
					url: "https://mcp.example.test/mcp",
					envHttpHeaders: { "X-Secret": "SECRET_HEADER" },
					bearerTokenEnvVar: "SECRET_TOKEN",
				},
				process.cwd(),
				{ SECRET_HEADER: "super-secret-header-123", SECRET_TOKEN: "super-secret-token-456" },
			),
			AuthStorage.inMemory(),
		);
		const safeErrorMessage = (
			client as unknown as { safeErrorMessage: (error: unknown) => string }
		).safeErrorMessage.bind(client);
		const redacted = safeErrorMessage(
			new Error("Failed with token super-secret-token-456 and header super-secret-header-123"),
		);
		expect(redacted).not.toContain("super-secret-token-456");
		expect(redacted).not.toContain("super-secret-header-123");
		expect(redacted).toContain("[REDACTED]");
	});
});
