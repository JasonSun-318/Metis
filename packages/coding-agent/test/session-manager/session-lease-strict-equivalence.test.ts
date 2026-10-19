import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type LeaseProcessIdentity, SessionLease, type SessionLeaseOptions } from "../../src/core/session-lease.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSessionFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "metis-session-lease-gate-"));
	tempDirs.push(directory);
	const sessionFile = join(directory, "session.jsonl");
	writeFileSync(sessionFile, '{"type":"session"}\n');
	return sessionFile;
}

const identity: LeaseProcessIdentity = {
	pid: 101,
	hostname: "test-host",
	bootId: "boot-a",
	processStartedAt: 1_000,
};

function ownerPath(sessionFile: string): string {
	return join(`${sessionFile}.lease`, "owner.json");
}

function gatePath(sessionFile: string): string {
	return `${sessionFile}.write.lock`;
}

function readOwnerBytes(sessionFile: string): string {
	return readFileSync(ownerPath(sessionFile), "utf8");
}

function leaseOptions(clock: { value: number }, onNow?: () => void): SessionLeaseOptions {
	let nonce = 0;
	return {
		identity,
		inspectProcess: () => ({ status: "unknown" }),
		now: () => {
			onNow?.();
			return clock.value;
		},
		randomNonce: () => `nonce-${++nonce}`,
		heartbeatIntervalMs: 0,
	};
}

describe("SessionLease write-gate strict equivalence", () => {
	it("holds the write gate for explicit heartbeats and write permits", () => {
		const sessionFile = createSessionFile();
		const clock = { value: 1_000 };
		const nowGateObservations: boolean[] = [];
		const lease = SessionLease.acquire(
			sessionFile,
			leaseOptions(clock, () => nowGateObservations.push(existsSync(gatePath(sessionFile)))),
		);

		nowGateObservations.length = 0;
		expect(lease.withWritePermit(() => existsSync(gatePath(sessionFile)))).toBe(true);
		expect(existsSync(gatePath(sessionFile))).toBe(false);

		clock.value = 2_000;
		lease.heartbeat();
		// The final clock read is the updatedAt write inside the permit; it must
		// still happen while the write gate is published.
		expect(nowGateObservations.at(-1)).toBe(true);
		expect(existsSync(gatePath(sessionFile))).toBe(false);
		lease.close();
	});

	it("does not refresh owner bytes when a foreign unreclaimable gate blocks the heartbeat", () => {
		const sessionFile = createSessionFile();
		const clock = { value: 1_000 };
		const lease = SessionLease.acquire(sessionFile, leaseOptions(clock));
		const ownerBefore = readOwnerBytes(sessionFile);

		writeFileSync(
			gatePath(sessionFile),
			`${JSON.stringify({ ...identity, nonce: "foreign-gate", updatedAt: 1_500 })}\n`,
		);
		clock.value = 2_000;
		expect(() => lease.heartbeat()).toThrowError(expect.objectContaining({ code: "SESSION_IN_USE" }));
		expect(readOwnerBytes(sessionFile)).toBe(ownerBefore);

		unlinkSync(gatePath(sessionFile));
		lease.heartbeat();
		expect(readFileSync(ownerPath(sessionFile), "utf8")).toContain('"updatedAt":2000');
		lease.close();
	});

	it("fails closed when the owner file gains a second hard link after acquisition", () => {
		const sessionFile = createSessionFile();
		const clock = { value: 1_000 };
		const lease = SessionLease.acquire(sessionFile, leaseOptions(clock));
		const ownerBefore = readOwnerBytes(sessionFile);
		const aliasPath = join(`${sessionFile}.lease`, "owner-alias.json");
		linkSync(ownerPath(sessionFile), aliasPath);

		clock.value = 2_000;
		expect(() => lease.heartbeat()).toThrowError(expect.objectContaining({ code: "LEASE_LOST" }));
		// Ownership reads must keep the single-link invariant; comparing cached
		// bytes would accept an aliased owner with identical content.
		expect(readOwnerBytes(sessionFile)).toBe(ownerBefore);
		expect(existsSync(aliasPath)).toBe(true);
	});
});
