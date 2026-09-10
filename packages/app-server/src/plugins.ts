import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginInspectionView, PluginUpdateInspectionView } from "@metis/app-protocol";
import {
	AuthStorage,
	type CapabilityKind,
	getPluginCacheDir,
	getPluginPackageDir,
	getPluginPackagesDir,
	type MarketRecord,
	type McpCredentialIdentity,
	type NormalizedComponent,
	type NormalizedPluginPackage,
	OFFICIAL_MARKET_ID,
	type PluginFormat,
	type PluginIssue,
	type PluginRecord,
	type PluginRegistry,
	pluginMcpCredentialKeys,
	readPluginRegistry,
	readPluginSnapshot,
	withPluginRegistryLock,
} from "@metis/coding-agent";
import { type FetchImplementation, validArchivePath } from "./github-archive.ts";
import { type ParsedPluginComponent, parsePluginManifest } from "./plugin-manifests.ts";
import {
	type CatalogEntry,
	canonicalizeRepository,
	computePluginId,
	fetchPluginFiles,
	fetchPluginFilesAtCommit,
	inspectRepositorySource,
	type ResolvedPluginFiles,
	resolveTrackedPluginCommit,
} from "./plugin-sources.ts";
import { AppServerError } from "./session-runtime-host.ts";

export type PluginActivationStatus = "applied" | "next-turn" | "failed";

export interface ComponentPublicView {
	readonly componentId: string;
	readonly kind: CapabilityKind;
	readonly displayName: string;
	readonly originalName: string;
	readonly status: "ready" | "needs-configuration" | "unsupported" | "failed";
	readonly reason?: string;
}

export interface PluginInstalledView {
	readonly plugin: PluginRecord;
	readonly components: ComponentPublicView[];
	readonly activation: PluginActivationStatus;
	readonly runtimeErrors: Array<{ readonly componentId: string; readonly message: string }>;
}

export interface PluginMarketCatalogCache {
	readonly commit: string;
	readonly fetchedAt: string;
	readonly catalog: CatalogEntry[];
}

export interface CatalogEntryView {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly formatHint: PluginFormat;
	readonly sourceSupported: boolean;
	readonly installState: "installed" | "not-installed" | "update-available";
}

export interface InspectionCacheData {
	readonly cacheVersion?: number;
	readonly inspectionId: string;
	readonly sourceId: string;
	readonly entryId: string;
	readonly canonicalRepository: string;
	readonly subdir: string;
	readonly commit: string;
	readonly trackingRef?: string;
	readonly pinnedCommit?: string;
	readonly manifestHints?: PluginRecord["manifestHints"];
	readonly plugin: {
		readonly id: string;
		readonly name: string;
		readonly displayName: string;
		readonly format: PluginFormat;
		readonly version?: string;
		readonly description: string;
		readonly repository: string;
		readonly subdir: string;
		readonly commit: string;
		readonly trackingRef?: string;
		readonly pinnedCommit?: string;
		readonly manifestHints?: PluginRecord["manifestHints"];
		readonly sourceId: string;
	};
	readonly components: ComponentPublicView[];
	readonly parsedComponents: readonly ParsedPluginComponent[];
	readonly issues: readonly PluginIssue[];
	readonly files: Array<{ readonly path: string; readonly base64: string; readonly mode: number }>;
	readonly registryRevision: number;
}

export function makeComponentId(pluginId: string, originalName: string): string {
	const prefix = `p-${pluginId.slice(0, 16)}-`;
	const maxSlugLen = 64 - prefix.length;
	const slug = originalName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxSlugLen);
	return `${prefix}${slug || "comp"}`;
}

function getPluginMcpIdentities(agentDir: string, plugin: PluginRecord): McpCredentialIdentity[] {
	const packageDir = getPluginPackageDir(agentDir, plugin.id, plugin.commit);
	const normalizedPath = join(packageDir, ".metis-plugin.json");
	try {
		const normalized = JSON.parse(readFileSync(normalizedPath, "utf8"));
		if (Array.isArray(normalized.components)) {
			return normalized.components
				.filter((c: any) => c.kind === "mcp" && typeof c.name === "string")
				.map((c: any) => ({ scope: "user" as const, name: c.name as string }));
		}
	} catch {
		// Fallback to reading snapshot
	}
	const snapshot = readPluginSnapshot(agentDir);
	return snapshot.mcp
		.filter((c) => c.owner.pluginId === plugin.id)
		.map((c) => ({ scope: "user" as const, name: c.name }));
}

export class PluginService {
	private readonly agentDir: string;
	private readonly fetchImpl: FetchImplementation;
	private readonly authStorage: AuthStorage;
	private readonly inspectionCache = new Map<string, InspectionCacheData>();

	constructor(agentDir: string, fetchImpl: FetchImplementation = globalThis.fetch, authStorage?: AuthStorage) {
		this.agentDir = agentDir;
		this.fetchImpl = fetchImpl;
		this.authStorage = authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
		// Ensure registry is initialized
		readPluginRegistry(this.agentDir);
		try {
			this.drainPendingCredentialCleanup();
		} catch {
			// Ignore init failure
		}
	}

	drainPendingCredentialCleanup(targetKeys?: readonly string[]): void {
		const registry = readPluginRegistry(this.agentDir);
		const pending = registry.pendingCredentialCleanup;
		if (!pending || pending.length === 0) return;
		const keysToClean = targetKeys ? pending.filter((k) => targetKeys.includes(k)) : [...pending];
		if (keysToClean.length === 0) return;

		this.authStorage.applyChanges(keysToClean.map((provider) => ({ provider, credential: undefined })));

		withPluginRegistryLock(this.agentDir, (current) => {
			const remaining = (current.pendingCredentialCleanup ?? []).filter((k) => !keysToClean.includes(k));
			const next: PluginRegistry = {
				...current,
				pendingCredentialCleanup: remaining.length > 0 ? remaining : undefined,
			};
			return { next, result: undefined };
		});
	}

	listMarkets(): { markets: MarketRecord[]; selectedSourceId: string; registryRevision: number } {
		const registry = readPluginRegistry(this.agentDir);
		const selected = registry.markets.find((m) => m.selected) || registry.markets[0];
		return {
			markets: registry.markets,
			selectedSourceId: selected?.id || OFFICIAL_MARKET_ID,
			registryRevision: registry.revision,
		};
	}

	async addMarket(input: {
		requestId: string;
		url: string;
		expectedRevision: number;
	}): Promise<{ markets: MarketRecord[]; selectedSourceId: string; registryRevision: number }> {
		const inspected = await inspectRepositorySource(input.url, this.fetchImpl);
		const marketKey = `${inspected.canonicalRepository}\0${inspected.root || ""}\0${inspected.trackingRef || ""}\0${inspected.pinnedCommit || ""}`;
		const marketId = `market-${createHash("sha256").update(marketKey).digest("hex").slice(0, 16)}`;

		return withPluginRegistryLock(this.agentDir, (current) => {
			if (current.revision !== input.expectedRevision) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			if (
				current.markets.some(
					(m) =>
						m.url.toLowerCase() === inspected.canonicalRepository.toLowerCase() &&
						(m.root || "") === (inspected.root || "") &&
						(m.trackingRef || "") === (inspected.trackingRef || "") &&
						(m.pinnedCommit || "") === (inspected.pinnedCommit || ""),
				)
			) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}

			const nextRecord: MarketRecord = {
				id: marketId,
				url: inspected.canonicalRepository,
				displayName: inspected.repo,
				selected: true,
				fetchedAt: new Date().toISOString(),
				commit: inspected.commit,
				...(inspected.root ? { root: inspected.root } : {}),
				...(inspected.trackingRef ? { trackingRef: inspected.trackingRef } : {}),
				...(inspected.pinnedCommit ? { pinnedCommit: inspected.pinnedCommit } : {}),
			};

			const nextMarkets = current.markets.map((m) => ({ ...m, selected: false }));
			nextMarkets.push(nextRecord);

			// Cache market catalog
			this.writeMarketCatalogCache(marketId, inspected.catalog, inspected.commit);

			const next: PluginRegistry = {
				...current,
				revision: current.revision + 1,
				markets: nextMarkets,
			};

			return {
				next,
				result: {
					markets: nextMarkets,
					selectedSourceId: marketId,
					registryRevision: next.revision,
				},
			};
		});
	}

	selectMarket(input: { requestId: string; sourceId: string; expectedRevision: number }): {
		markets: MarketRecord[];
		selectedSourceId: string;
		registryRevision: number;
	} {
		return withPluginRegistryLock(this.agentDir, (current) => {
			if (current.revision !== input.expectedRevision) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			const exists = current.markets.some((m) => m.id === input.sourceId);
			if (!exists) {
				throw new AppServerError("NOT_FOUND", { requestId: input.requestId });
			}

			const nextMarkets = current.markets.map((m) => ({
				...m,
				selected: m.id === input.sourceId,
			}));

			const next: PluginRegistry = {
				...current,
				revision: current.revision + 1,
				markets: nextMarkets,
			};

			return {
				next,
				result: {
					markets: nextMarkets,
					selectedSourceId: input.sourceId,
					registryRevision: next.revision,
				},
			};
		});
	}

	removeMarket(input: { requestId: string; sourceId: string; expectedRevision: number }): {
		markets: MarketRecord[];
		selectedSourceId: string;
		registryRevision: number;
	} {
		if (input.sourceId === OFFICIAL_MARKET_ID) {
			throw new AppServerError("INVALID_REQUEST", { requestId: input.requestId });
		}

		return withPluginRegistryLock(this.agentDir, (current) => {
			if (current.revision !== input.expectedRevision) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			const toRemove = current.markets.find((m) => m.id === input.sourceId);
			if (!toRemove) {
				throw new AppServerError("NOT_FOUND", { requestId: input.requestId });
			}

			let nextMarkets = current.markets.filter((m) => m.id !== input.sourceId);
			let selectedSourceId = input.sourceId;

			// If removing currently selected, fall back to official market
			if (toRemove.selected) {
				nextMarkets = nextMarkets.map((m) => ({
					...m,
					selected: m.id === OFFICIAL_MARKET_ID,
				}));
				selectedSourceId = OFFICIAL_MARKET_ID;
			} else {
				const currentSel = nextMarkets.find((m) => m.selected);
				selectedSourceId = currentSel?.id || OFFICIAL_MARKET_ID;
			}

			const next: PluginRegistry = {
				...current,
				revision: current.revision + 1,
				markets: nextMarkets,
			};

			return {
				next,
				result: {
					markets: nextMarkets,
					selectedSourceId,
					registryRevision: next.revision,
				},
			};
		});
	}

	async refreshMarket(input: { requestId: string; sourceId: string }): Promise<{
		catalog: CatalogEntryView[];
		entries?: CatalogEntryView[];
		fetchedAt: string;
		cacheStatus: "fresh" | "cached";
	}> {
		const registry = readPluginRegistry(this.agentDir);
		const market = registry.markets.find((m) => m.id === input.sourceId);
		if (!market) {
			throw new AppServerError("NOT_FOUND", { requestId: input.requestId });
		}

		const refPart = market.trackingRef || market.pinnedCommit;
		const sourceUrl =
			market.root || refPart
				? `${market.url}/tree/${refPart || "main"}${market.root ? `/${market.root}` : ""}`
				: market.url;
		const inspected = await inspectRepositorySource(sourceUrl, this.fetchImpl);
		this.writeMarketCatalogCache(input.sourceId, inspected.catalog, inspected.commit);

		// Update market commit & fetchedAt under lock without bumping capability revision
		withPluginRegistryLock(this.agentDir, (current) => {
			const nextMarkets = current.markets.map((m) =>
				m.id === input.sourceId ? { ...m, commit: inspected.commit, fetchedAt: new Date().toISOString() } : m,
			);
			const next = { ...current, markets: nextMarkets };
			return { next, result: undefined };
		});

		const catalogViews = this.projectCatalogViews(inspected.catalog);
		return {
			catalog: catalogViews,
			entries: catalogViews,
			fetchedAt: new Date().toISOString(),
			cacheStatus: "fresh",
		};
	}

	async getCatalog(sourceId: string): Promise<{
		entries: CatalogEntryView[];
		cacheStatus: "fresh" | "cached" | "offline";
	}> {
		const cached = this.readMarketCatalogCache(sourceId);
		if (cached) {
			return {
				entries: this.projectCatalogViews(cached.catalog),
				cacheStatus: "cached",
			};
		}

		const registry = readPluginRegistry(this.agentDir);
		const market = registry.markets.find((m) => m.id === sourceId);
		if (!market) {
			throw new AppServerError("NOT_FOUND");
		}

		try {
			const refreshed = await this.refreshMarket({ requestId: randomUUID(), sourceId });
			return {
				entries: refreshed.catalog,
				cacheStatus: "fresh",
			};
		} catch {
			return {
				entries: [],
				cacheStatus: "offline",
			};
		}
	}

	private projectCatalogViews(catalog: readonly CatalogEntry[]): CatalogEntryView[] {
		const registry = readPluginRegistry(this.agentDir);

		return catalog.map((entry) => {
			let installState: "installed" | "not-installed" | "update-available" = "not-installed";
			// Check if already installed
			for (const inst of registry.installed) {
				if (inst.name.toLowerCase() === entry.name.toLowerCase()) {
					installState = "installed";
					break;
				}
			}

			return {
				id: entry.id,
				name: entry.name,
				description: entry.description,
				formatHint: entry.formatHint,
				sourceSupported: entry.sourceSupported,
				installState,
			};
		});
	}

	private createInspection(params: {
		sourceId: string;
		entryId: string;
		resolved: ResolvedPluginFiles;
		format: PluginFormat;
		manifestHints?: PluginRecord["manifestHints"];
		registryRevision: number;
		trackingRef?: string;
		pinnedCommit?: string;
	}): PluginInspectionView {
		const pluginId = computePluginId(params.resolved.repository, params.resolved.subdir);

		const parsed = parsePluginManifest({
			format: params.format,
			files: params.resolved.files,
			root: "",
			marketEntry: params.manifestHints as unknown as import("./plugin-manifests.ts").MarketplacePluginEntry,
		});

		// Check component names and assign unique IDs
		const components: ComponentPublicView[] = [];
		const seenIds = new Set<string>();

		for (const comp of parsed.components) {
			const compId = makeComponentId(pluginId, comp.kind === "hook" ? comp.id : comp.name);
			if (seenIds.has(compId)) {
				throw new AppServerError("OPERATION_FAILED");
			}
			seenIds.add(compId);

			let status: ComponentPublicView["status"] = "ready";
			let reason: string | undefined;

			if (comp.kind === "unsupported") {
				status = "unsupported";
				reason = comp.reason;
			} else {
				const hasConfigIssue = parsed.issues.some(
					(iss: PluginIssue) => iss.componentId === comp.id && iss.status === "needs-configuration",
				);
				if (hasConfigIssue) {
					status = "needs-configuration";
					reason = parsed.issues.find((iss: PluginIssue) => iss.componentId === comp.id)?.message;
				}
			}

			components.push({
				componentId: compId,
				kind: comp.kind,
				displayName: comp.name,
				originalName:
					comp.kind === "hook"
						? comp.definition.name
						: "originalName" in comp && typeof comp.originalName === "string"
							? comp.originalName
							: comp.name,
				status,
				...(reason !== undefined ? { reason } : {}),
			});
		}

		const inspectionId = randomUUID();
		const filesList: Array<{ path: string; base64: string; mode: number }> = [];
		for (const [path, buf] of params.resolved.files.entries()) {
			const mode = params.resolved.fileModes.get(path) ?? 0o644;
			filesList.push({ path, base64: buf.toString("base64"), mode });
		}

		const inspectionData: InspectionCacheData = {
			cacheVersion: 2,
			inspectionId,
			sourceId: params.sourceId,
			entryId: params.entryId,
			canonicalRepository: params.resolved.repository,
			subdir: params.resolved.subdir,
			commit: params.resolved.commit,
			trackingRef: params.trackingRef,
			pinnedCommit: params.pinnedCommit,
			manifestHints: params.manifestHints,
			plugin: {
				id: pluginId,
				name: parsed.name,
				displayName: parsed.displayName,
				format: parsed.format,
				...(parsed.version !== undefined ? { version: parsed.version } : {}),
				description: parsed.description,
				repository: params.resolved.repository,
				subdir: params.resolved.subdir,
				commit: params.resolved.commit,
				...(params.trackingRef !== undefined ? { trackingRef: params.trackingRef } : {}),
				sourceId: params.sourceId,
			},
			components,
			parsedComponents: parsed.components,
			issues: parsed.issues as PluginIssue[],
			files: filesList,
			registryRevision: params.registryRevision,
		};

		this.inspectionCache.set(inspectionId, inspectionData);
		this.writeInspectionDiskCache(inspectionId, inspectionData);

		return {
			inspectionId,
			plugin: inspectionData.plugin,
			components,
			issues: [...inspectionData.issues],
			sourceCommit: params.resolved.commit,
			registryRevision: params.registryRevision,
		};
	}

	async inspectPlugin(sourceId: string, entryId: string): Promise<PluginInspectionView> {
		const registry = readPluginRegistry(this.agentDir);
		const market = registry.markets.find((m) => m.id === sourceId);
		if (!market) throw new AppServerError("NOT_FOUND");

		let cachedMarket = this.readMarketCatalogCache(sourceId);
		if (!cachedMarket) {
			await this.refreshMarket({ requestId: randomUUID(), sourceId });
			cachedMarket = this.readMarketCatalogCache(sourceId);
		}
		const entry = cachedMarket?.catalog.find((e) => e.id === entryId);
		if (!entry) throw new AppServerError("NOT_FOUND");

		const origin = {
			canonicalRepository: market.url,
			owner: canonicalizeRepository(market.url).owner,
			repo: canonicalizeRepository(market.url).repo,
			commit: cachedMarket?.commit || market.commit || "main",
			root: market.root ?? "",
		};

		const resolved = await fetchPluginFiles(origin, entry, this.fetchImpl);
		return this.createInspection({
			sourceId,
			entryId,
			resolved,
			format: entry.formatHint,
			manifestHints: {
				...(entry.name !== undefined ? { name: entry.name } : {}),
				...(entry.description !== undefined ? { description: entry.description } : {}),
				...(entry.strict !== undefined ? { strict: entry.strict } : {}),
				...(entry.skills !== undefined ? { skills: entry.skills } : {}),
			},
			registryRevision: registry.revision,
			trackingRef: market.trackingRef,
			pinnedCommit: market.pinnedCommit,
		});
	}

	async install(input: {
		requestId: string;
		inspectionId: string;
		expectedRevision: number;
		allowPartial?: boolean;
		expectedInstalledCommit?: string;
	}): Promise<{ plugin: PluginInstalledView; registryRevision: number; activation: PluginActivationStatus }> {
		const inspection = this.getInspectionData(input.inspectionId);
		if (!inspection) {
			throw new AppServerError("NOT_FOUND", { requestId: input.requestId });
		}

		const hasUnsupported = inspection.components.some((c) => c.status === "unsupported");
		const hasReady = inspection.components.some((c) => c.status === "ready" || c.status === "needs-configuration");

		if (hasUnsupported && !input.allowPartial) {
			throw new AppServerError("INVALID_REQUEST", { requestId: input.requestId });
		}
		if (!hasReady) {
			throw new AppServerError("INVALID_REQUEST", { requestId: input.requestId });
		}

		// Stage package files
		const pluginId = inspection.plugin.id;
		const currentRegistry = readPluginRegistry(this.agentDir);
		if (currentRegistry.pendingCredentialCleanup && currentRegistry.pendingCredentialCleanup.length > 0) {
			const prefix = `p-${pluginId.slice(0, 16)}-`;
			const matchingKeys = currentRegistry.pendingCredentialCleanup.filter(
				(k) => k.includes(prefix) || k.includes(pluginId),
			);
			if (matchingKeys.length > 0) {
				try {
					this.drainPendingCredentialCleanup(matchingKeys);
				} catch {
					// Failure to drain will be caught below
				}
				const latestRegistry = readPluginRegistry(this.agentDir);
				if (matchingKeys.some((k) => (latestRegistry.pendingCredentialCleanup ?? []).includes(k))) {
					throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
				}
			}
		}

		const commit = inspection.commit;
		const stagingDir = join(getPluginPackagesDir(this.agentDir), pluginId, `.staging-${randomUUID()}`);

		try {
			mkdirSync(stagingDir, { recursive: true });
			for (const file of inspection.files) {
				if (!validArchivePath(file.path)) {
					throw new AppServerError("INVALID_REQUEST", { requestId: input.requestId });
				}
				const mode = (file.mode & 0o111) !== 0 ? 0o755 : 0o644;
				const targetFile = join(stagingDir, file.path);
				mkdirSync(dirname(targetFile), { recursive: true });
				const bytes = Buffer.from(file.base64, "base64");
				writeFileSync(targetFile, bytes, { mode });
				if (process.platform !== "win32") {
					chmodSync(targetFile, mode);
				}
			}

			// Create normalized.json
			const normalizedComponents: NormalizedComponent[] = [];
			for (let i = 0; i < inspection.parsedComponents.length; i++) {
				const comp = inspection.parsedComponents[i]!;
				const pub = inspection.components[i]!;

				if (pub.status === "unsupported") continue; // Skip unsupported in normalized package

				if (comp.kind === "skill") {
					normalizedComponents.push({
						kind: "skill",
						componentId: pub.componentId,
						name: pub.componentId,
						originalName: comp.originalName,
						relativeEntryPath: comp.relativeEntryPath,
						relativeBaseDir: comp.relativeBaseDir,
						disableModelInvocation: comp.disableModelInvocation,
					});
				} else if (comp.kind === "mcp") {
					normalizedComponents.push({
						kind: "mcp",
						componentId: pub.componentId,
						name: pub.componentId,
						originalName: comp.originalName,
						definition: comp.definition,
					});
				} else if (comp.kind === "hook") {
					normalizedComponents.push({
						kind: "hook",
						componentId: pub.componentId,
						name: pub.componentId,
						originalName: comp.definition.name,
						definition: {
							...comp.definition,
							id: pub.componentId,
						},
					});
				}
			}

			const normalizedPackage: NormalizedPluginPackage = {
				pluginId,
				commit,
				format: inspection.plugin.format,
				name: inspection.plugin.name,
				displayName: inspection.plugin.displayName,
				description: inspection.plugin.description,
				...(inspection.plugin.version !== undefined ? { version: inspection.plugin.version } : {}),
				components: normalizedComponents,
				issues: inspection.issues,
			};

			const normalizedPath = join(stagingDir, "normalized.json");
			writeFileSync(normalizedPath, JSON.stringify(normalizedPackage, null, 2), { mode: 0o644 });
			if (process.platform !== "win32") {
				chmodSync(normalizedPath, 0o644);
			}

			// Registry transaction
			return withPluginRegistryLock(this.agentDir, (current) => {
				if (current.revision !== input.expectedRevision) {
					throw new AppServerError("CONFLICT", { requestId: input.requestId });
				}
				return this.commitInspection(
					current,
					inspection,
					stagingDir,
					input.requestId,
					input.expectedInstalledCommit,
				);
			});
		} finally {
			rmSync(stagingDir, { recursive: true, force: true });
		}
	}

	private commitInspection(
		current: PluginRegistry,
		inspection: InspectionCacheData,
		stagingDir: string,
		requestId: string,
		expectedInstalledCommit?: string,
	): {
		next?: PluginRegistry;
		result: { plugin: PluginInstalledView; registryRevision: number; activation: PluginActivationStatus };
	} {
		const pluginId = inspection.plugin.id;
		const commit = inspection.commit;
		const targetDir = getPluginPackageDir(this.agentDir, pluginId, commit);

		if (existsSync(targetDir)) {
			if (!this.matchesExistingPackage(targetDir, inspection.files)) {
				throw new AppServerError("CONFLICT", { requestId });
			}
		} else {
			mkdirSync(dirname(targetDir), { recursive: true });
			renameSync(stagingDir, targetDir);
		}

		const existingIndex = current.installed.findIndex((p) => p.id === pluginId);
		if (expectedInstalledCommit !== undefined) {
			if (existingIndex < 0 || current.installed[existingIndex]!.commit !== expectedInstalledCommit) {
				throw new AppServerError("CONFLICT", { requestId });
			}
		}

		if (existingIndex >= 0 && current.installed[existingIndex]!.commit === commit) {
			// Same commit idempotent install
			const record = current.installed[existingIndex]!;
			return {
				next: undefined,
				result: {
					plugin: this.buildInstalledView(record),
					registryRevision: current.revision,
					activation: "applied",
				},
			};
		}

		const record: PluginRecord = {
			id: pluginId,
			name: inspection.plugin.name,
			displayName: inspection.plugin.displayName,
			format: inspection.plugin.format,
			repository: inspection.canonicalRepository,
			subdir: inspection.subdir,
			commit,
			...(inspection.plugin.version !== undefined ? { version: inspection.plugin.version } : {}),
			...(inspection.trackingRef !== undefined ? { trackingRef: inspection.trackingRef } : {}),
			...(inspection.pinnedCommit !== undefined ? { pinnedCommit: inspection.pinnedCommit } : {}),
			...(inspection.manifestHints !== undefined ? { manifestHints: inspection.manifestHints } : {}),
			sourceId: inspection.sourceId,
			enabled: true,
			installedAt: new Date().toISOString(),
			issues: [...inspection.issues],
		};

		const nextInstalled = [...current.installed];
		if (existingIndex >= 0) {
			nextInstalled[existingIndex] = record;
		} else {
			nextInstalled.push(record);
		}

		const next: PluginRegistry = {
			...current,
			revision: current.revision + 1,
			installed: nextInstalled,
		};

		return {
			next,
			result: {
				plugin: this.buildInstalledView(record),
				registryRevision: next.revision,
				activation: "applied",
			},
		};
	}

	private matchesExistingPackage(
		targetDir: string,
		files: Array<{ readonly path: string; readonly base64: string; readonly mode: number }>,
	): boolean {
		try {
			const expectedSorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
			const expectedHasher = createHash("sha256");
			const actualHasher = createHash("sha256");

			for (const f of expectedSorted) {
				const expectedMode = (f.mode & 0o111) !== 0 ? 0o755 : 0o644;
				expectedHasher.update(`${f.path}\0${expectedMode}\0`);
				expectedHasher.update(Buffer.from(f.base64, "base64"));

				const actualPath = join(targetDir, f.path);
				if (!existsSync(actualPath)) return false;
				const actualBytes = readFileSync(actualPath);
				let actualMode = expectedMode;
				if (process.platform !== "win32") {
					actualMode = (statSync(actualPath).mode & 0o111) !== 0 ? 0o755 : 0o644;
				}
				actualHasher.update(`${f.path}\0${actualMode}\0`);
				actualHasher.update(actualBytes);
			}

			return expectedHasher.digest("hex") === actualHasher.digest("hex");
		} catch {
			return false;
		}
	}

	listInstalled(): { installed: PluginRecord[]; registryRevision: number } {
		const registry = readPluginRegistry(this.agentDir);
		return {
			installed: registry.installed,
			registryRevision: registry.revision,
		};
	}

	getInstalled(pluginId: string): PluginInstalledView {
		const registry = readPluginRegistry(this.agentDir);
		const record = registry.installed.find((p) => p.id === pluginId);
		if (!record) throw new AppServerError("NOT_FOUND");
		return this.buildInstalledView(record);
	}

	setEnabled(input: { requestId: string; pluginId: string; enabled: boolean; expectedRevision: number }): {
		plugin: PluginInstalledView;
		registryRevision: number;
		activation: PluginActivationStatus;
	} {
		return withPluginRegistryLock(this.agentDir, (current) => {
			if (current.revision !== input.expectedRevision) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			const existing = current.installed.find((p) => p.id === input.pluginId);
			if (!existing) {
				throw new AppServerError("NOT_FOUND", { requestId: input.requestId });
			}

			const updatedRecord: PluginRecord = { ...existing, enabled: input.enabled };
			const nextInstalled = current.installed.map((p) => (p.id === input.pluginId ? updatedRecord : p));

			const next: PluginRegistry = {
				...current,
				revision: current.revision + 1,
				installed: nextInstalled,
			};

			return {
				next,
				result: {
					plugin: this.buildInstalledView(updatedRecord),
					registryRevision: next.revision,
					activation: "applied",
				},
			};
		});
	}

	remove(input: { requestId: string; pluginId: string; expectedRevision: number }): {
		installed: PluginRecord[];
		registryRevision: number;
		activation: PluginActivationStatus;
	} {
		try {
			this.drainPendingCredentialCleanup();
		} catch {
			// Ignore prior drain errors
		}

		let keysToRemove: string[] = [];

		const updateResult = withPluginRegistryLock(this.agentDir, (current) => {
			if (current.revision !== input.expectedRevision) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			const targetPlugin = current.installed.find((p) => p.id === input.pluginId);
			if (!targetPlugin) {
				throw new AppServerError("NOT_FOUND", { requestId: input.requestId });
			}

			const identities = getPluginMcpIdentities(this.agentDir, targetPlugin);
			keysToRemove = pluginMcpCredentialKeys(this.authStorage, identities);

			const nextInstalled = current.installed.filter((p) => p.id !== input.pluginId);
			const pendingCleanup = [...new Set([...(current.pendingCredentialCleanup ?? []), ...keysToRemove])];

			const next: PluginRegistry = {
				...current,
				revision: current.revision + 1,
				installed: nextInstalled,
				...(pendingCleanup.length > 0 ? { pendingCredentialCleanup: pendingCleanup } : {}),
			};

			return {
				next,
				result: {
					installed: nextInstalled,
					registryRevision: next.revision,
					activation: "applied" as PluginActivationStatus,
				},
			};
		});

		if (keysToRemove.length > 0) {
			this.authStorage.applyChanges(keysToRemove.map((provider) => ({ provider, credential: undefined })));
			withPluginRegistryLock(this.agentDir, (current) => {
				const remaining = (current.pendingCredentialCleanup ?? []).filter((k) => !keysToRemove.includes(k));
				const next: PluginRegistry = {
					...current,
					pendingCredentialCleanup: remaining.length > 0 ? remaining : undefined,
				};
				return { next, result: undefined };
			});
		}

		return updateResult;
	}

	async inspectUpdate(pluginId: string): Promise<PluginUpdateInspectionView> {
		const registry = readPluginRegistry(this.agentDir);
		const installed = registry.installed.find((p) => p.id === pluginId);
		if (!installed) throw new AppServerError("NOT_FOUND");

		const targetCommit = await resolveTrackedPluginCommit(installed, this.fetchImpl);

		if (targetCommit === installed.commit) {
			return {
				pluginId,
				currentCommit: installed.commit,
				upToDate: true,
			};
		}

		const resolved = await fetchPluginFilesAtCommit(
			{
				repository: installed.repository,
				subdir: installed.subdir,
				commit: targetCommit,
			},
			this.fetchImpl,
		);

		const inspection = this.createInspection({
			sourceId: installed.sourceId,
			entryId: `entry-${installed.name.toLowerCase()}`,
			resolved,
			format: installed.format,
			manifestHints: installed.manifestHints,
			registryRevision: registry.revision,
			trackingRef: installed.trackingRef,
			pinnedCommit: installed.pinnedCommit,
		});

		return {
			pluginId,
			currentCommit: installed.commit,
			upToDate: false,
			newCommit: inspection.sourceCommit,
			inspectionId: inspection.inspectionId,
			inspection,
		};
	}

	async update(input: {
		requestId: string;
		pluginId: string;
		inspectionId: string;
		expectedRevision: number;
		expectedCommit: string;
		allowPartial?: boolean;
	}): Promise<{ plugin: PluginInstalledView; registryRevision: number; activation: PluginActivationStatus }> {
		const inspection = this.getInspectionData(input.inspectionId);
		if (!inspection || inspection.plugin.id !== input.pluginId) {
			throw new AppServerError("INVALID_REQUEST", { requestId: input.requestId });
		}
		if (inspection.commit === input.expectedCommit) {
			throw new AppServerError("CONFLICT", { requestId: input.requestId });
		}

		return await this.install({
			requestId: input.requestId,
			inspectionId: input.inspectionId,
			expectedRevision: input.expectedRevision,
			allowPartial: input.allowPartial,
			expectedInstalledCommit: input.expectedCommit,
		});
	}

	private buildInstalledView(record: PluginRecord): PluginInstalledView {
		const packageDir = getPluginPackageDir(this.agentDir, record.id, record.commit);
		const normalizedPath = join(packageDir, "normalized.json");
		const components: ComponentPublicView[] = [];

		if (existsSync(normalizedPath)) {
			try {
				const pkg: NormalizedPluginPackage = JSON.parse(readFileSync(normalizedPath, "utf8"));
				for (const comp of pkg.components) {
					const componentId =
						comp.kind === "hook" && !comp.componentId.startsWith(`p-${record.id.slice(0, 8)}-`)
							? makeComponentId(record.id, comp.componentId)
							: comp.componentId;
					components.push({
						componentId,
						kind: comp.kind,
						displayName: comp.originalName || comp.name,
						originalName: comp.originalName || comp.name,
						status: "ready",
					});
				}
			} catch {
				// ignore
			}
		}

		return {
			plugin: record,
			components,
			activation: "applied",
			runtimeErrors: [],
		};
	}

	private getInspectionData(inspectionId: string): InspectionCacheData | undefined {
		if (this.inspectionCache.has(inspectionId)) {
			const cached = this.inspectionCache.get(inspectionId);
			if (
				cached &&
				cached.cacheVersion === 2 &&
				Array.isArray(cached.files) &&
				cached.files.every((f) => typeof f.mode === "number")
			) {
				return cached;
			}
			return undefined;
		}
		const diskPath = join(getPluginCacheDir(this.agentDir), "inspections", `${inspectionId}.json`);
		if (existsSync(diskPath)) {
			try {
				const data = JSON.parse(readFileSync(diskPath, "utf8"));
				if (
					typeof data === "object" &&
					data !== null &&
					data.cacheVersion === 2 &&
					Array.isArray(data.files) &&
					data.files.every(
						(f: unknown) =>
							typeof f === "object" && f !== null && typeof (f as { mode?: unknown }).mode === "number",
					)
				) {
					this.inspectionCache.set(inspectionId, data);
					return data;
				}
				return undefined;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	private writeInspectionDiskCache(inspectionId: string, data: InspectionCacheData): void {
		const dir = join(getPluginCacheDir(this.agentDir), "inspections");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${inspectionId}.json`), JSON.stringify(data), "utf8");
	}

	private writeMarketCatalogCache(sourceId: string, catalog: readonly CatalogEntry[], commit?: string): void {
		const dir = join(getPluginCacheDir(this.agentDir), "markets");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${sourceId}.json`);
		writeFileSync(file, JSON.stringify({ catalog, commit, fetchedAt: new Date().toISOString() }), "utf8");
	}

	private readMarketCatalogCache(sourceId: string): { catalog: CatalogEntry[]; commit?: string } | undefined {
		const file = join(getPluginCacheDir(this.agentDir), "markets", `${sourceId}.json`);
		if (!existsSync(file)) return undefined;
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return undefined;
		}
	}
}
