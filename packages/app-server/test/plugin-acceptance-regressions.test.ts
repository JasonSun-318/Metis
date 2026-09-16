import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	readPluginSnapshot,
	resolveMcpServerDefinitions,
	resolveMcpServerSettings,
	withPluginRegistryLock,
} from "@metis/coding-agent/host";
import { afterEach, describe, expect, it } from "vitest";
import { parsePluginManifest } from "../src/plugin-manifests.ts";
import { fetchPluginFiles, inspectRepositorySource } from "../src/plugin-sources.ts";
import { PluginService } from "../src/plugins.ts";
import { A, B, dirs, harness, installedHarness, skill } from "./helpers/plugin-acceptance-fixture.ts";

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Plugin acceptance regressions", () => {
	it("R1 single plugin repository root ./ must resolve files", async () => {
		const h = harness({ single: true });
		const source = await inspectRepositorySource(h.url, h.fetchImpl);
		const resolved = await fetchPluginFiles(source, source.catalog[0], h.fetchImpl);
		expect(resolved.files.has(".claude-plugin/plugin.json")).toBe(true);
	});

	it("R2 keeps marketplace root through inspection", async () => {
		const h = harness({ nested: true });
		const service = new PluginService(h.agentDir, h.fetchImpl);
		const market = await service.addMarket({ requestId: randomUUID(), url: h.url, expectedRevision: 1 });
		const detail = await service.inspectPlugin(market.selectedSourceId, "entry-fixture-plugin");
		expect(detail.components.some((c) => c.kind === "skill")).toBe(true);
	});

	it("R3 update installs the advertised commit and exposes inspection", async () => {
		const h = await installedHarness();
		h.advance();
		const inspected = await h.service.inspectUpdate(h.installed.plugin.plugin.id);
		expect(inspected.newCommit).toBe(B);
		expect(inspected.inspection?.sourceCommit).toBe(B);
		const result = await h.service.update({
			requestId: randomUUID(),
			pluginId: h.installed.plugin.plugin.id,
			inspectionId: inspected.inspection!.inspectionId,
			expectedCommit: A,
			expectedRevision: h.installed.registryRevision,
		});
		expect(result.plugin.plugin.commit).toBe(B);
	});

	it("R3 rejects update when inspectionId or expectedCommit does not match", async () => {
		const h = await installedHarness();
		h.advance();
		const inspected = await h.service.inspectUpdate(h.installed.plugin.plugin.id);

		// Invalid inspection ID
		await expect(
			h.service.update({
				requestId: randomUUID(),
				pluginId: h.installed.plugin.plugin.id,
				inspectionId: randomUUID(),
				expectedCommit: A,
				expectedRevision: h.installed.registryRevision,
			}),
		).rejects.toThrow();

		// Mismatched expectedCommit (already at B or wrong commit)
		await expect(
			h.service.update({
				requestId: randomUUID(),
				pluginId: h.installed.plugin.plugin.id,
				inspectionId: inspected.inspection!.inspectionId,
				expectedCommit: B,
				expectedRevision: h.installed.registryRevision,
			}),
		).rejects.toThrow();
	});

	it("R3 checks update even after marketplace is removed", async () => {
		const h = await installedHarness();
		await h.service.removeMarket({
			requestId: randomUUID(),
			sourceId: h.market.selectedSourceId,
			expectedRevision: h.installed.registryRevision,
		});
		h.advance();
		const inspected = await h.service.inspectUpdate(h.installed.plugin.plugin.id);
		expect(inspected.newCommit).toBe(B);
		expect(inspected.inspection?.sourceCommit).toBe(B);
	});

	it("R3 pinned sha does not advance when repository branch advances", async () => {
		const h = await installedHarness();
		withPluginRegistryLock(h.agentDir, (cur) => {
			cur.installed[0]!.pinnedCommit = A;
			return { next: cur, result: undefined };
		});
		h.advance();
		const inspected = await h.service.inspectUpdate(h.installed.plugin.plugin.id);
		expect(inspected.upToDate).toBe(true);
		expect(inspected.currentCommit).toBe(A);
	});

	it("R4 preserves executable scripts", async () => {
		const h = await installedHarness();
		const p = join(h.agentDir, "plugins/packages", h.installed.plugin.plugin.id, A, "scripts/run.sh");
		expect(readFileSync(p, "utf8")).toBe("#!/bin/sh\necho OK");
		if (process.platform !== "win32") expect(statSync(p).mode & 0o111).not.toBe(0);
	});

	it("R7 rejected revision does not replace live bytes", async () => {
		const h = await installedHarness();
		const p = join(h.agentDir, "plugins/packages", h.installed.plugin.plugin.id, A, "skills/helper/SKILL.md");
		writeFileSync(p, "LIVE-BYTES");
		await expect(
			h.service.install({
				requestId: randomUUID(),
				inspectionId: h.inspection.inspectionId,
				expectedRevision: 1,
			}),
		).rejects.toThrow();
		expect(readFileSync(p, "utf8")).toBe("LIVE-BYTES");
	});

	it("R5 Codex skills directory field discovers its child skills", () => {
		const p = parsePluginManifest({
			files: new Map([
				[".codex-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "codex-fixture", skills: "./skills/" }))],
				["skills/helper/SKILL.md", Buffer.from(skill)],
			]),
		});
		expect(p.components.filter((c) => c.kind === "skill")).toHaveLength(1);
	});

	it.each(["./skills/", "skills", ["./skills/"]])("discovers a skill collection: %j", (skills) => {
		const parsed = parsePluginManifest({
			files: new Map([
				[".codex-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "example", skills }))],
				["skills/helper/SKILL.md", Buffer.from("---\nname: helper\ndescription: Helper\n---\nHelp")],
			]),
		});
		expect(parsed.components.filter((c) => c.kind === "skill")).toHaveLength(1);
	});

	it("R6 custom hooks supplement defaults rather than dropping defaults", () => {
		const config = (event: string) =>
			Buffer.from(JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command: "echo OK" }] }] } }));
		const p = parsePluginManifest({
			files: new Map([
				[".claude-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "fixture", hooks: "./custom.json" }))],
				["custom.json", config("UserPromptSubmit")],
				["hooks/hooks.json", config("PreToolUse")],
			]),
		});
		expect(p.components.filter((c) => c.kind === "hook")).toHaveLength(2);
	});

	it("R8 different installed plugins must receive different hook IDs and disabling one preserves the other", async () => {
		const h = await installedHarness();
		const other = await h.service.addMarket({
			requestId: randomUUID(),
			url: "other/repo",
			expectedRevision: h.installed.registryRevision,
		});
		const detail = await h.service.inspectPlugin(other.selectedSourceId, "entry-fixture-plugin");
		const otherInstalled = await h.service.install({
			requestId: randomUUID(),
			inspectionId: detail.inspectionId,
			expectedRevision: detail.registryRevision,
		});
		const hooks = readPluginSnapshot(h.agentDir).hooks;
		expect(hooks).toHaveLength(2);
		expect(new Set(hooks.map((h) => h.definition.id)).size).toBe(2);

		// Disable first plugin; second plugin's hook remains active
		h.service.setEnabled({
			requestId: randomUUID(),
			pluginId: h.installed.plugin.plugin.id,
			enabled: false,
			expectedRevision: otherInstalled.registryRevision,
		});
		const hooksAfter = readPluginSnapshot(h.agentDir).hooks;
		expect(hooksAfter).toHaveLength(1);
		expect(hooksAfter[0].definition.id).toBe(hooks[1].definition.id);
	});

	it("R10 unknown Codex async hooks are not silently treated as sync hooks", () => {
		const p = parsePluginManifest({
			format: "codex",
			manifest: { name: "fixture" },
			files: new Map([
				[
					"hooks/hooks.json",
					Buffer.from(
						JSON.stringify({
							hooks: { PreToolUse: [{ hooks: [{ type: "command", async: true, command: "echo OK" }] }] },
						}),
					),
				],
			]),
		});
		expect(p.components.some((c) => c.kind === "unsupported")).toBe(true);
	});

	it("R12 broken manifest must report a diagnostic, not silently become valid", () => {
		const p = parsePluginManifest({
			files: new Map([
				[".claude-plugin/plugin.json", Buffer.from("{broken")],
				["skills/helper/SKILL.md", Buffer.from(skill)],
			]),
		});
		expect(p.issues.length).toBeGreaterThan(0);
	});

	it("R11 http headers must map to httpHeaders not envHttpHeaders", () => {
		const parsed = parsePluginManifest({
			format: "claude",
			manifest: {
				name: "fixture",
				mcpServers: {
					remote: {
						type: "http",
						url: "https://example.com/mcp",
						headers: { "X-Test": "literal-value" },
					},
				},
			},
			files: new Map(),
		});
		const remote = parsed.components.find((c) => c.kind === "mcp");
		if (!remote || remote.kind !== "mcp") throw new Error("Expected remote MCP");
		expect(resolveMcpServerSettings(remote.name, remote.definition, "/tmp", {}).httpHeaders).toEqual({
			"X-Test": "literal-value",
		});
	});

	it("R13 plugin MCP must coexist with manual same display name", () => {
		const owner = { pluginId: "f".repeat(64), displayName: "Fixture", componentId: "p-plugin-echo" };
		const cfg = resolveMcpServerDefinitions({ echo: { command: "node" } }, {}, "/tmp", {}, [
			{
				kind: "mcp",
				name: "p-plugin-echo",
				originalName: "echo",
				packageDir: "/tmp",
				owner,
				definition: { command: "node" },
			},
		]);
		expect(cfg.servers.map((s) => s.name)).toEqual(["echo", "p-plugin-echo"]);
	});

	it("R9 marketplace selection does not change active capabilities", async () => {
		const h = await installedHarness();
		const before = readPluginSnapshot(h.agentDir).fingerprint;
		await h.service.selectMarket({
			requestId: randomUUID(),
			sourceId: "official-market",
			expectedRevision: h.installed.registryRevision,
		});
		expect(readPluginSnapshot(h.agentDir).fingerprint).toBe(before);
	});
});
