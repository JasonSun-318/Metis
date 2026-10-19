import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDefaultSessionDir,
	getSessionDisplayMetadataPath,
	migrateSessionDisplayMetadata,
	moveSessionFileWithLease,
	readSessionDisplayMetadata,
	SessionManager,
} from "../../src/core/session-manager.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_NAME_BYTES = MAX_METADATA_BYTES / 2;

let directory: string;
const openManagers: SessionManager[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "metis-phase2-display-metadata-"));
});

afterEach(() => {
	for (const manager of openManagers.splice(0)) {
		manager.close();
	}
	rmSync(directory, { recursive: true, force: true });
});

function displayMetadataPath(sessionFile: string): string {
	return getSessionDisplayMetadataPath(sessionFile);
}

function writeMetadataText(sessionFile: string, text: string): void {
	writeFileSync(displayMetadataPath(sessionFile), text);
}

function writeMetadataValue(sessionFile: string, value: unknown): void {
	writeMetadataText(sessionFile, `${JSON.stringify(value)}\n`);
}

function createPersistedSession(): {
	manager: SessionManager;
	sessionFile: string;
	sidecar: string;
} {
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir), { id: SESSION_ID });
	openManagers.push(manager);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	return { manager, sessionFile, sidecar: displayMetadataPath(sessionFile) };
}

type ExpectedFingerprint = {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
};

function fingerprint(sessionFile: string): ExpectedFingerprint {
	const stats = lstatSync(sessionFile);
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
	};
}

function canonicalMetadata(
	name: string | null,
	flags: { useMemory?: boolean; contributeMemory?: boolean } = {},
): string {
	return `${JSON.stringify({
		version: 1,
		sessionId: SESSION_ID,
		name,
		...(flags.useMemory === false ? { useMemory: false } : {}),
		...(flags.contributeMemory === false ? { contributeMemory: false } : {}),
	})}\n`;
}

describe("readSessionDisplayMetadata compatibility", () => {
	it("reads version 1 metadata with an explicit null name and ignores unknown fields", () => {
		const sessionFile = join(directory, "session.jsonl");
		writeMetadataValue(sessionFile, {
			version: 1,
			sessionId: SESSION_ID,
			name: null,
			future: "ignored",
		});

		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID });
	});

	it("rejects a missing name but accepts null and empty names", () => {
		const sessionFile = join(directory, "session.jsonl");

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID });
		expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: null });
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID });

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: "" });
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID });
	});

	it("trims the read name but preserves embedded CR and LF characters", () => {
		const sessionFile = join(directory, "session.jsonl");

		writeMetadataValue(sessionFile, {
			version: 1,
			sessionId: SESSION_ID,
			name: "  alpha\r\nbeta  ",
		});
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({
			sessionId: SESSION_ID,
			name: "alpha\r\nbeta",
		});

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: " alpha\n beta " });
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({
			sessionId: SESSION_ID,
			name: "alpha\n beta",
		});

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: " \r\n\t " });
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID });
	});

	it("keeps only exact false memory flags", () => {
		const sessionFile = join(directory, "session.jsonl");

		writeMetadataValue(sessionFile, {
			version: 1,
			sessionId: SESSION_ID,
			name: "named",
			useMemory: false,
			contributeMemory: false,
		});
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({
			sessionId: SESSION_ID,
			name: "named",
			useMemory: false,
			contributeMemory: false,
		});

		writeMetadataValue(sessionFile, {
			version: 1,
			sessionId: SESSION_ID,
			name: "named",
			useMemory: true,
			contributeMemory: "false",
		});
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID, name: "named" });

		writeMetadataValue(sessionFile, {
			version: 1,
			sessionId: SESSION_ID,
			name: "named",
			useMemory: false,
			contributeMemory: 0,
		});
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({
			sessionId: SESSION_ID,
			name: "named",
			useMemory: false,
		});
	});

	it.each([
		["malformed JSON", "{not json\n"],
		["empty file", ""],
		["JSON null", "null\n"],
		["JSON array", "[]\n"],
		["missing version", `${JSON.stringify({ sessionId: SESSION_ID, name: null })}\n`],
		["future version", `${JSON.stringify({ version: 2, sessionId: SESSION_ID, name: null })}\n`],
		["string version", `${JSON.stringify({ version: "1", sessionId: SESSION_ID, name: null })}\n`],
		["missing session id", `${JSON.stringify({ version: 1, name: null })}\n`],
		["invalid session id", `${JSON.stringify({ version: 1, sessionId: "bad id", name: null })}\n`],
		["numeric name", `${JSON.stringify({ version: 1, sessionId: SESSION_ID, name: 42 })}\n`],
		["trailing content", `${JSON.stringify({ version: 1, sessionId: SESSION_ID, name: null })} trailing\n`],
	])("rejects %s", (_label, text) => {
		const sessionFile = join(directory, "session.jsonl");
		writeMetadataText(sessionFile, text);
		expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();
	});

	it("enforces the 8192 UTF-8 byte read name limit", () => {
		const sessionFile = join(directory, "session.jsonl");

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: "a".repeat(MAX_NAME_BYTES) });
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({
			sessionId: SESSION_ID,
			name: "a".repeat(MAX_NAME_BYTES),
		});

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: "a".repeat(MAX_NAME_BYTES + 1) });
		expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: "é".repeat(MAX_NAME_BYTES / 2) });
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({
			sessionId: SESSION_ID,
			name: "é".repeat(MAX_NAME_BYTES / 2),
		});

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: "é".repeat(MAX_NAME_BYTES / 2 + 1) });
		expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();
	});

	it("applies trim before the 8192-byte read name limit", () => {
		const sessionFile = join(directory, "session.jsonl");
		const paddedName = `${" ".repeat(5000)}a${" ".repeat(5000)}`;

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: paddedName });
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID, name: "a" });
	});

	it("reads exactly 16384 bytes but rejects a file one byte over", () => {
		const sessionFile = join(directory, "session.jsonl");
		const emptyValue = `${JSON.stringify({ version: 1, sessionId: SESSION_ID, name: null, padding: "" })}\n`;
		const paddingBytes = MAX_METADATA_BYTES - Buffer.byteLength(emptyValue);
		const boundaryText = `${JSON.stringify({
			version: 1,
			sessionId: SESSION_ID,
			name: null,
			padding: "x".repeat(paddingBytes),
		})}\n`;
		expect(Buffer.byteLength(boundaryText)).toBe(MAX_METADATA_BYTES);

		writeMetadataText(sessionFile, boundaryText);
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID });

		writeMetadataText(sessionFile, `${boundaryText}x`);
		expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();
	});

	it("returns undefined for a missing, symlinked, hard-linked or non-file sidecar", () => {
		const sessionFile = join(directory, "session.jsonl");
		const sidecar = displayMetadataPath(sessionFile);

		expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();

		writeMetadataValue(sessionFile, { version: 1, sessionId: SESSION_ID, name: "linked" });
		const alias = join(directory, "metadata-alias.json");
		linkSync(sidecar, alias);
		expect(lstatSync(sidecar).nlink).toBe(2);
		expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();
		unlinkSync(alias);

		const target = join(directory, "metadata-target.json");
		writeFileSync(target, canonicalMetadata(null));
		unlinkSync(sidecar);
		if (process.platform !== "win32") {
			symlinkSync(target, sidecar);
			expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();
			unlinkSync(sidecar);
		}

		mkdirSync(sidecar);
		expect(readSessionDisplayMetadata(sessionFile)).toBeUndefined();
	});
});

describe("SessionManager display metadata serialization compatibility", () => {
	it("normalizes a historical journal name when a later metadata update writes the sidecar", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.close();
		const info = {
			type: "session_info",
			id: "legacy-info",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			name: "Legacy\r\nName",
		};
		writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf8")}${JSON.stringify(info)}\n`);
		const reopened = SessionManager.open(sessionFile);
		openManagers.push(reopened);

		reopened.setMemoryFlags({ useMemory: false });

		expect(readFileSync(sidecar, "utf8")).toBe(canonicalMetadata("Legacy Name", { useMemory: false }));
	});

	it("moves the metadata bytes with the journal and removes the original sidecar", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.appendSessionInfo("Moved Title");
		manager.setMemoryFlags({ contributeMemory: false });
		const bytes = readFileSync(sidecar);
		manager.close();
		const destination = join(directory, "moved.jsonl");

		moveSessionFileWithLease(sessionFile, destination);

		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(sidecar)).toBe(false);
		expect(readFileSync(displayMetadataPath(destination))).toEqual(bytes);
		expect(readSessionDisplayMetadata(destination)).toEqual({
			sessionId: SESSION_ID,
			name: "Moved Title",
			contributeMemory: false,
		});
	});

	it("writes an explicit null name and one trailing newline on create", () => {
		const { sessionFile, sidecar } = createPersistedSession();

		expect(readFileSync(sidecar, "utf8")).toBe(canonicalMetadata(null));
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID });
	});

	it("persists a trimmed, CRLF-free name in canonical field order", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();

		manager.appendSessionInfo("  alpha\r\nbeta  ");

		expect(readFileSync(sidecar, "utf8")).toBe(canonicalMetadata("alpha beta"));
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID, name: "alpha beta" });
	});

	it("writes null for a blank name and omits the name on read", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();

		manager.appendSessionInfo(" \r\n\t ");

		expect(readFileSync(sidecar, "utf8")).toBe(canonicalMetadata(null));
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID });
	});

	it("writes exact false memory flags after the name", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.appendSessionInfo("named");

		manager.setMemoryFlags({ useMemory: false, contributeMemory: false });

		expect(readFileSync(sidecar, "utf8")).toBe(
			canonicalMetadata("named", { useMemory: false, contributeMemory: false }),
		);
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({
			sessionId: SESSION_ID,
			name: "named",
			useMemory: false,
			contributeMemory: false,
		});

		manager.setMemoryFlags({ useMemory: true, contributeMemory: true });
		expect(readFileSync(sidecar, "utf8")).toBe(canonicalMetadata("named"));
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID, name: "named" });
	});

	it("restores only exact false memory flags when the session is reopened", () => {
		const { manager, sessionFile } = createPersistedSession();
		manager.setMemoryFlags({ useMemory: false, contributeMemory: false });
		manager.close();

		const reopened = SessionManager.open(sessionFile);
		openManagers.push(reopened);
		expect(reopened.getUseMemory()).toBe(false);
		expect(reopened.getContributeMemory()).toBe(false);

		writeMetadataValue(sessionFile, {
			version: 1,
			sessionId: SESSION_ID,
			name: null,
			useMemory: true,
			contributeMemory: "false",
		});
		const reset = SessionManager.openReadOnly(sessionFile);
		expect(reset.getUseMemory()).toBe(true);
		expect(reset.getContributeMemory()).toBe(true);
	});
});

describe("migrateSessionDisplayMetadata compatibility", () => {
	it("writes sanitized metadata and leaves the journal bytes and stat untouched", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.close();
		const journalBefore = readFileSync(sessionFile);
		const statsBefore = lstatSync(sessionFile);

		const migrated = migrateSessionDisplayMetadata(sessionFile, {
			...fingerprint(sessionFile),
			sessionId: SESSION_ID,
			name: "  alpha\r\nbeta  ",
			useMemory: false,
			contributeMemory: false,
		});

		expect(migrated).toBe(true);
		expect(readFileSync(sidecar, "utf8")).toBe(
			canonicalMetadata("alpha beta", { useMemory: false, contributeMemory: false }),
		);
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({
			sessionId: SESSION_ID,
			name: "alpha beta",
			useMemory: false,
			contributeMemory: false,
		});
		expect(readFileSync(sessionFile)).toEqual(journalBefore);
		const statsAfter = lstatSync(sessionFile);
		expect({
			dev: statsAfter.dev,
			ino: statsAfter.ino,
			size: statsAfter.size,
			mtimeMs: statsAfter.mtimeMs,
			ctimeMs: statsAfter.ctimeMs,
		}).toEqual({
			dev: statsBefore.dev,
			ino: statsBefore.ino,
			size: statsBefore.size,
			mtimeMs: statsBefore.mtimeMs,
			ctimeMs: statsBefore.ctimeMs,
		});
	});

	it("returns false while a writer lease is active", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		const initialSidecar = readFileSync(sidecar, "utf8");

		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				...fingerprint(sessionFile),
				sessionId: SESSION_ID,
				name: "leased",
			}),
		).toBe(false);
		expect(readFileSync(sidecar, "utf8")).toBe(initialSidecar);
		expect(manager.getSessionName()).toBeUndefined();
	});

	it("returns false without replacing the sidecar when the journal identity is stale", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.close();
		const sentinel = canonicalMetadata("sentinel");
		writeFileSync(sidecar, sentinel);
		const expected = fingerprint(sessionFile);

		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				...expected,
				ino: expected.ino + 1,
				sessionId: SESSION_ID,
				name: "replaced",
			}),
		).toBe(false);
		expect(readFileSync(sidecar, "utf8")).toBe(sentinel);
		expect(readSessionDisplayMetadata(sessionFile)).toEqual({ sessionId: SESSION_ID, name: "sentinel" });
	});

	it("returns false for an invalid session id and does not create a sidecar", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.close();
		unlinkSync(sidecar);

		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				...fingerprint(sessionFile),
				sessionId: "bad id",
				name: "invalid",
			}),
		).toBe(false);
		expect(existsSync(sidecar)).toBe(false);
	});

	it("returns false for a missing journal", () => {
		const sessionFile = join(directory, "missing.jsonl");
		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				dev: 0,
				ino: 0,
				size: 0,
				mtimeMs: 0,
				ctimeMs: 0,
				sessionId: SESSION_ID,
				name: "missing",
			}),
		).toBe(false);
	});

	it("applies CRLF replacement and trim before the write size limit", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.close();
		const oversizedRawName = `${"\r\n".repeat(9000)}a${"\r\n".repeat(9000)}`;
		expect(Buffer.byteLength(oversizedRawName)).toBeGreaterThan(MAX_METADATA_BYTES);

		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				...fingerprint(sessionFile),
				sessionId: SESSION_ID,
				name: oversizedRawName,
			}),
		).toBe(true);
		expect(readFileSync(sidecar, "utf8")).toBe(canonicalMetadata("a"));
	});

	it("accepts exactly 16384 serialized bytes but not one byte more", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.close();
		const emptyLine = canonicalMetadata("");
		const nameBytes = MAX_METADATA_BYTES - Buffer.byteLength(emptyLine);
		const boundaryName = "x".repeat(nameBytes);

		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				...fingerprint(sessionFile),
				sessionId: SESSION_ID,
				name: boundaryName,
			}),
		).toBe(true);
		const boundaryBytes = readFileSync(sidecar);
		expect(boundaryBytes.byteLength).toBe(MAX_METADATA_BYTES);
		expect(boundaryBytes.toString("utf8")).toBe(canonicalMetadata(boundaryName));
		expect(boundaryBytes.at(-1)).toBe(0x0a);
		expect(boundaryBytes.at(-2)).not.toBe(0x0a);

		unlinkSync(sidecar);
		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				...fingerprint(sessionFile),
				sessionId: SESSION_ID,
				name: `${boundaryName}x`,
			}),
		).toBe(false);
		expect(existsSync(sidecar)).toBe(false);
	});

	it("counts UTF-8 bytes rather than code units at the write boundary", () => {
		const { manager, sessionFile, sidecar } = createPersistedSession();
		manager.close();
		const emptyLine = canonicalMetadata("");
		const nameBytes = MAX_METADATA_BYTES - Buffer.byteLength(emptyLine);
		const boundaryName = `${"é".repeat(Math.floor((nameBytes - 1) / 2))}a`;
		expect(Buffer.byteLength(boundaryName)).toBe(nameBytes);

		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				...fingerprint(sessionFile),
				sessionId: SESSION_ID,
				name: boundaryName,
			}),
		).toBe(true);
		expect(readFileSync(sidecar).byteLength).toBe(MAX_METADATA_BYTES);

		unlinkSync(sidecar);
		expect(
			migrateSessionDisplayMetadata(sessionFile, {
				...fingerprint(sessionFile),
				sessionId: SESSION_ID,
				name: `${boundaryName}a`,
			}),
		).toBe(false);
		expect(existsSync(sidecar)).toBe(false);
	});
});
