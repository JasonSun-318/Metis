import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type LeaseProcessIdentity,
	type LeaseProcessInspection,
	SessionLease,
	type SessionLeaseOptions,
} from "../../src/core/session-lease.ts";

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all(
		[...children].map((child) =>
			child.exitCode !== null || child.signalCode !== null ? undefined : once(child, "exit").catch(() => undefined),
		),
	);
	children.clear();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSessionFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "arcmind-session-lease-"));
	tempDirs.push(directory);
	const sessionFile = join(directory, "session.jsonl");
	writeFileSync(sessionFile, '{"type":"session"}\n');
	return sessionFile;
}

function identity(overrides: Partial<LeaseProcessIdentity> = {}): LeaseProcessIdentity {
	return {
		pid: 101,
		hostname: "test-host",
		bootId: "boot-a",
		processStartedAt: 1_000,
		...overrides,
	};
}

function options(
	owner: LeaseProcessIdentity,
	inspectProcess: (pid: number) => LeaseProcessInspection = () => ({ status: "unknown" }),
): SessionLeaseOptions {
	let nonce = 0;
	return {
		identity: owner,
		inspectProcess,
		now: () => 10_000,
		randomNonce: () => `nonce-${owner.pid}-${++nonce}`,
		heartbeatIntervalMs: 0,
	};
}

function ownerPath(sessionFile: string): string {
	return join(`${sessionFile}.lease`, "owner.json");
}

function reclaimPath(sessionFile: string): string {
	return `${sessionFile}.write.lock.reclaim`;
}

function reclaimForcePath(sessionFile: string): string {
	return `${sessionFile}.write.lock.reclaim.force`;
}

function ownerBytes(owner: LeaseProcessIdentity, nonce: string): string {
	return `${JSON.stringify({ ...owner, nonce, updatedAt: 10_000 })}\n`;
}

function readOwner(sessionFile: string): Record<string, unknown> {
	return JSON.parse(readFileSync(ownerPath(sessionFile), "utf8")) as Record<string, unknown>;
}

function waitForLine(child: ChildProcess, expected: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}: ${stderr}`)), 10_000);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			if (!stdout.split(/\r?\n/).includes(expected)) return;
			clearTimeout(timeout);
			resolve();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`Lease child exited before ${expected}: code=${code} signal=${signal} stderr=${stderr}`));
		});
	});
}

async function spawnLeaseChild(sessionFile: string): Promise<ChildProcess> {
	const moduleUrl = new URL("../../src/core/session-lease.ts", import.meta.url).href;
	const source = `
		import { SessionLease } from ${JSON.stringify(moduleUrl)};
		const lease = SessionLease.acquire(process.argv[1], { heartbeatIntervalMs: 0 });
		console.log("ready");
		process.stdin.once("data", () => {
			lease.close();
			console.log("closed");
			process.exit(0);
		});
		setInterval(() => {}, 1_000);
	`;
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "--eval", source, sessionFile],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	children.add(child);
	await waitForLine(child, "ready");
	return child;
}

async function spawnForceClaimChild(sessionFile: string): Promise<ChildProcess> {
	const moduleUrl = new URL("../../src/core/durable-file.ts", import.meta.url).href;
	const source = `
		import { createFileAtomicallySync } from ${JSON.stringify(moduleUrl)};
		const forceClaimPath = process.argv[1];
		const owner = {
			pid: process.pid,
			hostname: "test-host",
			bootId: "boot-a",
			processStartedAt: Date.now(),
			nonce: "force-claim-child",
			updatedAt: Date.now(),
		};
		createFileAtomicallySync(forceClaimPath, JSON.stringify(owner) + "\\n", { mode: 0o600 });
		console.log("ready");
		setInterval(() => {}, 1_000);
	`;
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "--eval", source, reclaimForcePath(sessionFile)],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	children.add(child);
	await waitForLine(child, "ready");
	return child;
}

function inspectRunningProcess(pid: number): LeaseProcessInspection {
	try {
		process.kill(pid, 0);
		return { status: "alive" };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? { status: "dead" } : { status: "unknown" };
	}
}

function spawnReclaimChild(sessionFile: string, readyFile: string, releaseFile: string): ChildProcess {
	const moduleUrl = new URL("../../src/core/session-lease.ts", import.meta.url).href;
	const source = `
		import { existsSync, writeFileSync } from "node:fs";
		import { SessionLease } from ${JSON.stringify(moduleUrl)};
		const [sessionFile, readyFile, releaseFile] = process.argv.slice(1);
		let firstInspection = true;
		try {
			const lease = SessionLease.acquire(sessionFile, {
				heartbeatIntervalMs: 0,
				identity: {
					pid: process.pid,
					hostname: "test-host",
					bootId: "boot-a",
					processStartedAt: Date.now(),
				},
				inspectProcess: () => {
					if (firstInspection) {
						firstInspection = false;
						writeFileSync(readyFile, "ready\\n", { flag: "wx" });
						console.log("barrier");
						const signal = new Int32Array(new SharedArrayBuffer(4));
						while (!existsSync(releaseFile)) Atomics.wait(signal, 0, 0, 20);
					}
					return { status: "dead" };
				},
			});
			console.log("acquired");
			process.stdin.once("data", () => {
				lease.close();
				console.log("closed");
				process.exit(0);
			});
			setInterval(() => {}, 1_000);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN";
			console.log(\`error:\${code}\`);
			process.exit(0);
		}
	`;
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "--eval", source, sessionFile, readyFile, releaseFile],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	children.add(child);
	return child;
}

function waitForOneOfLines(child: ChildProcess, expected: readonly string[], timeoutMs = 10_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (line: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(line);
		};
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`Timed out waiting for ${expected.join(" or ")}: ${stderr}`));
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			for (const line of stdout.split(/\r?\n/)) {
				if (expected.includes(line)) finish(line);
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(new Error(`Lease child exited before an outcome: code=${code} signal=${signal} stderr=${stderr}`));
		});
	});
}

function spawnLeaseOperationChild(sessionFile: string, operation: "acquire" | "forceUnlock"): ChildProcess {
	const moduleUrl = new URL("../../src/core/session-lease.ts", import.meta.url).href;
	const source = `
		import { SessionLease } from ${JSON.stringify(moduleUrl)};
		const [sessionFile, operation] = process.argv.slice(1);
		try {
			if (operation === "forceUnlock") {
				SessionLease.forceUnlock(sessionFile, { heartbeatIntervalMs: 0 });
			} else {
				const lease = SessionLease.acquire(sessionFile, { heartbeatIntervalMs: 0 });
				lease.close();
			}
			console.log("completed");
		} catch {
			console.log("rejected");
		}
	`;
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "--eval", source, sessionFile, operation],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	children.add(child);
	return child;
}

function createAlias(kind: "symlink" | "hardlink", source: string, destination: string): void {
	if (kind === "symlink") symlinkSync(source, destination);
	else linkSync(source, destination);
}

function waitForExit(child: ChildProcess): Promise<unknown> {
	return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
}

describe("SessionLease", () => {
	it("writes complete owner metadata and releases cleanly", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));

		expect(readOwner(sessionFile)).toEqual({
			pid: 101,
			hostname: "test-host",
			bootId: "boot-a",
			processStartedAt: 1_000,
			nonce: "nonce-101-2",
			updatedAt: 10_000,
		});
		lease.close();
		expect(existsSync(`${sessionFile}.lease`)).toBe(false);
	});

	it("fences transient and durable leases in both directions without residue", () => {
		const sessionFile = createSessionFile();
		const durable = SessionLease.acquire(sessionFile, options(identity()));
		expect(() => SessionLease.acquireTransient(sessionFile, options(identity({ pid: 202 })))).toThrowError(
			expect.objectContaining({ code: "SESSION_IN_USE" }),
		);
		durable.close();

		const transient = SessionLease.acquireTransient(sessionFile, options(identity({ pid: 202 })));
		expect(readOwner(sessionFile)).toMatchObject({ pid: 202, nonce: "nonce-202-2" });
		expect(() => SessionLease.acquire(sessionFile, options(identity({ pid: 303 })))).toThrowError(
			expect.objectContaining({ code: "SESSION_IN_USE" }),
		);
		transient.close();

		expect(existsSync(`${sessionFile}.lease`)).toBe(false);
		expect(readdirSync(join(sessionFile, "..")).filter((name) => name.includes(".transient.tmp"))).toEqual([]);
	});

	it("lets a transient lease reclaim only a confirmed-dead durable owner", () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));
		const replacement = SessionLease.acquireTransient(
			sessionFile,
			options(identity({ pid: 202 }), () => ({ status: "dead" })),
		);

		expect(() => oldLease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
		replacement.close();
	});

	it("retries only the pending parent sync after lease removal", () => {
		const sessionFile = createSessionFile();
		const leaseOptions = options(identity());
		let syncCalls = 0;
		leaseOptions.syncDirectory = () => {
			syncCalls++;
			if (syncCalls === 1) throw new Error("injected parent sync failure");
		};
		const lease = SessionLease.acquire(sessionFile, leaseOptions);

		expect(() => lease.close()).toThrow("injected parent sync failure");
		expect(existsSync(`${sessionFile}.lease`)).toBe(false);
		expect(syncCalls).toBe(1);
		expect(() => lease.close()).not.toThrow();
		expect(syncCalls).toBe(2);
		expect(() => lease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
		lease.close();
		expect(syncCalls).toBe(2);
	});

	it("rejects a second process while the real child owner is alive, then permits clean release", async () => {
		const sessionFile = createSessionFile();
		const child = await spawnLeaseChild(sessionFile);

		expect(() => SessionLease.acquire(sessionFile, { heartbeatIntervalMs: 0 })).toThrowError(
			expect.objectContaining({ code: "SESSION_IN_USE" }),
		);

		const closed = waitForLine(child, "closed");
		const exited = once(child, "exit");
		child.stdin?.end("close\n");
		await closed;
		await exited;

		const lease = SessionLease.acquire(sessionFile, { heartbeatIntervalMs: 0 });
		lease.close();
	});

	it("reclaims a lease after its real child owner crashes", async () => {
		const sessionFile = createSessionFile();
		const child = await spawnLeaseChild(sessionFile);
		child.kill("SIGKILL");
		await once(child, "exit");

		const lease = SessionLease.acquire(sessionFile, { heartbeatIntervalMs: 0 });
		lease.close();
	});

	it("reclaims a prior-boot owner without trusting PID liveness", () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));
		const replacement = SessionLease.acquire(
			sessionFile,
			options(identity({ pid: 202, bootId: "boot-b" }), () => ({ status: "unknown" })),
		);

		expect(() => oldLease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
		replacement.close();
	});

	it("does not reclaim a merely stale heartbeat from a still-live owner", () => {
		const sessionFile = createSessionFile();
		const firstNow = { value: 1 };
		const firstOptions = options(identity(), () => ({ status: "alive", processStartedAt: 1_000 }));
		firstOptions.now = () => firstNow.value;
		const lease = SessionLease.acquire(sessionFile, firstOptions);
		firstNow.value = 10_000_000;

		expect(() =>
			SessionLease.acquire(
				sessionFile,
				options(identity({ pid: 202 }), () => ({ status: "alive", processStartedAt: 1_000 })),
			),
		).toThrowError(expect.objectContaining({ code: "SESSION_IN_USE" }));
		lease.close();
	});

	it("refuses unreadable owner metadata and unknown or permission-denied process state", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));
		writeFileSync(ownerPath(sessionFile), "not-json\n");

		expect(() => SessionLease.acquire(sessionFile, options(identity({ pid: 202 })))).toThrowError(
			expect.objectContaining({ code: "SESSION_IN_USE" }),
		);
		expect(() => lease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
		const artifactPath = SessionLease.forceUnlock(sessionFile, options(identity({ pid: 202 })));
		expect(readFileSync(join(artifactPath!, "owner.json"), "utf8")).toBe("not-json\n");
	});

	it("does not reclaim a valid owner when process state or host identity is unknown", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));

		expect(() => SessionLease.acquire(sessionFile, options(identity({ pid: 202 })))).toThrowError(
			expect.objectContaining({ code: "SESSION_IN_USE" }),
		);
		expect(() =>
			SessionLease.acquire(
				sessionFile,
				options(identity({ pid: 202, hostname: "another-host" }), () => ({ status: "dead" })),
			),
		).toThrowError(expect.objectContaining({ code: "SESSION_IN_USE" }));
		lease.close();
	});

	it("reclaims an invalid leftover gate only when the long lease owner is proved dead", () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));
		writeFileSync(`${sessionFile}.write.lock`, "partial-gate");

		const replacement = SessionLease.acquire(
			sessionFile,
			options(identity({ pid: 202 }), () => ({ status: "dead" })),
		);
		expect(() => oldLease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
		replacement.close();
	});

	it("cleans a published hard-link temp left by a gate creator crash", () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));
		const gatePath = `${sessionFile}.write.lock`;
		const publishTemp = join(
			sessionFile,
			"..",
			`.${basename(gatePath)}.00000000-0000-4000-8000-000000000000.publish.tmp`,
		);
		writeFileSync(gatePath, ownerBytes(identity(), "stale-gate"));
		linkSync(gatePath, publishTemp);

		const replacement = SessionLease.acquire(
			sessionFile,
			options(identity({ pid: 202 }), () => ({ status: "dead" })),
		);

		expect(existsSync(publishTemp)).toBe(false);
		expect(() => oldLease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
		replacement.close();
	});

	it("cleans a published hard-link temp left by an owner creator crash", () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));
		const path = ownerPath(sessionFile);
		const publishTemp = join(`${sessionFile}.lease`, `.owner.json.00000000-0000-4000-8000-000000000000.publish.tmp`);
		linkSync(path, publishTemp);

		const replacement = SessionLease.acquire(
			sessionFile,
			options(identity({ pid: 202 }), () => ({ status: "dead" })),
		);

		expect(existsSync(publishTemp)).toBe(false);
		expect(() => oldLease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
		replacement.close();
	});

	it.each(["symlink", "hardlink"] as const)("fails closed on %s gate, owner, and reclaim aliases", (kind) => {
		const gateSession = createSessionFile();
		const gateOutside = join(gateSession, "..", `gate-${kind}.json`);
		const gateBytes = ownerBytes(identity(), "aliased-gate");
		writeFileSync(gateOutside, gateBytes);
		createAlias(kind, gateOutside, `${gateSession}.write.lock`);
		expect(() => SessionLease.acquire(gateSession, options(identity({ pid: 202 })))).toThrow();
		expect(readFileSync(gateOutside, "utf8")).toBe(gateBytes);

		const ownerSession = createSessionFile();
		const ownerOutside = join(ownerSession, "..", `owner-${kind}.json`);
		const aliasedOwner = ownerBytes(identity(), "aliased-owner");
		writeFileSync(ownerOutside, aliasedOwner);
		mkdirSync(`${ownerSession}.lease`);
		createAlias(kind, ownerOutside, ownerPath(ownerSession));
		expect(() => SessionLease.acquire(ownerSession, options(identity({ pid: 202 })))).toThrow();
		expect(readFileSync(ownerOutside, "utf8")).toBe(aliasedOwner);

		const reclaimSession = createSessionFile();
		const reclaimOutside = join(reclaimSession, "..", `reclaim-${kind}.json`);
		const reclaimBytes = ownerBytes(identity({ pid: 303 }), "aliased-reclaim");
		writeFileSync(reclaimOutside, reclaimBytes);
		createAlias(kind, reclaimOutside, reclaimPath(reclaimSession));
		expect(() =>
			SessionLease.forceUnlock(
				reclaimSession,
				options(identity({ pid: 202 }), () => ({ status: "dead" })),
			),
		).toThrow();
		expect(readFileSync(reclaimOutside, "utf8")).toBe(reclaimBytes);
	});

	for (const [name, operation, prepare] of [
		["gate", "acquire", (sessionFile: string) => `${sessionFile}.write.lock`],
		[
			"owner",
			"acquire",
			(sessionFile: string) => {
				mkdirSync(`${sessionFile}.lease`);
				return ownerPath(sessionFile);
			},
		],
		["reclaim", "forceUnlock", (sessionFile: string) => reclaimPath(sessionFile)],
		["force-claim", "forceUnlock", (sessionFile: string) => reclaimForcePath(sessionFile)],
	] as const) {
		it.skipIf(process.platform === "win32")(`rejects a ${name} FIFO without blocking`, async () => {
			const sessionFile = createSessionFile();
			const fifoPath = prepare(sessionFile);
			execFileSync("mkfifo", [fifoPath]);
			const child = spawnLeaseOperationChild(sessionFile, operation);

			expect(await waitForOneOfLines(child, ["rejected", "completed"], 5_000)).toBe("rejected");
			await waitForExit(child);
			expect(existsSync(fifoPath)).toBe(true);
		});
	}

	it("lets only one stale-gate contender enter after both observe the same gate", async () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));
		writeFileSync(`${sessionFile}.write.lock`, ownerBytes(identity(), "stale-gate"));
		const readyA = join(sessionFile, "..", "ready-a");
		const readyB = join(sessionFile, "..", "ready-b");
		const releaseFile = join(sessionFile, "..", "release");
		const childA = spawnReclaimChild(sessionFile, readyA, releaseFile);
		const childB = spawnReclaimChild(sessionFile, readyB, releaseFile);
		const outcomeA = waitForOneOfLines(childA, ["acquired", "error:SESSION_IN_USE"]);
		const outcomeB = waitForOneOfLines(childB, ["acquired", "error:SESSION_IN_USE"]);

		await Promise.all([waitForLine(childA, "barrier"), waitForLine(childB, "barrier")]);
		expect(existsSync(readyA)).toBe(true);
		expect(existsSync(readyB)).toBe(true);
		writeFileSync(releaseFile, "go\n", { flag: "wx" });

		const outcomes = await Promise.all([outcomeA, outcomeB]);
		expect([...outcomes].sort()).toEqual(["acquired", "error:SESSION_IN_USE"]);
		const winner = outcomes[0] === "acquired" ? childA : childB;
		const closed = waitForLine(winner, "closed");
		const exited = waitForExit(winner);
		winner.stdin?.end("close\n");
		await closed;
		await exited;

		expect(existsSync(reclaimPath(sessionFile))).toBe(false);
		expect(existsSync(`${sessionFile}.write.lock`)).toBe(false);
		expect(() => oldLease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
	});

	it("does not remove an invalid leftover gate for a live long lease owner", () => {
		const sessionFile = createSessionFile();
		SessionLease.acquire(sessionFile, options(identity()));
		writeFileSync(`${sessionFile}.write.lock`, "partial-gate");

		expect(() =>
			SessionLease.acquire(
				sessionFile,
				options(identity({ pid: 202 }), () => ({ status: "alive", processStartedAt: 1_000 })),
			),
		).toThrowError(expect.objectContaining({ code: "SESSION_IN_USE" }));
		expect(readFileSync(`${sessionFile}.write.lock`, "utf8")).toBe("partial-gate");
	});

	it("reclaims only when PID reuse is proved by a different process start time", () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));

		expect(() =>
			SessionLease.acquire(
				sessionFile,
				options(identity({ pid: 202 }), () => ({ status: "alive" })),
			),
		).toThrowError(expect.objectContaining({ code: "SESSION_IN_USE" }));

		const replacement = SessionLease.acquire(
			sessionFile,
			options(identity({ pid: 202 }), () => ({ status: "alive", processStartedAt: 9_000 })),
		);
		expect(() => oldLease.heartbeat()).toThrowError(expect.objectContaining({ code: "LEASE_LOST" }));
		replacement.close();
	});

	it("preserves a forced lease as an artifact and fences the old owner", () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));
		const ownerBytes = readFileSync(ownerPath(sessionFile));

		const artifactPath = SessionLease.forceUnlock(sessionFile, options(identity({ pid: 202 })));
		expect(artifactPath).toBeDefined();
		expect(readFileSync(join(artifactPath!, "owner.json"))).toEqual(ownerBytes);
		expect(existsSync(`${sessionFile}.lease`)).toBe(false);
		expect(() => oldLease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);

		const replacement = SessionLease.acquire(sessionFile, options(identity({ pid: 303 })));
		replacement.close();
	});

	it("refuses force-unlock through a symlinked recovery directory", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));
		const outside = join(sessionFile, "..", "outside-recovery");
		const recoveryPath = join(sessionFile, "..", ".recovery");
		mkdirSync(outside);
		symlinkSync(outside, recoveryPath);

		expect(() => SessionLease.forceUnlock(sessionFile, options(identity({ pid: 202 })))).toThrow(
			"not a real directory",
		);
		expect(existsSync(`${sessionFile}.lease`)).toBe(true);
		expect(readdirSync(outside)).toEqual([]);

		unlinkSync(recoveryPath);
		lease.close();
	});

	it("refuses force-unlock while a valid reclaim marker owner may still be alive", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));
		const marker = ownerBytes(identity({ pid: 303, processStartedAt: 3_000 }), "active-reclaimer");
		writeFileSync(reclaimPath(sessionFile), marker);

		expect(() =>
			SessionLease.forceUnlock(
				sessionFile,
				options(identity({ pid: 202 }), () => ({ status: "alive", processStartedAt: 3_000 })),
			),
		).toThrowError(expect.objectContaining({ code: "SESSION_IN_USE" }));
		expect(readFileSync(reclaimPath(sessionFile), "utf8")).toBe(marker);
		expect(existsSync(reclaimForcePath(sessionFile))).toBe(false);

		rmSync(reclaimPath(sessionFile), { force: true });
		lease.close();
	});

	it("force-unlock preserves and clears a proved-dead reclaim marker", () => {
		const sessionFile = createSessionFile();
		const oldLease = SessionLease.acquire(sessionFile, options(identity()));
		const marker = ownerBytes(identity({ pid: 303 }), "dead-reclaimer");
		writeFileSync(reclaimPath(sessionFile), marker);

		SessionLease.forceUnlock(
			sessionFile,
			options(identity({ pid: 202 }), () => ({ status: "dead" })),
		);

		const recoveryDirectory = join(sessionFile, "..", ".recovery");
		const markerArtifact = readdirSync(recoveryDirectory).find((entry) => entry.endsWith(".reclaim.json"));
		expect(markerArtifact).toBeDefined();
		expect(readFileSync(join(recoveryDirectory, markerArtifact!), "utf8")).toBe(marker);
		expect(existsSync(reclaimPath(sessionFile))).toBe(false);
		expect(existsSync(reclaimForcePath(sessionFile))).toBe(false);
		expect(() => oldLease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
	});

	it("force-unlock preserves and clears an atomically published malformed reclaim marker", () => {
		const sessionFile = createSessionFile();
		writeFileSync(reclaimPath(sessionFile), "malformed-marker\n");

		const artifactPath = SessionLease.forceUnlock(sessionFile, options(identity({ pid: 202 })));

		expect(artifactPath).toBeDefined();
		expect(readFileSync(artifactPath!, "utf8")).toBe("malformed-marker\n");
		expect(existsSync(reclaimPath(sessionFile))).toBe(false);
		expect(existsSync(reclaimForcePath(sessionFile))).toBe(false);
	});

	it.each([
		["an unknown", () => ({ status: "unknown" }) as LeaseProcessInspection],
		["a live", () => ({ status: "alive", processStartedAt: 1_000 }) as LeaseProcessInspection],
	])("refuses force-unlock while %s force-claim owner may still be running", (_name, inspectProcess) => {
		const sessionFile = createSessionFile();
		const claim = ownerBytes(identity({ pid: 303 }), "active-force-claim");
		writeFileSync(reclaimForcePath(sessionFile), claim);

		expect(() => SessionLease.forceUnlock(sessionFile, options(identity({ pid: 202 }), inspectProcess))).toThrowError(
			expect.objectContaining({ code: "SESSION_IN_USE" }),
		);
		expect(readFileSync(reclaimForcePath(sessionFile), "utf8")).toBe(claim);
	});

	it("refuses force-unlock when a force claim has no provable owner", () => {
		const sessionFile = createSessionFile();
		writeFileSync(reclaimForcePath(sessionFile), "malformed-force-claim\n");

		expect(() =>
			SessionLease.forceUnlock(
				sessionFile,
				options(identity({ pid: 202 }), () => ({ status: "dead" })),
			),
		).toThrowError(expect.objectContaining({ code: "SESSION_IN_USE" }));
		expect(readFileSync(reclaimForcePath(sessionFile), "utf8")).toBe("malformed-force-claim\n");
	});

	it.each([
		[
			"a prior-boot owner",
			identity({ pid: 202, bootId: "boot-b" }),
			() => ({ status: "unknown" }) as LeaseProcessInspection,
		],
		[
			"a reused PID",
			identity({ pid: 202 }),
			() => ({ status: "alive", processStartedAt: 9_000 }) as LeaseProcessInspection,
		],
	])("force-unlock preserves and clears a force claim from %s", (_name, reclaimer, inspectProcess) => {
		const sessionFile = createSessionFile();
		const claim = ownerBytes(identity({ pid: 303 }), "abandoned-force-claim");
		writeFileSync(reclaimForcePath(sessionFile), claim);

		const artifactPath = SessionLease.forceUnlock(sessionFile, options(reclaimer, inspectProcess));

		expect(artifactPath).toMatch(/\.force-claim\.json$/);
		expect(readFileSync(artifactPath!, "utf8")).toBe(claim);
		expect(existsSync(reclaimForcePath(sessionFile))).toBe(false);
	});

	it("recovers a proved-dead force claim after its owner process crashes", async () => {
		const sessionFile = createSessionFile();
		const child = await spawnForceClaimChild(sessionFile);
		const claim = readFileSync(reclaimForcePath(sessionFile), "utf8");
		const reclaimerOptions = options(identity({ pid: 202 }), inspectRunningProcess);

		expect(() => SessionLease.forceUnlock(sessionFile, reclaimerOptions)).toThrowError(
			expect.objectContaining({ code: "SESSION_IN_USE" }),
		);
		child.kill("SIGKILL");
		await waitForExit(child);
		// Ordinary acquisition never interprets or removes a force claim, even when
		// its owner is known dead. Recovery remains an explicit operator action.
		expect(() => SessionLease.acquire(sessionFile, reclaimerOptions)).toThrowError(
			expect.objectContaining({ code: "SESSION_IN_USE" }),
		);

		const artifactPath = SessionLease.forceUnlock(sessionFile, reclaimerOptions);

		expect(artifactPath).toMatch(/\.force-claim\.json$/);
		expect(readFileSync(artifactPath!, "utf8")).toBe(claim);
		expect(existsSync(reclaimForcePath(sessionFile))).toBe(false);
	});

	it("does not delete a replacement gate when releasing its own gate token", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));
		const gatePath = `${sessionFile}.write.lock`;

		expect(() =>
			lease.withWritePermit(() => {
				writeFileSync(
					gatePath,
					`${JSON.stringify({
						...identity({ bootId: "old-boot" }),
						nonce: "replacement-token",
						updatedAt: 10_000,
					})}\n`,
				);
			}),
		).toThrowError(expect.objectContaining({ code: "LEASE_LOST" }));

		expect(existsSync(gatePath)).toBe(true);
		lease.close();
	});

	it("checks the owner nonce before every write permit", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));
		const owner = readOwner(sessionFile);
		writeFileSync(ownerPath(sessionFile), `${JSON.stringify({ ...owner, nonce: "different" })}\n`);

		expect(() => lease.withWritePermit(() => undefined)).toThrowError(
			expect.objectContaining({ code: "LEASE_LOST" }),
		);
	});

	it("allows read-only catalog work while a writer lease is held", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));

		expect(readFileSync(sessionFile, "utf8")).toContain('"type":"session"');
		expect(readdirSync(join(sessionFile, ".."))).toContain("session.jsonl");
		lease.close();
	});

	it("serializes force-unlock behind the same write gate", () => {
		const sessionFile = createSessionFile();
		const lease = SessionLease.acquire(sessionFile, options(identity()));

		lease.withWritePermit(() => {
			expect(() => SessionLease.forceUnlock(sessionFile, options(identity({ pid: 202 })))).toThrowError(
				expect.objectContaining({ code: "SESSION_IN_USE" }),
			);
			expect(existsSync(`${sessionFile}.lease`)).toBe(true);
		});
		lease.close();
	});
});
