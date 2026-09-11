import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { replaceFileAtomicallySync } from "../durable-file.ts";
import type {
	PluginHookComponent,
	PluginIssue,
	PluginMcpComponent,
	PluginOwner,
	PluginRegistry,
	PluginSkillComponent,
	PluginSnapshot,
} from "./types.ts";

export const OFFICIAL_MARKET_ID = "official-market";
export const OFFICIAL_MARKET_URL = "https://github.com/anthropics/claude-plugins-official";
export const OFFICIAL_MARKET_NAME = "anthropics/claude-plugins-official";

export function getPluginsDir(agentDir: string): string {
	return join(agentDir, "plugins");
}

export function getPluginRegistryPath(agentDir: string): string {
	return join(getPluginsDir(agentDir), "registry.json");
}

export function getPluginLockPath(agentDir: string): string {
	return join(getPluginsDir(agentDir), "registry.lock");
}

export function getPluginPackagesDir(agentDir: string): string {
	return join(getPluginsDir(agentDir), "packages");
}

export function getPluginPackageDir(agentDir: string, pluginId: string, commit: string): string {
	return join(getPluginPackagesDir(agentDir), pluginId, commit);
}

export function getPluginDataDir(agentDir: string, pluginId: string): string {
	return join(getPluginsDir(agentDir), "data", pluginId);
}

export function getPluginCacheDir(agentDir: string): string {
	return join(getPluginsDir(agentDir), "cache");
}

export function createInitialPluginRegistry(): PluginRegistry {
	return {
		schemaVersion: 1,
		revision: 1,
		markets: [
			{
				id: OFFICIAL_MARKET_ID,
				url: OFFICIAL_MARKET_URL,
				displayName: OFFICIAL_MARKET_NAME,
				selected: true,
			},
		],
		installed: [],
	};
}

function ensureLockFile(lockPath: string): void {
	mkdirSync(dirname(lockPath), { recursive: true });
	if (!existsSync(lockPath)) {
		try {
			replaceFileAtomicallySync(lockPath, "", { mode: 0o600 });
		} catch {
			// ignore if already created by another process
		}
	}
}

function acquireLockSyncWithRetry(lockPath: string): () => void {
	ensureLockFile(lockPath);
	const maxAttempts = 20;
	const delayMs = 25;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(lockPath, { realpath: false });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// busy wait sync
			}
		}
	}
	throw (lastError as Error) ?? new Error("Failed to acquire plugin registry lock");
}

export function readPluginRegistry(agentDir: string): PluginRegistry {
	const registryPath = getPluginRegistryPath(agentDir);
	if (!existsSync(registryPath)) {
		const initial = createInitialPluginRegistry();
		mkdirSync(dirname(registryPath), { recursive: true });
		replaceFileAtomicallySync(registryPath, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
		return initial;
	}

	const content = readFileSync(registryPath, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Plugin registry file at ${registryPath} is corrupted. File preserved.`);
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("schemaVersion" in parsed) ||
		(parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
		!("revision" in parsed) ||
		typeof (parsed as { revision?: unknown }).revision !== "number" ||
		!("markets" in parsed) ||
		!Array.isArray((parsed as { markets?: unknown }).markets) ||
		!("installed" in parsed) ||
		!Array.isArray((parsed as { installed?: unknown }).installed)
	) {
		throw new Error(`Plugin registry file at ${registryPath} has invalid schema. File preserved.`);
	}

	return parsed as PluginRegistry;
}

export function withPluginRegistryLock<T>(
	agentDir: string,
	fn: (current: PluginRegistry) => { next?: PluginRegistry; result: T },
): T {
	const lockPath = getPluginLockPath(agentDir);
	const release = acquireLockSyncWithRetry(lockPath);
	try {
		const current = readPluginRegistry(agentDir);
		const { next, result } = fn(current);
		if (next !== undefined) {
			const registryPath = getPluginRegistryPath(agentDir);
			replaceFileAtomicallySync(registryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		}
		return result;
	} finally {
		release();
	}
}

export interface NormalizedPluginPackage {
	readonly pluginId: string;
	readonly commit: string;
	readonly format: string;
	readonly name: string;
	readonly displayName: string;
	readonly description: string;
	readonly version?: string;
	readonly components: readonly NormalizedComponent[];
	readonly issues: readonly PluginIssue[];
}

export interface NormalizedComponent {
	readonly kind: "skill" | "mcp" | "hook" | "unsupported";
	readonly componentId: string;
	readonly name: string;
	readonly originalName?: string;
	readonly relativeEntryPath?: string;
	readonly relativeBaseDir?: string;
	readonly disableModelInvocation?: boolean;
	readonly definition?: unknown;
	readonly reason?: string;
}

export function readPluginSnapshot(agentDir: string): PluginSnapshot {
	const registry = readPluginRegistry(agentDir);
	const enabledPlugins = registry.installed.filter((p) => p.enabled);

	const skills: PluginSkillComponent[] = [];
	const mcp: PluginMcpComponent[] = [];
	const hooks: PluginHookComponent[] = [];
	const diagnostics: PluginIssue[] = [];

	for (const plugin of enabledPlugins) {
		const packageDir = getPluginPackageDir(agentDir, plugin.id, plugin.commit);
		const normalizedPath = join(packageDir, "normalized.json");

		if (!existsSync(normalizedPath)) {
			diagnostics.push({
				code: "PACKAGE_MISSING",
				componentId: plugin.id,
				message: `Plugin package files for ${plugin.displayName} are missing`,
				status: "unsupported",
			});
			continue;
		}

		let normalized: NormalizedPluginPackage;
		try {
			normalized = JSON.parse(readFileSync(normalizedPath, "utf8"));
		} catch {
			diagnostics.push({
				code: "PACKAGE_CORRUPTED",
				componentId: plugin.id,
				message: `Plugin package manifest for ${plugin.displayName} is corrupted`,
				status: "unsupported",
			});
			continue;
		}

		if (Array.isArray(normalized.issues)) {
			diagnostics.push(...normalized.issues);
		}

		if (!Array.isArray(normalized.components)) continue;

		for (const comp of normalized.components) {
			const owner: PluginOwner = {
				pluginId: plugin.id,
				displayName: plugin.displayName,
				componentId: comp.componentId,
			};

			if (comp.kind === "skill") {
				if (typeof comp.relativeEntryPath !== "string") continue;
				const filePath = resolve(packageDir, comp.relativeEntryPath);
				const baseDir = comp.relativeBaseDir ? resolve(packageDir, comp.relativeBaseDir) : dirname(filePath);

				skills.push({
					kind: "skill",
					owner,
					name: comp.name,
					originalName: comp.originalName || comp.name,
					filePath,
					baseDir,
					disableModelInvocation: comp.disableModelInvocation,
				});
			} else if (comp.kind === "mcp") {
				if (!comp.definition || typeof comp.definition !== "object") continue;
				mcp.push({
					kind: "mcp",
					owner,
					name: comp.name,
					originalName: comp.originalName || comp.name,
					packageDir,
					definition: comp.definition as PluginMcpComponent["definition"],
				});
			} else if (comp.kind === "hook") {
				if (!comp.definition || typeof comp.definition !== "object") continue;
				hooks.push({
					kind: "hook",
					owner,
					packageDir,
					definition: comp.definition as PluginHookComponent["definition"],
				});
			}
		}
	}

	const fingerprintData = {
		plugins: enabledPlugins.map((p) => `${p.id}@${p.commit}`),
		skills: skills.map((s) => `${s.name}:${s.filePath}:${Boolean(s.disableModelInvocation)}`),
		mcp: mcp.map((m) => [m.name, m.definition]),
		hooks: hooks.map((h) => [h.definition.id, h.definition]),
		diagnostics: diagnostics.map((d) => [d.componentId, d.code, d.status]),
	};
	const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintData)).digest("hex");

	return {
		fingerprint,
		plugins: enabledPlugins,
		skills,
		mcp,
		hooks,
		diagnostics,
	};
}
