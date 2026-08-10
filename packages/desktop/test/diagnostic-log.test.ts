import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticLog } from "../src/main/diagnostic-log.ts";

describe("DiagnosticLog", () => {
	it("redacts common credential shapes before they reach disk", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-desktop-log-"));
		const path = join(root, "app-server.log");
		const log = new DiagnosticLog({ path, maxBytes: 1_024, backups: 2 });

		await log.append("stderr", 'apiKey="sk-secret" token: abc123 Authorization: Bearer bearer-secret\n');
		await log.flush();
		const contents = await readFile(path, "utf8");

		expect(contents).toContain("[REDACTED]");
		expect(contents).not.toContain("sk-secret");
		expect(contents).not.toContain("abc123");
		expect(contents).not.toContain("bearer-secret");
	});

	it("rotates at the byte limit and retains exactly two backups", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-desktop-log-"));
		const path = join(root, "app-server.log");
		const log = new DiagnosticLog({ path, maxBytes: 96, backups: 2 });

		for (let index = 0; index < 12; index += 1) await log.append("stdout", `record-${index}-${"x".repeat(24)}\n`);
		await log.flush();

		for (const candidate of [path, `${path}.1`, `${path}.2`]) {
			expect((await stat(candidate)).size).toBeLessThanOrEqual(96);
		}
		await expect(stat(`${path}.3`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("serializes concurrent writes without retaining oversized records", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-desktop-log-"));
		const path = join(root, "app-server.log");
		const log = new DiagnosticLog({ path, maxBytes: 128, backups: 2 });

		await Promise.all(
			Array.from({ length: 20 }, (_, index) => log.append("stderr", `${index}:${"y".repeat(256)}\n`)),
		);
		await log.flush();

		expect((await stat(path)).size).toBeLessThanOrEqual(128);
		expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
	});
});
