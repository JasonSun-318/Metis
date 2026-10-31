import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, getDefaultSessionDir, getSessionDisplayMetadataPath } from "@metis/coding-agent/host";
import { afterEach, expect, it } from "vitest";
import { SessionCatalog } from "../src/session-catalog.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each(["code", "chat"] as const)(
	"preserves future %s identity through full and project refresh without touching body or metadata",
	async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), "metis-catalog-availability-"));
		directories.push(directory);
		const cwd = join(directory, "project");
		mkdirSync(cwd);
		const agentDir = join(directory, "agent");
		const storage = getDefaultSessionDir(cwd, agentDir);
		mkdirSync(storage, { recursive: true });
		const id = "11111111-1111-4111-8111-111111111111";
		const scheduled =
			mode === "chat"
				? { taskId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333" }
				: undefined;
		const file = join(storage, "future.jsonl");
		const body = Buffer.concat([
			Buffer.from(
				`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION + 1, id, timestamp: "2026-10-28T12:00:00.000Z", cwd, mode, cwdOrigin: "user-selected", ...(scheduled ? { scheduled } : {}) })}\n`,
			),
			Buffer.from([0xff, 0x00, 0x7b]),
		]);
		writeFileSync(file, body);
		const sidecar = Buffer.from(
			JSON.stringify({ version: 1, sessionId: id, name: "Saved future name", useMemory: false }),
		);
		writeFileSync(getSessionDisplayMetadataPath(file), sidecar);
		const originalFiles = readdirSync(storage).sort();
		const catalog = new SessionCatalog({ agentDir, sessionsRoot: join(agentDir, "sessions") });
		await catalog.refresh();
		for (const projectRefresh of [false, true]) {
			if (projectRefresh) await catalog.refreshModeProjectStorage(cwd);
			const ref = catalog.get(id);
			expect(ref.summary).toMatchObject({
				sessionId: id,
				state: "unsupported",
				cwd: realpathSync(cwd),
				mode,
				name: "Saved future name",
				useMemory: false,
			});
			expect(ref.unsupportedVersion).toBe(CURRENT_SESSION_VERSION + 1);
			expect(ref.summary.scheduled).toEqual(scheduled);
			expect(ref.scheduled).toEqual(scheduled);
			expect(readFileSync(file)).toEqual(body);
			expect(readFileSync(getSessionDisplayMetadataPath(file))).toEqual(sidecar);
			expect(readdirSync(storage).sort()).toEqual(originalFiles);
		}
	},
);
