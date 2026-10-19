import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ownerWriteFault = vi.hoisted(() => ({
	enabled: false,
	error: Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" }),
}));

// Fault only the owner.json atomic replacement; every other durable-file call
// stays real. This keeps the ENOSPC regression portable (no POSIX mode checks).
vi.mock("../../src/core/durable-file.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/durable-file.ts")>();
	return {
		...actual,
		replaceFileAtomicallySync: (...args: Parameters<typeof actual.replaceFileAtomicallySync>) => {
			if (ownerWriteFault.enabled && String(args[0]).endsWith("owner.json")) throw ownerWriteFault.error;
			return actual.replaceFileAtomicallySync(...args);
		},
	};
});

import { type LeaseProcessIdentity, SessionLease, type SessionLeaseOptions } from "../../src/core/session-lease.ts";

const tempDirs: string[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	ownerWriteFault.enabled = false;
});

afterEach(() => {
	ownerWriteFault.enabled = false;
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSessionFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "metis-session-lease-heartbeat-"));
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

function leaseOptions(clock: { value: number }, heartbeatIntervalMs: number): SessionLeaseOptions {
	let nonce = 0;
	return {
		identity,
		inspectProcess: () => ({ status: "alive", processStartedAt: 1_000 }),
		now: () => clock.value,
		randomNonce: () => `nonce-${++nonce}`,
		heartbeatIntervalMs,
	};
}

function ownerPath(sessionFile: string): string {
	return join(`${sessionFile}.lease`, "owner.json");
}

function gatePath(sessionFile: string): string {
	return `${sessionFile}.write.lock`;
}

function readOwner(sessionFile: string): Record<string, unknown> {
	return JSON.parse(readFileSync(ownerPath(sessionFile), "utf8")) as Record<string, unknown>;
}

function readOwnerBytes(sessionFile: string): string {
	return readFileSync(ownerPath(sessionFile), "utf8");
}

describe("SessionLease heartbeat", () => {
	it("does not schedule a timer when heartbeatIntervalMs is 0, and explicit heartbeat still writes updatedAt", () => {
		const sessionFile = createSessionFile();
		const clock = { value: 1_000 };
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const lease = SessionLease.acquire(sessionFile, leaseOptions(clock, 0));

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(readOwner(sessionFile)).toEqual({
			...identity,
			nonce: "nonce-2",
			updatedAt: 1_000,
		});
		const acquiredBytes = readOwnerBytes(sessionFile);

		clock.value = 60_000;
		vi.advanceTimersByTime(60_000);
		expect(readOwnerBytes(sessionFile)).toBe(acquiredBytes);

		clock.value = 2_000;
		lease.heartbeat();
		expect(readOwner(sessionFile)).toEqual({
			...identity,
			nonce: "nonce-2",
			updatedAt: 2_000,
		});
		expect(readOwnerBytes(sessionFile).endsWith("\n")).toBe(true);
		expect(lease.withWritePermit(() => "permitted")).toBe("permitted");
		expect(existsSync(gatePath(sessionFile))).toBe(false);

		lease.close();
		expect(vi.getTimerCount()).toBe(0);
		expect(existsSync(`${sessionFile}.lease`)).toBe(false);
		expect(() => lease.heartbeat()).toThrowError(expect.objectContaining({ code: "LEASE_LOST" }));
	});

	it("scheduled heartbeat rewrites only updatedAt while preserving the owner JSON shape", async () => {
		const sessionFile = createSessionFile();
		const clock = { value: 1_000 };
		const lease = SessionLease.acquire(sessionFile, leaseOptions(clock, 1_000));
		expect(vi.getTimerCount()).toBe(1);
		expect(readOwner(sessionFile).updatedAt).toBe(1_000);

		clock.value = 2_000;
		await vi.advanceTimersByTimeAsync(1_000);

		expect(vi.getTimerCount()).toBe(1);
		expect(readOwner(sessionFile)).toEqual({
			...identity,
			nonce: "nonce-2",
			updatedAt: 2_000,
		});
		expect(Object.keys(readOwner(sessionFile))).toEqual([
			"pid",
			"hostname",
			"bootId",
			"processStartedAt",
			"nonce",
			"updatedAt",
		]);
		expect(existsSync(gatePath(sessionFile))).toBe(false);
		expect(existsSync(`${sessionFile}.write.lock.reclaim`)).toBe(false);
		expect(existsSync(`${sessionFile}.write.lock.reclaim.force`)).toBe(false);
		lease.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("scheduled heartbeat rechecks ownership and stops writing after the owner nonce is replaced", async () => {
		const sessionFile = createSessionFile();
		const clock = { value: 1_000 };
		const lease = SessionLease.acquire(sessionFile, leaseOptions(clock, 1_000));
		expect(vi.getTimerCount()).toBe(1);

		clock.value = 2_000;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(readOwner(sessionFile).updatedAt).toBe(2_000);
		expect(vi.getTimerCount()).toBe(1);

		const replacement = { ...identity, nonce: "replacement-owner", updatedAt: 2_500 };
		writeFileSync(ownerPath(sessionFile), `${JSON.stringify(replacement)}\n`);
		const replacementBytes = readOwnerBytes(sessionFile);

		clock.value = 3_000;
		await vi.advanceTimersByTimeAsync(1_000);
		// The scheduled heartbeat must detect the foreign nonce before writing.
		expect(readOwnerBytes(sessionFile)).toBe(replacementBytes);
		expect(readOwner(sessionFile)).toEqual(replacement);
		expect(existsSync(gatePath(sessionFile))).toBe(false);
		// The scheduled callback stopped its interval as soon as ownership was lost.
		expect(vi.getTimerCount()).toBe(0);

		clock.value = 4_000;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readOwnerBytes(sessionFile)).toBe(replacementBytes);
		expect(vi.getTimerCount()).toBe(0);
		expect(() => lease.heartbeat()).toThrowError(expect.objectContaining({ code: "LEASE_LOST" }));
		expect(() => lease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps ownership after a scheduled heartbeat I/O error and retries the next interval",
		async () => {
			const sessionFile = createSessionFile();
			const clock = { value: 1_000 };
			const lease = SessionLease.acquire(sessionFile, leaseOptions(clock, 1_000));
			const leaseDirectory = `${sessionFile}.lease`;
			const acquiredBytes = readOwnerBytes(sessionFile);

			chmodSync(leaseDirectory, 0o500);
			try {
				clock.value = 2_000;
				// owner.json replacement cannot create its temp file; the timer must
				// swallow the raw I/O error without declaring the lease lost.
				await vi.advanceTimersByTimeAsync(1_000);
				expect(readOwnerBytes(sessionFile)).toBe(acquiredBytes);
				expect(existsSync(gatePath(sessionFile))).toBe(false);
				expect(lease.withWritePermit(() => "still-owned")).toBe("still-owned");

				// Explicit heartbeat exposes the raw I/O error and keeps ownership.
				expect(() => lease.heartbeat()).toThrowError(expect.objectContaining({ code: "EACCES" }));
				expect(readOwnerBytes(sessionFile)).toBe(acquiredBytes);
			} finally {
				chmodSync(leaseDirectory, 0o700);
			}

			clock.value = 3_000;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(readOwner(sessionFile)).toEqual({
				...identity,
				nonce: "nonce-2",
				updatedAt: 3_000,
			});
			lease.close();
			expect(vi.getTimerCount()).toBe(0);
			expect(existsSync(leaseDirectory)).toBe(false);
		},
	);

	it("transient leases do not schedule timers but support explicit heartbeat with the normal owner format", () => {
		const sessionFile = createSessionFile();
		const clock = { value: 1_000 };
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const lease = SessionLease.acquireTransient(sessionFile, leaseOptions(clock, 1_000));

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(readOwner(sessionFile)).toEqual({
			...identity,
			nonce: "nonce-2",
			updatedAt: 1_000,
		});

		clock.value = 2_000;
		lease.heartbeat();
		expect(readOwner(sessionFile)).toEqual({
			...identity,
			nonce: "nonce-2",
			updatedAt: 2_000,
		});
		expect(lease.withWritePermit(() => "transient-write")).toBe("transient-write");
		expect(existsSync(gatePath(sessionFile))).toBe(false);
		expect(readdirSync(join(sessionFile, "..")).filter((name) => name.includes(".transient.tmp"))).toEqual([]);

		lease.close();
		expect(vi.getTimerCount()).toBe(0);
		expect(existsSync(`${sessionFile}.lease`)).toBe(false);
		expect(() => lease.heartbeat()).toThrowError(expect.objectContaining({ code: "LEASE_LOST" }));
	});

	it("keeps ownership on an injected ENOSPC, recovers on the next scheduled tick, and surfaces the raw error explicitly", async () => {
		const sessionFile = createSessionFile();
		const clock = { value: 1_000 };
		const lease = SessionLease.acquire(sessionFile, leaseOptions(clock, 1_000));
		const leaseDirectory = `${sessionFile}.lease`;
		const acquiredBytes = readOwnerBytes(sessionFile);
		expect(vi.getTimerCount()).toBe(1);

		ownerWriteFault.enabled = true;
		try {
			clock.value = 2_000;
			await vi.advanceTimersByTimeAsync(1_000);
			// The timer swallowed ENOSPC without declaring the lease lost or
			// replacing the last durable owner bytes.
			expect(readOwnerBytes(sessionFile)).toBe(acquiredBytes);
			expect(existsSync(gatePath(sessionFile))).toBe(false);
			expect(vi.getTimerCount()).toBe(1);
			expect(lease.withWritePermit(() => "still-owned")).toBe("still-owned");

			let explicitError: unknown;
			try {
				clock.value = 2_500;
				lease.heartbeat();
			} catch (error) {
				explicitError = error;
			}
			expect(explicitError).toBe(ownerWriteFault.error);
			expect(explicitError).toMatchObject({ code: "ENOSPC", message: "injected ENOSPC" });
			expect(readOwnerBytes(sessionFile)).toBe(acquiredBytes);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			ownerWriteFault.enabled = false;
		}

		clock.value = 3_000;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(readOwner(sessionFile)).toEqual({
			...identity,
			nonce: "nonce-2",
			updatedAt: 3_000,
		});
		expect(existsSync(gatePath(sessionFile))).toBe(false);
		expect(vi.getTimerCount()).toBe(1);

		lease.close();
		expect(vi.getTimerCount()).toBe(0);
		expect(existsSync(leaseDirectory)).toBe(false);
	});
});
