import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionId } from "../../src/core/session-id.ts";
import { CorruptSessionError, UnsupportedSessionVersionError } from "../../src/core/session-journal.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeJournal(directory: string, name: string, header: Record<string, unknown>, body = ""): string {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, name);
	writeFileSync(path, `${JSON.stringify(header)}\n${body}`);
	return path;
}

function futureHeader(directory: string, version: number): Record<string, unknown> {
	return {
		type: "session",
		version,
		id: createSessionId(),
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: directory,
		mode: "code",
		cwdOrigin: "user-selected",
	};
}

describe("UnsupportedSessionVersionError", () => {
	it("distinguishes a future journal version from a corrupt journal", () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-unsupported-version-"));
		directories.push(directory);
		const path = writeJournal(directory, "future.jsonl", futureHeader(directory, CURRENT_SESSION_VERSION + 1));

		let error: unknown;
		try {
			SessionManager.open(path);
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(UnsupportedSessionVersionError);
		const typed = error as UnsupportedSessionVersionError;
		expect(typed.found).toBe(CURRENT_SESSION_VERSION + 1);
		expect(typed.supported).toBe(CURRENT_SESSION_VERSION);
		expect(typed.filePath).toBe(realpathSync(path));
		expect(typed.name).toBe("UnsupportedSessionVersionError");
	});

	it("keeps strict CorruptSessionError validation for malformed versions", () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-unsupported-version-"));
		directories.push(directory);
		for (const version of [0, -1, 1.5, "16", null]) {
			const path = writeJournal(directory, `invalid-${String(version)}.jsonl`, {
				...futureHeader(directory, CURRENT_SESSION_VERSION + 1),
				version,
			});
			expect(() => SessionManager.open(path)).toThrow(CorruptSessionError);
		}
	});

	it("never modifies a future-format journal", () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-unsupported-version-"));
		directories.push(directory);
		const body = `${JSON.stringify({ type: "message", id: "m1", unknownField: { nested: true } })}\n`;
		const path = writeJournal(directory, "future.jsonl", futureHeader(directory, CURRENT_SESSION_VERSION + 1), body);
		const before = readFileSync(path);

		expect(() => SessionManager.openReadOnly(path)).toThrow(UnsupportedSessionVersionError);
		expect(() => SessionManager.open(path)).toThrow(UnsupportedSessionVersionError);

		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("refuses a future header without a trailing newline without truncating it", () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-unsupported-version-"));
		directories.push(directory);
		const path = join(directory, "future.jsonl");
		mkdirSync(directory, { recursive: true });
		const bytes = Buffer.from(`${JSON.stringify(futureHeader(directory, CURRENT_SESSION_VERSION + 1))}`);
		writeFileSync(path, bytes);

		expect(() => SessionManager.open(path)).toThrow(UnsupportedSessionVersionError);
		expect(() => SessionManager.openReadOnly(path)).toThrow(UnsupportedSessionVersionError);
		expect(readFileSync(path).equals(bytes)).toBe(true);
	});

	it("preserves a future-format journal and its replacement artifacts", () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-unsupported-version-"));
		directories.push(directory);
		const path = writeJournal(
			directory,
			"future.jsonl",
			futureHeader(directory, CURRENT_SESSION_VERSION + 1),
			`${JSON.stringify({ type: "message", id: "m1" })}\n`,
		);
		const before = readFileSync(path);
		const recovery = join(directory, ".recovery");
		mkdirSync(recovery, { recursive: true });
		const artifact = join(recovery, `future.jsonl-1-11111111-1111-4111-8111-111111111111.partial`);
		const artifactBytes = Buffer.from(`${JSON.stringify(futureHeader(directory, CURRENT_SESSION_VERSION + 1))}\n`);
		writeFileSync(artifact, artifactBytes);

		expect(() => SessionManager.open(path)).toThrow(UnsupportedSessionVersionError);

		expect(readFileSync(path).equals(before)).toBe(true);
		expect(existsSync(artifact)).toBe(true);
		expect(readFileSync(artifact).equals(artifactBytes)).toBe(true);
	});
});
