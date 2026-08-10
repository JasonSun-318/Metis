import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { canonicalizePathForCreation } from "../utils/paths.ts";
import { type AgentMode, isAgentMode } from "./agent-mode.ts";
import {
	cleanupPublishedAliasesSync,
	createFileAtomicallySync,
	ensureRealDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
	syncDirectorySync,
} from "./durable-file.ts";

const UNKNOWN_BOOT_ID = "unknown";
const PROCESS_START_TOLERANCE_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface LeaseProcessIdentity {
	pid: number;
	hostname: string;
	bootId: string;
	processStartedAt: number;
}

export interface LeaseOwner extends LeaseProcessIdentity {
	nonce: string;
	updatedAt: number;
}

export type LeaseProcessInspection =
	| { status: "alive"; processStartedAt?: number }
	| { status: "dead" }
	| { status: "unknown" };

export interface SessionLeaseOptions {
	identity?: LeaseProcessIdentity;
	inspectProcess?: (pid: number) => LeaseProcessInspection;
	now?: () => number;
	randomNonce?: () => string;
	/** Filesystem hook used by crash-consistency tests. */
	syncDirectory?: (directory: string) => void;
	/** Set to 0 when the caller owns heartbeat scheduling. */
	heartbeatIntervalMs?: number;
}

export type SessionLeaseErrorCode = "SESSION_IN_USE" | "LEASE_LOST";
export type SessionLeaseInspection = "free" | "stale" | "active" | "unknown";

export class SessionLeaseError extends Error {
	readonly code: SessionLeaseErrorCode;

	constructor(code: SessionLeaseErrorCode, message: string) {
		super(message);
		this.name = "SessionLeaseError";
		this.code = code;
	}
}

interface LeasePaths {
	sessionFile: string;
	leaseDirectory: string;
	ownerFile: string;
	gateFile: string;
	reclaimFile: string;
	reclaimForceFile: string;
}

interface ResolvedOptions {
	identity: LeaseProcessIdentity;
	inspectProcess: (pid: number) => LeaseProcessInspection;
	now: () => number;
	randomNonce: () => string;
	syncDirectory: (directory: string) => void;
	heartbeatIntervalMs: number;
	durable: boolean;
}

interface GateToken {
	bytes: string;
	reclaimArtifactPath?: string;
	durable?: boolean;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function readBootId(): string {
	try {
		if (process.platform === "linux") {
			return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || UNKNOWN_BOOT_ID;
		}
		if (process.platform === "darwin") {
			const value = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
				encoding: "utf8",
				timeout: 2_000,
			});
			const seconds = /sec\s*=\s*(\d+)/.exec(value)?.[1];
			return seconds ? `darwin-${seconds}` : UNKNOWN_BOOT_ID;
		}
		if (process.platform === "win32") {
			return (
				execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
					],
					{ encoding: "utf8", timeout: 2_000, windowsHide: true },
				).trim() || UNKNOWN_BOOT_ID
			);
		}
	} catch {
		// An unknown boot never authorizes takeover; confirmed-dead PID checks still work.
	}
	return UNKNOWN_BOOT_ID;
}

const defaultIdentity: LeaseProcessIdentity = {
	pid: process.pid,
	hostname: hostname(),
	bootId: readBootId(),
	processStartedAt: Math.max(0, Date.now() - process.uptime() * 1_000),
};

function inspectProcess(pid: number): LeaseProcessInspection {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return errorCode(error) === "ESRCH" ? { status: "dead" } : { status: "unknown" };
	}

	if (pid === process.pid) return { status: "alive", processStartedAt: defaultIdentity.processStartedAt };

	try {
		const value =
			process.platform === "win32"
				? execFileSync(
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							`(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
						],
						{ encoding: "utf8", timeout: 2_000, windowsHide: true },
					).trim()
				: execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
						encoding: "utf8",
						timeout: 2_000,
					}).trim();
		const processStartedAt = Date.parse(value);
		return Number.isFinite(processStartedAt) ? { status: "alive", processStartedAt } : { status: "alive" };
	} catch {
		return { status: "alive" };
	}
}

function assertIdentity(identity: LeaseProcessIdentity): void {
	if (!Number.isInteger(identity.pid) || identity.pid <= 0) throw new TypeError("Lease identity pid must be positive");
	if (!identity.hostname) throw new TypeError("Lease identity hostname must be non-empty");
	if (!identity.bootId) throw new TypeError("Lease identity bootId must be non-empty");
	if (!Number.isFinite(identity.processStartedAt) || identity.processStartedAt < 0) {
		throw new TypeError("Lease identity processStartedAt must be a non-negative timestamp");
	}
}

function resolveOptions(options: SessionLeaseOptions, durable = true): ResolvedOptions {
	const identity = { ...(options.identity ?? defaultIdentity) };
	assertIdentity(identity);
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 0) {
		throw new TypeError("heartbeatIntervalMs must be a non-negative number");
	}
	return {
		identity,
		inspectProcess: options.inspectProcess ?? inspectProcess,
		now: options.now ?? Date.now,
		randomNonce: options.randomNonce ?? randomUUID,
		syncDirectory: options.syncDirectory ?? syncDirectorySync,
		heartbeatIntervalMs,
		durable,
	};
}

function pathsFor(sessionFile: string): LeasePaths {
	if (!sessionFile) throw new TypeError("sessionFile must be non-empty");
	const canonicalSessionFile = canonicalizePathForCreation(sessionFile);
	const leaseDirectory = `${canonicalSessionFile}.lease`;
	return {
		sessionFile: canonicalSessionFile,
		leaseDirectory,
		ownerFile: join(leaseDirectory, "owner.json"),
		gateFile: `${canonicalSessionFile}.write.lock`,
		reclaimFile: `${canonicalSessionFile}.write.lock.reclaim`,
		reclaimForceFile: `${canonicalSessionFile}.write.lock.reclaim.force`,
	};
}

function now(options: ResolvedOptions): number {
	const value = options.now();
	if (!Number.isFinite(value) || value < 0) throw new TypeError("Lease clock must return a non-negative timestamp");
	return value;
}

function nonce(options: ResolvedOptions): string {
	const value = options.randomNonce();
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		throw new TypeError("Lease nonce must contain only alphanumeric characters, '.', '_', or '-'");
	}
	return value;
}

function createOwner(options: ResolvedOptions): LeaseOwner {
	return { ...options.identity, nonce: nonce(options), updatedAt: now(options) };
}

function serializeOwner(owner: LeaseOwner): string {
	return `${JSON.stringify(owner)}\n`;
}

function parseOwner(bytes: string): LeaseOwner | undefined {
	try {
		const value = JSON.parse(bytes) as Partial<LeaseOwner> | null;
		if (!value || typeof value !== "object") return undefined;
		const identity: LeaseProcessIdentity = {
			pid: value.pid as number,
			hostname: value.hostname as string,
			bootId: value.bootId as string,
			processStartedAt: value.processStartedAt as number,
		};
		assertIdentity(identity);
		if (typeof value.nonce !== "string" || value.nonce.length === 0) return undefined;
		if (!Number.isFinite(value.updatedAt) || (value.updatedAt as number) < 0) return undefined;
		return { ...identity, nonce: value.nonce, updatedAt: value.updatedAt as number };
	} catch {
		return undefined;
	}
}

function readLeaseFile(path: string): string | undefined {
	// Atomic create publishes through a temporary hard link. Heal that exact
	// crash artifact before enforcing the single-link read invariant.
	cleanupPublishedAliasesSync(path);
	return readSingleLinkTextFileSync(path);
}

function readOwner(path: string): LeaseOwner | undefined {
	try {
		const bytes = readLeaseFile(path);
		return bytes === undefined ? undefined : parseOwner(bytes);
	} catch {
		return undefined;
	}
}

function inspectOwnerFile(path: string): LeaseOwner | undefined {
	try {
		const bytes = readSingleLinkTextFileSync(path);
		return bytes === undefined ? undefined : parseOwner(bytes);
	} catch {
		return undefined;
	}
}

function isKnownBootId(value: string): boolean {
	return value !== UNKNOWN_BOOT_ID;
}

function canReclaim(owner: LeaseOwner, options: ResolvedOptions): boolean {
	if (owner.hostname !== options.identity.hostname) return false;
	if (
		isKnownBootId(owner.bootId) &&
		isKnownBootId(options.identity.bootId) &&
		owner.bootId !== options.identity.bootId
	) {
		return true;
	}

	let inspection: LeaseProcessInspection;
	try {
		inspection = options.inspectProcess(owner.pid);
	} catch {
		return false;
	}
	if (inspection.status === "dead") return true;
	if (inspection.status !== "alive" || inspection.processStartedAt === undefined) return false;
	return Math.abs(inspection.processStartedAt - owner.processStartedAt) > PROCESS_START_TOLERANCE_MS;
}

function inspectOwner(owner: LeaseOwner, options: ResolvedOptions): Exclude<SessionLeaseInspection, "free"> {
	if (owner.hostname !== options.identity.hostname) return "unknown";
	if (
		isKnownBootId(owner.bootId) &&
		isKnownBootId(options.identity.bootId) &&
		owner.bootId !== options.identity.bootId
	) {
		return "stale";
	}

	let inspection: LeaseProcessInspection;
	try {
		inspection = options.inspectProcess(owner.pid);
	} catch {
		return "unknown";
	}
	if (inspection.status === "dead") return "stale";
	if (inspection.status === "unknown") return "unknown";
	if (inspection.processStartedAt === undefined) return "active";
	return Math.abs(inspection.processStartedAt - owner.processStartedAt) > PROCESS_START_TOLERANCE_MS
		? "stale"
		: "active";
}

/** Inspect lease artifacts without acquiring, reclaiming, or deleting them. */
export function inspectSessionLease(
	sessionFile: string,
	leaseOptions: SessionLeaseOptions = {},
): SessionLeaseInspection {
	const paths = pathsFor(sessionFile);
	const artifacts = [paths.ownerFile, paths.gateFile, paths.reclaimFile, paths.reclaimForceFile];
	if (!existsSync(paths.leaseDirectory) && artifacts.slice(1).every((path) => !existsSync(path))) return "free";

	const owners: LeaseOwner[] = [];
	for (const path of artifacts) {
		if (!existsSync(path)) continue;
		const owner = inspectOwnerFile(path);
		if (!owner) return "unknown";
		owners.push(owner);
	}
	if (existsSync(paths.leaseDirectory) && !existsSync(paths.ownerFile)) return "unknown";
	if (owners.length === 0) return "unknown";

	const options = resolveOptions({ ...leaseOptions, heartbeatIntervalMs: 0 });
	const inspections = owners.map((owner) => inspectOwner(owner, options));
	if (inspections.includes("active")) return "active";
	if (inspections.includes("unknown")) return "unknown";
	return "stale";
}

function sessionInUse(sessionFile: string): SessionLeaseError {
	return new SessionLeaseError("SESSION_IN_USE", `Session is already in use: ${sessionFile}`);
}

function leaseLost(sessionFile: string): SessionLeaseError {
	return new SessionLeaseError("LEASE_LOST", `Session writer lease was lost: ${sessionFile}`);
}

function readFileIfPresent(path: string): string | undefined {
	return readLeaseFile(path);
}

function releaseOwnedFile(path: string, token: GateToken): boolean {
	const bytes = readLeaseFile(path);
	if (bytes === undefined) return false;
	if (bytes !== token.bytes) return false;
	unlinkSync(path);
	if (token.durable !== false) syncDirectorySync(dirname(path));
	return true;
}

function releaseAfterFailure(path: string, token: GateToken): void {
	try {
		releaseOwnedFile(path, token);
	} catch {
		// Preserve the failure that made the caller abort.
	}
}

function recoverReclaimMarkerForForce(
	sessionFile: string,
	paths: LeasePaths,
	options: ResolvedOptions,
): string | undefined {
	const markerBytes = readFileIfPresent(paths.reclaimFile);
	if (markerBytes === undefined) return undefined;
	const markerOwner = parseOwner(markerBytes);
	// Atomic publication means malformed bytes are abandoned, not a partial live write.
	if (markerOwner && !canReclaim(markerOwner, options)) throw sessionInUse(sessionFile);

	const claim = { bytes: serializeOwner(createOwner(options)) };
	try {
		createFileAtomicallySync(paths.reclaimForceFile, claim.bytes, { mode: 0o600 });
	} catch (error) {
		if (errorCode(error) === "EEXIST") throw sessionInUse(sessionFile);
		throw error;
	}

	try {
		if (readFileIfPresent(paths.reclaimFile) !== markerBytes) throw sessionInUse(sessionFile);
		const gateBytes = readFileIfPresent(paths.gateFile);
		const gateOwner = gateBytes === undefined ? undefined : parseOwner(gateBytes);
		if (gateOwner && !canReclaim(gateOwner, options)) throw sessionInUse(sessionFile);

		const recoveryDirectory = join(dirname(paths.sessionFile), ".recovery");
		ensureRealDirectoryDurablySync(recoveryDirectory);
		const artifactPath = join(
			recoveryDirectory,
			`${basename(paths.sessionFile)}.${now(options)}.${nonce(options)}.reclaim.json`,
		);
		createFileAtomicallySync(artifactPath, markerBytes, { mode: 0o600 });

		if (gateBytes !== undefined && !releaseOwnedFile(paths.gateFile, { bytes: gateBytes })) {
			throw sessionInUse(sessionFile);
		}
		if (!releaseOwnedFile(paths.reclaimFile, { bytes: markerBytes })) throw sessionInUse(sessionFile);
		return artifactPath;
	} finally {
		releaseAfterFailure(paths.reclaimForceFile, claim);
	}
}

function recoverForceClaimForForce(
	sessionFile: string,
	paths: LeasePaths,
	options: ResolvedOptions,
): string | undefined {
	const claimBytes = readFileIfPresent(paths.reclaimForceFile);
	if (claimBytes === undefined) return undefined;
	const claimOwner = parseOwner(claimBytes);
	if (!claimOwner || !canReclaim(claimOwner, options)) throw sessionInUse(sessionFile);

	const recoveryDirectory = join(dirname(paths.sessionFile), ".recovery");
	ensureRealDirectoryDurablySync(recoveryDirectory);
	const artifactPath = join(
		recoveryDirectory,
		`${basename(paths.sessionFile)}.${now(options)}.${nonce(options)}.force-claim.json`,
	);
	createFileAtomicallySync(artifactPath, claimBytes, { mode: 0o600 });
	if (!releaseOwnedFile(paths.reclaimForceFile, { bytes: claimBytes })) throw sessionInUse(sessionFile);
	return artifactPath;
}

function createTransientLeaseFile(path: string, bytes: string): void {
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.transient.tmp`);
	try {
		writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
		linkSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function acquireTransientGate(sessionFile: string, paths: LeasePaths, options: ResolvedOptions): GateToken {
	const token: GateToken = { bytes: serializeOwner(createOwner(options)), durable: false };
	try {
		createTransientLeaseFile(paths.gateFile, token.bytes);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return acquireGate(sessionFile, paths, { ...options, durable: true });
		throw error;
	}
	try {
		if (
			existsSync(paths.reclaimFile) ||
			existsSync(paths.reclaimForceFile) ||
			readFileIfPresent(paths.gateFile) !== token.bytes
		) {
			throw sessionInUse(sessionFile);
		}
		return token;
	} catch (error) {
		releaseAfterFailure(paths.gateFile, token);
		throw error;
	}
}

function acquireGate(
	sessionFile: string,
	paths: LeasePaths,
	options: ResolvedOptions,
	allowReclaimMarkerRecovery = false,
): GateToken {
	let reclaimArtifactPath: string | undefined;
	for (let attempt = 0; attempt < 8; attempt++) {
		if (existsSync(paths.reclaimForceFile)) {
			if (!allowReclaimMarkerRecovery) throw sessionInUse(sessionFile);
			reclaimArtifactPath = recoverForceClaimForForce(sessionFile, paths, options) ?? reclaimArtifactPath;
			continue;
		}
		if (existsSync(paths.reclaimFile)) {
			if (!allowReclaimMarkerRecovery) throw sessionInUse(sessionFile);
			reclaimArtifactPath = recoverReclaimMarkerForForce(sessionFile, paths, options) ?? reclaimArtifactPath;
			continue;
		}

		const token = { bytes: serializeOwner(createOwner(options)), reclaimArtifactPath };
		try {
			createFileAtomicallySync(paths.gateFile, token.bytes, { mode: 0o600 });
			if (existsSync(paths.reclaimFile) || existsSync(paths.reclaimForceFile)) {
				releaseAfterFailure(paths.gateFile, token);
				throw sessionInUse(sessionFile);
			}
			if (readFileIfPresent(paths.gateFile) !== token.bytes) throw sessionInUse(sessionFile);
			return token;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				releaseAfterFailure(paths.gateFile, token);
				throw error;
			}
		}

		let existingBytes: string;
		try {
			const bytes = readLeaseFile(paths.gateFile);
			if (bytes === undefined) throw sessionInUse(sessionFile);
			existingBytes = bytes;
		} catch {
			throw sessionInUse(sessionFile);
		}
		const existingOwner = parseOwner(existingBytes);
		const reclaimOwner = existingOwner ?? readOwner(paths.ownerFile);
		if (!reclaimOwner || !canReclaim(reclaimOwner, options)) throw sessionInUse(sessionFile);

		const marker = { bytes: serializeOwner(createOwner(options)) };
		try {
			createFileAtomicallySync(paths.reclaimFile, marker.bytes, { mode: 0o600 });
		} catch (error) {
			if (errorCode(error) === "EEXIST") throw sessionInUse(sessionFile);
			throw error;
		}

		let publishedGate = false;
		try {
			if (existsSync(paths.reclaimForceFile)) throw sessionInUse(sessionFile);
			if (readFileIfPresent(paths.gateFile) !== existingBytes) throw sessionInUse(sessionFile);
			unlinkSync(paths.gateFile);
			syncDirectorySync(dirname(paths.gateFile));
			if (existsSync(paths.reclaimForceFile)) throw sessionInUse(sessionFile);
			try {
				createFileAtomicallySync(paths.gateFile, token.bytes, { mode: 0o600 });
				publishedGate = true;
			} catch (error) {
				if (errorCode(error) === "EEXIST") throw sessionInUse(sessionFile);
				throw error;
			}
			if (
				existsSync(paths.reclaimForceFile) ||
				readFileIfPresent(paths.reclaimFile) !== marker.bytes ||
				readFileIfPresent(paths.gateFile) !== token.bytes
			) {
				throw sessionInUse(sessionFile);
			}
			if (!releaseOwnedFile(paths.reclaimFile, marker)) throw sessionInUse(sessionFile);
			return token;
		} catch (error) {
			if (publishedGate) releaseAfterFailure(paths.gateFile, token);
			releaseAfterFailure(paths.reclaimFile, marker);
			throw error;
		}
	}
	throw sessionInUse(sessionFile);
}

function withGate<T>(
	sessionFile: string,
	paths: LeasePaths,
	options: ResolvedOptions,
	operation: (token: GateToken) => T,
	allowReclaimMarkerRecovery = false,
): T {
	const token = options.durable
		? acquireGate(sessionFile, paths, options, allowReclaimMarkerRecovery)
		: acquireTransientGate(sessionFile, paths, options);
	let result: T;
	try {
		result = operation(token);
	} catch (error) {
		releaseAfterFailure(paths.gateFile, token);
		throw error;
	}
	if (!releaseOwnedFile(paths.gateFile, token)) throw leaseLost(sessionFile);
	return result;
}

export class SessionLease {
	private readonly sessionFile: string;
	private readonly paths: LeasePaths;
	private readonly options: ResolvedOptions;
	private owner: LeaseOwner;
	private heartbeatTimer?: NodeJS.Timeout;
	private closed = false;
	private lost = false;
	private releasePhase: "active" | "parent_sync_pending" | "released" = "active";

	private constructor(sessionFile: string, paths: LeasePaths, options: ResolvedOptions, owner: LeaseOwner) {
		this.sessionFile = sessionFile;
		this.paths = paths;
		this.options = options;
		this.owner = owner;
		this.startHeartbeat();
	}

	static acquire(sessionFile: string, leaseOptions: SessionLeaseOptions = {}): SessionLease {
		return SessionLease.acquireResolved(sessionFile, resolveOptions(leaseOptions));
	}

	/**
	 * Process-lifetime fence for a batch already protected by one durable project
	 * lease and recovery manifest. It shares the normal gate/owner/liveness format.
	 */
	static acquireTransient(sessionFile: string, leaseOptions: SessionLeaseOptions = {}): SessionLease {
		return SessionLease.acquireResolved(
			sessionFile,
			resolveOptions({ ...leaseOptions, heartbeatIntervalMs: 0 }, false),
		);
	}

	private static acquireResolved(sessionFile: string, options: ResolvedOptions): SessionLease {
		const paths = pathsFor(sessionFile);
		const owner = withGate(paths.sessionFile, paths, options, () => {
			if (existsSync(paths.leaseDirectory)) {
				const currentOwner = readOwner(paths.ownerFile);
				if (!currentOwner || !canReclaim(currentOwner, options)) throw sessionInUse(paths.sessionFile);
				rmSync(paths.leaseDirectory, { recursive: true, force: true });
				if (options.durable) syncDirectorySync(dirname(paths.leaseDirectory));
			}

			mkdirSync(paths.leaseDirectory, { mode: 0o700 });
			if (options.durable) syncDirectorySync(dirname(paths.leaseDirectory));
			const owner = createOwner(options);
			try {
				if (options.durable) {
					createFileAtomicallySync(paths.ownerFile, serializeOwner(owner), { mode: 0o600 });
				} else {
					createTransientLeaseFile(paths.ownerFile, serializeOwner(owner));
				}
			} catch (error) {
				rmSync(paths.leaseDirectory, { recursive: true, force: true });
				if (options.durable) syncDirectorySync(dirname(paths.leaseDirectory));
				throw error;
			}
			return owner;
		});
		// Do not start heartbeats until the acquisition gate is released.
		return new SessionLease(paths.sessionFile, paths, options, owner);
	}

	static forceUnlock(sessionFile: string, leaseOptions: SessionLeaseOptions = {}): string | undefined {
		const paths = pathsFor(sessionFile);
		const options = resolveOptions(leaseOptions);
		return withGate(
			paths.sessionFile,
			paths,
			options,
			(token) => {
				if (!existsSync(paths.leaseDirectory)) return token.reclaimArtifactPath;
				const recoveryDirectory = join(dirname(paths.sessionFile), ".recovery");
				ensureRealDirectoryDurablySync(recoveryDirectory);
				const artifactPath = join(
					recoveryDirectory,
					`${basename(paths.sessionFile)}.${now(options)}.${nonce(options)}.lease`,
				);
				renameSync(paths.leaseDirectory, artifactPath);
				syncDirectorySync(artifactPath);
				syncDirectorySync(recoveryDirectory);
				syncDirectorySync(dirname(paths.leaseDirectory));
				return artifactPath;
			},
			true,
		);
	}

	withWritePermit<T>(operation: () => T): T {
		if (this.closed || this.lost) throw leaseLost(this.sessionFile);
		return withGate(this.sessionFile, this.paths, this.options, () => {
			this.assertOwnership();
			return operation();
		});
	}

	heartbeat(): void {
		this.withWritePermit(() => {
			this.owner = { ...this.owner, updatedAt: now(this.options) };
			replaceFileAtomicallySync(this.paths.ownerFile, serializeOwner(this.owner), { mode: 0o600 });
		});
	}

	close(): void {
		if (this.closed) return;
		this.stopHeartbeat();
		if (this.releasePhase === "parent_sync_pending") {
			this.options.syncDirectory(dirname(this.paths.leaseDirectory));
			this.releasePhase = "released";
			this.closed = true;
			return;
		}
		try {
			withGate(this.sessionFile, this.paths, this.options, () => {
				this.assertOwnership();
				rmSync(this.paths.leaseDirectory, { recursive: true, force: true });
				this.releasePhase = this.options.durable ? "parent_sync_pending" : "released";
				if (this.options.durable) this.options.syncDirectory(dirname(this.paths.leaseDirectory));
				this.releasePhase = "released";
			});
			this.closed = true;
		} catch (error) {
			if (this.releasePhase === "released") this.closed = true;
			if (this.releasePhase === "active" && !this.lost) this.startHeartbeat();
			throw error;
		}
	}

	private assertOwnership(): void {
		const current = readOwner(this.paths.ownerFile);
		if (!current || current.nonce !== this.owner.nonce) {
			this.lost = true;
			this.stopHeartbeat();
			throw leaseLost(this.sessionFile);
		}
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer || this.options.heartbeatIntervalMs === 0 || this.closed || this.lost) return;
		this.heartbeatTimer = setInterval(() => {
			try {
				this.heartbeat();
			} catch (error) {
				if (error instanceof SessionLeaseError && error.code === "LEASE_LOST") this.stopHeartbeat();
			}
		}, this.options.heartbeatIntervalMs);
		this.heartbeatTimer.unref();
	}

	private stopHeartbeat(): void {
		if (!this.heartbeatTimer) return;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}
}

/** Fence creation and destructive mutation for one mode within one project session directory. */
export function acquireModeProjectMutationLease(
	projectSessionDir: string,
	mode: AgentMode,
	options: SessionLeaseOptions = {},
): SessionLease {
	if (!isAgentMode(mode)) throw new TypeError("Project mutation lease mode must be chat or code");
	const directory = canonicalizePathForCreation(projectSessionDir);
	ensureRealDirectoryDurablySync(directory, 0o700);
	return SessionLease.acquire(join(directory, `.mode-${mode}-project.mutation`), options);
}
