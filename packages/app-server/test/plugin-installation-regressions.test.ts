import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, mcpCredentialKey, readPluginSnapshot } from "@metis/coding-agent/host";
import { afterEach, expect, it } from "vitest";
import { PluginService } from "../src/plugins.ts";
import { createZip } from "./helpers/plugin-zip-fixture.ts";

const A = "1".repeat(40),
	B = "2".repeat(40),
	M = "3".repeat(40);
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(
	options: { source?: Record<string, unknown>; files?: Record<string, string>; marketUrl?: string } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "metis-fixes-review-"));
	dirs.push(dir);
	let advanced = false;
	const calls: string[] = [];
	const source = options.source ?? { source: "github", repo: "vendor/plugin", sha: A };
	const catalog = { name: "catalog", plugins: [{ name: "demo", source }] };
	const files: Record<string, string> = {
		".claude-plugin/plugin.json": JSON.stringify({ name: "demo" }),
		"skills/helper/SKILL.md": "---\nname: helper\ndescription: test\n---\nHelp",
		...options.files,
	};
	const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
		const u = new URL(String(input));
		calls.push(u.toString());
		if (u.hostname === "codeload.github.com") {
			return new Response(
				createZip(
					Object.fromEntries(
						Object.entries(files).map(([p, content]) => [
							`repo-${u.pathname.split("/").at(-1)}/${source.source === "git-subdir" ? `${source.path}/` : ""}${p}`,
							content,
						]),
					),
				),
			);
		}
		if (u.pathname === "/repos/catalog/market") return Response.json({ default_branch: "main" });
		if (u.pathname === "/repos/catalog/market/commits/main") return Response.json({ sha: M });
		if (u.pathname === `/repos/catalog/market/commits/${M}`) return Response.json({ sha: M });
		if (u.pathname === "/repos/catalog/market/contents/.claude-plugin/marketplace.json")
			return Response.json(catalog);
		if (u.pathname === "/repos/vendor/plugin") return Response.json({ default_branch: "main" });
		if (u.pathname === "/repos/vendor/plugin/commits/main") return Response.json({ sha: B });
		if (u.pathname === "/repos/vendor/plugin/commits/release") return Response.json({ sha: advanced ? B : A });
		return new Response("", { status: 404 });
	}) as typeof fetch;
	const authStorage = AuthStorage.inMemory();
	const service = new PluginService(dir, fakeFetch, authStorage);
	const market = await service.addMarket({
		requestId: randomUUID(),
		url: options.marketUrl ?? "catalog/market",
		expectedRevision: 1,
	});
	return {
		service,
		market,
		calls,
		dir,
		authStorage,
		files,
		restart: () => new PluginService(dir, fakeFetch, authStorage),
		advance: () => {
			advanced = true;
		},
		inspect: () => service.inspectPlugin(market.selectedSourceId, "entry-demo"),
	};
}

it.each([
	{ source: "github", repo: "vendor/plugin", sha: A },
	{ source: "url", url: "https://github.com/vendor/plugin.git", sha: A },
	{ source: "git-subdir", url: "https://github.com/vendor/plugin.git", path: "packages/demo", sha: A },
])("external source sha remains pinned after installation from a pinned market: %j", async (source) => {
	const h = await setup({ source, marketUrl: `https://github.com/catalog/market/tree/${M}` });
	const inspected = await h.inspect();
	expect(inspected.sourceCommit).toBe(A);
	const installed = await h.service.install({
		requestId: randomUUID(),
		inspectionId: inspected.inspectionId,
		expectedRevision: inspected.registryRevision,
	});
	const update = await h.restart().inspectUpdate(installed.plugin.plugin.id);
	expect(update.upToDate, JSON.stringify(update)).toBe(true);
});

it("X2 external source ref survives inspection and tracks its own branch", async () => {
	const h = await setup({ source: { source: "github", repo: "vendor/plugin", ref: "release" } });
	const inspected = await h.inspect();
	expect(inspected.sourceCommit).toBe(A);
	expect(inspected.plugin.trackingRef).toBe("release");
	const installed = await h.service.install({
		requestId: randomUUID(),
		inspectionId: inspected.inspectionId,
		expectedRevision: inspected.registryRevision,
	});
	expect((await h.restart().inspectUpdate(installed.plugin.plugin.id)).upToDate).toBe(true);
	h.advance();
	expect((await h.restart().inspectUpdate(installed.plugin.plugin.id)).newCommit).toBe(B);
});

it.each([
	["X3 malformed manifest", ".claude-plugin/plugin.json"],
	["X4 malformed MCP config", ".mcp.json"],
	["X5 malformed hook config", "hooks/hooks.json"],
])("%s cannot be successfully installed as a skill-only package", async (_name, path) => {
	const h = await setup({ files: { [path]: "{BROKEN" } });
	const inspected = await h.inspect();
	expect(inspected.issues.length).toBeGreaterThan(0);
	await expect(
		h.service.install({
			requestId: randomUUID(),
			inspectionId: inspected.inspectionId,
			expectedRevision: inspected.registryRevision,
			allowPartial: true,
		}),
	).rejects.toThrow();
});

it("X6 two unsupported handlers for one event still yield an inspectable partial plugin", async () => {
	const h = await setup({
		files: {
			"hooks/hooks.json": JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							hooks: [
								{ type: "command", command: "echo one", async: true },
								{ type: "prompt", prompt: "two" },
							],
						},
					],
				},
			}),
		},
	});
	const inspected = await h.inspect();
	expect(inspected.components.filter((c) => c.status === "unsupported")).toHaveLength(2);
});

it.each([false, true])("X7 uninstall removes owned credentials (disable first=%s)", async (disable) => {
	const h = await setup({
		files: { ".mcp.json": JSON.stringify({ mcpServers: { echo: { url: "http://127.0.0.1:1/mcp" } } }) },
	});
	const inspected = await h.inspect();
	const installed = await h.service.install({
		requestId: randomUUID(),
		inspectionId: inspected.inspectionId,
		expectedRevision: inspected.registryRevision,
	});
	const name = readPluginSnapshot(h.dir).mcp[0]!.name;
	const key = mcpCredentialKey({ scope: "user", name });
	const manualKey = mcpCredentialKey({ scope: "user", name: "manual-echo" });
	h.authStorage.set(key, { type: "mcp_secret", serverFingerprint: "test", env: { TOKEN: "test-only" } });
	h.authStorage.set(manualKey, {
		type: "mcp_secret",
		serverFingerprint: "manual",
		env: { TOKEN: "manual-test-only" },
	});
	expect(h.authStorage.has(key)).toBe(true);
	let revision = installed.registryRevision;
	if (disable)
		revision = h.service.setEnabled({
			requestId: randomUUID(),
			pluginId: installed.plugin.plugin.id,
			enabled: false,
			expectedRevision: revision,
		}).registryRevision;
	h.service.remove({ requestId: randomUUID(), pluginId: installed.plugin.plugin.id, expectedRevision: revision });
	expect(h.authStorage.has(manualKey)).toBe(true);
	expect(h.authStorage.has(key)).toBe(false);
});

it("X8 installed hook public identity matches its actual runtime identity", async () => {
	const h = await setup({
		files: {
			"hooks/hooks.json": JSON.stringify({
				hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo ok" }] }] },
			}),
		},
	});
	const inspected = await h.inspect();
	const installed = await h.service.install({
		requestId: randomUUID(),
		inspectionId: inspected.inspectionId,
		expectedRevision: inspected.registryRevision,
	});
	expect(installed.plugin.components.find((c) => c.kind === "hook")!.componentId).toBe(
		readPluginSnapshot(h.dir).hooks[0]!.definition.id,
	);
});

it.each(["null", "[]", '{"mcpServers":null}'])("invalid JSON structure cannot install: %s", async (json) => {
	const h = await setup({ files: { ".mcp.json": json } });
	const inspected = await h.inspect();
	expect(inspected.issues.some((i) => i.code === "INVALID_JSON")).toBe(true);
	await expect(
		h.service.install({
			requestId: randomUUID(),
			inspectionId: inspected.inspectionId,
			expectedRevision: inspected.registryRevision,
			allowPartial: true,
		}),
	).rejects.toThrow();
});

it("corrupt updates preserve the installed version even with allowPartial", async () => {
	const h = await setup({ source: { source: "github", repo: "vendor/plugin", ref: "release" } });
	const inspected = await h.inspect();
	const installed = await h.service.install({
		requestId: randomUUID(),
		inspectionId: inspected.inspectionId,
		expectedRevision: inspected.registryRevision,
	});
	h.files[".mcp.json"] = "{BROKEN";
	h.advance();
	const update = await h.service.inspectUpdate(installed.plugin.plugin.id);
	await expect(
		h.service.update({
			requestId: randomUUID(),
			pluginId: installed.plugin.plugin.id,
			inspectionId: update.inspection!.inspectionId,
			expectedCommit: A,
			expectedRevision: installed.registryRevision,
			allowPartial: true,
		}),
	).rejects.toThrow();
	expect(h.service.getInstalled(installed.plugin.plugin.id).plugin.commit).toBe(A);
});

it("installed detail preserves missing variable requirements", async () => {
	const h = await setup({
		files: {
			".mcp.json": JSON.stringify({
				mcpServers: { echo: { command: "node", args: ["$" + "{UNCONFIGURED_PLUGIN_VALUE}"] } },
			}),
		},
	});
	const inspected = await h.inspect();
	const installed = await h.service.install({
		requestId: randomUUID(),
		inspectionId: inspected.inspectionId,
		expectedRevision: inspected.registryRevision,
	});
	expect(installed.plugin.components.find((c) => c.kind === "mcp")).toMatchObject({
		status: "needs-configuration",
		reason: expect.stringContaining("UNCONFIGURED_PLUGIN_VALUE"),
	});
});

it("allows deleting the default and last market without restoring it on restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "metis-empty-markets-"));
	dirs.push(dir);
	const service = new PluginService(dir);
	const initial = service.listMarkets();
	expect(initial.markets[0]?.id).toBe("official-market");
	expect(initial.markets[0]?.displayName).toBe("anthropics/claude-plugins-official");
	const result = service.removeMarket({
		requestId: randomUUID(),
		sourceId: "official-market",
		expectedRevision: initial.registryRevision,
	});
	expect(result.markets).toEqual([]);
	expect(result.selectedSourceId).toBeNull();
	expect(new PluginService(dir).listMarkets()).toEqual(result);
});

it("deleting a market preserves its installed capabilities and selects an existing source", async () => {
	const h = await setup();
	expect(h.market.markets.find((market) => market.id === h.market.selectedSourceId)?.displayName).toBe(
		"catalog/market",
	);
	const inspected = await h.inspect();
	const installed = await h.service.install({
		requestId: randomUUID(),
		inspectionId: inspected.inspectionId,
		expectedRevision: inspected.registryRevision,
	});
	const entry = (await h.service.getCatalog(h.market.selectedSourceId)).entries[0];
	expect(entry?.installedPluginId).toBe(installed.plugin.plugin.id);
	const withoutOfficial = h.service.removeMarket({
		requestId: randomUUID(),
		sourceId: "official-market",
		expectedRevision: installed.registryRevision,
	});
	expect(withoutOfficial.selectedSourceId).toBe(h.market.selectedSourceId);
	expect(withoutOfficial.markets[0]?.selected).toBe(true);
	h.service.removeMarket({
		requestId: randomUUID(),
		sourceId: h.market.selectedSourceId,
		expectedRevision: withoutOfficial.registryRevision,
	});
	const restarted = h.restart();
	expect(restarted.listMarkets().markets).toEqual([]);
	expect(readPluginSnapshot(h.dir).skills).toHaveLength(1);
	await expect(restarted.getCatalog(h.market.selectedSourceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("opening an uncached market reports GitHub errors instead of a false empty catalog", async () => {
	const dir = mkdtempSync(join(tmpdir(), "metis-market-offline-"));
	dirs.push(dir);
	const service = new PluginService(
		dir,
		async () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
	);
	await expect(service.getCatalog("official-market")).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
});
