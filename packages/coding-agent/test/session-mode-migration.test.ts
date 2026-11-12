import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacySessionModes } from "../src/core/session-mode-migration.ts";

const roots: string[] = [];

function agentDir(): string {
	const root = mkdtempSync(join(tmpdir(), "metis-mode-migration-"));
	roots.push(root);
	return root;
}

function journal(
	directory: string,
	relativePath: string,
	header: Record<string, unknown>,
	body: string[] = [],
): string {
	const path = join(directory, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${[JSON.stringify(header), ...body].join("\n")}\n`);
	return path;
}

const HEADER = {
	type: "session",
	version: 15,
	id: "11111111-1111-4111-8111-111111111111",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/work/project",
	cwdOrigin: "user-selected",
	permissionPreset: "auto",
};
const BODY = ['{"type":"message","id":"a"}'];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("migrateLegacySessionModes", () => {
	it("strips the retired mode field from session and agent journals only", () => {
		const directory = agentDir();
		const session = journal(directory, "sessions/--work--/a.jsonl", { ...HEADER, mode: "code" }, BODY);
		const archived = journal(directory, "sessions/.archive/--work--/b.jsonl", { ...HEADER, mode: "chat" }, BODY);
		const agent = journal(directory, "agents/root/c.jsonl", { ...HEADER, mode: "code" }, BODY);
		const untouched = journal(directory, "sessions/--work--/d.jsonl", HEADER, BODY);

		expect(migrateLegacySessionModes(directory)).toEqual({ scanned: 4, migrated: 3, failed: [] });

		for (const path of [session, archived, agent]) {
			const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
			expect(header).not.toHaveProperty("mode");
			expect(header.permissionPreset).toBe("auto");
			expect(readFileSync(path, "utf8")).toContain('{"type":"message","id":"a"}');
		}
		expect(readFileSync(untouched, "utf8")).toBe(`${JSON.stringify(HEADER)}\n${BODY.join("\n")}\n`);
	});

	it("is idempotent", () => {
		const directory = agentDir();
		journal(directory, "sessions/--work--/a.jsonl", { ...HEADER, mode: "code" }, BODY);
		expect(migrateLegacySessionModes(directory).migrated).toBe(1);
		expect(migrateLegacySessionModes(directory)).toEqual({ scanned: 1, migrated: 0, failed: [] });
	});

	it("leaves unreadable journals in the failed list instead of throwing", () => {
		const directory = agentDir();
		const broken = journal(directory, "sessions/--work--/broken.jsonl", HEADER, BODY);
		writeFileSync(broken, "{not json\n");
		journal(directory, "sessions/--work--/ok.jsonl", { ...HEADER, mode: "chat" }, BODY);

		const result = migrateLegacySessionModes(directory);
		expect(result.migrated).toBe(1);
		expect(result.failed).toEqual([broken]);
	});

	it("returns an empty result when the agent directory has no journals", () => {
		expect(migrateLegacySessionModes(agentDir())).toEqual({ scanned: 0, migrated: 0, failed: [] });
	});
});
