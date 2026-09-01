import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeActionPath } from "../../utils/paths.ts";
import { assertCompleteAction, digestCanonical, digestPermissionAction } from "./normalize.ts";
import type { ExecutionGrant, GrantRequest, NetworkEndpoint, NormalizedPermissionAction } from "./types.ts";

export const EXECUTION_GRANT_TTL_MS = 30_000;
const EXECUTION_TARGETS = ["sandbox", "host", "external"] as const;
const MAX_PROTECTED_ROOTS = 4_096;

export interface SandboxGrantProfile {
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly protectedRoots: readonly string[];
	readonly networkEndpoints: readonly NetworkEndpoint[];
}

export interface ExecutionGrantIssueInput {
	readonly action: NormalizedPermissionAction;
	readonly grant: GrantRequest;
	readonly settingsEpoch: number;
}

export interface ExecutionGrantConsumeInput {
	readonly action: NormalizedPermissionAction;
	readonly settingsEpoch: number;
	readonly executionTarget: GrantRequest["executionTarget"];
}

export interface ExecutionGrantStoreOptions {
	readonly now?: () => number;
	readonly createId?: () => string;
}

interface StoredGrant {
	readonly grant: ExecutionGrant;
	readonly profileDigest: string;
}

type GrantState = "active" | "consumed" | "claimed" | "revoked";
const grantStates = new WeakMap<ExecutionGrant, GrantState>();

export function assertConsumedExecutionGrant(grant: ExecutionGrant): void {
	if (grantStates.get(grant) !== "consumed") {
		throw new Error("Execution grant was not consumed or is no longer usable");
	}
}

export function claimConsumedExecutionGrant(grant: ExecutionGrant): void {
	assertConsumedExecutionGrant(grant);
	grantStates.set(grant, "claimed");
}

function exactArray(left: readonly unknown[], right: readonly unknown[]): boolean {
	return isDeepStrictEqual(left, right);
}

function normalizedProtectedRoots(roots: readonly string[], cwd: string): readonly string[] {
	if (!Array.isArray(roots) || roots.length > MAX_PROTECTED_ROOTS) {
		throw new TypeError("Grant protected roots are invalid");
	}
	for (let index = 0; index < roots.length; index += 1) {
		const root = roots[index];
		if (
			typeof root !== "string" ||
			!isAbsolute(root) ||
			root.includes("\0") ||
			canonicalizeActionPath(root, cwd) !== root ||
			(index > 0 && (roots[index - 1] ?? "") >= root)
		) {
			throw new TypeError("Grant protected roots are invalid");
		}
	}
	return Object.freeze([...roots]);
}

function normalizedProfile(action: NormalizedPermissionAction, grant: GrantRequest): SandboxGrantProfile {
	if (!grant || typeof grant !== "object" || !EXECUTION_TARGETS.includes(grant.executionTarget)) {
		throw new TypeError("Grant execution target is invalid");
	}
	if (!exactArray(grant.readRoots, action.readPaths)) throw new TypeError("Grant read roots do not match the action");
	if (!exactArray(grant.writeRoots, action.writePaths))
		throw new TypeError("Grant write roots do not match the action");
	if (!exactArray(grant.networkEndpoints, action.networkEndpoints)) {
		throw new TypeError("Grant network endpoints do not match the action");
	}
	return Object.freeze({
		readRoots: Object.freeze([...grant.readRoots]),
		writeRoots: Object.freeze([...grant.writeRoots]),
		protectedRoots: normalizedProtectedRoots(grant.protectedRoots, action.cwd),
		networkEndpoints: Object.freeze(
			grant.networkEndpoints.map(({ hostname, port }) => Object.freeze({ hostname, port })),
		),
	});
}

export function executionGrantProfile(grant: ExecutionGrant): SandboxGrantProfile {
	return Object.freeze({
		readRoots: Object.freeze([...grant.readRoots]),
		writeRoots: Object.freeze([...grant.writeRoots]),
		protectedRoots: Object.freeze([...grant.protectedRoots]),
		networkEndpoints: Object.freeze(
			grant.networkEndpoints.map(({ hostname, port }) => Object.freeze({ hostname, port })),
		),
	});
}

export function digestExecutionGrantProfile(profile: SandboxGrantProfile): string {
	return digestCanonical(profile);
}

function settingsEpoch(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Settings epoch is invalid");
	return value;
}

function grantId(value: string): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.trim() !== value ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > 256
	) {
		throw new TypeError("Grant identifier is invalid");
	}
	return value;
}

function mismatch(field: string): never {
	throw new Error(`Execution grant ${field} changed before consumption`);
}

export class ExecutionGrantStore {
	private readonly active = new Map<string, StoredGrant>();
	private readonly now: () => number;
	private readonly createId: () => string;
	private highestSettingsEpoch = 0;

	constructor(options: ExecutionGrantStoreOptions = {}) {
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
	}

	private currentTime(): number {
		const now = this.now();
		if (!Number.isFinite(now)) throw new TypeError("Grant clock is invalid");
		return now;
	}

	issue(input: ExecutionGrantIssueInput): ExecutionGrant {
		assertCompleteAction(input.action);
		const epoch = settingsEpoch(input.settingsEpoch);
		if (epoch < this.highestSettingsEpoch) throw new Error("Cannot issue a grant for an older settings epoch");
		const id = grantId(this.createId());
		if (this.active.has(id)) throw new Error("Grant identifier is already active");
		const now = this.currentTime();
		const profile = normalizedProfile(input.action, input.grant);
		const grant = Object.freeze({
			...profile,
			executionTarget: input.grant.executionTarget,
			grantId: id,
			actionId: input.action.actionId,
			actionDigest: digestPermissionAction(input.action),
			toolName: input.action.toolName,
			toolIdentity: input.action.toolIdentity,
			argsDigest: input.action.argsDigest,
			...(input.action.command === undefined ? {} : { command: input.action.command }),
			cwd: input.action.cwd,
			workspaceRoots: Object.freeze([...input.action.workspaceRoots]),
			settingsEpoch: epoch,
			issuedAt: new Date(now).toISOString(),
			expiresAt: new Date(now + EXECUTION_GRANT_TTL_MS).toISOString(),
		}) satisfies ExecutionGrant;
		this.highestSettingsEpoch = epoch;
		this.active.set(id, { grant, profileDigest: digestExecutionGrantProfile(profile) });
		grantStates.set(grant, "active");
		return grant;
	}

	consumeExact(id: string, current: ExecutionGrantConsumeInput): ExecutionGrant {
		const stored = this.active.get(id);
		if (!stored) throw new Error("Execution grant is not active or was already consumed");
		this.active.delete(id);
		const { grant } = stored;
		grantStates.set(grant, "revoked");
		if (this.currentTime() >= Date.parse(grant.expiresAt)) {
			throw new Error("Execution grant expired before consumption");
		}
		if (current.action.toolIdentity !== grant.toolIdentity) mismatch("toolIdentity");
		if (current.action.argsDigest !== grant.argsDigest) mismatch("argsDigest");
		if (current.action.cwd !== grant.cwd) mismatch("cwd");
		if (!exactArray(current.action.workspaceRoots, grant.workspaceRoots)) mismatch("workspaceRoots");
		if (!exactArray(current.action.readPaths, grant.readRoots)) mismatch("read paths");
		if (!exactArray(current.action.writePaths, grant.writeRoots)) mismatch("write paths");
		if (!exactArray(current.action.networkEndpoints, grant.networkEndpoints)) mismatch("network endpoints");
		if (current.settingsEpoch !== grant.settingsEpoch) mismatch("settingsEpoch");
		if (current.executionTarget !== grant.executionTarget) mismatch("executionTarget");
		assertCompleteAction(current.action);
		if (digestPermissionAction(current.action) !== grant.actionDigest) mismatch("action");
		if (digestExecutionGrantProfile(executionGrantProfile(grant)) !== stored.profileDigest) mismatch("profile");
		grantStates.set(grant, "consumed");
		return grant;
	}

	has(id: string): boolean {
		return this.active.has(id);
	}

	revoke(id: string): boolean {
		const stored = this.active.get(id);
		if (!stored) return false;
		this.active.delete(id);
		grantStates.set(stored.grant, "revoked");
		return true;
	}

	retire(grant: ExecutionGrant): void {
		if (grantStates.has(grant)) grantStates.set(grant, "revoked");
	}

	revokeAll(): number {
		const count = this.active.size;
		for (const { grant } of this.active.values()) grantStates.set(grant, "revoked");
		this.active.clear();
		return count;
	}
}
