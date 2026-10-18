import { spawnSync } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import JSZip from "jszip";
import { createMcpTestServer, type McpTestServer } from "../../../coding-agent/test/helpers/mcp-test-server.ts"; // boundary-allow: reuse the MCP test server in plugin market integration fixtures
import { closeServer, listen } from "../packaged-app-harness.ts";

export const FIXTURE_COMMIT_A = "c0ffee0000000000000000000000000000000001";
export const FIXTURE_COMMIT_B = "c0ffee0000000000000000000000000000000002";
export const FIXTURE_COMMIT = FIXTURE_COMMIT_A;
export const FIXTURE_MARKET_REPO = "fixture/plugins-market";
export const FIXTURE_MARKET_URL = `https://github.com/${FIXTURE_MARKET_REPO}`;

export interface PluginFixtureServer {
	readonly proxyUrl: string;
	readonly close: () => Promise<void>;
	readonly setCommit: (commit: string) => void;
	readonly setFailDownload: (fail: boolean) => void;
	readonly setRateLimited: (limited: boolean) => void;
	readonly mcpTestServer: McpTestServer;
}

function buildSuiteMcpServerJs(version: "A" | "B"): string {
	return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "suite-echo-server", version: "${version === "A" ? "1.0.0" : "2.0.0"}" }
      }
    }) + "\\n");
  } else if (msg.method === "notifications/initialized") {
    // ack
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{
          name: "fixture_suite_echo",
          description: "Echo from fixture suite MCP",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"]
          }
        }]
      }
    }) + "\\n");
  } else if (msg.method === "tools/call") {
    const message = msg.params?.arguments?.message ?? "";
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{
          type: "text",
          text: "FIXTURE_MCP_ECHO_RESULT:${version === "A" ? "v1" : "v2"}:" + message
        }]
      }
    }) + "\\n");
  }
});
`;
}

function buildSuiteHookJs(version: "A" | "B"): string {
	return `
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const result = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "${version === "A" ? "FIXTURE_SUITE_HOOK_ACTIVE_CONTEXT_V1" : "FIXTURE_SUITE_HOOK_ACTIVE_CONTEXT_V2"}"
    }
  };
  process.stdout.write(JSON.stringify(result));
});
`;
}

async function buildRepositoryZip(version: "A" | "B", httpMcpUrl: string): Promise<Buffer> {
	const zip = new JSZip();
	const root = "plugins-market-fixture";

	const marketManifest = {
		name: "Fixture Market",
		description: "Deterministic fixture plugins marketplace",
		plugins: [
			{
				name: "fixture-suite",
				description: "Full suite plugin with skill, mcp and hook",
				source: "./plugins/fixture-suite",
				strict: false,
			},
			{
				name: "fixture-partial",
				description: "Partial plugin with supported mcp and unsupported app",
				source: "./plugins/fixture-partial",
			},
			{
				name: "fixture-unsupported",
				description: "Plugin with only unsupported apps",
				source: "./plugins/fixture-unsupported",
			},
			{
				name: "fixture-codex",
				description: "Codex format plugin with two skills",
				source: "./plugins/fixture-codex",
			},
			{
				name: "fixture-broken",
				description: "Plugin with malformed manifest",
				source: "./plugins/fixture-broken",
			},
			{
				name: "fixture-subdir",
				description: "Subdirectory plugin with scripts and resources",
				source: "./plugins/fixture-subdir",
			},
			{
				name: "fixture-http-token",
				description: "HTTP MCP plugin requiring bearer token",
				source: "./plugins/fixture-http-token",
			},
		],
	};
	zip.file(`${root}/.claude-plugins/marketplace.json`, JSON.stringify(marketManifest, null, 2));
	zip.file(`${root}/.claude-plugin/marketplace.json`, JSON.stringify(marketManifest, null, 2));

	// 1. Fixture Suite Plugin (A vs B)
	const suiteManifest = {
		name: "fixture-suite",
		displayName: "Fixture Suite Plugin",
		description: "Full suite plugin with skill, mcp and hook",
		version: version === "A" ? "1.0.0" : "2.0.0",
		skills: "./skills",
		mcpServers: "./mcp.json",
		hooks: "./hooks.json",
	};
	zip.file(`${root}/plugins/fixture-suite/.claude-plugin/plugin.json`, JSON.stringify(suiteManifest, null, 2));

	const skillMd = `---
name: fixture-suite-skill
description: Fixture suite skill instructions
---
# Fixture Suite Skill Instructions
${version === "A" ? "FIXTURE_SUITE_SKILL_A_MARKER" : "FIXTURE_SUITE_SKILL_B_MARKER"}
When asked about fixture suite, use the suite echo tool.
`;
	zip.file(`${root}/plugins/fixture-suite/skills/fixture-suite-skill/SKILL.md`, skillMd);

	const mcpJson = {
		"suite-echo-server": {
			command: "node",
			args: ["${CLAUDE_PLUGIN_ROOT}/mcp-server.cjs"],
		},
	};
	zip.file(`${root}/plugins/fixture-suite/mcp.json`, JSON.stringify(mcpJson, null, 2));
	zip.file(`${root}/plugins/fixture-suite/mcp-server.cjs`, buildSuiteMcpServerJs(version));

	const hooksJson = {
		hooks: {
			UserPromptSubmit: [
				{
					type: "command",
					command: `node \${CLAUDE_PLUGIN_ROOT}/hook.cjs`,
				},
			],
		},
	};
	zip.file(`${root}/plugins/fixture-suite/hooks.json`, JSON.stringify(hooksJson, null, 2));
	zip.file(`${root}/plugins/fixture-suite/hook.cjs`, buildSuiteHookJs(version));

	// 2. Fixture Partial Plugin
	const partialManifest = {
		name: "fixture-partial",
		displayName: "Fixture Partial Plugin",
		description: "Partial plugin with supported MCP and unsupported component",
		version: "1.0.0",
		mcpServers: "./mcp.json",
	};
	zip.file(`${root}/plugins/fixture-partial/.claude-plugin/plugin.json`, JSON.stringify(partialManifest, null, 2));
	zip.file(
		`${root}/plugins/fixture-partial/mcp.json`,
		JSON.stringify(
			{
				"partial-echo-server": {
					command: "node",
					args: ["${CLAUDE_PLUGIN_ROOT}/mcp-server.cjs"],
				},
				"partial-unsupported-server": {
					type: "sse",
					url: "https://example.com/sse",
				},
			},
			null,
			2,
		),
	);
	zip.file(`${root}/plugins/fixture-partial/mcp-server.cjs`, buildSuiteMcpServerJs("A"));

	// 3. Fixture Unsupported Plugin
	const unsupportedManifest = {
		name: "fixture-unsupported",
		displayName: "Fixture Unsupported Plugin",
		description: "Plugin with only unsupported components",
		version: "1.0.0",
		mcpServers: "./mcp.json",
	};
	zip.file(
		`${root}/plugins/fixture-unsupported/.claude-plugin/plugin.json`,
		JSON.stringify(unsupportedManifest, null, 2),
	);
	zip.file(
		`${root}/plugins/fixture-unsupported/mcp.json`,
		JSON.stringify(
			{
				"unsupported-sse-server": {
					type: "sse",
					url: "https://example.com/sse",
				},
			},
			null,
			2,
		),
	);

	// 4. Fixture Codex Plugin (2 skills)
	const codexManifest = {
		name: "fixture-codex",
		displayName: "Fixture Codex Plugin",
		description: "Codex format plugin with two skills",
		version: "1.0.0",
		skills: "./skills",
	};
	zip.file(`${root}/plugins/fixture-codex/.codex-plugin/plugin.json`, JSON.stringify(codexManifest, null, 2));
	zip.file(
		`${root}/plugins/fixture-codex/skills/codex-skill-one/SKILL.md`,
		`---\nname: codex-skill-one\ndescription: First codex skill\n---\n# Codex Skill One\nInstructions for codex skill one.\n`,
	);
	zip.file(
		`${root}/plugins/fixture-codex/skills/codex-skill-two/SKILL.md`,
		`---\nname: codex-skill-two\ndescription: Second codex skill\n---\n# Codex Skill Two\nInstructions for codex skill two.\n`,
	);

	// 5. Fixture Broken Manifest Plugin
	zip.file(
		`${root}/plugins/fixture-broken/.claude-plugin/plugin.json`,
		`{\n  "name": "fixture-broken",\n  invalid_json:\n`,
	);

	zip.file(
		`${root}/plugins/fixture-broken/skills/valid/SKILL.md`,
		"---\nname: valid\ndescription: valid skill with a broken plugin manifest\n---\nHelp",
	);

	// 6. Fixture Subdirectory Plugin (with scripts & resources)
	const subdirManifest = {
		name: "fixture-subdir",
		displayName: "Fixture Subdir Plugin",
		description: "Subdirectory plugin with scripts and resources",
		version: "1.0.0",
		skills: "./skills",
	};
	zip.file(`${root}/plugins/fixture-subdir/.claude-plugin/plugin.json`, JSON.stringify(subdirManifest, null, 2));
	zip.file(
		`${root}/plugins/fixture-subdir/skills/subdir-skill/SKILL.md`,
		`---\nname: subdir-skill\ndescription: Subdir skill\n---\n# Subdir Skill\nSubdir instructions.\n`,
	);
	zip.file(`${root}/plugins/fixture-subdir/scripts/helper.sh`, `#!/bin/sh\necho subdir-helper-ok\n`, {
		unixPermissions: 0o755,
	});
	zip.file(`${root}/plugins/fixture-subdir/resources/data.txt`, "subdir-resource-data\n");

	// 7. Fixture HTTP Token Plugin
	const httpTokenManifest = {
		name: "fixture-http-token",
		displayName: "Fixture HTTP Token Plugin",
		description: "HTTP MCP plugin requiring bearer token",
		version: "1.0.0",
		mcpServers: "./mcp.json",
	};
	zip.file(
		`${root}/plugins/fixture-http-token/.claude-plugin/plugin.json`,
		JSON.stringify(httpTokenManifest, null, 2),
	);
	zip.file(
		`${root}/plugins/fixture-http-token/mcp.json`,
		JSON.stringify(
			{
				"fixture-http-server": {
					type: "http",
					url: httpMcpUrl,
				},
			},
			null,
			2,
		),
	);

	return zip.generateAsync({ type: "nodebuffer" });
}

export async function createPluginFixtureServer(): Promise<PluginFixtureServer> {
	// 1. Generate multi-domain self-signed TLS cert
	const key = spawnSync("openssl", ["genrsa", "2048"], { encoding: "buffer" }).stdout;
	const cert = spawnSync(
		"openssl",
		[
			"req",
			"-new",
			"-x509",
			"-key",
			"/dev/stdin",
			"-subj",
			"/CN=github.com",
			"-addext",
			"subjectAltName = DNS:api.github.com, DNS:codeload.github.com, DNS:raw.githubusercontent.com, DNS:github.com",
			"-days",
			"1",
		],
		{ input: key, encoding: "buffer" },
	).stdout;

	// 2. Start HTTP MCP Test Server with required Bearer token
	const mcpTestServer = await createMcpTestServer({
		requiredBearerToken: "fixture-bearer-secret",
		tools: [
			{
				name: "fixture_http_tool",
				title: "Fixture HTTP Tool",
				description: "Echo from fixture HTTP MCP",
				inputSchema: {
					type: "object",
					properties: { message: { type: "string" } },
					required: ["message"],
				},
			},
		],
	});

	// 3. Build Fixture Repository Zip Archives for Commit A and B
	const zipA = await buildRepositoryZip("A", mcpTestServer.url.toString());
	const zipB = await buildRepositoryZip("B", mcpTestServer.url.toString());

	let currentCommit = FIXTURE_COMMIT_A;
	let shouldFailDownload = false;
	let rateLimited = false;

	// 4. Create HTTPS GitHub Fixture Server
	const httpsServer = createHttpsServer({ key, cert }, async (req: IncomingMessage, res: ServerResponse) => {
		const host = req.headers.host ?? "";
		const url = req.url ?? "";

		if (rateLimited) {
			res.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0" });
			res.end(JSON.stringify({ message: "API rate limit exceeded" }));
			return;
		}

		// Codeload zip downloads
		if (host.includes("codeload.github.com") || url.includes("/zip/")) {
			if (shouldFailDownload) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end("Simulated download failure");
				return;
			}
			const currentZip = url.endsWith(FIXTURE_COMMIT_B) ? zipB : zipA;
			res.writeHead(200, {
				"content-type": "application/zip",
				"content-length": String(currentZip.length),
			});
			res.end(currentZip);
			return;
		}

		// API routes: repository inspection
		if (url.endsWith("/repos/fixture/plugins-market") || url.endsWith("/repos/anthropics/claude-plugins-official")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ default_branch: "main" }));
			return;
		}

		// API routes: commits
		if (url.includes("/commits/")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ sha: currentCommit }));
			return;
		}

		// API routes: raw content inspection for marketplace.json
		if (url.includes("marketplace.json")) {
			const marketManifest = {
				name: "Fixture Market",
				description: "Deterministic fixture plugins marketplace",
				plugins: [
					{
						name: "fixture-suite",
						description: "Full suite plugin with skill, mcp and hook",
						source: "./plugins/fixture-suite",
						strict: false,
					},
					{
						name: "fixture-partial",
						description: "Partial plugin with supported mcp and unsupported app",
						source: "./plugins/fixture-partial",
					},
					{
						name: "fixture-unsupported",
						description: "Plugin with only unsupported apps",
						source: "./plugins/fixture-unsupported",
					},
					{
						name: "fixture-codex",
						description: "Codex format plugin with two skills",
						source: "./plugins/fixture-codex",
					},
					{
						name: "fixture-broken",
						description: "Plugin with malformed manifest",
						source: "./plugins/fixture-broken",
					},
					{
						name: "fixture-subdir",
						description: "Subdirectory plugin with scripts and resources",
						source: "./plugins/fixture-subdir",
					},
					{
						name: "fixture-http-token",
						description: "HTTP MCP plugin requiring bearer token",
						source: "./plugins/fixture-http-token",
					},
				],
			};
			const jsonBytes = Buffer.from(JSON.stringify(marketManifest, null, 2), "utf8");
			res.writeHead(200, {
				"content-type": "application/vnd.github.raw+json",
				"content-length": String(jsonBytes.length),
			});
			res.end(jsonBytes);
			return;
		}

		// Default fallback for other probe paths
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ message: "Not Found" }));
	});

	const httpsPort = await listen(httpsServer);

	// 5. Create HTTP Forward Proxy
	const proxyServer = createHttpServer((_req, res) => {
		res.writeHead(400).end("Use CONNECT");
	});

	proxyServer.on("connect", (_req, clientSocket, head) => {
		const targetSocket = net.connect(httpsPort, "127.0.0.1", () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			targetSocket.write(head);
			targetSocket.pipe(clientSocket);
			clientSocket.pipe(targetSocket);
		});
		targetSocket.on("error", () => clientSocket.destroy());
		clientSocket.on("error", () => targetSocket.destroy());
	});

	const proxyPort = await listen(proxyServer);
	const proxyUrl = `http://127.0.0.1:${proxyPort}`;

	return {
		proxyUrl,
		close: async () => {
			await closeServer(proxyServer);
			await closeServer(httpsServer);
			await mcpTestServer.close();
		},
		setCommit: (commit: string) => {
			currentCommit = commit;
		},
		setRateLimited: (limited: boolean) => { rateLimited = limited; },
		setFailDownload: (fail: boolean) => {
			shouldFailDownload = fail;
		},
		mcpTestServer,
	};
}
