import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginService } from "../../src/plugins.ts";
import { createZip } from "./plugin-zip-fixture.ts";

const A = "1".repeat(40),
	B = "2".repeat(40);
const dirs: string[] = [];
const skill = "---\nname: helper\ndescription: Helpful test skill\n---\nHello";
function harness({ nested = false, single = false } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "metis-acceptance-"));
	dirs.push(agentDir);
	let current = A;
	const root = nested ? "catalog/" : "";
	const pluginPath = single ? "" : `${root}plugins/fixture/`;
	const manifest = { name: "fixture-plugin" };
	const market = { name: "fixture-market", plugins: [{ name: "fixture-plugin", source: "./plugins/fixture" }] };
	const zip = (commit: string) =>
		createZip({
			[`repo-${commit}/${pluginPath}.claude-plugin/plugin.json`]: JSON.stringify(manifest),
			[`repo-${commit}/${pluginPath}skills/helper/SKILL.md`]: `${skill}\n${commit}`,
			[`repo-${commit}/${pluginPath}scripts/run.sh`]: { content: "#!/bin/sh\necho OK", mode: 0o100755 },
			[`repo-${commit}/${pluginPath}hooks/hooks.json`]: JSON.stringify({
				hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hooked" }] }] },
			}),
		});
	const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
		const u = new URL(String(input));
		u.pathname = u.pathname.replace("/repos/other/repo", "/repos/owner/repo");
		if (u.hostname === "codeload.github.com") return new Response(zip(u.pathname.split("/").at(-1)!));
		if (u.pathname === "/repos/owner/repo") return Response.json({ default_branch: "main" });
		if (u.pathname === "/repos/owner/repo/commits/main") return Response.json({ sha: current });
		if (u.pathname.includes("/commits/")) return new Response("", { status: 404 });
		if (u.pathname === `/repos/owner/repo/contents/${root}.claude-plugin/marketplace.json` && !single)
			return Response.json(market);
		if (u.pathname === `/repos/owner/repo/contents/${pluginPath}.claude-plugin/plugin.json`)
			return Response.json(manifest);
		return new Response("", { status: 404 });
	};
	return {
		agentDir,
		fetchImpl: fetchImpl as typeof fetch,
		advance: () => {
			current = B;
		},
		url: nested ? "https://github.com/owner/repo/tree/main/catalog" : "owner/repo",
	};
}
async function installedHarness() {
	const h = harness(),
		service = new PluginService(h.agentDir, h.fetchImpl);
	const market = await service.addMarket({ requestId: randomUUID(), url: h.url, expectedRevision: 1 });
	const inspection = await service.inspectPlugin(market.selectedSourceId, "entry-fixture-plugin");
	const installed = await service.install({
		requestId: randomUUID(),
		inspectionId: inspection.inspectionId,
		expectedRevision: market.registryRevision,
	});
	return { ...h, service, market, inspection, installed };
}
export { harness, installedHarness, dirs, A, B, skill };
