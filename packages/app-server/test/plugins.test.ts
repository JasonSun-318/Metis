import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginSnapshot } from "@metis/coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginService } from "../src/plugins.ts";

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Record<string, string | { readonly content: string; readonly mode: number }>): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(entries)) {
		const fileName = Buffer.from(name);
		const bytes = Buffer.from(typeof value === "string" ? value : value.content);
		const mode = typeof value === "string" ? 0o100600 : value.mode;
		const checksum = crc32(bytes);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(checksum, 14);
		header.writeUInt32LE(bytes.length, 18);
		header.writeUInt32LE(bytes.length, 22);
		header.writeUInt16LE(fileName.length, 26);
		local.push(header, fileName, bytes);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(0x0314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(checksum, 16);
		directory.writeUInt32LE(bytes.length, 20);
		directory.writeUInt32LE(bytes.length, 24);
		directory.writeUInt16LE(fileName.length, 28);
		directory.writeUInt32LE((mode << 16) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, fileName);
		offset += header.length + fileName.length + bytes.length;
	}
	const directoryBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(directoryBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directoryBytes, end]);
}

interface UserFilesState {
	settingsJson: string;
	hooksJson: string;
	userSkillMd: string;
}

function seedUserFiles(agentDir: string): UserFilesState {
	const settingsJson = JSON.stringify({ mcpServers: { "user-mcp": { command: "node" } } }, null, 2);
	const hooksJson = JSON.stringify({ hooks: [{ id: "user-hook", name: "User Hook" }] }, null, 2);
	const userSkillMd = "---\nname: user-skill\ndescription: Manual skill\n---\n# User Skill";

	writeFileSync(join(agentDir, "settings.json"), settingsJson, "utf8");
	writeFileSync(join(agentDir, "hooks.json"), hooksJson, "utf8");
	const skillDir = join(agentDir, "skills", "user-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), userSkillMd, "utf8");

	return { settingsJson, hooksJson, userSkillMd };
}

function readUserFiles(agentDir: string): UserFilesState {
	return {
		settingsJson: readFileSync(join(agentDir, "settings.json"), "utf8"),
		hooksJson: readFileSync(join(agentDir, "hooks.json"), "utf8"),
		userSkillMd: readFileSync(join(agentDir, "skills", "user-skill", "SKILL.md"), "utf8"),
	};
}

describe("PluginService", () => {
	let agentDir: string;
	const COMMIT_1 = "1111111111111111111111111111111111111111";
	const COMMIT_2 = "2222222222222222222222222222222222222222";

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "metis-plugins-service-test-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function createMockFetch() {
		const marketplaceJson = JSON.stringify({
			name: "official-market",
			plugins: [
				{
					name: "fixture-plugin",
					description: "Fixture plugin",
					source: "./plugins/fixture",
				},
			],
		});

		const repoZip = createZip({
			[`repo-${COMMIT_1}/plugins/fixture/.claude-plugin/plugin.json`]: JSON.stringify({
				name: "fixture-plugin",
				description: "Fixture plugin with skill and mcp",
			}),
			[`repo-${COMMIT_1}/plugins/fixture/skills/helper/SKILL.md`]:
				"---\nname: helper\ndescription: Helper skill\n---\n# Helper",
			[`repo-${COMMIT_1}/plugins/fixture/.mcp.json`]: JSON.stringify({
				mcpServers: {
					"plugin-server": {
						command: "node",
						args: ["./index.js"],
					},
				},
			}),
		});

		return vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/repos/anthropics/claude-plugins-official")) {
				return new Response(JSON.stringify({ default_branch: "main" }));
			}
			if (url.endsWith("/commits/main")) {
				return new Response(JSON.stringify({ sha: COMMIT_1 }));
			}
			if (url.endsWith("/repos/community/awesome-plugins")) {
				return new Response(JSON.stringify({ default_branch: "main" }));
			}
			if (url.includes("/awesome-plugins/contents/.claude-plugin/marketplace.json")) {
				return new Response(
					JSON.stringify({
						name: "awesome-market",
						plugins: [
							{
								name: "fixture-plugin",
								source: {
									source: "git-subdir",
									url: "https://github.com/anthropics/claude-plugins-official",
									path: "plugins/fixture",
									sha: COMMIT_1,
								},
							},
						],
					}),
				);
			}
			if (url.includes("/contents/.claude-plugin/marketplace.json")) {
				return new Response(marketplaceJson);
			}
			if (url.includes("codeload.github.com")) {
				return new Response(repoZip);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;
	}

	it("installs and removes plugin atomically without touching user files", async () => {
		const fetchImpl = createMockFetch();
		const service = new PluginService(agentDir, fetchImpl);

		const before = seedUserFiles(agentDir);
		const initialMarkets = service.listMarkets();
		assert(initialMarkets.selectedSourceId, "A new registry contains the default market");

		// Refresh market to populate catalog cache
		await service.refreshMarket({
			requestId: randomUUID(),
			sourceId: initialMarkets.selectedSourceId,
		});

		const inspection = await service.inspectPlugin(initialMarkets.selectedSourceId, "entry-fixture-plugin");
		expect(inspection.components).toHaveLength(2);

		const installResult = await service.install({
			requestId: randomUUID(),
			inspectionId: inspection.inspectionId,
			expectedRevision: inspection.registryRevision,
		});

		expect(installResult.activation).toBe("applied");
		expect(installResult.plugin.plugin.name).toBe("fixture-plugin");

		// Snapshot reflects active components
		const snapshotAfterInstall = readPluginSnapshot(agentDir);
		expect(snapshotAfterInstall.plugins).toHaveLength(1);
		expect(snapshotAfterInstall.skills).toHaveLength(1);
		expect(snapshotAfterInstall.mcp).toHaveLength(1);

		// Remove plugin
		const removeResult = await service.remove({
			requestId: randomUUID(),
			pluginId: installResult.plugin.plugin.id,
			expectedRevision: installResult.registryRevision,
		});

		expect(removeResult.installed).toHaveLength(0);

		// User files must remain byte-for-byte identical!
		expect(readUserFiles(agentDir)).toEqual(before);
		// Snapshot returns 0 enabled plugins
		expect(readPluginSnapshot(agentDir).plugins).toEqual([]);
	});

	it("prevents partial registration when revision conflict occurs", async () => {
		const fetchImpl = createMockFetch();
		const service = new PluginService(agentDir, fetchImpl);

		const markets = service.listMarkets();
		assert(markets.selectedSourceId, "A new registry contains the default market");
		await service.refreshMarket({ requestId: randomUUID(), sourceId: markets.selectedSourceId });
		const inspection = await service.inspectPlugin(markets.selectedSourceId, "entry-fixture-plugin");

		// Pass outdated expectedRevision
		await expect(
			service.install({
				requestId: randomUUID(),
				inspectionId: inspection.inspectionId,
				expectedRevision: 999, // Wrong revision
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		// Nothing registered
		expect(service.listInstalled().installed).toHaveLength(0);
		expect(readPluginSnapshot(agentDir).plugins).toHaveLength(0);
	});

	it("ensures idempotent install for identical commit", async () => {
		const fetchImpl = createMockFetch();
		const service = new PluginService(agentDir, fetchImpl);

		const markets = service.listMarkets();
		assert(markets.selectedSourceId, "A new registry contains the default market");
		await service.refreshMarket({ requestId: randomUUID(), sourceId: markets.selectedSourceId });
		const inspection = await service.inspectPlugin(markets.selectedSourceId, "entry-fixture-plugin");

		const first = await service.install({
			requestId: randomUUID(),
			inspectionId: inspection.inspectionId,
			expectedRevision: inspection.registryRevision,
		});

		// Second install of exact same commit
		const second = await service.install({
			requestId: randomUUID(),
			inspectionId: inspection.inspectionId,
			expectedRevision: first.registryRevision,
		});

		expect(second.plugin.plugin.id).toBe(first.plugin.plugin.id);
		expect(service.listInstalled().installed).toHaveLength(1);
	});

	it("disables and re-enables plugin without re-downloading", async () => {
		const fetchImpl = createMockFetch();
		const service = new PluginService(agentDir, fetchImpl);

		const markets = service.listMarkets();
		assert(markets.selectedSourceId, "A new registry contains the default market");
		await service.refreshMarket({ requestId: randomUUID(), sourceId: markets.selectedSourceId });
		const inspection = await service.inspectPlugin(markets.selectedSourceId, "entry-fixture-plugin");

		const installed = await service.install({
			requestId: randomUUID(),
			inspectionId: inspection.inspectionId,
			expectedRevision: inspection.registryRevision,
		});

		// Disable
		const disabled = service.setEnabled({
			requestId: randomUUID(),
			pluginId: installed.plugin.plugin.id,
			enabled: false,
			expectedRevision: installed.registryRevision,
		});
		expect(disabled.plugin.plugin.enabled).toBe(false);
		expect(readPluginSnapshot(agentDir).plugins).toHaveLength(0);

		// Re-enable
		const enabled = service.setEnabled({
			requestId: randomUUID(),
			pluginId: installed.plugin.plugin.id,
			enabled: true,
			expectedRevision: disabled.registryRevision,
		});
		expect(enabled.plugin.plugin.enabled).toBe(true);
		expect(readPluginSnapshot(agentDir).plugins).toHaveLength(1);
	});

	it("refreshes market catalog without modifying installed plugin commit", async () => {
		let currentCommit = COMMIT_1;
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/commits/main")) {
				return new Response(JSON.stringify({ sha: currentCommit }));
			}
			if (url.endsWith("/repos/anthropics/claude-plugins-official")) {
				return new Response(JSON.stringify({ default_branch: "main" }));
			}
			if (url.includes("/contents/.claude-plugin/marketplace.json")) {
				return new Response(
					JSON.stringify({
						name: "official-market",
						plugins: [{ name: "fixture-plugin", source: "./plugins/fixture" }],
					}),
				);
			}
			if (url.includes("codeload.github.com")) {
				return new Response(
					createZip({
						[`repo-${currentCommit}/plugins/fixture/.claude-plugin/plugin.json`]: JSON.stringify({
							name: "fixture-plugin",
						}),
						[`repo-${currentCommit}/plugins/fixture/skills/helper/SKILL.md`]: "---\nname: helper\n---\n# Help",
					}),
				);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		const service = new PluginService(agentDir, fetchImpl);
		const markets = service.listMarkets();
		assert(markets.selectedSourceId, "A new registry contains the default market");

		await service.refreshMarket({ requestId: randomUUID(), sourceId: markets.selectedSourceId });
		const inspection = await service.inspectPlugin(markets.selectedSourceId, "entry-fixture-plugin");

		const installed = await service.install({
			requestId: randomUUID(),
			inspectionId: inspection.inspectionId,
			expectedRevision: inspection.registryRevision,
		});
		expect(installed.plugin.plugin.commit).toBe(COMMIT_1);

		// Now remote repo has newer commit
		currentCommit = COMMIT_2;
		await service.refreshMarket({ requestId: randomUUID(), sourceId: markets.selectedSourceId });

		// Installed plugin commit MUST still be COMMIT_1!
		const currentInstalled = service.getInstalled(installed.plugin.plugin.id);
		expect(currentInstalled.plugin.commit).toBe(COMMIT_1);
	});

	it("does not duplicate when same plugin is installed from two different markets", async () => {
		const fetchImpl = createMockFetch();
		const service = new PluginService(agentDir, fetchImpl);

		const markets = service.listMarkets();
		assert(markets.selectedSourceId, "A new registry contains the default market");
		await service.refreshMarket({ requestId: randomUUID(), sourceId: markets.selectedSourceId });

		// Add a second market pointing to the same plugin repository
		const added = await service.addMarket({
			requestId: randomUUID(),
			url: "community/awesome-plugins",
			expectedRevision: markets.registryRevision,
		});

		// Inspect and install from Market 1
		const inspection1 = await service.inspectPlugin(markets.selectedSourceId, "entry-fixture-plugin");
		const install1 = await service.install({
			requestId: randomUUID(),
			inspectionId: inspection1.inspectionId,
			expectedRevision: added.registryRevision,
		});
		expect(service.listInstalled().installed).toHaveLength(1);

		const market2Id = added.markets.find((m) => m.url.includes("awesome-plugins"))!.id;

		// Refresh Market 2 catalog
		await service.refreshMarket({ requestId: randomUUID(), sourceId: market2Id });

		// Now inspect from Market 2 (same canonical repository + subdir)
		const inspection2 = await service.inspectPlugin(market2Id, "entry-fixture-plugin");
		expect(inspection2.plugin.id).toBe(inspection1.plugin.id);

		// Install again from Market 2
		const install2 = await service.install({
			requestId: randomUUID(),
			inspectionId: inspection2.inspectionId,
			expectedRevision: install1.registryRevision,
		});

		// Must remain single installed record, never duplicated!
		expect(service.listInstalled().installed).toHaveLength(1);
		expect(install2.plugin.plugin.id).toBe(install1.plugin.plugin.id);
	});

	it("recovers cleanly from simulated crash before registry commit", async () => {
		const fetchImpl = createMockFetch();
		const service = new PluginService(agentDir, fetchImpl);

		const markets = service.listMarkets();
		assert(markets.selectedSourceId, "A new registry contains the default market");
		await service.refreshMarket({ requestId: randomUUID(), sourceId: markets.selectedSourceId });
		const inspection = await service.inspectPlugin(markets.selectedSourceId, "entry-fixture-plugin");

		// Staging files exist, but registry CAS fails
		await expect(
			service.install({
				requestId: randomUUID(),
				inspectionId: inspection.inspectionId,
				expectedRevision: 999999, // deliberate mismatch simulating conflict/crash
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		// On new service instance (simulating restart), registry and snapshot are intact
		const restartedService = new PluginService(agentDir, fetchImpl);
		expect(restartedService.listInstalled().installed).toHaveLength(0);
		expect(readPluginSnapshot(agentDir).plugins).toHaveLength(0);
	});

	it("failure injection: preserves active package and registry on write/rename/registry failures", async () => {
		const fetchImpl = createMockFetch();
		const service = new PluginService(agentDir, fetchImpl);

		const markets = service.listMarkets();
		assert(markets.selectedSourceId, "A new registry contains the default market");
		await service.refreshMarket({ requestId: randomUUID(), sourceId: markets.selectedSourceId });
		const inspection = await service.inspectPlugin(markets.selectedSourceId, "entry-fixture-plugin");

		// Initial successful install
		const initialInstall = await service.install({
			requestId: randomUUID(),
			inspectionId: inspection.inspectionId,
			expectedRevision: 1,
		});
		expect(service.listInstalled().installed).toHaveLength(1);
		const pluginId = initialInstall.plugin.plugin.id;
		const initialSkillPath = join(agentDir, "plugins/packages", pluginId, COMMIT_1, "skills/helper/SKILL.md");
		const initialContent = readFileSync(initialSkillPath, "utf8");

		// 1. Filesystem permission error during staging (make parent dir read-only)
		const packagesDir = join(agentDir, "plugins/packages", pluginId);
		chmodSync(packagesDir, 0o555);
		try {
			await expect(
				service.install({
					requestId: randomUUID(),
					inspectionId: inspection.inspectionId,
					expectedRevision: initialInstall.registryRevision,
				}),
			).rejects.toThrow();
		} finally {
			chmodSync(packagesDir, 0o755);
		}

		// Old package and registry must be completely intact
		expect(service.listInstalled().installed).toHaveLength(1);
		expect(readFileSync(initialSkillPath, "utf8")).toBe(initialContent);

		// 2. Registry write failure (read-only registry file)
		const registryDir = join(agentDir, "plugins");
		const registryPath = join(registryDir, "registry.json");
		chmodSync(registryPath, 0o444);
		chmodSync(registryDir, 0o555);
		try {
			await expect(
				service.install({
					requestId: randomUUID(),
					inspectionId: inspection.inspectionId,
					expectedRevision: initialInstall.registryRevision,
				}),
			).rejects.toThrow();
		} finally {
			chmodSync(registryDir, 0o755);
			chmodSync(registryPath, 0o600);
		}

		// Old package and registry still completely intact
		expect(service.listInstalled().installed).toHaveLength(1);
		expect(readFileSync(initialSkillPath, "utf8")).toBe(initialContent);
	});

	it("source matrix: supports catalog root, feature branch, pinned sha, and different root in same repo", async () => {
		const PINNED_SHA = "4444444444444444444444444444444444444444";
		const FEATURE_SHA = "5555555555555555555555555555555555555555";
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/repos/acme/multiroot")) {
				return new Response(JSON.stringify({ default_branch: "main" }));
			}
			if (url.endsWith("/commits/main")) {
				return new Response(JSON.stringify({ sha: COMMIT_1 }));
			}
			if (url.endsWith("/commits/feature%2Fplugins")) {
				return new Response(JSON.stringify({ sha: FEATURE_SHA }));
			}
			if (url.endsWith(`/commits/${PINNED_SHA}`)) {
				return new Response(JSON.stringify({ sha: PINNED_SHA }));
			}
			if (url.includes("/contents/catalog/.claude-plugin/marketplace.json")) {
				return new Response(
					JSON.stringify({
						name: "catalog-market",
						plugins: [{ name: "catalog-plugin", source: "./plugins/cat" }],
					}),
				);
			}
			if (url.includes("/contents/other/.claude-plugin/marketplace.json")) {
				return new Response(
					JSON.stringify({
						name: "other-market",
						plugins: [{ name: "other-plugin", source: "./plugins/oth" }],
					}),
				);
			}
			if (url.includes("codeload.github.com")) {
				const commit = /zip\/([a-f0-9]+)/.exec(url)?.[1] ?? COMMIT_1;
				const zip = createZip({
					[`multiroot-${commit}/catalog/plugins/cat/.claude-plugin/plugin.json`]: JSON.stringify({
						name: "catalog-plugin",
					}),
					[`multiroot-${commit}/catalog/plugins/cat/skills/s1/SKILL.md`]: `---\nname: s1\n---\nSkill 1 ${commit}`,
					[`multiroot-${commit}/other/plugins/oth/.claude-plugin/plugin.json`]: JSON.stringify({
						name: "other-plugin",
					}),
					[`multiroot-${commit}/other/plugins/oth/skills/s2/SKILL.md`]: `---\nname: s2\n---\nSkill 2 ${commit}`,
				});
				return new Response(zip);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		const service = new PluginService(agentDir, fetchImpl);

		// 1. Add root=catalog on main
		const m1 = await service.addMarket({
			requestId: randomUUID(),
			url: "https://github.com/acme/multiroot/tree/main/catalog",
			expectedRevision: 1,
		});
		expect(m1.markets.find((m) => m.id === m1.selectedSourceId)?.root).toBe("catalog");

		// 2. Add same repo with branch=feature/plugins and root=catalog
		const m2 = await service.addMarket({
			requestId: randomUUID(),
			url: "https://github.com/acme/multiroot/tree/feature/plugins/catalog",
			expectedRevision: m1.registryRevision,
		});
		expect(m2.markets.find((m) => m.id === m2.selectedSourceId)?.trackingRef).toBe("feature/plugins");

		// 3. Add same repo with pinned sha and root=catalog
		const m3 = await service.addMarket({
			requestId: randomUUID(),
			url: `https://github.com/acme/multiroot/tree/${PINNED_SHA}/catalog`,
			expectedRevision: m2.registryRevision,
		});
		expect(m3.markets.find((m) => m.id === m3.selectedSourceId)?.pinnedCommit).toBe(PINNED_SHA);

		// 4. Add same repo with root=other on main
		const m4 = await service.addMarket({
			requestId: randomUUID(),
			url: "https://github.com/acme/multiroot/tree/main/other",
			expectedRevision: m3.registryRevision,
		});
		expect(m4.markets.find((m) => m.id === m4.selectedSourceId)?.root).toBe("other");

		// 5. Duplicate add throws CONFLICT
		await expect(
			service.addMarket({
				requestId: randomUUID(),
				url: "https://github.com/acme/multiroot/tree/main/catalog",
				expectedRevision: m4.registryRevision,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		// 6. Invalid ref throws
		await expect(
			service.addMarket({
				requestId: randomUUID(),
				url: "https://github.com/acme/multiroot/tree/nonexistent-ref/catalog",
				expectedRevision: m4.registryRevision,
			}),
		).rejects.toThrow();

		// 7. Restart service: new instance reads from persisted registry and still inspects from original root
		const restarted = new PluginService(agentDir, fetchImpl);
		const listed = restarted.listMarkets();
		expect(listed.markets).toHaveLength(5); // 1 official + 4 added

		const catalogDetail = await restarted.inspectPlugin(m1.selectedSourceId, "entry-catalog-plugin");
		expect(catalogDetail.components.some((c) => c.kind === "skill")).toBe(true);

		const otherDetail = await restarted.inspectPlugin(m4.selectedSourceId, "entry-other-plugin");
		expect(otherDetail.components.some((c) => c.kind === "skill")).toBe(true);
	});
});
