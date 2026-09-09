import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "../src/plugin-manifests.ts";

function loadFixtureFiles(dirPath: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	function scan(current: string) {
		const entries = readdirSync(current);
		for (const entry of entries) {
			const full = join(current, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				scan(full);
			} else if (stat.isFile()) {
				const rel = relative(dirPath, full).replace(/\\/g, "/");
				files.set(rel, readFileSync(full));
			}
		}
	}
	scan(dirPath);
	return files;
}

const FIXTURES_ROOT = join(__dirname, "fixtures/plugins");

describe("parsePluginManifest", () => {
	it("parses standard Claude plugin with 1 skill, 1 mcp, 1 hook", () => {
		const files = loadFixtureFiles(join(FIXTURES_ROOT, "claude-standard"));
		const parsed = parsePluginManifest({ files });

		expect(parsed.format).toBe("claude");
		expect(parsed.name).toBe("claude-fixture-plugin");
		expect(parsed.components.map((c) => c.kind)).toEqual(["skill", "mcp", "hook"]);
		expect(parsed.components.filter((c) => c.kind === "hook")).toHaveLength(1);
		expect(parsed.issues).toEqual([]);

		const skill = parsed.components.find((c) => c.kind === "skill");
		expect(skill?.name).toBe("helper");
		expect(skill?.description).toBe("A helpful skill");

		const mcp = parsed.components.find((c) => c.kind === "mcp");
		expect(mcp?.name).toBe("fixture-mcp");
		if (mcp?.kind === "mcp") {
			const def = mcp.definition;
			if (typeof def.command === "string") {
				expect(def.command).toBe("node");
				expect((def as { cwd?: string }).cwd).toBe(`$${"{CLAUDE_PLUGIN_ROOT}"}`);
			}
		}

		const hook = parsed.components.find((c) => c.kind === "hook");
		expect(hook?.kind).toBe("hook");
		if (hook?.kind === "hook") {
			expect(hook.event).toBe("PreToolUse");
			expect(hook.definition.matcher).toBe("bash");
			expect(hook.definition.command).toBe("node ./scripts/check.js");
		}
	});

	it("parses Codex plugin with custom paths for skills, mcp, and hooks", () => {
		const files = loadFixtureFiles(join(FIXTURES_ROOT, "codex-custom-paths"));
		const parsed = parsePluginManifest({ files });

		expect(parsed.format).toBe("codex");
		expect(parsed.name).toBe("codex-fixture-plugin");
		expect(parsed.displayName).toBe("Codex Fixture Plugin");
		expect(parsed.components.map((c) => c.kind)).toEqual(["skill", "mcp", "hook"]);
		expect(parsed.components.filter((c) => c.kind === "hook")).toHaveLength(1);
		expect(parsed.issues).toEqual([]);

		const skill = parsed.components.find((c) => c.kind === "skill");
		expect(skill?.name).toBe("analyzer");
		expect(skill?.disableModelInvocation).toBe(true);

		const mcp = parsed.components.find((c) => c.kind === "mcp");
		expect(mcp?.name).toBe("codex-mcp");

		const hook = parsed.components.find((c) => c.kind === "hook");
		expect(hook?.kind).toBe("hook");
		if (hook?.kind === "hook") {
			expect(hook.event).toBe("PreToolUse");
			expect(hook.definition.command).toBe("python ./scripts/validate.py");
		}
	});

	it("parses generic Agent Skills collection without manifest", () => {
		const files = loadFixtureFiles(join(FIXTURES_ROOT, "agent-skills-no-manifest"));
		const parsed = parsePluginManifest({ files });

		expect(parsed.format).toBe("agent-skills");
		expect(parsed.components).toHaveLength(2);
		expect(parsed.components.every((c) => c.kind === "skill")).toBe(true);
		expect(parsed.components.map((c) => c.name).sort()).toEqual(["skill-one", "skill-two"]);
		expect(parsed.issues).toEqual([]);
	});

	it("handles dual manifests at same root by picking Claude and reporting conflict warning", () => {
		const files = loadFixtureFiles(join(FIXTURES_ROOT, "dual-manifest-same-root"));
		const parsed = parsePluginManifest({ files });

		expect(parsed.format).toBe("claude");
		expect(parsed.name).toBe("claude-manifest-name");
		expect(parsed.issues).toEqual([
			expect.objectContaining({
				code: "DUAL_MANIFEST_CONFLICT",
				status: "warning",
			}),
		]);
		// Should not duplicate components
		expect(parsed.components).toHaveLength(1);
		expect(parsed.components[0].name).toBe("shared-skill");
	});

	it("parses skill-bundle with strict:false and explicit skills list, ignoring undeclared skills", () => {
		const files = loadFixtureFiles(join(FIXTURES_ROOT, "claude-skill-bundle-strict-false"));
		const parsed = parsePluginManifest({
			files,
			marketEntry: {
				name: "my-skill-bundle",
				strict: false,
				skills: ["skills/declared-skill"],
			},
		});

		expect(parsed.format).toBe("claude");
		expect(parsed.components).toHaveLength(1);
		expect(parsed.components[0].name).toBe("declared-skill");
		expect(parsed.issues).toEqual([]);
	});

	it("reports unsupported hook event as issue and unsupported component", () => {
		const files = loadFixtureFiles(join(FIXTURES_ROOT, "unknown-hook-event"));
		const parsed = parsePluginManifest({ files });

		expect(parsed.components.map((c) => c.kind)).toEqual(["unsupported"]);
		expect(parsed.issues).toEqual([
			expect.objectContaining({
				code: "UNSUPPORTED_HOOK_EVENT",
				status: "unsupported",
			}),
		]);
	});

	it("reports Codex apps-only plugin as unsupported, without masquerading as MCP", () => {
		const files = loadFixtureFiles(join(FIXTURES_ROOT, "codex-apps-only"));
		const parsed = parsePluginManifest({ files });

		expect(parsed.components.map((c) => c.kind)).toEqual(["unsupported"]);
		expect(parsed.components[0].id).toBe("app-connector-1");
		expect(parsed.issues).toEqual([
			expect.objectContaining({
				code: "UNSUPPORTED_APP_CONNECTOR",
				status: "unsupported",
			}),
		]);
	});

	it("flags unknown variables in MCP as needs-configuration", () => {
		const files = new Map<string, Buffer>([
			[".claude-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "var-plugin" }))],
			[
				".mcp.json",
				Buffer.from(
					JSON.stringify({
						mcpServers: {
							"custom-server": {
								command: "node",
								args: [`$${"{CUSTOM_VAR}"}/server.js`],
							},
						},
					}),
				),
			],
		]);

		const parsed = parsePluginManifest({ files });
		expect(parsed.issues).toEqual([
			expect.objectContaining({
				code: "UNKNOWN_VARIABLE",
				status: "needs-configuration",
			}),
		]);
	});
});
