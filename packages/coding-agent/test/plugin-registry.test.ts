import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getPluginPackageDir,
	getPluginRegistryPath,
	readPluginRegistry,
	readPluginSnapshot,
	withPluginRegistryLock,
} from "../src/core/plugins/registry.ts";

describe("plugin-registry", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "metis-plugin-registry-test-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("initializes default registry with official market when file does not exist", () => {
		const registry = readPluginRegistry(agentDir);
		expect(registry.schemaVersion).toBe(1);
		expect(registry.revision).toBe(1);
		expect(registry.markets).toHaveLength(1);
		expect(registry.markets[0].url).toBe("https://github.com/anthropics/claude-plugins-official");
		expect(registry.markets[0].selected).toBe(true);
		expect(registry.installed).toEqual([]);
		expect(existsSync(getPluginRegistryPath(agentDir))).toBe(true);
	});

	it("preserves corrupted registry file and throws without overwriting", () => {
		const regPath = getPluginRegistryPath(agentDir);
		mkdirSync(join(agentDir, "plugins"), { recursive: true });
		writeFileSync(regPath, "{ invalid json", "utf8");

		expect(() => readPluginRegistry(agentDir)).toThrow(/corrupted/i);
		expect(readFileSync(regPath, "utf8")).toBe("{ invalid json");
	});

	it("locks and atomically updates registry with revision increment", () => {
		readPluginRegistry(agentDir); // init

		const result = withPluginRegistryLock(agentDir, (current) => {
			const next = {
				...current,
				revision: current.revision + 1,
				markets: [
					...current.markets,
					{
						id: "custom-market",
						url: "https://github.com/custom/market",
						displayName: "Custom Market",
						selected: false,
					},
				],
			};
			return { next, result: "updated" };
		});

		expect(result).toBe("updated");
		const updated = readPluginRegistry(agentDir);
		expect(updated.revision).toBe(2);
		expect(updated.markets).toHaveLength(2);
	});

	it("reads active snapshot only for enabled plugins and resolves absolute paths", () => {
		const pluginId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
		const commit = "1111111111111111111111111111111111111111";
		const packageDir = getPluginPackageDir(agentDir, pluginId, commit);
		mkdirSync(packageDir, { recursive: true });

		// Write normalized.json
		const normalized = {
			pluginId,
			commit,
			format: "claude",
			name: "test-plugin",
			displayName: "Test Plugin",
			description: "A test plugin",
			components: [
				{
					kind: "skill",
					componentId: "skill-helper",
					name: "p-abcdef1234567890-helper",
					originalName: "helper",
					relativeEntryPath: "skills/helper/SKILL.md",
					relativeBaseDir: "skills/helper",
					disableModelInvocation: true,
				},
				{
					kind: "mcp",
					componentId: "mcp-server",
					name: "p-abcdef1234567890-mcp",
					originalName: "server",
					definition: {
						command: "node",
						args: ["./index.js"],
						cwd: "$${CLAUDE_PLUGIN_ROOT}".slice(1),
					},
				},
				{
					kind: "hook",
					componentId: "hook-1",
					name: "p-abcdef1234567890-hook-1",
					definition: {
						id: "hook-1",
						name: "PreToolUse hook",
						enabled: true,
						event: "PreToolUse",
						command: "node ./check.js",
						runMode: "shell",
					},
				},
			],
			issues: [],
		};
		writeFileSync(join(packageDir, "normalized.json"), JSON.stringify(normalized, null, 2), "utf8");

		// Seed registry with enabled plugin
		withPluginRegistryLock(agentDir, (current) => {
			const next = {
				...current,
				revision: current.revision + 1,
				installed: [
					{
						id: pluginId,
						name: "test-plugin",
						displayName: "Test Plugin",
						format: "claude" as const,
						repository: "https://github.com/test/repo",
						subdir: "",
						commit,
						sourceId: "official-market",
						enabled: true,
						installedAt: new Date().toISOString(),
						issues: [],
					},
				],
			};
			return { next, result: undefined };
		});

		const snapshot = readPluginSnapshot(agentDir);
		expect(snapshot.plugins).toHaveLength(1);
		expect(snapshot.skills).toHaveLength(1);
		expect(snapshot.mcp).toHaveLength(1);
		expect(snapshot.hooks).toHaveLength(1);
		expect(snapshot.skills[0].filePath).toBe(join(packageDir, "skills/helper/SKILL.md"));
		expect(snapshot.skills[0].baseDir).toBe(join(packageDir, "skills/helper"));
		expect(snapshot.skills[0].disableModelInvocation).toBe(true);
		expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);

		// Now disable the plugin: snapshot should return 0 components!
		withPluginRegistryLock(agentDir, (current) => {
			const next = {
				...current,
				revision: current.revision + 1,
				installed: current.installed.map((p) => ({ ...p, enabled: false })),
			};
			return { next, result: undefined };
		});

		const disabledSnapshot = readPluginSnapshot(agentDir);
		expect(disabledSnapshot.plugins).toHaveLength(0);
		expect(disabledSnapshot.skills).toHaveLength(0);
		expect(disabledSnapshot.mcp).toHaveLength(0);
		expect(disabledSnapshot.hooks).toHaveLength(0);
		expect(disabledSnapshot.fingerprint).not.toBe(snapshot.fingerprint);
	});
});
