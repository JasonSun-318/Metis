import { createHash, randomUUID } from "node:crypto";
import { canonicalizePathForCreation } from "../../utils/paths.ts";
import {
	type AuthStorage,
	type AuthStorageChange,
	legacyMcpCredentialKey,
	type McpCredentialIdentity,
	type McpSecretCredential,
	mcpCredentialKey,
	mcpVersionedCredentialKey,
	mcpVersionedCredentialPrefix,
} from "../auth-storage.ts";
import type { McpServerSettings, SettingsManager } from "../settings-manager.ts";
import { mcpServerFingerprint, resolveMcpServerSettings } from "./config.ts";
import type { McpManager, McpPreparedConfiguration } from "./manager.ts";

export type McpConfigurationScope = "user" | "project";

export type McpCredentialChange =
	| { readonly action: "preserve" }
	| { readonly action: "remove" }
	| {
			readonly action: "replace";
			readonly bearerToken?: string;
			readonly environment?: Readonly<Record<string, string>>;
	  };

export interface McpConfigurationChange {
	readonly name: string;
	readonly expectedRevision: string | null;
	readonly next: McpServerSettings | undefined;
	readonly credential: McpCredentialChange;
}

export interface McpConfigurationMutation {
	readonly settingsManager: SettingsManager;
	readonly cwd: string;
	readonly scope: McpConfigurationScope;
	readonly changes: readonly McpConfigurationChange[];
}

export interface McpConfigurationResult {
	readonly scope: McpConfigurationScope;
	readonly entries: readonly {
		readonly name: string;
		readonly server?: McpServerSettings;
		readonly revision?: string;
		readonly credentialConfigured: boolean;
	}[];
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export function mcpConfigurationRevision(
	scope: McpConfigurationScope,
	name: string,
	server: McpServerSettings,
	credentialState?: string,
): string {
	const publicServer =
		typeof server.command === "string" && server.env ? { ...server, env: Object.keys(server.env).sort() } : server;
	return createHash("sha256")
		.update(canonicalJson([scope, name, publicServer, credentialState]))
		.digest("hex");
}

export class McpConfigurationConflictError extends Error {
	readonly names: readonly string[];

	constructor(names: readonly string[]) {
		super(`MCP configuration changed: ${names.join(", ")}`);
		this.name = "McpConfigurationConflictError";
		this.names = names;
	}
}

interface NormalizedChange {
	readonly name: string;
	readonly previous: McpServerSettings | undefined;
	readonly next: McpServerSettings | undefined;
	readonly stagedCredential?: AuthStorageChange;
	readonly keepCredentialKey?: string;
	readonly cleanupCredentialKeys: readonly string[];
}

interface PreparedRuntime {
	readonly manager: McpManager;
	readonly prepared: McpPreparedConfiguration;
}

function credentialIdentity(scope: McpConfigurationScope, name: string, cwd: string): McpCredentialIdentity {
	return scope === "user" ? { scope, name } : { scope, name, cwd };
}

function nonEmptyCredential(credential: McpSecretCredential | undefined): McpSecretCredential | undefined {
	if (!credential) return undefined;
	if (credential.bearerToken || Object.keys(credential.env ?? {}).length > 0) return credential;
	return undefined;
}

export class McpConfigurationCoordinator {
	private readonly authStorage: AuthStorage;
	private readonly runtimes = new Set<McpManager>();
	private mutationTail: Promise<void> = Promise.resolve();
	private readonly diagnostics: Error[] = [];

	constructor(options: { readonly authStorage: AuthStorage }) {
		this.authStorage = options.authStorage;
	}

	register(manager: McpManager): () => void {
		this.runtimes.add(manager);
		return () => this.runtimes.delete(manager);
	}

	drainDiagnostics(): Error[] {
		return this.diagnostics.splice(0);
	}

	mutate(mutation: McpConfigurationMutation): Promise<McpConfigurationResult> {
		const previous = this.mutationTail;
		let release!: () => void;
		this.mutationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		return previous.then(() => this.performMutation(mutation)).finally(release);
	}

	private matchingCredential(
		identity: McpCredentialIdentity,
		name: string,
		server: McpServerSettings | undefined,
		cwd: string,
	): { key: string; credential: McpSecretCredential; fingerprint: string } | undefined {
		if (!server) return undefined;
		const resolved = resolveMcpServerSettings(name, server, cwd, process.env, identity);
		const fingerprint = mcpServerFingerprint(resolved);
		for (const key of new Set([resolved.credentialKey, mcpCredentialKey(identity), legacyMcpCredentialKey(name)])) {
			const credential = this.authStorage.get(key);
			if (credential?.type === "mcp_secret" && credential.serverFingerprint === fingerprint) {
				return { key, credential: structuredClone(credential), fingerprint };
			}
		}
		return undefined;
	}

	private credentialKeys(identity: McpCredentialIdentity, name: string): string[] {
		const versionedPrefix = mcpVersionedCredentialPrefix(identity);
		return this.authStorage
			.list()
			.filter(
				(key) =>
					key.startsWith(versionedPrefix) ||
					key === mcpCredentialKey(identity) ||
					key === legacyMcpCredentialKey(name),
			);
	}

	private normalizeChange(
		mutation: McpConfigurationMutation,
		change: McpConfigurationChange,
		previous: McpServerSettings | undefined,
	): NormalizedChange {
		const identity = credentialIdentity(mutation.scope, change.name, mutation.cwd);
		const previousCredential = this.matchingCredential(identity, change.name, previous, mutation.cwd);
		const cleanupCredentialKeys = this.credentialKeys(identity, change.name);
		if (!change.next) return { name: change.name, previous, next: undefined, cleanupCredentialKeys };

		const next = structuredClone(change.next);
		const inlineEnvironment = typeof next.command === "string" ? { ...(next.env ?? {}) } : {};
		if (typeof next.command === "string") delete next.env;
		delete next.credentialVersion;
		const resolved = resolveMcpServerSettings(change.name, next, mutation.cwd, process.env, identity);
		const fingerprint = mcpServerFingerprint(resolved);

		let credential: McpSecretCredential | undefined;
		if (change.credential.action === "replace") {
			const environment = { ...(change.credential.environment ?? {}) };
			if (
				change.credential.bearerToken === "" ||
				Object.entries(environment).some(([name, value]) => !name || !value)
			) {
				throw new Error("MCP secret names and values must not be empty");
			}
			if (change.credential.bearerToken && "command" in next) {
				throw new Error("Bearer credentials require an HTTP MCP server");
			}
			credential = nonEmptyCredential({
				type: "mcp_secret",
				...(change.credential.bearerToken ? { bearerToken: change.credential.bearerToken } : {}),
				...(Object.keys(environment).length > 0 ? { env: environment } : {}),
				serverFingerprint: fingerprint,
			});
		} else if (change.credential.action === "preserve") {
			const canPreserve = previousCredential?.fingerprint === fingerprint;
			credential = nonEmptyCredential({
				type: "mcp_secret",
				...(canPreserve && previousCredential?.credential.bearerToken
					? { bearerToken: previousCredential.credential.bearerToken }
					: {}),
				...((canPreserve && previousCredential?.credential.env) || Object.keys(inlineEnvironment).length > 0
					? {
							env: {
								...(canPreserve ? previousCredential?.credential.env : {}),
								...inlineEnvironment,
							},
						}
					: {}),
				serverFingerprint: fingerprint,
			});
		}

		if (!credential) return { name: change.name, previous, next, cleanupCredentialKeys };

		const canReuseVersion = Boolean(
			change.credential.action === "preserve" &&
				Object.keys(inlineEnvironment).length === 0 &&
				previous?.credentialVersion &&
				previousCredential?.key.startsWith(mcpVersionedCredentialPrefix(identity)),
		);
		const credentialVersion = canReuseVersion ? previous!.credentialVersion! : randomUUID();
		next.credentialVersion = credentialVersion;
		const key = mcpVersionedCredentialKey(identity, fingerprint, credentialVersion);
		return {
			name: change.name,
			previous,
			next,
			...(canReuseVersion ? {} : { stagedCredential: { provider: key, credential } }),
			keepCredentialKey: key,
			cleanupCredentialKeys,
		};
	}

	private affectedRuntimes(scope: McpConfigurationScope, cwd: string): McpManager[] {
		if (scope === "user") return [...this.runtimes];
		const target = canonicalizePathForCreation(cwd);
		return [...this.runtimes].filter((manager) => canonicalizePathForCreation(manager.configurationCwd) === target);
	}

	private async discardPrepared(prepared: readonly PreparedRuntime[]): Promise<Error[]> {
		const settled = await Promise.allSettled(
			prepared.map(({ manager, prepared: token }) => manager.discardConfiguration(token)),
		);
		return settled.flatMap((result) =>
			result.status === "rejected"
				? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
				: [],
		);
	}

	private rollbackStaged(staged: readonly AuthStorageChange[]): Error[] {
		if (staged.length === 0) return [];
		try {
			this.authStorage.applyChanges(staged.map(({ provider }) => ({ provider, credential: undefined })));
			return [];
		} catch (error) {
			return [error instanceof Error ? error : new Error(String(error))];
		}
	}

	private async performMutation(mutation: McpConfigurationMutation): Promise<McpConfigurationResult> {
		if (mutation.changes.length === 0) return { scope: mutation.scope, entries: [] };
		const names = mutation.changes.map((change) => change.name);
		if (new Set(names).size !== names.length) throw new Error("Duplicate MCP configuration change");
		if (names.some((name) => !name.trim())) throw new Error("MCP server name must not be empty");

		await mutation.settingsManager.reload();
		this.authStorage.reload();
		const settingsScope = mutation.scope === "user" ? "global" : "project";
		const scopedSettings =
			settingsScope === "global"
				? mutation.settingsManager.getGlobalSettings()
				: mutation.settingsManager.getProjectSettings();
		const currentServers = scopedSettings.mcpServers ?? {};
		const conflicts: string[] = [];
		for (const change of mutation.changes) {
			const current = currentServers[change.name];
			const identity = credentialIdentity(mutation.scope, change.name, mutation.cwd);
			const credential = this.matchingCredential(identity, change.name, current, mutation.cwd);
			const credentialState = current?.credentialVersion ?? (credential ? "legacy" : undefined);
			const revision = current
				? mcpConfigurationRevision(mutation.scope, change.name, current, credentialState)
				: null;
			if (revision !== change.expectedRevision) conflicts.push(change.name);
		}
		if (conflicts.length > 0) throw new McpConfigurationConflictError(conflicts);

		const normalized = mutation.changes.map((change) =>
			this.normalizeChange(mutation, change, currentServers[change.name]),
		);
		const expected = new Map(normalized.map((change) => [change.name, change.previous]));
		const definitions = new Map(normalized.map((change) => [change.name, change.next]));
		const staged = normalized.flatMap((change) => (change.stagedCredential ? [change.stagedCredential] : []));
		if (staged.length > 0) this.authStorage.applyChanges(staged);

		const runtimeResults = await Promise.allSettled(
			this.affectedRuntimes(mutation.scope, mutation.cwd).map(async (manager) => ({
				manager,
				prepared: await manager.prepareConfigurationChanges(settingsScope, definitions),
			})),
		);
		const prepared = runtimeResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		const prepareFailure = runtimeResults.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (prepareFailure) {
			const recoveryErrors = [...(await this.discardPrepared(prepared)), ...this.rollbackStaged(staged)];
			if (recoveryErrors.length > 0) {
				throw new AggregateError([prepareFailure.reason, ...recoveryErrors], "MCP prepare and recovery failed");
			}
			throw prepareFailure.reason;
		}

		try {
			const committed = await mutation.settingsManager.commitMcpServerChanges(settingsScope, expected, definitions);
			if (!committed) throw new McpConfigurationConflictError(names);
		} catch (error) {
			const recoveryErrors = [...(await this.discardPrepared(prepared)), ...this.rollbackStaged(staged)];
			if (recoveryErrors.length > 0) {
				throw new AggregateError([error, ...recoveryErrors], "MCP commit and recovery failed");
			}
			throw error;
		}

		for (const { manager, prepared: token } of prepared) {
			try {
				manager.activateConfiguration(token);
			} catch (error) {
				this.diagnostics.push(error instanceof Error ? error : new Error(String(error)));
			}
		}

		const cleanup = normalized.flatMap((change) =>
			change.cleanupCredentialKeys
				.filter((key) => key !== change.keepCredentialKey)
				.map((provider) => ({ provider, credential: undefined })),
		);
		if (cleanup.length > 0) {
			try {
				this.authStorage.applyChanges(cleanup);
			} catch (error) {
				this.diagnostics.push(error instanceof Error ? error : new Error(String(error)));
			}
		}

		return {
			scope: mutation.scope,
			entries: normalized.map((change) => ({
				name: change.name,
				...(change.next
					? {
							server: structuredClone(change.next),
							revision: mcpConfigurationRevision(mutation.scope, change.name, change.next),
						}
					: {}),
				credentialConfigured: Boolean(change.keepCredentialKey),
			})),
		};
	}
}
