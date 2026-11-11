import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applySessionModeMigration,
	cleanLegacyMutationLeases,
	findActiveLocks,
	findLegacyMutationLeases,
	planSessionModeMigration,
} from "../migrate-session-modes.mjs";

function makeAgentDir() {
	return mkdtempSync(join(tmpdir(), "metis-migrate-sessions-"));
}

function writeJournal(agentDir, relativePath, header, body = []) {
	const path = join(agentDir, "sessions", relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	const bytes = `${[JSON.stringify(header), ...body.map((line) => JSON.stringify(line))].join("\n")}\n`;
	writeFileSync(path, bytes);
	return { path, bytes };
}

const CODE_HEADER = {
	type: "session",
	version: 15,
	id: "11111111-1111-4111-8111-111111111111",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/work/project",
	cwdOrigin: "user-selected",
	mode: "code",
	permissionPreset: "auto",
};
const CHAT_HEADER = { ...CODE_HEADER, id: "22222222-2222-4222-8222-222222222222", mode: "chat" };
const BODY = [
	{ id: "a", type: "message", role: "user", content: "hello" },
	{ id: "b", type: "session_directory_added", path: "/work/other" },
];

test("plans journals that still carry a chat/code mode", () => {
	const agentDir = makeAgentDir();
	writeJournal(agentDir, "--work-project--/code.jsonl", CODE_HEADER, BODY);
	writeJournal(agentDir, "--work-project--/chat.jsonl", CHAT_HEADER, BODY);
	writeJournal(agentDir, "--work-project--/plain.jsonl", { ...CODE_HEADER, mode: undefined }, BODY);
	const { entries, errors } = planSessionModeMigration({ agentDir });
	assert.equal(errors.length, 0);
	assert.deepEqual(
		entries.map((entry) => [entry.mode, entry.relativePath.split("/").at(-1)]),
		[
			["chat", "chat.jsonl"],
			["code", "code.jsonl"],
		],
	);
});

test("skips subagent journals and leaves them untouched", () => {
	const agentDir = makeAgentDir();
	writeJournal(agentDir, "subagents/root/agent.jsonl", CODE_HEADER, BODY);
	writeJournal(agentDir, "--work-project--/code.jsonl", CODE_HEADER, BODY);
	const { entries } = planSessionModeMigration({ agentDir });
	assert.deepEqual(
		entries.map((entry) => entry.relativePath),
		["sessions/--work-project--/code.jsonl"],
	);
});

test("apply removes the mode field, preserves the body byte for byte and writes a backup", () => {
	const agentDir = makeAgentDir();
	const { path, bytes } = writeJournal(agentDir, "--work-project--/code.jsonl", CODE_HEADER, BODY);
	const { migrated, backupDir } = applySessionModeMigration({ agentDir });
	assert.equal(migrated.length, 1);
	const next = readFileSync(path, "utf8");
	const header = JSON.parse(next.slice(0, next.indexOf("\n")));
	assert.equal(Object.hasOwn(header, "mode"), false);
	assert.equal(header.permissionPreset, "auto");
	assert.equal(next.slice(next.indexOf("\n")), bytes.slice(bytes.indexOf("\n")));
	assert.ok(backupDir);
	const backup = readFileSync(join(backupDir, "sessions/--work-project--/code.jsonl"), "utf8");
	assert.equal(backup, bytes);
});

test("migration is idempotent", () => {
	const agentDir = makeAgentDir();
	writeJournal(agentDir, "--work-project--/code.jsonl", CODE_HEADER, BODY);
	applySessionModeMigration({ agentDir });
	const second = applySessionModeMigration({ agentDir });
	assert.deepEqual(
		second.migrated.map((entry) => entry.relativePath),
		[],
	);
	assert.equal(second.backupDir, undefined);
});

test("migrates archived journals", () => {
	const agentDir = makeAgentDir();
	writeJournal(agentDir, ".archive/--work-project--/code.jsonl", CODE_HEADER, BODY);
	const { entries } = planSessionModeMigration({ agentDir });
	assert.equal(entries.length, 1);
	assert.match(entries[0].relativePath, /^sessions\/\.archive\//u);
});

test("reports corrupt headers instead of rewriting them", () => {
	const agentDir = makeAgentDir();
	const path = join(agentDir, "sessions", "--work-project--", "broken.jsonl");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "{not json\n");
	const { entries, errors } = planSessionModeMigration({ agentDir });
	assert.equal(entries.length, 0);
	assert.equal(errors.length, 1);
	assert.equal(applySessionModeMigration({ agentDir }).migrated.length, 0);
});

test("detects active session leases", () => {
	const agentDir = makeAgentDir();
	const { path } = writeJournal(agentDir, "--work-project--/code.jsonl", CODE_HEADER, BODY);
	mkdirSync(`${path}.lease`, { recursive: true });
	writeFileSync(join(`${path}.lease`, "owner.json"), "{}");
	assert.deepEqual(findActiveLocks({ agentDir }), [join(`${path}.lease`, "owner.json")]);
});

test("lists and cleans stale mode mutation leases", () => {
	const agentDir = makeAgentDir();
	const storage = join(agentDir, "sessions", "--work-project--");
	const stale = join(storage, ".mode-code-project.mutation");
	const owned = join(storage, ".mode-chat-project.mutation");
	mkdirSync(stale, { recursive: true });
	mkdirSync(owned, { recursive: true });
	writeFileSync(join(owned, "owner.json"), "{}");
	const leases = findLegacyMutationLeases({ agentDir });
	assert.equal(leases.length, 2);
	assert.equal(leases.find((lease) => lease.path === owned)?.owned, true);
	assert.equal(leases.find((lease) => lease.path === stale)?.owned, false);
	assert.deepEqual(cleanLegacyMutationLeases({ agentDir }), { removed: [stale], kept: [owned] });
	assert.equal(existsSync(stale), false);
	assert.equal(existsSync(owned), true);
	assert.deepEqual(cleanLegacyMutationLeases({ agentDir, force: true }), { removed: [owned], kept: [] });
});
