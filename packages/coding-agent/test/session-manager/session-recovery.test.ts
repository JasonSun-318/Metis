import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CorruptSessionError,
	openSessionJournal,
	SessionJournalPoisonedError,
} from "../../src/core/session-journal.ts";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";

describe("session journal recovery", () => {
	let directory: string;
	let path: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "metis-session-recovery-"));
		path = join(directory, "session.jsonl");
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("repairs every byte boundary in the final record", () => {
		const header = { type: "session", version: 4, id: "session-1" };
		const record = { type: "message", id: "entry-1", text: "中文🙂" };
		const completePrefix = Buffer.from(`${JSON.stringify(header)}\n`);
		const finalRecord = Buffer.from(`${JSON.stringify(record)}\n`);

		for (let boundary = 0; boundary < finalRecord.byteLength; boundary++) {
			const candidatePath = join(directory, `session-${boundary}.jsonl`);
			const partial = finalRecord.subarray(0, boundary);
			writeFileSync(candidatePath, Buffer.concat([completePrefix, partial]));
			const journal = openSessionJournal(candidatePath);

			const result = journal.readStrict();
			expect(result.records, `boundary ${boundary}`).toEqual([header]);
			expect(readFileSync(candidatePath), `boundary ${boundary}`).toEqual(completePrefix);
			if (boundary === 0) {
				expect(result.recovery).toEqual({ status: "clean" });
			} else {
				expect(result.recovery, `boundary ${boundary}`).toMatchObject({
					status: "tail_repaired",
					discardedBytes: boundary,
				});
				if (result.recovery.status !== "tail_repaired") throw new Error("Expected tail repair");
				expect(readFileSync(result.recovery.artifactPath), `boundary ${boundary}`).toEqual(partial);
			}
			journal.close();
		}
	});

	it("treats a valid final record without LF as an uncommitted tail", () => {
		const header = { type: "session", id: "session-1" };
		const tail = Buffer.from(JSON.stringify({ type: "message", id: "complete-json" }));
		const prefix = Buffer.from(`${JSON.stringify(header)}\n`);
		writeFileSync(path, Buffer.concat([prefix, tail]));

		const result = openSessionJournal(path).readStrict();

		expect(result.records).toEqual([header]);
		expect(result.recovery).toMatchObject({ status: "tail_repaired", discardedBytes: tail.byteLength });
		expect(readFileSync(path)).toEqual(prefix);
	});

	it("can report an incomplete tail without repairing the source", () => {
		const original = `${JSON.stringify({ type: "session", id: "session-1" })}\n{"partial"`;
		writeFileSync(path, original);
		const journal = openSessionJournal(path);

		expect(() => journal.readStrict({ repairTail: false })).toThrow(CorruptSessionError);
		expect(() => journal.append({ id: "must-not-join-the-partial-tail" })).toThrow(SessionJournalPoisonedError);
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(existsSync(join(directory, ".recovery"))).toBe(false);
	});

	it("returns the complete prefix for an allowed incomplete tail without mutating it", () => {
		const header = { type: "session", id: "session-1" };
		const partial = '{"partial"';
		const original = `${JSON.stringify(header)}\n${partial}`;
		writeFileSync(path, original);
		const journal = openSessionJournal(path, { readOnly: true });

		expect(journal.readStrict({ allowIncompleteTail: true })).toEqual({
			records: [header],
			recovery: { status: "tail_incomplete", discardedBytes: Buffer.byteLength(partial) },
		});
		expect(readFileSync(path, "utf8")).toBe(original);
		journal.close();
	});

	it("keeps complete-record corruption fatal when incomplete tails are allowed", () => {
		const original = `${JSON.stringify({ id: "header" })}\n{malformed}\n{"partial"`;
		writeFileSync(path, original);
		const journal = openSessionJournal(path, { readOnly: true });

		expect(() => journal.readStrict({ allowIncompleteTail: true })).toThrow(
			expect.objectContaining({ lineNumber: 2 }),
		);
		expect(readFileSync(path, "utf8")).toBe(original);
		journal.close();
	});

	it("poisons a writer after returning an allowed incomplete tail", () => {
		const original = `${JSON.stringify({ id: "header" })}\n{"partial"`;
		writeFileSync(path, original);
		const journal = openSessionJournal(path);

		expect(journal.readStrict({ allowIncompleteTail: true }).recovery.status).toBe("tail_incomplete");
		expect(() => journal.append({ id: "must-not-append" })).toThrow(SessionJournalPoisonedError);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("opens read-only without writer fencing or implicit tail repair", () => {
		const original = `${JSON.stringify({ type: "session", id: "session-1" })}\n{"partial"`;
		writeFileSync(path, original);
		const journal = openSessionJournal(path, {
			readOnly: true,
			runExclusiveMutation: () => {
				throw new Error("read-only open must not acquire writer fencing");
			},
		});

		expect(() => journal.readStrict()).toThrow(CorruptSessionError);
		expect(() => journal.readStrict({ repairTail: true })).toThrow(CorruptSessionError);
		expect(() => journal.append({ id: "forbidden" })).toThrow("read-only session journal");
		expect(() => journal.replaceAtomically([])).toThrow("read-only session journal");
		expect(readFileSync(path, "utf8")).toBe(original);
		journal.close();
	});

	it("preserves a malformed complete line and reports its location", () => {
		const original = `${JSON.stringify({ type: "session", id: "session-1" })}\n{malformed}\n${JSON.stringify({ id: "later" })}\n`;
		writeFileSync(path, original);
		const journal = openSessionJournal(path);

		try {
			journal.readStrict();
			throw new Error("Expected readStrict to reject malformed JSON");
		} catch (error) {
			expect(error).toBeInstanceOf(CorruptSessionError);
			expect(error).toMatchObject({ filePath: path, lineNumber: 2 });
		}
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(existsSync(join(directory, ".recovery"))).toBe(false);
	});

	it("rejects an empty complete line without changing the source", () => {
		const original = `${JSON.stringify({ type: "session", id: "session-1" })}\n\n`;
		writeFileSync(path, original);

		expect(() => openSessionJournal(path).readStrict()).toThrow(
			expect.objectContaining({ filePath: path, lineNumber: 2 }),
		);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("rejects invalid UTF-8 in a complete line without changing the source", () => {
		const original = Buffer.concat([
			Buffer.from(`${JSON.stringify({ type: "session", id: "session-1" })}\n`),
			Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]),
		]);
		writeFileSync(path, original);

		expect(() => openSessionJournal(path).readStrict()).toThrow(
			expect.objectContaining({ filePath: path, lineNumber: 2 }),
		);
		expect(readFileSync(path)).toEqual(original);
	});

	it("rejects a record over the configured byte limit", () => {
		const original = `${JSON.stringify({ id: "larger-than-eight-bytes" })}\n`;
		writeFileSync(path, original);

		expect(() => openSessionJournal(path, { maxRecordBytes: 8 }).readStrict()).toThrow("8 byte limit");
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it.each([
		{ name: "malformed JSON", bytes: Buffer.from("{malformed}\n"), maxRecordBytes: undefined },
		{
			name: "invalid UTF-8",
			bytes: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]),
			maxRecordBytes: undefined,
		},
		{ name: "an oversized record", bytes: Buffer.from('{"id":"too-large"}\n'), maxRecordBytes: 8 },
	])("poisons a writer after reading $name in a complete record", ({ bytes, maxRecordBytes }) => {
		writeFileSync(path, bytes);
		const journal = openSessionJournal(path, { maxRecordBytes });

		expect(() => journal.readStrict()).toThrow(CorruptSessionError);
		expect(() => journal.append({ id: "must-not-append" })).toThrow(SessionJournalPoisonedError);
		expect(() => journal.replaceAtomically([])).toThrow(SessionJournalPoisonedError);
	});

	it("preserves the partial tail byte-for-byte in a recovery artifact", () => {
		const prefix = Buffer.from(`${JSON.stringify({ type: "session", id: "session-1" })}\n`);
		const partial = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xf0, 0x9f]);
		writeFileSync(path, Buffer.concat([prefix, partial]));

		const result = openSessionJournal(path).readStrict();

		if (result.recovery.status !== "tail_repaired") throw new Error("Expected tail repair");
		expect(result.recovery.artifactPath).toContain(`${join(directory, ".recovery", "session-")}`);
		expect(readFileSync(result.recovery.artifactPath)).toEqual(partial);
		expect(readFileSync(path)).toEqual(prefix);
	});

	it("leaves the journal untouched when the recovery artifact cannot be synced", () => {
		const original = `${JSON.stringify({ type: "session", id: "session-1" })}\n{"partial"`;
		writeFileSync(path, original);
		const journal = openSessionJournal(path, {
			hooks: {
				syncFile: () => {
					throw new Error("injected artifact sync failure");
				},
			},
		});

		expect(() => journal.readStrict()).toThrow(CorruptSessionError);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("refuses a symlinked recovery directory before truncating the journal", () => {
		const original = `${JSON.stringify({ type: "session", id: "session-1" })}\n{"partial"`;
		const outside = join(directory, "outside-recovery");
		mkdirSync(outside);
		symlinkSync(outside, join(directory, ".recovery"));
		writeFileSync(path, original);
		const journal = openSessionJournal(path);

		expect(() => journal.readStrict()).toThrow("not a real directory");
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(readdirSync(outside)).toEqual([]);
	});

	it("recovers an interrupted replacement by committing its durable temp", () => {
		const backupPath = join(directory, `.session.jsonl.keep-v3.${TRANSACTION_ID}.replace.bak`);
		const temporaryPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.tmp`);
		writeFileSync(backupPath, `${JSON.stringify({ id: "old" })}\n`);
		writeFileSync(temporaryPath, `${JSON.stringify({ id: "new" })}\n`);
		let guardedMutations = 0;

		const journal = openSessionJournal(path, {
			runExclusiveMutation: (mutation) => {
				guardedMutations++;
				return mutation();
			},
		});

		expect(journal.readStrict().records).toEqual([{ id: "new" }]);
		expect(guardedMutations).toBe(1);
		expect(existsSync(temporaryPath)).toBe(false);
		expect(existsSync(backupPath)).toBe(true);
	});

	it("reopens and commits a recovery-copy temp left before backup publication", () => {
		const backupPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.bak`);
		const recoveryCopyPath = join(directory, `.session.jsonl.recovery-copy-${TRANSACTION_ID}.replace.tmp`);
		const lastGood = `${JSON.stringify({ id: "last-good" })}\n`;
		writeFileSync(backupPath, lastGood);
		writeFileSync(recoveryCopyPath, lastGood);

		const journal = openSessionJournal(path);

		expect(journal.readStrict().records).toEqual([{ id: "last-good" }]);
		expect(existsSync(recoveryCopyPath)).toBe(false);
		expect(existsSync(backupPath)).toBe(false);
	});

	it.each([
		{ name: "an empty file", bytes: Buffer.alloc(0) },
		{ name: "malformed JSON", bytes: Buffer.from("{broken}\n") },
		{ name: "an empty record", bytes: Buffer.from("\n") },
		{
			name: "invalid UTF-8",
			bytes: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]),
		},
		{ name: "an unterminated final record", bytes: Buffer.from('{"id":"new"}') },
	])("quarantines a temp with $name and restores the last valid backup", ({ bytes }) => {
		const backupPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.bak`);
		const temporaryPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.tmp`);
		writeFileSync(backupPath, `${JSON.stringify({ id: "last-good" })}\n`);
		writeFileSync(temporaryPath, bytes);

		const journal = openSessionJournal(path);

		expect(journal.readStrict().records).toEqual([{ id: "last-good" }]);
		const quarantine = readdirSync(directory).find((name) => name.endsWith(".invalid-replacement"));
		expect(quarantine).toBeDefined();
		expect(readFileSync(join(directory, quarantine!))).toEqual(bytes);
		expect(existsSync(temporaryPath)).toBe(false);
		expect(existsSync(backupPath)).toBe(false);
	});

	it("applies the configured record limit before promoting a replacement temp", () => {
		const backupPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.bak`);
		const temporaryPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.tmp`);
		writeFileSync(backupPath, "{}\n");
		writeFileSync(temporaryPath, '{"id":"too-large"}\n');

		const journal = openSessionJournal(path, { maxRecordBytes: 8 });

		expect(journal.readStrict().records).toEqual([{}]);
		expect(readdirSync(directory).some((name) => name.endsWith(".invalid-replacement"))).toBe(true);
	});

	it("restores a semantically valid backup when a JSON-valid temp fails record validation", () => {
		const backupPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.bak`);
		const temporaryPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.tmp`);
		writeFileSync(backupPath, `${JSON.stringify({ id: "last-good" })}\n`);
		writeFileSync(temporaryPath, `${JSON.stringify({ id: "duplicate" })}\n${JSON.stringify({ id: "duplicate" })}\n`);

		const journal = openSessionJournal<{ id: string }>(path, {
			validateRecords: (records) => {
				const ids = records.map((record) => record.id);
				if (new Set(ids).size !== ids.length) throw new Error("duplicate id");
			},
		});

		expect(journal.readStrict().records).toEqual([{ id: "last-good" }]);
		const quarantine = readdirSync(directory).find((name) => name.endsWith(".invalid-replacement"));
		expect(quarantine).toBeDefined();
		expect(readFileSync(join(directory, quarantine!), "utf8")).toContain('"id":"duplicate"');
		expect(existsSync(backupPath)).toBe(false);
	});

	it("keeps every artifact when no strict recovery candidate is valid", () => {
		const backupPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.bak`);
		const temporaryPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.tmp`);
		writeFileSync(backupPath, "{bad-backup}\n");
		writeFileSync(temporaryPath, "{bad-temp}\n");

		expect(() => openSessionJournal(path)).toThrow(CorruptSessionError);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(temporaryPath)).toBe(true);
		expect(existsSync(backupPath)).toBe(true);
	});

	it("keeps recovery artifacts when the existing canonical is not strict JSONL", () => {
		const backupPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.bak`);
		const temporaryPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.tmp`);
		writeFileSync(path, "{broken-canonical}\n");
		writeFileSync(backupPath, `${JSON.stringify({ id: "last-good" })}\n`);
		writeFileSync(temporaryPath, `${JSON.stringify({ id: "replacement" })}\n`);

		const journal = openSessionJournal(path);

		expect(() => journal.readStrict()).toThrow(CorruptSessionError);
		expect(existsSync(temporaryPath)).toBe(true);
		expect(existsSync(backupPath)).toBe(true);
	});

	it("recovers an interrupted replacement by rolling back its only backup", () => {
		const backupPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.bak`);
		writeFileSync(backupPath, `${JSON.stringify({ id: "old" })}\n`);

		const journal = openSessionJournal(path);

		expect(journal.readStrict().records).toEqual([{ id: "old" }]);
		expect(existsSync(backupPath)).toBe(false);
	});

	it("keeps the canonical and backup while cleaning an orphan replacement temp", () => {
		const backupPath = join(directory, `.session.jsonl.keep-v3.${TRANSACTION_ID}.replace.bak`);
		const temporaryPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.tmp`);
		writeFileSync(path, `${JSON.stringify({ id: "canonical" })}\n`);
		writeFileSync(backupPath, `${JSON.stringify({ id: "backup" })}\n`);
		writeFileSync(temporaryPath, `${JSON.stringify({ id: "orphan" })}\n`);

		const journal = openSessionJournal(path);

		expect(journal.readStrict().records).toEqual([{ id: "canonical" }]);
		expect(existsSync(temporaryPath)).toBe(false);
		expect(existsSync(backupPath)).toBe(true);
	});

	it("cleans a transient backup after observing the committed canonical", () => {
		const backupPath = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.bak`);
		writeFileSync(path, `${JSON.stringify({ id: "canonical" })}\n`);
		writeFileSync(backupPath, `${JSON.stringify({ id: "old" })}\n`);

		const journal = openSessionJournal(path);

		expect(journal.readStrict().records).toEqual([{ id: "canonical" }]);
		expect(existsSync(backupPath)).toBe(false);
	});

	it.each(["replace.tmp", "replace.bak"])("rejects a symlinked %s recovery artifact", (suffix) => {
		const outside = join(directory, "outside.jsonl");
		const artifact = join(directory, `.session.jsonl.${TRANSACTION_ID}.${suffix}`);
		const original = `${JSON.stringify({ id: "outside" })}\n`;
		writeFileSync(outside, original);
		symlinkSync(outside, artifact);

		expect(() => openSessionJournal(path)).toThrow("Unsafe session replacement artifact");
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(outside, "utf8")).toBe(original);
	});

	it("rejects a hard-linked recovery artifact", () => {
		const outside = join(directory, "outside.jsonl");
		const artifact = join(directory, `.session.jsonl.${TRANSACTION_ID}.replace.tmp`);
		const original = `${JSON.stringify({ id: "outside" })}\n`;
		writeFileSync(outside, original);
		linkSync(outside, artifact);

		expect(() => openSessionJournal(path)).toThrow("Unsafe session replacement artifact");
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(outside, "utf8")).toBe(original);
	});

	it("does not delete arbitrary helper-like sibling files", () => {
		const temporaryPath = join(directory, ".session.jsonl.notes.replace.tmp");
		const backupPath = join(directory, ".session.jsonl.notes.replace.bak");
		writeFileSync(path, `${JSON.stringify({ id: "canonical" })}\n`);
		writeFileSync(temporaryPath, "unrelated temp");
		writeFileSync(backupPath, "unrelated backup");

		const journal = openSessionJournal(path);
		expect(journal.readStrict().records).toEqual([{ id: "canonical" }]);
		journal.close();

		expect(readFileSync(temporaryPath, "utf8")).toBe("unrelated temp");
		expect(readFileSync(backupPath, "utf8")).toBe("unrelated backup");
	});

	it("does not promote arbitrary helper-like sibling files", () => {
		const temporaryPath = join(directory, ".session.jsonl.notes.replace.tmp");
		const backupPath = join(directory, ".session.jsonl.notes.replace.bak");
		writeFileSync(temporaryPath, `${JSON.stringify({ id: "injected-temp" })}\n`);
		writeFileSync(backupPath, `${JSON.stringify({ id: "injected-backup" })}\n`);

		expect(() => openSessionJournal(path)).toThrow();
		expect(existsSync(path)).toBe(false);
		expect(existsSync(temporaryPath)).toBe(true);
		expect(existsSync(backupPath)).toBe(true);
	});

	it("runs open, append, repair, and replacement mutations through the guard", () => {
		writeFileSync(path, `${JSON.stringify({ id: "header" })}\n{"partial"`);
		let guardedMutations = 0;
		const journal = openSessionJournal(path, {
			runExclusiveMutation: (mutation) => {
				guardedMutations++;
				return mutation();
			},
		});

		journal.readStrict();
		journal.append({ id: "appended" });
		journal.replaceAtomically([{ id: "replacement" }]);
		expect(guardedMutations).toBe(4);
	});
});
