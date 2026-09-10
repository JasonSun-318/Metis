import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPluginFiles, inspectRepositorySource } from "../src/plugin-sources.ts";
import { PluginService } from "../src/plugins.ts";
import { dirs, harness } from "./helpers/plugin-acceptance-fixture.ts";

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
});
