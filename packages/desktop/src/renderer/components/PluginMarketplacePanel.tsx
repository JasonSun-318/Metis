import type {
	PluginActivationStatus,
	PluginCatalogEntryView,
	PluginComponentPublicView,
	PluginComponentStatus,
	PluginInstalledView,
	PluginInspectionView,
	PluginIssue,
	PluginMarketView,
	PluginRecord,
	PluginUpdateInspectionView,
} from "@metis/app-protocol";
import {
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
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import { DialogFrame } from "./ProjectActions.tsx";

function message(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	return String(cause ?? "An error occurred.");
}

export interface PluginMarketplacePanelProps {
	readonly api: MetisDesktopApi;
	readonly serverReady: boolean;
	readonly selectedPluginId?: string | null;
	readonly onClearSelectedPlugin?: () => void;
	readonly onOpenSkill?: (name: string) => void;
	readonly onOpenMcp?: (name: string) => void;
	readonly onOpenHook?: (id: string) => void;
}

type ViewMode = "browse" | "installed";

export function PluginMarketplacePanel({
	api,
	serverReady,
	selectedPluginId,
	onClearSelectedPlugin,
	onOpenSkill,
	onOpenMcp,
	onOpenHook,
}: PluginMarketplacePanelProps) {
	const { t } = useTranslation();
	const [viewMode, setViewMode] = useState<ViewMode>("browse");

	// Markets and catalog state
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

	const [removeConfirmPlugin, setRemoveConfirmPlugin] = useState<PluginRecord | null>(null);
	const [removePending, setRemovePending] = useState(false);
	const [removeError, setRemoveError] = useState<string | null>(null);

	// Generation tracker for market switching anti-race
	const marketGeneration = useRef(0);

	// Load markets on mount / server ready
	const loadMarkets = useCallback(async () => {
		if (!serverReady) return;
		try {
			const res = await api.listPluginMarkets();
			setMarkets(res.markets);
			setSelectedMarketId(res.selectedSourceId);
			setRegistryRevision(res.registryRevision);
		} catch (err) {
			setCatalogError(message(err));
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
		if (selectedMarketId) {
			loadCatalog(selectedMarketId);
		}
	}, [selectedMarketId, loadCatalog]);

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
		api
			.getInstalledPlugin({ pluginId: detailPluginId })
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
			if (sourceId === selectedMarketId || !serverReady) return;
			try {
				const res = await api.selectPluginMarket({
					requestId: crypto.randomUUID(),
					sourceId,
					expectedRevision: registryRevision,
				});
				setMarkets(res.markets);
				setSelectedMarketId(res.selectedSourceId);
				setRegistryRevision(res.registryRevision);
			} catch (err) {
				setCatalogError(message(err));
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
				setSelectedMarketId(res.selectedSourceId);
				setRegistryRevision(res.registryRevision);
				setAddMarketOpen(false);
			} catch (err) {
				setAddMarketError(message(err));
			} finally {
				setAddMarketPending(false);
			}
		},
		[api, registryRevision],
	);

	// Remove custom market
	const handleRemoveMarket = useCallback(async () => {
		if (!selectedMarketId || selectedMarketId === "official-market" || !serverReady) return;
		try {
			const res = await api.removePluginMarket({
				requestId: crypto.randomUUID(),
				sourceId: selectedMarketId,
				expectedRevision: registryRevision,
			});
			setMarkets(res.markets);
			setSelectedMarketId(res.selectedSourceId);
			setRegistryRevision(res.registryRevision);
		} catch (err) {
			setCatalogError(message(err));
		}
	}, [api, registryRevision, selectedMarketId, serverReady]);

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
			if (!inspection || installPending || !serverReady) return;
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
			try {
				const res = await api.inspectPluginUpdate({ pluginId });
				setUpdateInspection(res);
			} catch (err) {
				setUpdateError(message(err));
			} finally {
				setUpdateChecking(false);
			}
		},
		[api, serverReady, updateChecking],
	);

	// Perform plugin update
	const handlePerformUpdate = useCallback(
		async (allowPartial = false) => {
			if (!updateInspection || !updateInspection.inspection || updatePending || !serverReady) return;
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
			(entry) =>
				entry.name.toLowerCase().includes(q) ||
				(entry.description && entry.description.toLowerCase().includes(q)),
		);
	}, [catalogEntries, catalogQuery]);

	// Filter installed list
	const visibleInstalledList = useMemo(() => {
		const q = installedQuery.trim().toLowerCase();
		if (!q) return installedList;
		return installedList.filter(
			(plugin) =>
				plugin.name.toLowerCase().includes(q) ||
				plugin.displayName.toLowerCase().includes(q),
		);
	}, [installedList, installedQuery]);

	const selectedMarket = markets.find((m) => m.id === selectedMarketId);

	return (
		<div className="plugins-market-panel">
			{/* Sub-view switcher: Browse vs Installed */}
			<div className="plugins-sub-switch-row">
				<div aria-label={t("Plugin views")} className="plugins-sub-switch" role="tablist">
					<button
						aria-selected={viewMode === "browse"}
						className={`plugins-sub-tab ${viewMode === "browse" ? "active" : ""}`}
						onClick={() => setViewMode("browse")}
						role="tab"
						type="button"
					>
						{t("Browse")}
					</button>
					<button
						aria-selected={viewMode === "installed"}
						className={`plugins-sub-tab ${viewMode === "installed" ? "active" : ""}`}
						onClick={() => setViewMode("installed")}
						role="tab"
						type="button"
					>
						{t("Installed")}
						{(installedList?.length ?? 0) > 0 && (
							<span className="plugins-count-pill">{installedList.length}</span>
						)}
					</button>
				</div>
			</div>

			{viewMode === "browse" ? (
				<>
					{/* Browse Toolbar */}
					<div className="plugins-market-toolbar">
						<div className="plugins-market-selector-wrapper">
							<MenuSelect
								ariaLabel={t("Marketplace")}
								className="plugins-filter"
								disabled={!serverReady || markets.length === 0}
								onChange={handleSelectMarket}
								options={markets.map((m) => ({
									value: m.id,
									label: m.displayName || m.url,
								}))}
								value={selectedMarketId}
							/>
							{selectedMarket && selectedMarket.id !== "official-market" && (
								<button
									aria-label={t("Remove Market")}
									className="plugins-market-remove-btn"
									disabled={!serverReady}
									onClick={handleRemoveMarket}
									title={t("Remove Market")}
									type="button"
								>
									<Trash aria-hidden="true" size={15} />
								</button>
							)}
						</div>
						<div className="plugins-search plugins-market-search">
							<MagnifyingGlass aria-hidden="true" size={16} />
							<input
								aria-label={t("Search plugins…")}
								onChange={(e) => setCatalogQuery(e.target.value)}
								placeholder={t("Search plugins…")}
								type="search"
								value={catalogQuery}
							/>
						</div>
						<div className="plugins-market-toolbar-actions">
							<button
								aria-label={t(marketRefreshing ? "Refreshing market…" : "Refresh")}
								className="plugins-reload"
								disabled={!serverReady || marketRefreshing || catalogLoading}
								onClick={handleRefreshMarket}
								title={t("Refresh")}
								type="button"
							>
								<ArrowsClockwise
									aria-hidden="true"
									className={marketRefreshing ? "plugins-spin" : undefined}
									size={16}
								/>
								{t("Refresh")}
							</button>
							<button
								className="plugins-market-btn"
								disabled={!serverReady}
								onClick={() => {
									setAddMarketError(null);
									setAddMarketOpen(true);
								}}
								type="button"
							>
								<Plus aria-hidden="true" size={16} />
								<span>{t("Add Market")}</span>
							</button>
						</div>
					</div>

					{/* Catalog List */}
					<div className="plugins-full-list" role="listbox">
						{catalogLoading ? (
							<p className="plugins-catalog-message" role="status">
								{t("Loading catalog…")}
							</p>
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
										onClick={() => handleInspectEntry(entry)}
										type="button"
									>
										{t("Inspect")}
									</button>
								</div>
							))
						)}
					</div>
				</>
			) : (
				<>
					{/* Installed Toolbar */}
					<div className="plugins-market-toolbar">
						<div className="plugins-search plugins-market-search">
							<MagnifyingGlass aria-hidden="true" size={16} />
							<input
								aria-label={t("Search installed plugins…")}
								onChange={(e) => setInstalledQuery(e.target.value)}
								placeholder={t("Search installed plugins…")}
								type="search"
								value={installedQuery}
							/>
						</div>
						<div className="plugins-market-toolbar-actions">
							<button
								aria-label={t(installedLoading ? "Reloading…" : "Reload")}
								className="plugins-reload"
								disabled={!serverReady || installedLoading}
								onClick={loadInstalled}
								title={t("Reload")}
								type="button"
							>
								<ArrowsClockwise
									aria-hidden="true"
									className={installedLoading ? "plugins-spin" : undefined}
									size={16}
								/>
								{t("Reload")}
							</button>
						</div>
					</div>

					{/* Installed List */}
					<div className="plugins-full-list" role="listbox">
						{installedLoading ? (
							<p className="plugins-catalog-message" role="status">
								{t("Loading installed plugins…")}
							</p>
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
					entry={inspectingEntry}
					error={inspectionError}
					initialAllowPartial={Boolean(
						inspection?.components.some((c) => c.status === "unsupported") ||
						inspection?.issues.some((i) => i.status === "unsupported"),
					)}
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
						onClearSelectedPlugin?.();
					}}
					onOpenHook={onOpenHook}
					onOpenMcp={onOpenMcp}
					onOpenSkill={onOpenSkill}
					onToggleEnabled={() => detailPlugin && handleToggleEnabled(detailPlugin.plugin)}
					onUninstall={() => detailPlugin && setRemoveConfirmPlugin(detailPlugin.plugin)}
					pending={detailActionPending || updateChecking}
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
			<p id="add-market-description">
				{t("Enter GitHub repository URL or owner/repo")}
			</p>
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
					<button
						className="button-secondary"
						disabled={pending}
						onClick={onCancel}
						ref={cancelRef}
						type="button"
					>
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
	initialAllowPartial,
	inspection,
	installPending,
	installResult,
	loading,
	onClose,
	onInstall,
}: {
	readonly entry: PluginCatalogEntryView;
	readonly error: string | null;
	readonly initialAllowPartial: boolean;
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
	const [allowPartial, setAllowPartial] = useState(initialAllowPartial);

	useEffect(() => {
		setAllowPartial(initialAllowPartial);
	}, [initialAllowPartial]);

	// Capability evaluation
	const components = inspection?.components ?? [];
	const unsupportedComponents = components.filter(
		(c) => c.status === "unsupported" || c.kind === "unsupported",
	);
	const supportedComponents = components.filter(
		(c) => c.status !== "unsupported" && c.kind !== "unsupported",
	);
	const hasUnsupported = unsupportedComponents.length > 0;
	const allUnsupported = components.length > 0 && supportedComponents.length === 0;

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
			<h2 id="inspect-plugin-title">
				{inspection?.plugin.displayName || entry.name}
			</h2>
			<p id="inspect-plugin-description">
				{inspection?.plugin.description || entry.description}
			</p>

			{loading ? (
				<p className="plugins-detail-loading" role="status">
					{t("Loading plugin details…")}
				</p>
			) : error ? (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			) : installResult ? (
				<div className="plugins-install-success-banner" role="status">
					<CheckCircle aria-hidden="true" color="var(--success-action)" size={24} />
					<div>
						<strong>
							{t("Plugin installed", { name: installResult.name })}
						</strong>
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
								<p>
									{t(
										"This plugin contains unsupported components which will be skipped.",
									)}
								</p>
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
							<p>
								{t(
									"No compatible components can be installed from this plugin.",
								)}
							</p>
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
						{allUnsupported ? (
							<button className="button-primary" disabled type="button">
								{t("Cannot Install")}
							</button>
						) : (
							<button
								className="button-primary"
								disabled={installPending || (hasUnsupported && !allowPartial)}
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
			<h2 id="installed-detail-title">
				{detail?.plugin.displayName || detail?.plugin.name || t("Plugin Details")}
			</h2>
			<p id="installed-detail-description">
				{detail?.plugin.repository || ""}
			</p>

			{loading ? (
				<p className="plugins-detail-loading" role="status">
					{t("Loading plugin details…")}
				</p>
			) : error ? (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			) : detail ? (
				<div className="plugins-installed-detail-body">
					{/* Status overview */}
					<div className="plugins-status-card">
						<div className="plugins-status-card-row">
							<span>{t("Status")}:</span>
							<span
								className={`plugins-badge ${detail.plugin.enabled ? "badge-enabled" : "badge-disabled"}`}
							>
								{t(detail.plugin.enabled ? "Enabled" : "Disabled")}
							</span>
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
						<button
							className="button-secondary"
							disabled={pending}
							onClick={onToggleEnabled}
							type="button"
						>
							{detail.plugin.enabled ? t("Disable") : t("Enable")}
						</button>
						<button
							className="button-secondary"
							disabled={pending}
							onClick={onCheckUpdate}
							type="button"
						>
							{t("Check for Updates")}
						</button>
						<button
							className="mcp-danger"
							disabled={pending}
							onClick={onUninstall}
							type="button"
						>
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

	const inspection = updateInfo.inspection;
	const components = inspection?.components ?? [];
	const hasUnsupported = components.some(
		(c) => c.status === "unsupported" || c.kind === "unsupported",
	);

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
								</div>
							</li>
						))}
					</ul>
					{hasUnsupported && (
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
				</div>
			)}

			<div className="mcp-dialog-actions">
				<button
					className="button-secondary"
					disabled={pending}
					onClick={onClose}
					ref={closeRef}
					type="button"
				>
					{t("Cancel")}
				</button>
				<button
					className="button-primary"
					disabled={pending}
					onClick={() => onUpdate(allowPartial)}
					type="button"
				>
					{t(pending ? "Updating…" : "Update")}
				</button>
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
				{t(
					"Uninstall {{name}}? Manual configurations and other plugins will not be affected.",
					{ name: plugin.displayName || plugin.name },
				)}
			</p>
			{error && (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			)}
			<div className="mcp-dialog-actions">
				<button
					className="button-secondary"
					disabled={pending}
					onClick={onCancel}
					ref={cancelRef}
					type="button"
				>
					{t("Cancel")}
				</button>
				<button
					className="mcp-danger"
					disabled={pending}
					onClick={onConfirm}
					type="button"
				>
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
