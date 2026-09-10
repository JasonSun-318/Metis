// @vitest-environment jsdom

import type {
	CatalogEntryView,
	ComponentPublicView,
	MarketRecord,
	PluginInstalledView,
	PluginInspectionView,
	PluginRecord,
} from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginsPanel, type PluginSection } from "../src/renderer/components/PluginsPanel.tsx";
import i18n from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";

const officialMarket: MarketRecord = {
	id: "official-market",
	displayName: "Official Marketplace",
	url: "https://github.com/metis-ai/plugins",
	commit: "main-commit",
	fetchedAt: "2026-09-09T00:00:00.000Z",
	selected: true,
};

const customMarket: MarketRecord = {
	id: "custom-gh",
	displayName: "custom-org/plugins",
	url: "https://github.com/custom-org/plugins",
	commit: "custom-commit",
	fetchedAt: "2026-09-09T00:00:00.000Z",
	selected: false,
};

const devToolsCatalog: CatalogEntryView = {
	id: "dev-tools",
	name: "Dev Tools",
	description: "Developer tools for Metis",
	formatHint: "native",
	sourceSupported: true,
	installState: "not-installed",
};

const partialCatalog: CatalogEntryView = {
	id: "partial-tools",
	name: "Partial Tools",
	description: "Partially compatible plugin with unsupported components",
	formatHint: "native",
	sourceSupported: true,
	installState: "not-installed",
};

const unsupportedCatalog: CatalogEntryView = {
	id: "unsupported-addon",
	name: "Unsupported Addon",
	description: "Completely unsupported addon",
	formatHint: "claude",
	sourceSupported: false,
	installState: "not-installed",
};

const installedOneRecord: PluginRecord = {
	id: "installed-one",
	name: "installed-one",
	displayName: "Installed One",
	format: "native",
	repository: "https://github.com/metis-ai/installed-one",
	subdir: "",
	commit: "aaa11112222333",
	sourceId: "official-market",
	enabled: true,
	installedAt: "2026-09-09T10:00:00.000Z",
	issues: [],
};

const installedPendingRecord: PluginRecord = {
	id: "installed-pending",
	name: "installed-pending",
	displayName: "Installed Pending",
	format: "native",
	repository: "https://github.com/metis-ai/installed-pending",
	subdir: "",
	commit: "bbb22223333444",
	sourceId: "official-market",
	enabled: true,
	installedAt: "2026-09-09T11:00:00.000Z",
	issues: [],
};

const installedOneDetail: PluginInstalledView = {
	plugin: installedOneRecord,
	components: [
		{ componentId: "skill-one", kind: "skill", displayName: "skill-one", originalName: "skill-one", status: "ready" },
		{ componentId: "mcp-one", kind: "mcp", displayName: "mcp-one", originalName: "mcp-one", status: "ready" },
		{ componentId: "hook-one", kind: "hook", displayName: "hook-one", originalName: "hook-one", status: "ready" },
	],
	activation: "applied",
	runtimeErrors: [],
};

const installedPendingDetail: PluginInstalledView = {
	plugin: installedPendingRecord,
	components: [
		{ componentId: "skill-pending", kind: "skill", displayName: "skill-pending", originalName: "skill-pending", status: "ready" },
	],
	activation: "next-turn",
	runtimeErrors: [],
};

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function setInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PluginMarketplacePanel and Plugins 4th tab", () => {
	let container: HTMLDivElement;
	let root: Root;

	afterEach(async () => {
		if (root) {
			await act(async () => root.unmount());
		}
		container?.remove();
		document.body.innerHTML = "";
		await i18n.changeLanguage("en");
	});

	function createMockApi(overrides?: Partial<Parameters<typeof PluginsPanel>[0]["api"]>) {
		return {
			listSkills: vi.fn().mockResolvedValue({ skills: [] }),
			getSkill: vi.fn(),
			saveSkill: vi.fn(),
			removeSkill: vi.fn(),
			reloadSkills: vi.fn().mockResolvedValue({ skills: [] }),
			openSkillFolder: vi.fn(),
			inspectSkillImport: vi.fn(),
			importSkills: vi.fn(),
			selectProjectFolder: vi.fn(),
			selectAttachmentFiles: vi.fn(),
			resolveDroppedFiles: vi.fn(),
			listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
			listMcpProjects: vi.fn().mockResolvedValue({ projects: [] }),
			inspectMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
			importMcpServers: vi.fn(),
			getMcpServer: vi.fn(),
			getMcpCatalogItem: vi.fn(),
			upsertMcpServer: vi.fn(),
			removeMcpServer: vi.fn(),
			restartMcpServer: vi.fn(),
			setMcpCredential: vi.fn(),
			clearMcpCredential: vi.fn(),
			listHooks: vi.fn().mockResolvedValue({ hooks: [], loadErrors: [] }),
			upsertHook: vi.fn(),
			deleteHook: vi.fn(),
			listPluginMarkets: vi.fn().mockResolvedValue({
				markets: [officialMarket],
				selectedSourceId: "official-market",
				registryRevision: 1,
			}),
			addPluginMarket: vi.fn().mockResolvedValue({
				markets: [officialMarket, customMarket],
				selectedSourceId: "custom-gh",
				registryRevision: 2,
			}),
			selectPluginMarket: vi.fn().mockResolvedValue({
				markets: [officialMarket, customMarket],
				selectedSourceId: "custom-gh",
				registryRevision: 2,
			}),
			removePluginMarket: vi.fn().mockResolvedValue({
				markets: [officialMarket],
				selectedSourceId: "official-market",
				registryRevision: 3,
			}),
			refreshPluginMarket: vi.fn().mockResolvedValue({
				catalog: [devToolsCatalog, partialCatalog, unsupportedCatalog],
				entries: [devToolsCatalog, partialCatalog, unsupportedCatalog],
				fetchedAt: "2026-09-09T00:00:00.000Z",
				cacheStatus: "fresh",
			}),
			getPluginCatalog: vi.fn().mockResolvedValue({
				entries: [devToolsCatalog, partialCatalog, unsupportedCatalog],
				cacheStatus: "cached",
			}),
			inspectPlugin: vi.fn().mockImplementation(({ entryId }) => {
				const isPartial = entryId === "partial-tools";
				const isUnsupported = entryId === "unsupported-addon";
				const components: ComponentPublicView[] = isUnsupported
					? [{ componentId: "bad-hook", kind: "hook", displayName: "bad-hook", originalName: "bad-hook", status: "unsupported", reason: "Unsupported hook" }]
					: isPartial
						? [
								{ componentId: "valid-skill", kind: "skill", displayName: "valid-skill", originalName: "valid-skill", status: "ready" },
								{ componentId: "broken-mcp", kind: "mcp", displayName: "broken-mcp", originalName: "broken-mcp", status: "unsupported", reason: "broken-mcp is unsupported on this platform" },
						  ]
						: [
								{ componentId: "git-helper", kind: "skill", displayName: "git-helper", originalName: "git-helper", status: "ready" },
								{ componentId: "db-mcp", kind: "mcp", displayName: "db-mcp", originalName: "db-mcp", status: "ready" },
								{ componentId: "lint-hook", kind: "hook", displayName: "lint-hook", originalName: "lint-hook", status: "ready" },
						  ];

				const inspection: PluginInspectionView = {
					inspectionId: `insp-${entryId}`,
					plugin: {
						id: entryId,
						name: entryId,
						displayName: entryId === "partial-tools" ? "Partial Tools" : entryId === "unsupported-addon" ? "Unsupported Addon" : "Dev Tools",
						format: isUnsupported ? "claude" : "native",
						description: `${entryId} description`,
						repository: `https://github.com/test/${entryId}`,
						subdir: "",
						commit: "comm1234",
						sourceId: "official-market",
					},
					components,
					issues: isPartial ? [{ level: "warning", message: "broken-mcp is unsupported on this platform" }] : [],
					sourceCommit: "comm1234",
					registryRevision: 1,
				};
				return Promise.resolve(inspection);
			}),
			installPlugin: vi.fn().mockResolvedValue({
				plugin: installedOneDetail,
				registryRevision: 2,
				activation: "applied",
			}),
			listInstalledPlugins: vi.fn().mockResolvedValue({
				installed: [installedOneRecord, installedPendingRecord],
				registryRevision: 1,
			}),
			getInstalledPlugin: vi.fn().mockImplementation(({ pluginId }) => {
				if (pluginId === "installed-pending") return Promise.resolve(installedPendingDetail);
				return Promise.resolve(installedOneDetail);
			}),
			setPluginEnabled: vi.fn().mockImplementation(({ pluginId, enabled }) => {
				return Promise.resolve({
					plugin: {
						...installedOneDetail,
						plugin: {
							...installedOneDetail.plugin,
							enabled,
						},
					},
					registryRevision: 2,
					activation: "applied",
				});
			}),
			inspectPluginUpdate: vi.fn().mockResolvedValue({
				pluginId: "installed-one",
				currentCommit: "aaa11112222333",
				newCommit: "aaa99998888777",
				hasUpdate: true,
				inspection: {
					inspectionId: "insp-update",
					plugin: {
						...installedOneRecord,
						commit: "aaa99998888777",
					},
					components: installedOneDetail.components,
					issues: [],
					sourceCommit: "aaa99998888777",
					registryRevision: 1,
				},
				changes: { skills: 0, mcpServers: 1, hooks: 0 },
			}),
			updatePlugin: vi.fn().mockResolvedValue({
				plugin: {
					...installedOneDetail,
					plugin: {
						...installedOneDetail.plugin,
						commit: "aaa99998888777",
					},
				},
				registryRevision: 3,
				activation: "applied",
			}),
			removePlugin: vi.fn().mockResolvedValue({
				installed: [installedPendingRecord],
				registryRevision: 3,
				activation: "applied",
			}),
			...overrides,
		};
	}

	async function renderPanel(api = createMockApi(), initialSection: PluginSection = "plugins") {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const store = new AppStore();
		store.setSessions({
			sessions: [
				{
					sessionId: "live-session",
					mode: "chat",
					cwdOrigin: "user-selected",
					cwd: "/work/project",
					name: "live-session",
					createdAt: "2026-07-29T00:00:00.000Z",
					updatedAt: "2026-07-29T00:00:00.000Z",
					state: "idle",
					archived: false,
				},
			],
			nextAfterSessionId: null,
		});
		const state = { ...store.getSnapshot(), activeSessionId: "live-session" };

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root.render(
				<PluginsPanel
					api={api}
					initialSection={initialSection}
					onCreateSkillWithMetis={() => {}}
					onSkillsChanged={() => {}}
					preferences={new Map()}
					serverReady={true}
					state={state}
				/>,
			);
		});
		await flush();
		// Secondary flush to resolve catalog load triggered after markets are loaded
		await act(async () => {
			await flush();
		});

		return { api, container };
	}

	it("renders 4th section tab 'Plugins' and switches to it", async () => {
		const { api, container } = await renderPanel(createMockApi(), "skills");

		const sectionSwitch = container.querySelector(".plugins-section-switch");
		expect(sectionSwitch).not.toBeNull();
		const pluginsTab = [...sectionSwitch!.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Plugins"));
		expect(pluginsTab).toBeDefined();

		// Switch to Plugins tab
		await act(async () => pluginsTab!.click());
		await flush();
		await act(async () => {
			await flush();
		});

		expect(api.listPluginMarkets).toHaveBeenCalled();
		expect(api.getPluginCatalog).toHaveBeenCalledWith({ sourceId: "official-market" });
		expect(container.querySelector(".plugins-market-panel")).not.toBeNull();
	});

	it("switches markets with anti-race generation tracking", async () => {
		const api = createMockApi({
			listPluginMarkets: vi.fn().mockResolvedValue({
				markets: [officialMarket, customMarket],
				selectedSourceId: "official-market",
				registryRevision: 1,
			}),
			getPluginCatalog: vi.fn().mockImplementation(async ({ sourceId }) => {
				if (sourceId === "official-market") {
					return { entries: [devToolsCatalog], cacheStatus: "cached" };
				}
				return { entries: [partialCatalog], cacheStatus: "cached" };
			}),
		});

		const { container } = await renderPanel(api, "plugins");

		expect(container.textContent).toContain("Dev Tools");

		// Open market selector dropdown
		const marketTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Marketplace"]');
		expect(marketTrigger).not.toBeNull();
		await act(async () => marketTrigger!.click());
		await flush();

		const customOption = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((el) =>
			el.textContent?.includes("custom-org/plugins"),
		);
		expect(customOption).toBeDefined();
		await act(async () => customOption!.click());
		await flush();
		await act(async () => {
			await flush();
		});

		expect(api.selectPluginMarket).toHaveBeenCalledWith(
			expect.objectContaining({ sourceId: "custom-gh" }),
		);
		expect(api.getPluginCatalog).toHaveBeenCalledWith({ sourceId: "custom-gh" });
		expect(container.textContent).toContain("Partial Tools");
	});

	it("adds a new GitHub market from repo url dialog", async () => {
		const api = createMockApi({
			listPluginMarkets: vi.fn()
				.mockResolvedValueOnce({ markets: [officialMarket], selectedSourceId: "official-market", registryRevision: 1 })
				.mockResolvedValue({ markets: [officialMarket, customMarket], selectedSourceId: "custom-gh", registryRevision: 2 }),
		});

		const { container } = await renderPanel(api, "plugins");

		// Click Add Market button
		const addBtn = button(container, "Add Market");
		await act(async () => addBtn.click());
		await flush();

		const dialog = document.body.querySelector(".plugins-add-market-dialog");
		expect(dialog).not.toBeNull();

		// Fill in repo url
		const input = dialog!.querySelector<HTMLInputElement>("input");
		expect(input).not.toBeNull();
		await act(async () => setInput(input!, "https://github.com/custom-org/plugins"));
		await flush();

		// Submit
		const submitBtn = button(dialog!, "Add");
		await act(async () => submitBtn.click());
		await flush();

		expect(api.addPluginMarket).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://github.com/custom-org/plugins",
			}),
		);
	});

	it("inspects plugin, displays components and issues, and installs with compatible-only option", async () => {
		const api = createMockApi();
		const { container } = await renderPanel(api, "plugins");

		// Catalog should list Partial Tools
		expect(container.textContent).toContain("Partial Tools");

		// Find inspect button for Partial Tools
		const row = [...container.querySelectorAll(".plugins-market-row")].find((el) =>
			el.textContent?.includes("Partial Tools"),
		);
		expect(row).toBeDefined();

		const inspectBtn = button(row!, "Inspect");
		await act(async () => inspectBtn.click());
		await flush();

		expect(api.inspectPlugin).toHaveBeenCalledWith({
			sourceId: "official-market",
			entryId: "partial-tools",
		});

		const dialog = document.body.querySelector(".plugins-inspect-dialog");
		expect(dialog).not.toBeNull();
		expect(dialog!.textContent).toContain("Partial Tools");
		expect(dialog!.textContent).toContain("valid-skill");
		expect(dialog!.textContent).toContain("broken-mcp");
		expect(dialog!.textContent).toContain("broken-mcp is unsupported on this platform");

		// Partial plugin has incompatible components, so "Install Compatible Components" checkbox is present
		const checkbox = dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(checkbox).not.toBeNull();
		expect(checkbox!.checked).toBe(true);

		// Install
		const installBtn = button(dialog!, "Install");
		await act(async () => installBtn.click());
		await flush();

		expect(api.installPlugin).toHaveBeenCalledWith(
			expect.objectContaining({
				inspectionId: "insp-partial-tools",
				allowPartial: true,
			}),
		);
	});

	it("disables install button for completely unsupported plugins", async () => {
		const api = createMockApi();
		const { container } = await renderPanel(api, "plugins");

		const row = [...container.querySelectorAll(".plugins-market-row")].find((el) =>
			el.textContent?.includes("Unsupported Addon"),
		);
		expect(row).toBeDefined();

		const inspectBtn = button(row!, "Inspect");
		await act(async () => inspectBtn.click());
		await flush();

		const dialog = document.body.querySelector(".plugins-inspect-dialog");
		expect(dialog).not.toBeNull();
		expect(dialog!.textContent).toContain("No compatible components can be installed from this plugin.");

		const cannotInstallBtn = button(dialog!, "Cannot Install");
		expect(cannotInstallBtn.disabled).toBe(true);
	});

	it("manages installed plugins: toggles enabled state, checks updates, and uninstalls", async () => {
		const api = createMockApi();
		const { container } = await renderPanel(api, "plugins");

		// Switch to Installed sub-tab
		const installedSubTab = [...container.querySelectorAll(".plugins-sub-tab")].find((el) =>
			el.textContent?.includes("Installed"),
		);
		expect(installedSubTab).toBeDefined();
		await act(async () => installedSubTab!.click());
		await flush();

		expect(api.listInstalledPlugins).toHaveBeenCalled();
		expect(container.textContent).toContain("Installed One");
		expect(container.textContent).toContain("Installed Pending");

		// Toggle enabled state
		const rowOne = [...container.querySelectorAll(".plugins-installed-row")].find((el) =>
			el.textContent?.includes("Installed One"),
		);
		expect(rowOne).toBeDefined();
		const toggleBtn = button(rowOne!, "Disable");
		await act(async () => toggleBtn.click());
		await flush();

		expect(api.setPluginEnabled).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginId: "installed-one",
				enabled: false,
			}),
		);

		// Re-query rowOne after re-render
		const rowOneUpdated = [...container.querySelectorAll(".plugins-installed-row")].find((el) =>
			el.textContent?.includes("Installed One"),
		);
		expect(rowOneUpdated).toBeDefined();

		// Open installed plugin detail via Manage button
		const manageBtn = button(rowOneUpdated!, "Manage");
		await act(async () => manageBtn.click());
		await flush();
		await act(async () => {
			await flush();
		});

		const detailDialog = document.body.querySelector(".plugins-detail-dialog");
		expect(detailDialog).not.toBeNull();
		// Verify activation status badge in detail
		expect(detailDialog!.textContent).toContain("Active");
		expect(detailDialog!.textContent).toContain("Installed Commit");
		expect(detailDialog!.textContent).toContain("aaa1111");
		expect(detailDialog!.textContent).toContain("skill-one");
		expect(detailDialog!.textContent).toContain("mcp-one");
		expect(detailDialog!.textContent).toContain("hook-one");

		// Check for updates
		const checkUpdateBtn = button(detailDialog!, "Check for Updates");
		await act(async () => checkUpdateBtn.click());
		await flush();

		expect(api.inspectPluginUpdate).toHaveBeenCalledWith({
			pluginId: "installed-one",
		});

		// Update dialog should open
		const updateDialog = document.body.querySelector(".plugins-update-dialog");
		expect(updateDialog).not.toBeNull();
		expect(updateDialog!.textContent).toContain("Update commit from aaa1111 to aaa9999");

		// Confirm update
		const confirmUpdateBtn = button(updateDialog!, "Update");
		await act(async () => confirmUpdateBtn.click());
		await flush();

		expect(api.updatePlugin).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginId: "installed-one",
				inspectionId: "insp-update",
				expectedCommit: "aaa11112222333",
			}),
		);

		// Now test uninstall on Installed One from detail dialog
		const uninstallTrigger = button(detailDialog!, "Uninstall");
		await act(async () => uninstallTrigger.click());
		await flush();

		const removeDialog = document.body.querySelector(".plugins-remove-dialog");
		expect(removeDialog).not.toBeNull();
		expect(removeDialog!.textContent).toContain("Uninstall Installed One?");

		// Confirm remove
		const confirmRemoveBtn = button(removeDialog!, "Uninstall");
		await act(async () => confirmRemoveBtn.click());
		await flush();

		expect(api.removePlugin).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginId: "installed-one",
			}),
		);
	});

	it("handles update checks: missing inspection disables update, upToDate shows status without opening dialog", async () => {
		const api = createMockApi({
			inspectPluginUpdate: vi.fn().mockResolvedValue({
				pluginId: "installed-one",
				currentCommit: "aaa11112222333",
				newCommit: "aaa99998888777",
				upToDate: false,
				// inspection intentionally missing
			}),
		});
		const { container } = await renderPanel(api, "plugins");

		// Switch to Installed sub-tab
		const installedSubTab = [...container.querySelectorAll(".plugins-sub-tab")].find((el) =>
			el.textContent?.includes("Installed"),
		);
		await act(async () => installedSubTab!.click());
		await flush();

		// Open Manage dialog
		const rowOne = [...container.querySelectorAll(".plugins-installed-row")].find((el) =>
			el.textContent?.includes("Installed One"),
		);
		const manageBtn = button(rowOne!, "Manage");
		await act(async () => manageBtn.click());
		await flush();

		const detailDialog = document.body.querySelector(".plugins-detail-dialog");
		expect(detailDialog).not.toBeNull();

		// Check updates with missing inspection
		const checkUpdateBtn = button(detailDialog!, "Check for Updates");
		await act(async () => checkUpdateBtn.click());
		await flush();

		const updateDialog = document.body.querySelector(".plugins-update-dialog");
		expect(updateDialog).not.toBeNull();
		// Visible error must be present
		expect(updateDialog!.querySelector(".mcp-dialog-error")?.textContent).toContain("Failed to inspect plugin update");
		// Update button must be disabled
		const updateBtn = button(updateDialog!, "Update");
		expect(updateBtn.disabled).toBe(true);
		expect(api.updatePlugin).not.toHaveBeenCalled();

		// Close update dialog
		const cancelBtn = button(updateDialog!, "Cancel");
		await act(async () => cancelBtn.click());
		await flush();

		// Now simulate upToDate
		(api.inspectPluginUpdate as any).mockResolvedValueOnce({
			pluginId: "installed-one",
			currentCommit: "aaa11112222333",
			upToDate: true,
		});

		await act(async () => checkUpdateBtn.click());
		await flush();

		// Must NOT pop update dialog or "Plugin Update Available" title
		expect(document.body.querySelector(".plugins-update-dialog")).toBeNull();
		expect(document.body.textContent).not.toContain("Plugin Update Available");
		// Must display "Already up to date"
		expect(detailDialog!.textContent).toContain("Already up to date");
		expect(api.updatePlugin).not.toHaveBeenCalled();
	});

	it("renders Chinese translations for enable, disable, version, and not-running without fallback to English", async () => {
		await i18n.changeLanguage("zh-CN");

		const disabledRecord: PluginRecord = {
			...installedOneRecord,
			id: "disabled-plugin",
			name: "disabled-plugin",
			displayName: "Disabled Plugin",
			enabled: false,
		};

		const api = createMockApi({
			listInstalledPlugins: vi.fn().mockResolvedValue({
				installed: [installedOneRecord, disabledRecord],
				registryRevision: 1,
			}),
			getInstalledPlugin: vi.fn().mockImplementation(async ({ pluginId }: { pluginId: string }) => {
				if (pluginId === "disabled-plugin") {
					return {
						plugin: disabledRecord,
						components: [],
						activation: "not-running",
						runtimeErrors: [],
					};
				}
				return installedOneDetail;
			}),
		});

		const { container } = await renderPanel(api, "plugins");

		// Switch to Installed sub-tab
		const installedSubTab = [...container.querySelectorAll(".plugins-sub-tab")].find((el) =>
			el.textContent?.includes("已安装") || el.textContent?.includes("Installed"),
		);
		await act(async () => installedSubTab!.click());
		await flush();

		// Check buttons on rows
		const rowOne = [...container.querySelectorAll(".plugins-installed-row")].find((el) =>
			el.textContent?.includes("Installed One"),
		);
		expect(rowOne).toBeDefined();
		// Row 1 is enabled -> toggle button must say "停用", not "Disable"
		const toggleBtn1 = rowOne!.querySelector(".plugins-toggle-btn");
		expect(toggleBtn1?.textContent).toContain("停用");
		expect(toggleBtn1?.textContent).not.toContain("Disable");

		const rowDisabled = [...container.querySelectorAll(".plugins-installed-row")].find((el) =>
			el.textContent?.includes("Disabled Plugin"),
		);
		expect(rowDisabled).toBeDefined();
		// Row 2 is disabled -> toggle button must say "启用", not "Enable"
		const toggleBtn2 = rowDisabled!.querySelector(".plugins-toggle-btn");
		expect(toggleBtn2?.textContent).toContain("启用");
		expect(toggleBtn2?.textContent).not.toContain("Enable");

		// Open disabled plugin detail dialog (which has activation = "not-running")
		const manageDisabledBtn = rowDisabled!.querySelector(".plugins-inspect-action-btn") as HTMLButtonElement;
		await act(async () => manageDisabledBtn.click());
		await flush();

		const detailDialog = document.body.querySelector(".plugins-detail-dialog");
		expect(detailDialog).not.toBeNull();

		// Detail dialog toggle button must say "启用"
		const detailButtons = Array.from(detailDialog!.querySelectorAll("button"));
		const detailToggleBtn = detailButtons.find((b) => b.textContent?.includes("启用"));
		expect(detailToggleBtn).toBeDefined();
		expect(detailToggleBtn?.textContent).not.toContain("Enable");

		// Status card must show "未运行" for not-running activation
		expect(detailDialog!.textContent).toContain("未运行");
		expect(detailDialog!.textContent).not.toContain("Not Running");
	});

	it("requires allowPartial to enable update when update contains unsupported components, and blocks if all unsupported", async () => {
		const api = createMockApi({
			inspectPluginUpdate: vi.fn().mockResolvedValue({
				pluginId: "installed-one",
				currentCommit: "aaa11112222333",
				newCommit: "aaa99998888777",
				upToDate: false,
				inspection: {
					inspectionId: "insp-partial",
					components: [
						{ componentId: "c1", kind: "skill", displayName: "Skill 1", originalName: "s1", status: "ready" },
						{ componentId: "c2", kind: "unsupported", displayName: "Unsup", originalName: "u", status: "unsupported" },
					],
					issues: [],
					registryRevision: 1,
				},
			}),
		});

		const { container } = await renderPanel(api, "plugins");

		// Switch to Installed sub-tab
		const installedSubTab = [...container.querySelectorAll(".plugins-sub-tab")].find((el) =>
			el.textContent?.includes("Installed"),
		);
		await act(async () => installedSubTab!.click());
		await flush();

		// Open Manage dialog
		const rowOne = [...container.querySelectorAll(".plugins-installed-row")].find((el) =>
			el.textContent?.includes("Installed One"),
		);
		const manageBtn = button(rowOne!, "Manage");
		await act(async () => manageBtn.click());
		await flush();

		const detailDialog = document.body.querySelector(".plugins-detail-dialog");
		const checkUpdateBtn = button(detailDialog!, "Check for Updates");
		await act(async () => checkUpdateBtn.click());
		await flush();

		const updateDialog = document.body.querySelector(".plugins-update-dialog");
		expect(updateDialog).not.toBeNull();

		// Update button must be disabled until allowPartial is checked
		const updateBtn = button(updateDialog!, "Update");
		expect(updateBtn.disabled).toBe(true);

		// Check the allowPartial checkbox
		const checkbox = updateDialog!.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(checkbox).not.toBeNull();
		await act(async () => {
			checkbox.click();
		});
		await flush();

		// Now update button must be enabled
		expect(updateBtn.disabled).toBe(false);

		// Close dialog
		const cancelBtn = button(updateDialog!, "Cancel");
		await act(async () => cancelBtn.click());
		await flush();

		// Now test all unsupported in update
		(api.inspectPluginUpdate as any).mockResolvedValueOnce({
			pluginId: "installed-one",
			currentCommit: "aaa11112222333",
			newCommit: "aaa99998888777",
			upToDate: false,
			inspection: {
				inspectionId: "insp-all-unsup",
				components: [
					{ componentId: "c2", kind: "unsupported", displayName: "Unsup", originalName: "u", status: "unsupported" },
				],
				issues: [],
				registryRevision: 1,
			},
		});

		await act(async () => checkUpdateBtn.click());
		await flush();

		const updateDialog2 = document.body.querySelector(".plugins-update-dialog");
		expect(updateDialog2).not.toBeNull();

		// Must show "Cannot Install" disabled button
		const cannotInstallBtn = button(updateDialog2!, "Cannot Install");
		expect(cannotInstallBtn).not.toBeNull();
		expect(cannotInstallBtn.disabled).toBe(true);
	});
});
