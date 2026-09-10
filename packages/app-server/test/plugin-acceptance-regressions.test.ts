import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPluginFiles, inspectRepositorySource } from "../src/plugin-sources.ts";
import { PluginService } from "../src/plugins.ts";
import { A, dirs, harness, installedHarness } from "./helpers/plugin-acceptance-fixture.ts";

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

	it("R4 preserves executable scripts", async () => {
		const h = await installedHarness();
		const p = join(h.agentDir, "plugins/packages", h.installed.plugin.plugin.id, A, "scripts/run.sh");
		expect(statSync(p).mode & 0o111).not.toBe(0);
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
});
