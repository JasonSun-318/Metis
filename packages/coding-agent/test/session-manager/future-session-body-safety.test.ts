import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UnsupportedSessionVersionError } from "../../src/core/session-journal.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("future session body safety", () => {
	it.each([
		["open", "unknown record\n"],
		["open", "{unfinished future tail"],
		["readOnly", "unknown record\n"],
		["readOnly", "{unfinished future tail"],
		["fork", "unknown record\n"],
		["fork", "{unfinished future tail"],
	] as const)("rejects %s before interpreting or repairing body %j", (operation, body) => {
		const directory = mkdtempSync(join(tmpdir(), "metis-future-session-safety-"));
		directories.push(directory);
		const file = join(directory, "future.jsonl");
		const destination = join(directory, "fork-storage");
		const bytes = Buffer.from(
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION + 1,
				id: "11111111-1111-4111-8111-111111111111",
				timestamp: "2026-10-28T12:00:00.000Z",
				cwd: directory,
				mode: "code",
				cwdOrigin: "user-selected",
				permissionPreset: "ask",
			})}\n${body}`,
		);
		writeFileSync(file, bytes);
		try {
			expect(() => {
				if (operation === "readOnly") {
					SessionManager.openReadOnly(file);
					return;
				}
				const manager =
					operation === "open" ? SessionManager.open(file) : SessionManager.forkFrom(file, directory, destination);
				manager.close();
			}).toThrow(UnsupportedSessionVersionError);
		} finally {
			// A classification error must never trigger tail repair or create a fork.
			expect(readFileSync(file)).toEqual(bytes);
			expect(existsSync(join(directory, ".recovery"))).toBe(false);
			expect(existsSync(destination)).toBe(false);
		}
	});
	it.each([
		[true, "\n"],
		[true, ""],
		[false, "\n"],
		[false, ""],
	] as const)(
		"preserves future replacement candidates with canonical=%s and delimiter=%j",
		(canonicalExists, delimiter) => {
			const directory = mkdtempSync(join(tmpdir(), "metis-future-artifact-safety-"));
			directories.push(directory);
			const file = join(directory, "future.jsonl");
			const header = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "11111111-1111-4111-8111-111111111111",
				timestamp: "2026-10-28T12:00:00.000Z",
				cwd: directory,
				mode: "code",
				cwdOrigin: "user-selected",
				permissionPreset: "ask",
			};
			const current = `${JSON.stringify(header)}\n`;
			if (canonicalExists) writeFileSync(file, current);
			const artifact = join(directory, ".future.jsonl.22222222-2222-4222-8222-222222222222.replace.tmp");
			const future = JSON.stringify({ ...header, version: CURRENT_SESSION_VERSION + 1 }) + delimiter;
			writeFileSync(artifact, future);
			expect(() => {
				const manager = SessionManager.open(file);
				manager.close();
			}).toThrow(UnsupportedSessionVersionError);
			expect(existsSync(file)).toBe(canonicalExists);
			if (canonicalExists) expect(readFileSync(file, "utf8")).toBe(current);
			expect(readFileSync(artifact, "utf8")).toBe(future);
		},
	);
});
