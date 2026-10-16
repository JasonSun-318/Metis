import type {
	PluginActivationStatus,
	PluginCatalogEntryView,
	PluginComponentStatus,
	PluginInspectionView,
	PluginInstalledView,
	PluginIssue,
	PluginMarketView,
	PluginRecord,
	PluginUpdateInspectionView,
} from "@metis/app-protocol";
import {
	ArrowLeft,
	ArrowSquareOut,
	ArrowsClockwise,
	CaretRight,
	CheckCircle,
	Lightning,
	MagnifyingGlass,
	Package,
	Plug,
	Plus,
	PuzzlePiece,
	Trash,
	Warning,
	WarningCircle,
	X,
	XCircle,
} from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import i18n from "../i18n.ts";
import { DialogFrame } from "./ProjectActions.tsx";

function message(cause: unknown): string {
	if (cause instanceof Error) return i18n.t(cause.message);
	return String(cause ?? "An error occurred.");
}

function marketName(market: PluginMarketView): string {
	return market.url
		.replace(/^https:\/\/github\.com\//iu, "")
		.replace(/\/$/u, "")
		.replace(/\.git$/u, "");
}

function isFatalInspectionIssue(issue: PluginIssue): boolean {
	return issue.code === "CORRUPT_MANIFEST" || issue.code === "INVALID_JSON";
}

export interface PluginMarketplacePanelProps {
	readonly headerActionsTarget: HTMLElement | null;
	readonly api: MetisDesktopApi;
	readonly serverReady: boolean;
	readonly selectedPluginId?: string | null;
	readonly onClearSelectedPlugin?: () => void;
	readonly onOpenSkill?: (name: string) => void;
	readonly onOpenMcp?: (name: string) => void;
	readonly onOpenHook?: (id: string) => void;
}

type ViewMode = "markets" | "browse" | "installed";

export function PluginMarketplacePanel({
	headerActionsTarget,
	api,
	serverReady,
	selectedPluginId,
	onClearSelectedPlugin,
	onOpenSkill,
	onOpenMcp,
	onOpenHook,
}: PluginMarketplacePanelProps) {
	const { t } = useTranslation();
	const [viewMode, setViewMode] = useState<ViewMode>("markets");

	// Markets and catalog state
	const [marketQuery, setMarketQuery] = useState("");
	const [marketsLoading, setMarketsLoading] = useState(false);
	const [marketError, setMarketError] = useState<string | null>(null);
	const [marketRemovingId, setMarketRemovingId] = useState<string | null>(null);
	const [markets, setMarkets] = useState<readonly PluginMarketView[]>([]);
	const [selectedMarketId, setSelectedMarketId] = useState<string>("");
	const [registryRevision, setRegistryRevision] = useState(0);
	const [catalogEntries, setCatalogEntries] = useState<readonly PluginCatalogEntryView[]>([]);
	const [catalogLoading, setCatalogLoading] = useState(false);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [catalogQuery, setCatalogQuery] = useState("");
	const [marketRefreshing, setMarketRefreshing] = useState(false);

	// Installed state
	const [installedList, setInstalledList] = useState<readonly PluginRecord[]>([]);
	const [installedLoading, setInstalledLoading] = useState(false);
	const [installedError, setInstalledError] = useState<string | null>(null);
	const [installedQuery, setInstalledQuery] = useState("");

	// Dialogs state
	const [addMarketOpen, setAddMarketOpen] = useState(false);
	const [addMarketPending, setAddMarketPending] = useState(false);
	const [addMarketError, setAddMarketError] = useState<string | null>(null);

	const [inspectingEntry, setInspectingEntry] = useState<PluginCatalogEntryView | null>(null);
	const [inspection, setInspection] = useState<PluginInspectionView | null>(null);
	const [inspectionLoading, setInspectionLoading] = useState(false);
	const [inspectionError, setInspectionError] = useState<string | null>(null);
	const [installPending, setInstallPending] = useState(false);
	const [installResult, setInstallResult] = useState<{
		readonly activation: PluginActivationStatus;
		readonly name: string;
	} | null>(null);

	const [detailPluginId, setDetailPluginId] = useState<string | null>(null);
	const [detailPlugin, setDetailPlugin] = useState<PluginInstalledView | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [detailActionPending, setDetailActionPending] = useState(false);

	const [updateInspection, setUpdateInspection] = useState<PluginUpdateInspectionView | null>(null);
	const [updateChecking, setUpdateChecking] = useState(false);
	const [updatePending, setUpdatePending] = useState(false);
	const [updateError, setUpdateError] = useState<string | null>(null);
	const [updateStatusMessage, setUpdateStatusMessage] = useState<string | null>(null);

	const [removeConfirmPlugin, setRemoveConfirmPlugin] = useState<PluginRecord | null>(null);
	const [removePending, setRemovePending] = useState(false);
	const [removeError, setRemoveError] = useState<string | null>(null);

	// Generation tracker for market switching anti-race
	const marketGeneration = useRef(0);

	// Load markets on mount / server ready
	const loadMarkets = useCallback(async () => {
		if (!serverReady) return;
		setMarketsLoading(true);
		setMarketError(null);
		try {
			const res = await api.listPluginMarkets();
			setMarkets(res.markets);
			setSelectedMarketId(res.selectedSourceId ?? "");
			setRegistryRevision(res.registryRevision);
		} catch (err) {
			setMarketError(message(err));
		} finally {
			setMarketsLoading(false);
		}
	}, [api, serverReady]);

	// Load catalog for a specific market
	const loadCatalog = useCallback(
		async (sourceId: string) => {
			if (!serverReady || !sourceId) return;
			const gen = ++marketGeneration.current;
			setCatalogLoading(true);
			setCatalogError(null);
			try {
				const res = await api.getPluginCatalog({ sourceId });
				if (gen !== marketGeneration.current) return;
				setCatalogEntries(res.entries);
			} catch (err) {
				if (gen !== marketGeneration.current) return;
				setCatalogError(message(err));
			} finally {
				if (gen === marketGeneration.current) {
					setCatalogLoading(false);
				}
			}
		},
		[api, serverReady],
	);

	// Load installed plugins
	const loadInstalled = useCallback(async () => {
		if (!serverReady) return;
		setInstalledLoading(true);
		setInstalledError(null);
		try {
			const res = await api.listInstalledPlugins();
			setInstalledList(res.installed ?? []);
			setRegistryRevision(res.registryRevision ?? 0);
		} catch (err) {
			setInstalledError(message(err));
		} finally {
			setInstalledLoading(false);
		}
	}, [api, serverReady]);

	// Initialize
	useEffect(() => {
		loadMarkets();
		loadInstalled();
	}, [loadMarkets, loadInstalled]);

	// When selectedMarketId changes, load catalog
	useEffect(() => {
		if (viewMode === "browse" && selectedMarketId) {
			loadCatalog(selectedMarketId);
		}
		return () => {
			marketGeneration.current += 1;
		};
	}, [viewMode, selectedMarketId, loadCatalog]);

	// Switch to installed plugin detail when selectedPluginId is provided
	useEffect(() => {
		if (selectedPluginId) {
			setViewMode("installed");
			setDetailPluginId(selectedPluginId);
		}
	}, [selectedPluginId]);

	// Load detail plugin when detailPluginId changes
	useEffect(() => {
		if (!detailPluginId || !serverReady) {
			setDetailPlugin(null);
			return;
		}
		let active = true;
		setDetailLoading(true);
		setDetailError(null);
		api.getInstalledPlugin({ pluginId: detailPluginId })
			.then((detail) => {
				if (active) setDetailPlugin(detail);
			})
			.catch((err) => {
				if (active) setDetailError(message(err));
			})
			.finally(() => {
				if (active) setDetailLoading(false);
			});
		return () => {
			active = false;
		};
	}, [api, detailPluginId, serverReady]);

	// Select a market
	const handleSelectMarket = useCallback(
		async (sourceId: string) => {
			if (!serverReady) return;
			setCatalogQuery("");
			if (sourceId === selectedMarketId) {
				setViewMode("browse");
				return;
			}
			try {
				const res = await api.selectPluginMarket({
					requestId: crypto.randomUUID(),
					sourceId,
					expectedRevision: registryRevision,
				});
				setMarkets(res.markets);
				setSelectedMarketId(res.selectedSourceId ?? "");
				setRegistryRevision(res.registryRevision);
				setViewMode("browse");
			} catch (err) {
				setMarketError(message(err));
			}
		},
		[api, registryRevision, selectedMarketId, serverReady],
	);

	// Refresh market
	const handleRefreshMarket = useCallback(async () => {
		if (!selectedMarketId || marketRefreshing || !serverReady) return;
		setMarketRefreshing(true);
		try {
			await api.refreshPluginMarket({
				requestId: crypto.randomUUID(),
				sourceId: selectedMarketId,
			});
			await loadCatalog(selectedMarketId);
		} catch (err) {
			setCatalogError(message(err));
		} finally {
			setMarketRefreshing(false);
		}
	}, [api, loadCatalog, marketRefreshing, selectedMarketId, serverReady]);

	// Add market
	const handleAddMarket = useCallback(
		async (url: string) => {
			setAddMarketPending(true);
			setAddMarketError(null);
			try {
				const res = await api.addPluginMarket({
					requestId: crypto.randomUUID(),
					url,
					expectedRevision: registryRevision,
				});
				setMarkets(res.markets);
				setSelectedMarketId(res.selectedSourceId ?? "");
				setRegistryRevision(res.registryRevision);
				setAddMarketOpen(false);
				setCatalogQuery("");
				setViewMode("browse");
			} catch (err) {
				setAddMarketError(message(err));
			} finally {
				setAddMarketPending(false);
			}
		},
		[api, registryRevision],
	);

	// Removing a source preserves installed plugins and their runtime capabilities.
	const handleRemoveMarket = useCallback(
		async (sourceId: string) => {
			if (!serverReady || marketRemovingId) return;
			setMarketRemovingId(sourceId);
			setMarketError(null);
			try {
				const res = await api.removePluginMarket({
					requestId: crypto.randomUUID(),
					sourceId,
					expectedRevision: registryRevision,
				});
				setMarkets(res.markets);
				setSelectedMarketId(res.selectedSourceId ?? "");
				setRegistryRevision(res.registryRevision);
				if (sourceId === selectedMarketId) setViewMode("markets");
			} catch (err) {
				setMarketError(message(err));
			} finally {
				setMarketRemovingId(null);
			}
		},
		[api, registryRevision, selectedMarketId, serverReady, marketRemovingId],
	);

	// Inspect a plugin entry
	const handleInspectEntry = useCallback(
		async (entry: PluginCatalogEntryView) => {
			setInspectingEntry(entry);
			setInspection(null);
			setInspectionLoading(true);
			setInspectionError(null);
			setInstallResult(null);
			try {
				const res = await api.inspectPlugin({
					sourceId: selectedMarketId,
					entryId: entry.id,
				});
				setInspection(res);
			} catch (err) {
				setInspectionError(message(err));
			} finally {
				setInspectionLoading(false);
			}
		},
		[api, selectedMarketId],
	);

	// Install a plugin
	const handleInstall = useCallback(
		async (allowPartial: boolean) => {
			if (!inspection || inspection.issues.some(isFatalInspectionIssue) || installPending || !serverReady) return;
			setInstallPending(true);
			setInspectionError(null);
			try {
				const res = await api.installPlugin({
					requestId: crypto.randomUUID(),
					inspectionId: inspection.inspectionId,
					expectedRevision: inspection.registryRevision,
					allowPartial,
				});
				setRegistryRevision(res.registryRevision);
				setInstallResult({
					activation: res.activation,
					name: inspection.plugin.displayName || inspection.plugin.name,
				});
				loadInstalled();
				if (selectedMarketId) loadCatalog(selectedMarketId);
			} catch (err) {
				setInspectionError(message(err));
			} finally {
				setInstallPending(false);
			}
		},
		[api, inspection, installPending, loadCatalog, loadInstalled, selectedMarketId, serverReady],
	);

	// Toggle enabled state of an installed plugin
	const handleToggleEnabled = useCallback(
		async (plugin: PluginRecord) => {
			if (detailActionPending || !serverReady) return;
			setDetailActionPending(true);
			try {
				const res = await api.setPluginEnabled({
					requestId: crypto.randomUUID(),
					pluginId: plugin.id,
					enabled: !plugin.enabled,
					expectedRevision: registryRevision,
				});
				setRegistryRevision(res.registryRevision);
				if (detailPlugin && detailPlugin.plugin.id === plugin.id) {
					setDetailPlugin(res.plugin);
				}
				loadInstalled();
			} catch (err) {
				setDetailError(message(err));
			} finally {
				setDetailActionPending(false);
			}
		},
		[api, detailActionPending, detailPlugin, loadInstalled, registryRevision, serverReady],
	);

	// Check updates for installed plugin
	const handleCheckUpdate = useCallback(
		async (pluginId: string) => {
			if (updateChecking || !serverReady) return;
			setUpdateChecking(true);
			setUpdateError(null);
			setUpdateStatusMessage(null);
			try {
				const res = await api.inspectPluginUpdate({ pluginId });
				if (res.upToDate) {
					setUpdateStatusMessage(t("Already up to date"));
					setUpdateInspection(null);
				} else {
					setUpdateStatusMessage(null);
					setUpdateInspection(res);
				}
			} catch (err) {
				setUpdateError(message(err));
			} finally {
				setUpdateChecking(false);
			}
		},
		[api, serverReady, t, updateChecking],
	);

	// Perform plugin update
	const handlePerformUpdate = useCallback(
		async (allowPartial = false) => {
			if (
				!updateInspection ||
				!updateInspection.inspection ||
				updateInspection.inspection.issues.some(isFatalInspectionIssue) ||
				updatePending ||
				!serverReady
			)
				return;
			setUpdatePending(true);
			setUpdateError(null);
			try {
				const res = await api.updatePlugin({
					requestId: crypto.randomUUID(),
					pluginId: updateInspection.pluginId,
					inspectionId: updateInspection.inspection.inspectionId,
					expectedRevision: registryRevision,
					expectedCommit: updateInspection.currentCommit,
					allowPartial,
				});
				setRegistryRevision(res.registryRevision);
				setUpdateInspection(null);
				if (detailPluginId) {
					const updatedDetail = await api.getInstalledPlugin({ pluginId: detailPluginId });
					setDetailPlugin(updatedDetail);
				}
				loadInstalled();
			} catch (err) {
				setUpdateError(message(err));
			} finally {
				setUpdatePending(false);
			}
		},
		[api, detailPluginId, loadInstalled, registryRevision, serverReady, updateInspection, updatePending],
	);

	// Remove installed plugin
	const handleRemovePlugin = useCallback(
		async (plugin: PluginRecord) => {
			if (removePending || !serverReady) return;
			setRemovePending(true);
			setRemoveError(null);
			try {
				const res = await api.removePlugin({
					requestId: crypto.randomUUID(),
					pluginId: plugin.id,
					expectedRevision: registryRevision,
				});
				setRegistryRevision(res.registryRevision);
				setRemoveConfirmPlugin(null);
				setDetailPluginId(null);
				setDetailPlugin(null);
				loadInstalled();
				if (selectedMarketId) loadCatalog(selectedMarketId);
			} catch (err) {
				setRemoveError(message(err));
			} finally {
				setRemovePending(false);
			}
		},
		[api, loadCatalog, loadInstalled, registryRevision, removePending, selectedMarketId, serverReady],
	);

	// Filter catalog entries
	const visibleCatalogEntries = useMemo(() => {
		const q = catalogQuery.trim().toLowerCase();
		if (!q) return catalogEntries;
		return catalogEntries.filter(
			(entry) => entry.name.toLowerCase().includes(q) || entry.description?.toLowerCase().includes(q),
		);
	}, [catalogEntries, catalogQuery]);

	// Filter installed list
	const visibleInstalledList = useMemo(() => {
		const q = installedQuery.trim().toLowerCase();
		if (!q) return installedList;
		return installedList.filter(
			(plugin) => plugin.name.toLowerCase().includes(q) || plugin.displayName.toLowerCase().includes(q),
		);
	}, [installedList, installedQuery]);

	const selectedMarket = markets.find((m) => m.id === selectedMarketId);
	const visibleMarkets = markets.filter((market) =>
		`${marketName(market)} ${market.url}`.toLowerCase().includes(marketQuery.trim().toLowerCase()),
	);
	const searchLabel =
		viewMode === "markets"
			? "Search markets…"
			: viewMode === "browse"
				? "Search plugins…"
				: "Search installed plugins…";
	const reloading =
		viewMode === "markets"
			? marketsLoading
			: viewMode === "browse"
				? marketRefreshing || catalogLoading
				: installedLoading;

	return (
		<div className="plugins-market-panel">
			{headerActionsTarget &&
				createPortal(
					<>
						<button
							aria-label={t(reloading ? "Reloading…" : "Reload")}
							className="plugins-reload"
							disabled={!serverReady || reloading || !!marketRemovingId}
							onClick={
								viewMode === "markets"
									? loadMarkets
									: viewMode === "browse"
										? handleRefreshMarket
										: loadInstalled
							}
							type="button"
						>
							<ArrowsClockwise aria-hidden="true" className={reloading ? "plugins-spin" : undefined} size={16} />
							{t("Reload")}
						</button>
						<button
							className="plugins-new-btn"
							disabled={!serverReady || !!marketRemovingId}
							onClick={() => {
								setAddMarketError(null);
								setAddMarketOpen(true);
							}}
							type="button"
						>
							<Plus aria-hidden="true" size={16} />
							<span>{t("Add Market")}</span>
						</button>
					</>,
					headerActionsTarget,
				)}
			<div className="plugins-list-controls plugins-installed-controls">
				<div className="plugins-search">
					<MagnifyingGlass aria-hidden="true" size={16} />
					<input
						aria-label={t(searchLabel)}
						placeholder={t(searchLabel)}
						type="search"
						onChange={(event) =>
							viewMode === "markets"
								? setMarketQuery(event.target.value)
								: viewMode === "browse"
									? setCatalogQuery(event.target.value)
									: setInstalledQuery(event.target.value)
						}
						value={viewMode === "markets" ? marketQuery : viewMode === "browse" ? catalogQuery : installedQuery}
					/>
				</div>
			</div>
			<div className="plugins-market-navigation">
				{viewMode !== "markets" ? (
					<button
						className="plugins-market-back"
						onClick={() => {
							setViewMode("markets");
							setMarketError(null);
						}}
						type="button"
					>
						<ArrowLeft aria-hidden="true" size={15} />
						{t("Markets")}
					</button>
				) : (
					<span>{t("Markets")}</span>
				)}
				{viewMode === "browse" && (
					<span className="plugins-current-market" title={selectedMarket?.url}>
						{selectedMarket ? marketName(selectedMarket) : ""}
					</span>
				)}
				{viewMode === "installed" ? (
					<span>{t("Manage plugins")}</span>
				) : (
					<button className="plugins-manage-installed" onClick={() => setViewMode("installed")} type="button">
						{t("Manage plugins")}
						<span className="plugins-count-pill">{installedList.length}</span>
					</button>
				)}
			</div>
			{marketError && (
				<p className="mcp-dialog-error" role="alert">
					{marketError}
				</p>
			)}
			{viewMode === "markets" ? (
				<section className="plugins-full-list plugins-market-sources" aria-label={t("Markets")}>
					{marketsLoading ? (
						<output className="status-paragraph plugins-catalog-message">{t("Loading markets…")}</output>
					) : visibleMarkets.length === 0 ? (
						<p className="plugins-catalog-message">
							{t(
								marketQuery
									? "No markets match your search."
									: "No markets added. Add a GitHub market to discover plugins.",
							)}
						</p>
					) : (
						visibleMarkets.map((market) => (
							<div className="plugins-source-row" key={market.id}>
								<button
									className="plugins-list-row plugins-source-open"
									disabled={!serverReady || !!marketRemovingId}
									onClick={() => handleSelectMarket(market.id)}
									type="button"
								>
									<span className="plugins-row-icon">
										<Package aria-hidden="true" size={22} />
									</span>
									<span className="plugins-row-copy">
										<strong>{marketName(market)}</strong>
										<small>{market.url}</small>
									</span>
									<CaretRight aria-hidden="true" size={17} />
								</button>
								<button
									aria-label={t("Remove market {{name}}", { name: marketName(market) })}
									title={t("Remove market; installed plugins are kept")}
									className="plugins-market-remove-btn"
									disabled={!serverReady || !!marketRemovingId}
									onClick={() => handleRemoveMarket(market.id)}
									type="button"
								>
									<Trash aria-hidden="true" size={16} />
								</button>
							</div>
						))
					)}
				</section>
			) : viewMode === "browse" ? (
				<>
					{/* Catalog List */}
					<div className="plugins-full-list" role="listbox">
						{catalogLoading ? (
							<output className="status-paragraph plugins-catalog-message">{t("Loading catalog…")}</output>
						) : catalogError ? (
							<div className="plugins-catalog-message" role="alert">
								<p>{catalogError}</p>
								<button onClick={() => selectedMarketId && loadCatalog(selectedMarketId)} type="button">
									{t("Retry")}
								</button>
							</div>
						) : visibleCatalogEntries.length === 0 ? (
							<p className="plugins-catalog-message">
								{t(catalogQuery ? "No plugins match your search." : "No plugins available in this market.")}
							</p>
						) : (
							visibleCatalogEntries.map((entry) => (
								<div className="plugins-list-row plugins-market-row" key={entry.id}>
									<span className="plugins-row-icon">
										<Package aria-hidden="true" size={22} />
									</span>
									<span className="plugins-row-copy">
										<strong>{entry.name}</strong>
										<small>{entry.description}</small>
									</span>
									<span className="plugins-row-meta">
										<span className="plugins-badge badge-format">{entry.formatHint}</span>
										{entry.installState === "installed" ? (
											<span className="plugins-badge badge-installed">{t("Installed")}</span>
										) : entry.installState === "update-available" ? (
											<span className="plugins-badge badge-update">{t("Update available")}</span>
										) : null}
										{!entry.sourceSupported && (
											<span className="plugins-badge badge-unsupported">{t("Unsupported")}</span>
										)}
									</span>
									<button
										className="plugins-inspect-action-btn"
										disabled={!serverReady}
										onClick={() => {
											if (entry.installedPluginId) setDetailPluginId(entry.installedPluginId);
											else handleInspectEntry(entry);
										}}
										type="button"
									>
										{t(entry.installedPluginId ? "Manage" : "Inspect")}
									</button>
								</div>
							))
						)}
					</div>
				</>
			) : (
				<>
					{/* Installed List */}
					<div className="plugins-full-list" role="listbox">
						{installedLoading ? (
							<output className="status-paragraph plugins-catalog-message">
								{t("Loading installed plugins…")}
							</output>
						) : installedError ? (
							<div className="plugins-catalog-message" role="alert">
								<p>{installedError}</p>
								<button onClick={loadInstalled} type="button">
									{t("Retry")}
								</button>
							</div>
						) : visibleInstalledList.length === 0 ? (
							<p className="plugins-catalog-message">
								{t(installedQuery ? "No plugins match your search." : "No plugins installed yet.")}
							</p>
						) : (
							visibleInstalledList.map((plugin) => (
								<div className="plugins-list-row plugins-installed-row" key={plugin.id}>
									<span className="plugins-row-icon">
										<Package aria-hidden="true" size={22} />
									</span>
									<span className="plugins-row-copy">
										<strong>{plugin.displayName || plugin.name}</strong>
										<small>
											{plugin.format} · commit {plugin.commit.slice(0, 7)}
										</small>
									</span>
									<span className="plugins-row-meta">
										<span className={`plugins-badge ${plugin.enabled ? "badge-enabled" : "badge-disabled"}`}>
											{t(plugin.enabled ? "Enabled" : "Disabled")}
										</span>
									</span>
									<div className="plugins-row-actions">
										<button
											className="plugins-toggle-btn"
											disabled={!serverReady || detailActionPending}
											onClick={() => handleToggleEnabled(plugin)}
											type="button"
										>
											{plugin.enabled ? (
												<XCircle aria-hidden="true" size={16} />
											) : (
												<CheckCircle aria-hidden="true" size={16} />
											)}
											{t(plugin.enabled ? "Disable" : "Enable")}
										</button>
										<button
											className="plugins-inspect-action-btn"
											disabled={!serverReady}
											onClick={() => setDetailPluginId(plugin.id)}
											type="button"
										>
											{t("Manage")}
											<CaretRight aria-hidden="true" size={14} />
										</button>
									</div>
								</div>
							))
						)}
					</div>
				</>
			)}

			{/* Dialog: Add Market */}
			{addMarketOpen && (
				<AddMarketDialog
					error={addMarketError}
					onCancel={() => setAddMarketOpen(false)}
					onSubmit={handleAddMarket}
					pending={addMarketPending}
				/>
			)}

			{/* Dialog: Inspect & Install Plugin */}
			{inspectingEntry && (
				<InspectPluginDialog
					key={`${inspectingEntry.id}:${inspection?.inspectionId ?? "pending"}`}
					entry={inspectingEntry}
					error={inspectionError}
					inspection={inspection}
					installPending={installPending}
					installResult={installResult}
					loading={inspectionLoading}
					onClose={() => {
						setInspectingEntry(null);
						setInspection(null);
						setInstallResult(null);
					}}
					onInstall={handleInstall}
				/>
			)}

			{/* Dialog: Installed Plugin Detail & Management */}
			{detailPluginId && (
				<InstalledPluginDetailDialog
					detail={detailPlugin}
					error={detailError}
					loading={detailLoading}
					onCheckUpdate={() => handleCheckUpdate(detailPluginId)}
					onClose={() => {
						setDetailPluginId(null);
						setDetailPlugin(null);
						setUpdateStatusMessage(null);
						setUpdateError(null);
						onClearSelectedPlugin?.();
					}}
					onOpenHook={onOpenHook}
					onOpenMcp={onOpenMcp}
					onOpenSkill={onOpenSkill}
					onToggleEnabled={() => detailPlugin && handleToggleEnabled(detailPlugin.plugin)}
					onUninstall={() => detailPlugin && setRemoveConfirmPlugin(detailPlugin.plugin)}
					pending={detailActionPending || updateChecking}
					updateError={updateError}
					updateMessage={updateStatusMessage}
				/>
			)}

			{/* Dialog: Update Confirmation */}
			{updateInspection && (
				<UpdatePluginDialog
					error={updateError}
					onClose={() => setUpdateInspection(null)}
					onUpdate={handlePerformUpdate}
					pending={updatePending}
					updateInfo={updateInspection}
				/>
			)}

			{/* Dialog: Confirm Remove Plugin */}
			{removeConfirmPlugin && (
				<RemovePluginDialog
					error={removeError}
					onCancel={() => setRemoveConfirmPlugin(null)}
					onConfirm={() => handleRemovePlugin(removeConfirmPlugin)}
					pending={removePending}
					plugin={removeConfirmPlugin}
				/>
			)}
		</div>
	);
}

// ---------------- Subcomponents ----------------

function AddMarketDialog({
	error,
	onCancel,
	onSubmit,
	pending,
}: {
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onSubmit: (url: string) => Promise<void>;
	readonly pending: boolean;
}) {
	const { t } = useTranslation();
	const [url, setUrl] = useState("");
	const cancelRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		const trimmed = url.trim();
		if (trimmed) void onSubmit(trimmed);
	};

	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog plugins-add-market-dialog"
			descriptionId="add-market-description"
			initialFocus={inputRef}
			onCancel={onCancel}
			titleId="add-market-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onCancel}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="add-market-title">{t("Add Market")}</h2>
			<p id="add-market-description">{t("Enter GitHub repository URL or owner/repo")}</p>
			<form onSubmit={handleSubmit}>
				<label>
					<span>{t("GitHub Address")}</span>
					<input
						disabled={pending}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="https://github.com/owner/repo"
						ref={inputRef}
						required
						type="text"
						value={url}
					/>
				</label>
				{error && (
					<p className="mcp-dialog-error" role="alert">
						{error}
					</p>
				)}
				<div className="mcp-dialog-actions">
					<button className="button-secondary" disabled={pending} onClick={onCancel} ref={cancelRef} type="button">
						{t("Cancel")}
					</button>
					<button className="button-primary" disabled={pending || !url.trim()} type="submit">
						{t(pending ? "Adding…" : "Add")}
					</button>
				</div>
			</form>
		</DialogFrame>
	);
}

function InspectPluginDialog({
	entry,
	error,
	inspection,
	installPending,
	installResult,
	loading,
	onClose,
	onInstall,
}: {
	readonly entry: PluginCatalogEntryView;
	readonly error: string | null;
	readonly inspection: PluginInspectionView | null;
	readonly installPending: boolean;
	readonly installResult: {
		readonly activation: PluginActivationStatus;
		readonly name: string;
	} | null;
	readonly loading: boolean;
	readonly onClose: () => void;
	readonly onInstall: (allowPartial: boolean) => Promise<void>;
}) {
	const { t } = useTranslation();
	const closeRef = useRef<HTMLButtonElement>(null);
	const [allowPartial, setAllowPartial] = useState(false);

	// Capability evaluation
	const components = inspection?.components ?? [];
	const unsupportedComponents = components.filter((c) => c.status === "unsupported" || c.kind === "unsupported");
	const supportedComponents = components.filter((c) => c.status !== "unsupported" && c.kind !== "unsupported");
	const hasUnsupported = unsupportedComponents.length > 0;
	const allUnsupported = supportedComponents.length === 0;
	const blockedByInspection = Boolean(inspection?.issues.some(isFatalInspectionIssue));

	return (
		<DialogFrame
			cancellable={!installPending}
			className="mcp-dialog plugins-inspect-dialog"
			descriptionId="inspect-plugin-description"
			initialFocus={closeRef}
			onCancel={onClose}
			titleId="inspect-plugin-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={installPending}
				onClick={onClose}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="inspect-plugin-title">{inspection?.plugin.displayName || entry.name}</h2>
			<p id="inspect-plugin-description">{inspection?.plugin.description || entry.description}</p>

			{loading ? (
				<output className="status-paragraph plugins-detail-loading">{t("Loading plugin details…")}</output>
			) : error ? (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			) : installResult ? (
				/* biome-ignore lint/a11y/useSemanticElements: This status banner groups block content and actions; output only accepts phrasing content. */
				<div className="plugins-install-success-banner" role="status">
					<CheckCircle aria-hidden="true" color="var(--success-action)" size={24} />
					<div>
						<strong>{t("Plugin installed", { name: installResult.name })}</strong>
						<p>
							{installResult.activation === "next-turn"
								? t(
										"Current task turn will continue using original capabilities. Changes will take effect on next turn.",
									)
								: t("Plugin is now active.")}
						</p>
					</div>
					<div className="mcp-dialog-actions">
						<button className="button-primary" onClick={onClose} ref={closeRef} type="button">
							{t("Done")}
						</button>
					</div>
				</div>
			) : (
				<div className="plugins-inspect-body">
					{/* Meta info */}
					<div className="plugins-inspect-meta-row">
						<span>
							<strong>{t("Format")}:</strong> {inspection?.plugin.format}
						</span>
						{inspection?.plugin.version && (
							<span>
								<strong>{t("Version")}:</strong> {inspection.plugin.version}
							</span>
						)}
						{inspection?.sourceCommit && (
							<span>
								<strong>{t("Commit")}:</strong> {inspection.sourceCommit.slice(0, 7)}
							</span>
						)}
						{inspection?.plugin.repository && (
							<a
								className="plugins-external-link"
								href={inspection.plugin.repository}
								rel="noreferrer"
								target="_blank"
							>
								{t("Repository")}
								<ArrowSquareOut aria-hidden="true" size={13} />
							</a>
						)}
					</div>

					{/* Components summary */}
					<div className="plugins-inspect-section">
						<h3>
							{t("Components")} ({components.length})
						</h3>
						{components.length === 0 ? (
							<p className="plugins-empty-hint">{t("No components declared.")}</p>
						) : (
							<ul className="plugins-component-list">
								{components.map((c) => (
									<li className="plugins-component-item" key={c.componentId}>
										<div className="plugins-component-icon">
											{c.kind === "skill" ? (
												<PuzzlePiece aria-hidden="true" size={16} />
											) : c.kind === "mcp" ? (
												<Plug aria-hidden="true" size={16} />
											) : c.kind === "hook" ? (
												<Lightning aria-hidden="true" size={16} />
											) : (
												<WarningCircle aria-hidden="true" size={16} />
											)}
										</div>
										<div className="plugins-component-copy">
											<div className="plugins-component-title">
												<strong>{c.displayName || c.originalName}</strong>
												<span className="plugins-component-kind">{c.kind}</span>
												<ComponentStatusBadge status={c.status} />
											</div>
											{c.reason && <small>{c.reason}</small>}
										</div>
									</li>
								))}
							</ul>
						)}
					</div>

					{/* Issues */}
					{inspection?.issues && inspection.issues.length > 0 && (
						<div className="plugins-inspect-section">
							<h3>{t("Issues and limitations")}</h3>
							<ul className="plugins-issues-list">
								{inspection.issues.map((issue, idx) => (
									/* biome-ignore lint/suspicious/noArrayIndexKey: Issues belong to one immutable inspection snapshot and have no unique issue IDs or local row state. */
									<li className={`plugins-issue-item status-${issue.status}`} key={idx}>
										<Warning aria-hidden="true" size={15} />
										<span>{issue.message}</span>
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Unsupported warning / allowPartial */}
					{hasUnsupported && !allUnsupported && (
						<div className="plugins-partial-notice">
							<Warning aria-hidden="true" size={18} />
							<div>
								<p>{t("This plugin contains unsupported components which will be skipped.")}</p>
								<label className="plugins-partial-checkbox">
									<input
										checked={allowPartial}
										disabled={installPending}
										onChange={(e) => setAllowPartial(e.target.checked)}
										type="checkbox"
									/>
									<span>{t("Install Compatible Components")}</span>
								</label>
							</div>
						</div>
					)}

					{allUnsupported && (
						<div className="plugins-unsupported-banner" role="alert">
							<XCircle aria-hidden="true" size={18} />
							<p>{t("No compatible components can be installed from this plugin.")}</p>
						</div>
					)}

					{/* Actions */}
					<div className="mcp-dialog-actions">
						<button
							className="button-secondary"
							disabled={installPending}
							onClick={onClose}
							ref={closeRef}
							type="button"
						>
							{t("Cancel")}
						</button>
						{allUnsupported || blockedByInspection ? (
							<button className="button-primary" disabled type="button">
								{t("Cannot Install")}
							</button>
						) : (
							<button
								className="button-primary"
								disabled={installPending || blockedByInspection || (hasUnsupported && !allowPartial)}
								onClick={() => onInstall(allowPartial)}
								type="button"
							>
								{t(installPending ? "Installing…" : "Install")}
							</button>
						)}
					</div>
				</div>
			)}
		</DialogFrame>
	);
}

function InstalledPluginDetailDialog({
	detail,
	error,
	loading,
	onCheckUpdate,
	onClose,
	onOpenHook,
	onOpenMcp,
	onOpenSkill,
	onToggleEnabled,
	onUninstall,
	pending,
	updateError,
	updateMessage,
}: {
	readonly detail: PluginInstalledView | null;
	readonly error: string | null;
	readonly loading: boolean;
	readonly onCheckUpdate: () => void;
	readonly onClose: () => void;
	readonly onOpenHook?: (id: string) => void;
	readonly onOpenMcp?: (name: string) => void;
	readonly onOpenSkill?: (name: string) => void;
	readonly onToggleEnabled: () => void;
	readonly onUninstall: () => void;
	readonly pending: boolean;
	readonly updateError?: string | null;
	readonly updateMessage?: string | null;
}) {
	const { t } = useTranslation();
	const closeRef = useRef<HTMLButtonElement>(null);

	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog plugins-detail-dialog"
			descriptionId="installed-detail-description"
			initialFocus={closeRef}
			onCancel={onClose}
			titleId="installed-detail-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onClose}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="installed-detail-title">{detail?.plugin.displayName || detail?.plugin.name || t("Plugin Details")}</h2>
			<p id="installed-detail-description">{detail?.plugin.repository || ""}</p>

			{loading ? (
				<output className="status-paragraph plugins-detail-loading">{t("Loading plugin details…")}</output>
			) : error ? (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			) : detail ? (
				<div className="plugins-installed-detail-body">
					{updateError && (
						<p className="mcp-dialog-error" role="alert">
							{updateError}
						</p>
					)}
					{updateMessage && <output className="status-paragraph plugins-update-status">{updateMessage}</output>}
					{/* Status overview */}
					<div className="plugins-status-card">
						<div className="plugins-status-card-row">
							<span>{t("Configuration")}:</span>
							<span className={`plugins-badge ${detail.plugin.enabled ? "badge-enabled" : "badge-disabled"}`}>
								{t(detail.plugin.enabled ? "Enabled" : "Disabled")}
							</span>
						</div>
						<div className="plugins-status-card-row">
							<span>{t("Runtime Status")}:</span>
							<span
								className={`plugins-badge badge-${detail.activation}`}
								title={
									detail.activation === "next-turn"
										? t(
												"Current task turn will continue using original capabilities. Changes will take effect on next turn.",
											)
										: undefined
								}
							>
								{t(
									detail.activation === "applied"
										? "Active"
										: detail.activation === "next-turn"
											? "Pending Turn"
											: detail.activation === "not-running"
												? "Not Running"
												: "Failed",
								)}
							</span>
						</div>
						<div className="plugins-status-card-row">
							<span>{t("Installed Commit")}:</span>
							<code>{detail.plugin.commit.slice(0, 7)}</code>
						</div>
						<div className="plugins-status-card-row">
							<span>{t("Installed At")}:</span>
							<small>{new Date(detail.plugin.installedAt).toLocaleString()}</small>
						</div>
					</div>

					{detail.runtimeErrors.length > 0 && (
						<div className="plugins-inspect-section" role="alert">
							<h3>{t("Runtime Errors")}</h3>
							<ul className="plugins-component-list">
								{detail.runtimeErrors.map((runtimeError, index) => (
									<li className="plugins-component-item" key={`${runtimeError.componentId}-${index}`}>
										<div className="plugins-component-icon">
											<WarningCircle aria-hidden="true" size={16} />
										</div>
										<div className="plugins-component-copy">
											<strong>
												{t("Affected session/component")}: <code>{runtimeError.componentId}</code>
											</strong>
											<small>{runtimeError.message}</small>
										</div>
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Components */}
					<div className="plugins-inspect-section">
						<h3>
							{t("Components")} ({detail.components.length})
						</h3>
						<ul className="plugins-component-list">
							{detail.components.map((c) => (
								<li className="plugins-component-item" key={c.componentId}>
									<div className="plugins-component-icon">
										{c.kind === "skill" ? (
											<PuzzlePiece aria-hidden="true" size={16} />
										) : c.kind === "mcp" ? (
											<Plug aria-hidden="true" size={16} />
										) : c.kind === "hook" ? (
											<Lightning aria-hidden="true" size={16} />
										) : (
											<WarningCircle aria-hidden="true" size={16} />
										)}
									</div>
									<div className="plugins-component-copy">
										<div className="plugins-component-title">
											<strong>{c.displayName || c.originalName}</strong>
											<span className="plugins-component-kind">{c.kind}</span>
											<ComponentStatusBadge status={c.status} />
										</div>
										{c.reason && <small>{c.reason}</small>}
									</div>
									<div className="plugins-component-nav">
										{c.kind === "skill" && onOpenSkill && (
											<button
												className="plugins-link-btn"
												onClick={() => {
													onClose();
													onOpenSkill(c.originalName);
												}}
												type="button"
											>
												{t("View in Skills")}
											</button>
										)}
										{c.kind === "mcp" && onOpenMcp && (
											<button
												className="plugins-link-btn"
												onClick={() => {
													onClose();
													onOpenMcp(c.displayName || c.originalName);
												}}
												type="button"
											>
												{t("View in MCP")}
											</button>
										)}
										{c.kind === "hook" && onOpenHook && (
											<button
												className="plugins-link-btn"
												onClick={() => {
													onClose();
													onOpenHook(c.componentId);
												}}
												type="button"
											>
												{t("View in Hooks")}
											</button>
										)}
									</div>
								</li>
							))}
						</ul>
					</div>

					{/* Actions */}
					<div className="mcp-dialog-actions plugins-installed-actions">
						<button className="button-secondary" disabled={pending} onClick={onToggleEnabled} type="button">
							{detail.plugin.enabled ? t("Disable") : t("Enable")}
						</button>
						<button className="button-secondary" disabled={pending} onClick={onCheckUpdate} type="button">
							{t("Check for Updates")}
						</button>
						<button className="mcp-danger" disabled={pending} onClick={onUninstall} type="button">
							{t("Uninstall")}
						</button>
						<button
							className="button-secondary"
							disabled={pending}
							onClick={onClose}
							ref={closeRef}
							type="button"
						>
							{t("Close")}
						</button>
					</div>
				</div>
			) : null}
		</DialogFrame>
	);
}

function UpdatePluginDialog({
	error,
	onClose,
	onUpdate,
	pending,
	updateInfo,
}: {
	readonly error: string | null;
	readonly onClose: () => void;
	readonly onUpdate: (allowPartial: boolean) => Promise<void>;
	readonly pending: boolean;
	readonly updateInfo: PluginUpdateInspectionView;
}) {
	const { t } = useTranslation();
	const closeRef = useRef<HTMLButtonElement>(null);
	const [allowPartial, setAllowPartial] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies(updateInfo.inspection?.inspectionId): Each new inspection resets consent for a partial installation.
	useEffect(() => {
		setAllowPartial(false);
	}, [updateInfo.inspection?.inspectionId]);

	const inspection = updateInfo.inspection;
	const components = inspection?.components ?? [];
	const hasUnsupported = components.some((c) => c.status === "unsupported" || c.kind === "unsupported");
	const allUnsupported =
		Boolean(inspection) && components.every((c) => c.status === "unsupported" || c.kind === "unsupported");
	const blockedByInspection = Boolean(inspection?.issues.some(isFatalInspectionIssue));

	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog plugins-update-dialog"
			descriptionId="update-plugin-description"
			initialFocus={closeRef}
			onCancel={onClose}
			titleId="update-plugin-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onClose}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="update-plugin-title">{t("Plugin Update Available")}</h2>
			<p id="update-plugin-description">
				{t("Update commit from {{oldCommit}} to {{newCommit}}", {
					oldCommit: updateInfo.currentCommit.slice(0, 7),
					newCommit: (updateInfo.newCommit ?? "").slice(0, 7),
				})}
			</p>

			{error && (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			)}

			{!inspection && (
				<p className="mcp-dialog-error" role="alert">
					{t("Failed to inspect plugin update. Update cannot be installed.")}
				</p>
			)}

			{inspection && (
				<div className="plugins-update-body">
					<h3>
						{t("Updated Components")} ({components.length})
					</h3>
					<ul className="plugins-component-list">
						{components.map((c) => (
							<li className="plugins-component-item" key={c.componentId}>
								<div className="plugins-component-icon">
									{c.kind === "skill" ? (
										<PuzzlePiece aria-hidden="true" size={16} />
									) : c.kind === "mcp" ? (
										<Plug aria-hidden="true" size={16} />
									) : (
										<Lightning aria-hidden="true" size={16} />
									)}
								</div>
								<div className="plugins-component-copy">
									<strong>{c.displayName || c.originalName}</strong>
									<span className="plugins-component-kind">{c.kind}</span>
									<ComponentStatusBadge status={c.status} />
									{c.reason && <small>{c.reason}</small>}
								</div>
							</li>
						))}
					</ul>
					{inspection.issues.length > 0 && (
						<div className="plugins-inspect-section">
							<h3>{t("Issues and limitations")}</h3>
							<ul className="plugins-issues-list">
								{inspection.issues.map((issue, index) => (
									/* biome-ignore lint/suspicious/noArrayIndexKey: Issues belong to one immutable inspection snapshot and have no unique issue IDs or local row state. */
									<li className={`plugins-issue-item status-${issue.status}`} key={index}>
										<Warning aria-hidden="true" size={15} />
										<span>{issue.message}</span>
									</li>
								))}
							</ul>
						</div>
					)}
					{hasUnsupported && !allUnsupported && (
						<label className="plugins-partial-checkbox">
							<input
								checked={allowPartial}
								disabled={pending}
								onChange={(e) => setAllowPartial(e.target.checked)}
								type="checkbox"
							/>
							<span>{t("Install Compatible Components")}</span>
						</label>
					)}
					{allUnsupported && (
						<div className="plugins-unsupported-banner" role="alert">
							<XCircle aria-hidden="true" size={18} />
							<p>{t("No compatible components can be installed from this plugin.")}</p>
						</div>
					)}
				</div>
			)}

			<div className="mcp-dialog-actions">
				<button className="button-secondary" disabled={pending} onClick={onClose} ref={closeRef} type="button">
					{t("Cancel")}
				</button>
				{allUnsupported || blockedByInspection ? (
					<button className="button-primary" disabled type="button">
						{t("Cannot Install")}
					</button>
				) : (
					<button
						className="button-primary"
						disabled={pending || !inspection || blockedByInspection || (hasUnsupported && !allowPartial)}
						onClick={() => onUpdate(allowPartial)}
						type="button"
					>
						{t(pending ? "Updating…" : "Update")}
					</button>
				)}
			</div>
		</DialogFrame>
	);
}

function RemovePluginDialog({
	error,
	onCancel,
	onConfirm,
	pending,
	plugin,
}: {
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onConfirm: () => Promise<void>;
	readonly pending: boolean;
	readonly plugin: PluginRecord;
}) {
	const { t } = useTranslation();
	const cancelRef = useRef<HTMLButtonElement>(null);

	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog plugins-remove-dialog"
			descriptionId="remove-plugin-description"
			initialFocus={cancelRef}
			onCancel={onCancel}
			titleId="remove-plugin-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onCancel}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="remove-plugin-title">{t("Uninstall Plugin?")}</h2>
			<p id="remove-plugin-description">
				{t("Uninstall {{name}}? Manual configurations and other plugins will not be affected.", {
					name: plugin.displayName || plugin.name,
				})}
			</p>
			{error && (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			)}
			<div className="mcp-dialog-actions">
				<button className="button-secondary" disabled={pending} onClick={onCancel} ref={cancelRef} type="button">
					{t("Cancel")}
				</button>
				<button className="mcp-danger" disabled={pending} onClick={onConfirm} type="button">
					{t(pending ? "Uninstalling…" : "Uninstall")}
				</button>
			</div>
		</DialogFrame>
	);
}

function ComponentStatusBadge({ status }: { readonly status: PluginComponentStatus }) {
	const { t } = useTranslation();
	const label =
		status === "ready"
			? t("Compatible")
			: status === "needs-configuration"
				? t("Needs configuration")
				: status === "unsupported"
					? t("Unsupported")
					: t("Failed");
	return <span className={`plugins-badge badge-${status}`}>{label}</span>;
}
