import { execFileSync, spawnSync } from "node:child_process";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getOwnedSessionJournalArtifacts,
	openSessionJournal,
	SessionJournalPoisonedError,
} from "../../src/core/session-journal.ts";

describe("session journal", () => {
	let directory: string;
	let path: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arcmind-session-journal-"));
		path = join(directory, "session.jsonl");
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("creates and reads an empty journal", () => {
		let guardedMutations = 0;
		const journal = openSessionJournal(path, {
			create: true,
			runExclusiveMutation: (mutation) => {
				guardedMutations++;
				return mutation();
			},
		});
		expect(journal.readStrict()).toEqual({ records: [], recovery: { status: "clean" } });
		expect(guardedMutations).toBe(1);
		journal.close();
	});

	it("reads a header-only journal", () => {
		const header = { type: "session", version: 4, id: "session-1" };
		const journal = openSessionJournal(path, { create: true, initialRecords: [header] });

		expect(journal.readStrict()).toEqual({ records: [header], recovery: { status: "clean" } });
	});

	it("keeps a read-only snapshot stable across a writer append", () => {
		const initial = { id: "initial" };
		const appended = { id: "appended" };
		writeFileSync(path, `${JSON.stringify(initial)}\n`);
		const reader = openSessionJournal(path, { readOnly: true });
		const writer = openSessionJournal(path);

		writer.append(appended);
		expect(reader.readStrict().records).toEqual([initial]);
		expect(reader.readStrict().records).toEqual([initial]);
		reader.close();
		writer.close();

		const laterReader = openSessionJournal(path, { readOnly: true });
		expect(laterReader.readStrict().records).toEqual([initial, appended]);
		laterReader.close();
	});

	it("uses exclusive creation", () => {
		openSessionJournal(path, { create: true }).close();

		expect(() => openSessionJournal(path, { create: true })).toThrowError(
			expect.objectContaining({ code: "EEXIST" }),
		);
	});

	it("rejects a hard-linked canonical journal that could bypass path-based writer leases", () => {
		writeFileSync(path, `${JSON.stringify({ type: "session", version: 4, id: "session-1" })}\n`);
		linkSync(path, join(directory, "alias.jsonl"));

		expect(() => openSessionJournal(path)).toThrow("single-link regular file");
		expect(() => openSessionJournal(join(directory, "alias.jsonl"))).toThrow("single-link regular file");
	});

	it.skipIf(process.platform === "win32")("fails closed without blocking on a FIFO journal", () => {
		execFileSync("mkfifo", [path]);
		const moduleUrl = new URL("../../src/core/session-journal.ts", import.meta.url).href;
		const source = `
			import { openSessionJournal } from ${JSON.stringify(moduleUrl)};
			try {
				openSessionJournal(process.argv[1], { readOnly: true });
				process.exit(2);
			} catch {
				process.exit(0);
			}
		`;
		const child = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "--eval", source, path],
			{ timeout: 10_000 },
		);

		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
	});

	it("poisons the writer instead of appending after the canonical inode is replaced", () => {
		const original = `${JSON.stringify({ id: "original" })}\n`;
		const replacement = `${JSON.stringify({ id: "replacement" })}\n`;
		const replacementPath = join(directory, "replacement.jsonl");
		writeFileSync(path, original);
		const journal = openSessionJournal(path);
		writeFileSync(replacementPath, replacement);
		renameSync(replacementPath, path);

		expect(() => journal.append({ id: "must-not-append" })).toThrow("identity changed after open");
		expect(readFileSync(path, "utf8")).toBe(replacement);
		expect(() => journal.append({ id: "still-forbidden" })).toThrow(SessionJournalPoisonedError);
	});

	it("poisons the writer after an in-place canonical size change", () => {
		const original = `${JSON.stringify({ id: "original" })}\n`;
		const replacement = `${JSON.stringify({ id: "externally-truncated" })}\n`;
		writeFileSync(path, original);
		const journal = openSessionJournal(path);
		writeFileSync(path, replacement);

		expect(() => journal.append({ id: "must-not-append" })).toThrow("identity changed after open");
		expect(readFileSync(path, "utf8")).toBe(replacement);
		expect(() => journal.replaceAtomically([])).toThrow(SessionJournalPoisonedError);
	});

	it("supports a serializer and JSON reviver", () => {
		const journal = openSessionJournal<{ at: Date }>(path, {
			create: true,
			serializer: (record) => JSON.stringify({ at: record.at.toISOString() }),
			reviver: (key, value) => (key === "at" && typeof value === "string" ? new Date(value) : value),
		});
		const at = new Date("2026-07-16T00:00:00.000Z");
		journal.append({ at });

		expect(journal.readStrict().records).toEqual([{ at }]);
	});

	it("runs create, append, and replacement serializers inside their mutation guard", () => {
		let insideGuard = false;
		let guardCalls = 0;
		let serializerCalls = 0;
		const journal = openSessionJournal<{ id: string }>(path, {
			create: true,
			initialRecords: [{ id: "initial" }],
			serializer: (record) => {
				expect(insideGuard).toBe(true);
				serializerCalls++;
				return JSON.stringify(record);
			},
			runExclusiveMutation: (mutation) => {
				guardCalls++;
				insideGuard = true;
				try {
					return mutation();
				} finally {
					insideGuard = false;
				}
			},
		});

		journal.append({ id: "append" });
		journal.replaceAtomically([{ id: "replacement" }]);
		expect({ guardCalls, serializerCalls }).toEqual({ guardCalls: 3, serializerCalls: 3 });
	});

	it("poisons the journal when fenced serialization fails", () => {
		writeFileSync(path, "");
		let insideGuard = false;
		const serializationFailure = new Error("injected serializer failure");
		const journal = openSessionJournal(path, {
			serializer: () => {
				expect(insideGuard).toBe(true);
				throw serializationFailure;
			},
			runExclusiveMutation: (mutation) => {
				insideGuard = true;
				try {
					return mutation();
				} finally {
					insideGuard = false;
				}
			},
		});

		expect(() => journal.append({ id: "one" })).toThrow(serializationFailure);
		expect(() => journal.append({ id: "two" })).toThrow(SessionJournalPoisonedError);
	});

	it("strictly reads a record split across multiple filesystem chunks", () => {
		const record = { id: "large", text: `${"a".repeat(70 * 1024)}中文🙂` };
		writeFileSync(path, `${JSON.stringify(record)}\n`);

		expect(openSessionJournal(path).readStrict().records).toEqual([record]);
	});

	it("throws on sync failure and poisons the journal", () => {
		writeFileSync(path, "");
		const syncFailure = new Error("injected sync failure");
		const journal = openSessionJournal(path, {
			hooks: {
				syncFile: () => {
					throw syncFailure;
				},
			},
		});

		expect(() => journal.append({ id: "one" })).toThrow(syncFailure);
		expect(() => journal.append({ id: "two" })).toThrow(SessionJournalPoisonedError);
	});

	it("rolls back a failed replacement rename and preserves the canonical file", () => {
		const original = `${JSON.stringify({ type: "session", id: "original" })}\n`;
		writeFileSync(path, original);
		let renameCalls = 0;
		const journal = openSessionJournal(path, {
			hooks: {
				rename: (source, destination) => {
					renameCalls++;
					if (renameCalls === 2) throw new Error("injected rename failure");
					renameSync(source, destination);
				},
			},
		});

		expect(() => journal.replaceAtomically([{ type: "session", id: "replacement" }])).toThrow(
			"injected rename failure",
		);
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(readdirSync(directory).filter((name) => name !== "session.jsonl")).toEqual([]);
	});

	it("replaces all records and keeps the journal appendable", () => {
		const journal = openSessionJournal(path, { create: true });
		journal.append({ id: "old" });
		journal.replaceAtomically([{ id: "new" }]);
		journal.append({ id: "after" });

		expect(journal.readStrict().records).toEqual([{ id: "new" }, { id: "after" }]);
		expect(readdirSync(directory)).toEqual(["session.jsonl"]);
	});

	it("retains a tagged, versioned backup when requested", () => {
		const journal = openSessionJournal(path, { create: true, initialRecords: [{ version: 3 }] });

		journal.replaceAtomically([{ version: 4 }], { backupTag: "v3" });

		const backup = readdirSync(directory).find((name) => name.includes(".keep-v3."));
		expect(backup).toMatch(/\.replace\.bak$/);
		expect(readFileSync(join(directory, backup!), "utf8")).toBe(`${JSON.stringify({ version: 3 })}\n`);
		expect(journal.readStrict().records).toEqual([{ version: 4 }]);
	});

	it("enumerates only exact journal replacement and recovery artifacts", () => {
		const transaction = "12345678-1234-4234-8234-123456789abc";
		writeFileSync(path, "{}\n");
		const recovery = join(directory, ".recovery");
		mkdirSync(recovery);
		const owned = [
			join(directory, `.session.jsonl.${transaction}.replace.tmp`),
			join(directory, `.session.jsonl.keep-v11.${transaction}.replace.bak`),
			join(recovery, `session-42-${transaction}.partial`),
			join(recovery, "session.jsonl.42.nonce.reclaim.json"),
		];
		for (const artifact of owned) writeFileSync(artifact, "owned");
		const leaseArtifact = join(recovery, "session.jsonl.42.nonce.lease");
		mkdirSync(leaseArtifact);
		writeFileSync(join(directory, ".session.jsonl.invalid.replace.tmp"), "lookalike");
		writeFileSync(join(recovery, "session-not-owned.partial"), "lookalike");

		expect(getOwnedSessionJournalArtifacts(path)).toEqual([...owned, leaseArtifact].sort());
	});
});
