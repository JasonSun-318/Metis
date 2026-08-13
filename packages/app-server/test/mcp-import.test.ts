import { describe, expect, it } from "vitest";
import { inspectMcpImport, resolveMcpImport } from "../src/mcp-import.ts";

const cwd = "/tmp/metis-mcp-import";

describe("MCP JSONC import", () => {
	it("accepts comments and trailing commas across STDIO and Streamable HTTP", () => {
		const text = `{
			// supported JSONC
			"mcpServers": {
				"stdio": { "type": "stdio", "command": "node", "args": ["server.js",], },
				/* block comment */
				"web": { "type": "streamable-http", "url": "https://example.test/mcp", },
			},
		}`;
		const result = inspectMcpImport({ scope: "user", cwd, text }, new Map());
		expect(result.candidates.map(({ name, transport }) => [name, transport])).toEqual([
			["stdio", "stdio"],
			["web", "http"],
		]);
	});

	it("preserves a trimmed optional description", () => {
		const result = resolveMcpImport(
			{
				scope: "user",
				cwd,
				text: JSON.stringify({
					docs: { url: "https://example.test/mcp", description: "  Documentation search.  " },
				}),
			},
			[{ id: "docs", expectedRevision: null }],
		);
		expect(result.entries[0]?.server).toMatchObject({ description: "Documentation search." });
		expect(() =>
			inspectMcpImport(
				{
					scope: "user",
					cwd,
					text: JSON.stringify({ docs: { url: "https://example.test/mcp", description: "界".repeat(1366) } }),
				},
				new Map(),
			),
		).toThrow("description is too long");
	});

	it("extracts literals without exposing them in the preview", () => {
		const text = JSON.stringify({
			mcpServers: {
				github: {
					type: "http",
					url: "https://example.test/mcp",
					headers: {
						Authorization: "Bearer literal-token",
						"X-Tenant": "literal-tenant",
						// biome-ignore lint/suspicious/noTemplateCurlyInString: This is an MCP environment reference, not interpolation.
						"X-Reference": "${EXTERNAL_TOKEN}",
					},
				},
			},
		});
		const inspected = inspectMcpImport({ scope: "project", cwd, text }, new Map([["github", "a".repeat(64)]]));
		expect(inspected.candidates[0]).toMatchObject({
			name: "github",
			existingRevision: "a".repeat(64),
			bearerTokenConfigured: true,
		});
		expect(JSON.stringify(inspected)).not.toContain("literal-token");
		expect(JSON.stringify(inspected)).not.toContain("literal-tenant");

		const resolved = resolveMcpImport(
			{ scope: "project", cwd, text },
			[{ id: "github", expectedRevision: "a".repeat(64) }],
			inspected.sourceRevision,
		);
		expect(resolved.entries[0]?.credential).toMatchObject({ bearerToken: "literal-token" });
		expect(Object.values(resolved.entries[0]?.credential?.environment ?? {})).toEqual(["literal-tenant"]);
		expect(resolved.entries[0]?.server).toMatchObject({
			transport: "http",
			envHttpHeaders: { "X-Reference": "EXTERNAL_TOKEN" },
		});
	});

	it("keeps STDIO references public and literal values credential-only", () => {
		const text = JSON.stringify({
			worker: { command: "node", env: { TOKEN: "$TOKEN", TENANT: "private-tenant" } },
		});
		const inspected = inspectMcpImport({ scope: "user", cwd, text }, new Map());
		expect(inspected.candidates[0]).toMatchObject({ credentialNames: ["TENANT"] });
		const resolved = resolveMcpImport({ scope: "user", cwd, text }, [{ id: "worker", expectedRevision: null }]);
		expect(resolved.entries[0]).toMatchObject({
			server: { transport: "stdio", envVars: ["TOKEN"] },
			credential: { environment: { TENANT: "private-tenant" } },
		});
	});

	it.each([
		["SSE", { bad: { type: "sse", url: "https://example.test/sse" } }],
		["both transports", { bad: { command: "node", url: "https://example.test/mcp" } }],
		["neither transport", { bad: {} }],
		["URL credentials", { bad: { url: "https://user:secret@example.test/mcp" } }],
		["non-HTTP URL", { bad: { url: "file:///tmp/mcp.sock" } }],
		["command arrays", { bad: { command: ["node", "server.js"] } }],
		["transport mismatch", { bad: { transport: "stdio", url: "https://example.test/mcp" } }],
	])("rejects %s", (_label, document) => {
		expect(() => inspectMcpImport({ scope: "user", cwd, text: JSON.stringify(document) }, new Map())).toThrow();
	});

	it("rejects duplicate JSON keys before normalization", () => {
		expect(() =>
			inspectMcpImport(
				{ scope: "user", cwd, text: `{"mcpServers":{"docs":{"command":"one"},"docs":{"command":"two"}}}` },
				new Map(),
			),
		).toThrow("duplicate object keys");
		expect(() =>
			inspectMcpImport(
				{ scope: "user", cwd, text: `{"mcpServers":{"docs":{"url":"https://one.test","url":"https://two.test"}}}` },
				new Map(),
			),
		).toThrow("duplicate object keys");
		expect(() =>
			inspectMcpImport(
				{ scope: "user", cwd, text: `{"mcpServers":{"docs":{"command":"node","env":{"__proto__":"secret"}}}}` },
				new Map(),
			),
		).toThrow("unsafe object key");
	});

	it("enforces server and secret count bounds", () => {
		const servers = Object.fromEntries(
			Array.from({ length: 129 }, (_, index) => [`server-${index}`, { command: "node" }]),
		);
		expect(() => inspectMcpImport({ scope: "user", cwd, text: JSON.stringify(servers) }, new Map())).toThrow(
			"1 to 128 servers",
		);
		const env = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`SECRET_${index}`, "value"]));
		expect(() =>
			inspectMcpImport(
				{ scope: "user", cwd, text: JSON.stringify({ worker: { command: "node", env } }) },
				new Map(),
			),
		).toThrow("MCP env");
	});

	it("rejects stale sources, missing selections, duplicates and oversized input", () => {
		const text = JSON.stringify({ one: { command: "node" } });
		const revision = inspectMcpImport({ scope: "user", cwd, text }, new Map()).sourceRevision;
		expect(() =>
			resolveMcpImport({ scope: "user", cwd, text: `${text} ` }, [{ id: "one", expectedRevision: null }], revision),
		).toThrow("source changed");
		expect(() => resolveMcpImport({ scope: "user", cwd, text }, [{ id: "missing", expectedRevision: null }])).toThrow(
			"not found",
		);
		expect(() =>
			resolveMcpImport({ scope: "user", cwd, text }, [
				{ id: "one", expectedRevision: null },
				{ id: "one", expectedRevision: null },
			]),
		).toThrow("duplicated");
		expect(() => inspectMcpImport({ scope: "user", cwd, text: "x".repeat(1024 * 1024 + 1) }, new Map())).toThrow(
			"1 MiB",
		);
	});
});
