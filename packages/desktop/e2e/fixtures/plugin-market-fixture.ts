import { spawnSync } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import net from "node:net";
import JSZip from "jszip";
import { closeServer, listen } from "../packaged-app-harness.ts";

export const FIXTURE_COMMIT = "c0ffee0000000000000000000000000000000001";
export const FIXTURE_MARKET_REPO = "fixture/plugins-market";
export const FIXTURE_MARKET_URL = `https://github.com/${FIXTURE_MARKET_REPO}`;

export interface PluginFixtureServer {
	readonly proxyUrl: string;
	readonly close: () => Promise<void>;
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

	// 2. Build Fixture Repository Zip Archive
	const zip = new JSZip();
	const root = "plugins-market-fixture";

	// Marketplace index
	const marketManifest = {
		name: "Fixture Market",
		description: "Deterministic fixture plugins marketplace",
		plugins: [
			{
				name: "fixture-suite",
				description: "Full suite plugin with skill, mcp and hook",
				source: "./plugins/fixture-suite",
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
		],
	};
	zip.file(`${root}/.claude-plugins/marketplace.json`, JSON.stringify(marketManifest, null, 2));
	zip.file(`${root}/.claude-plugin/marketplace.json`, JSON.stringify(marketManifest, null, 2));

	// Fixture Suite Plugin
	const suiteManifest = {
		name: "fixture-suite",
		displayName: "Fixture Suite Plugin",
		description: "Full suite plugin with skill, mcp and hook",
		version: "1.0.0",
		skills: "./skills",
		mcpServers: "./mcp.json",
		hooks: "./hooks.json",
	};
	zip.file(`${root}/plugins/fixture-suite/.claude-plugin/plugin.json`, JSON.stringify(suiteManifest, null, 2));

	// Skill
	const skillMd = `---
name: fixture-suite-skill
description: Fixture suite skill instructions
---
# Fixture Suite Skill Instructions
When asked about fixture suite, use the suite echo tool.
`;
	zip.file(`${root}/plugins/fixture-suite/skills/fixture-suite-skill/SKILL.md`, skillMd);

	// MCP Server JSON
	const mcpJson = {
		"suite-echo-server": {
			command: "node",
			args: ["${CLAUDE_PLUGIN_ROOT}/mcp-server.cjs"],
		},
	};
	zip.file(`${root}/plugins/fixture-suite/mcp.json`, JSON.stringify(mcpJson, null, 2));

	// MCP Server JS
	const mcpServerJs = `
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
        serverInfo: { name: "suite-echo-server", version: "1.0.0" }
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
          text: "FIXTURE_MCP_ECHO_RESULT:" + message
        }]
      }
    }) + "\\n");
  }
});
`;
	zip.file(`${root}/plugins/fixture-suite/mcp-server.cjs`, mcpServerJs);

	// Hooks JSON
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

	// Hook JS
	const hookJs = `
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const result = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "FIXTURE_SUITE_HOOK_ACTIVE_CONTEXT"
    }
  };
  process.stdout.write(JSON.stringify(result));
});
`;
	zip.file(`${root}/plugins/fixture-suite/hook.cjs`, hookJs);

	// Fixture Partial Plugin
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
	zip.file(`${root}/plugins/fixture-partial/mcp-server.cjs`, mcpServerJs);

	// Fixture Unsupported Plugin
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

	const repoZipBuffer = await zip.generateAsync({ type: "nodebuffer" });

	// 3. Create HTTPS GitHub Fixture Server
	const httpsServer = createHttpsServer({ key, cert }, async (req: IncomingMessage, res: ServerResponse) => {
		const host = req.headers.host ?? "";
		const url = req.url ?? "";

		// Codeload zip downloads
		if (host.includes("codeload.github.com") || url.includes("/zip/")) {
			res.writeHead(200, {
				"content-type": "application/zip",
				"content-length": String(repoZipBuffer.length),
			});
			res.end(repoZipBuffer);
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
			res.end(JSON.stringify({ sha: FIXTURE_COMMIT }));
			return;
		}

		// API routes: raw content inspection for marketplace.json
		if (url.includes("marketplace.json")) {
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

	// 4. Create HTTP Forward Proxy
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
		},
	};
}
