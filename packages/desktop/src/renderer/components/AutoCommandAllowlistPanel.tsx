import type { ClientResult, PermissionRuleView } from "@metis/app-protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { DotsThree, MagnifyingGlass, Plus, Trash } from "../icons.tsx";
import { PermissionRuleDialog, type RestoreDefaultEntry, RestoreDefaultsDialog } from "./PermissionRuleDialog.tsx";
import {
	applyDefaultRestore,
	enabledRuleCount,
	filterRules,
	isCommandRule,
	MAX_PERMISSION_RULES,
	MAX_USER_PERMISSION_RULES,
	type PermissionScopePreview,
	permissionRuleInput,
	restorableDefaults,
	ruleDisplayName,
	ruleModesText,
	userRuleCount,
} from "./permission-rule-presentation.ts";
import { FloatingSystemNotice } from "./SystemNotice.tsx";
import { WorkspaceTabMenu, type WorkspaceTabMenuItem } from "./WorkspaceTabMenu.tsx";

type AutoView = ClientResult<"permission/auto/get">;

interface RuleMenu {
	readonly anchor: HTMLElement;
	readonly ariaLabel: string;
	readonly items: readonly WorkspaceTabMenuItem[];
}

interface PendingUndo {
	readonly rule: PermissionRuleView;
	readonly index: number;
}

const UNDO_WINDOW_MS = 6_000;

/**
 * Global command rule manager. Non-command records stay in every save payload but
 * are intentionally not rendered or edited here.
 */
export function AutoCommandAllowlistPanel({
	api,
	embedded = false,
	focusRuleId,
	scopePreview,
	serverReady,
}: {
	readonly api: Pick<MetisDesktopApi, "getPermissionAutoSettings" | "updatePermissionAutoSettings">;
	readonly embedded?: boolean;
	readonly focusRuleId?: string;
	readonly scopePreview?: PermissionScopePreview;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [view, setView] = useState<AutoView | null>(null);
	const [loadRequest, setLoadRequest] = useState(0);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [savingId, setSavingId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [editor, setEditor] = useState<PermissionRuleView | "new" | null>(null);
	const [restoreEntries, setRestoreEntries] = useState<readonly RestoreDefaultEntry[] | null>(null);
	const [menu, setMenu] = useState<RuleMenu | null>(null);
	const [highlightId, setHighlightId] = useState<string | null>(null);
	const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
	const appliedFocusRef = useRef<string | null>(null);
	const cardMenuAnchor = useRef<HTMLButtonElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies(loadRequest): Retry explicitly reloads the rule list.
	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setLoadError(null);
		void api.getPermissionAutoSettings().then(
			(result) => {
				if (current) setView(result);
			},
			(cause) => {
				if (current) setLoadError(cause instanceof Error ? cause.message : t("Couldn’t load permission rules."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, loadRequest, serverReady, t]);

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), 2_500);
		return () => clearTimeout(timer);
	}, [notice]);

	useEffect(() => {
		if (pendingUndo === null) return;
		const timer = setTimeout(() => setPendingUndo(null), UNDO_WINDOW_MS);
		return () => clearTimeout(timer);
	}, [pendingUndo]);

	const rules = view?.permissionRules ?? [];
	const defaults = view?.permissionRuleDefaults ?? [];
	const commandRules = useMemo(() => rules.filter(isCommandRule), [rules]);
	const commandDefaults = useMemo(() => defaults.filter(isCommandRule), [defaults]);
	const focusedToolRule = rules.find((rule) => rule.id === focusRuleId && !isCommandRule(rule));
	const busy = savingId !== null;
	const displayName = (rule: PermissionRuleView) => ruleDisplayName(rule, t);

	useEffect(() => {
		if (!focusRuleId || !view || appliedFocusRef.current === focusRuleId) return;
		const rule = (view.permissionRules ?? []).find(
			(candidate) => candidate.id === focusRuleId && isCommandRule(candidate),
		);
		if (!rule) return;
		appliedFocusRef.current = focusRuleId;
		setSearch("");
		setHighlightId(focusRuleId);
		const timer = setTimeout(() => setHighlightId(null), 2_500);
		return () => clearTimeout(timer);
	}, [focusRuleId, view]);

	const filtered = filterRules(commandRules, search, displayName);
	const users = userRuleCount(rules);
	const nearCapacity = users >= MAX_USER_PERMISSION_RULES - 4;

	// Keep the focused row visible inside the bounded scroll region, not the whole page.
	useEffect(() => {
		if (!highlightId || !scrollRef.current) return;
		const row = [...scrollRef.current.querySelectorAll<HTMLElement>("[data-rule-id]")].find(
			(candidate) => candidate.getAttribute("data-rule-id") === highlightId,
		);
		if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
	}, [highlightId]);

	const mutate = async (
		nextRules: readonly PermissionRuleView[],
		busyKey: string,
		successMessage: string | null,
	): Promise<boolean> => {
		if (!view) return false;
		setSavingId(busyKey);
		setSaveError(null);
		try {
			const next = await api.updatePermissionAutoSettings({
				requestId: crypto.randomUUID(),
				permissionRules: nextRules.map(permissionRuleInput),
			});
			setView(next);
			if (successMessage) setNotice(successMessage);
			return true;
		} catch (cause) {
			setSaveError(cause instanceof Error ? cause.message : t("Permission rules could not be saved."));
			return false;
		} finally {
			setSavingId(null);
		}
	};

	const deleteRule = async (rule: PermissionRuleView) => {
		if (busy || !serverReady) return;
		const index = rules.findIndex((candidate) => candidate.id === rule.id);
		const deleted = await mutate(
			rules.filter((candidate) => candidate.id !== rule.id),
			rule.id,
			null,
		);
		if (deleted) {
			setNotice(null);
			setPendingUndo({ rule, index });
		}
	};

	const undoDelete = async () => {
		if (!pendingUndo || busy || !serverReady) return;
		const current = view?.permissionRules ?? [];
		if (current.some((candidate) => candidate.id === pendingUndo.rule.id)) {
			setPendingUndo(null);
			return;
		}
		const next = [...current];
		next.splice(Math.min(Math.max(pendingUndo.index, 0), next.length), 0, pendingUndo.rule);
		const restored = await mutate(next, "undo", t("Rule restored."));
		if (restored) setPendingUndo(null);
	};

	const openRestore = () => {
		setSaveError(null);
		const restorable = restorableDefaults(commandDefaults, rules);
		setRestoreEntries(
			restorable.map((entry) => ({
				id: entry.rule.id,
				name: ruleDisplayName(entry.rule, t),
				state: entry.state,
				selected: entry.defaultSelected,
			})),
		);
	};

	const confirmRestore = async () => {
		if (!restoreEntries || busy) return;
		const selectedIds = new Set(restoreEntries.filter((entry) => entry.selected).map((entry) => entry.id));
		const next = applyDefaultRestore(rules, commandDefaults, selectedIds);
		const restored = await mutate(next, "restore", t("Default rules restored."));
		if (restored) setRestoreEntries(null);
	};

	const saveRule = async (rule: PermissionRuleView): Promise<boolean> => {
		const next = rules.some((candidate) => candidate.id === rule.id)
			? rules.map((candidate) => (candidate.id === rule.id ? rule : candidate))
			: [...rules, rule];
		if (next.length > MAX_PERMISSION_RULES) {
			setSaveError(t("The rule list can hold at most {{max}} rules.", { max: MAX_PERMISSION_RULES }));
			return false;
		}
		const saved = await mutate(next, rule.id, t("Rule saved."));
		if (saved) setEditor(null);
		return saved;
	};

	const openEditor = (rule: PermissionRuleView) => {
		if (rule.support !== "supported" || busy || !serverReady) return;
		setSaveError(null);
		setEditor(rule);
	};

	return (
		<section
			className={
				embedded
					? "settings-section auto-command-allowlist-section permission-rules-section"
					: "settings-page auto-command-allowlist-page permission-rules-section"
			}
		>
			<div className="settings-section-heading permission-rules-heading">
				<div>
					<h3>{t("Allowed commands")}</h3>
					<p>
						{t(
							"Matching commands run automatically in Ask and Auto. Full mode ignores these rules; sensitive actions still need confirmation.",
						)}
					</p>
				</div>
				{view ? (
					<span className="auto-command-allowlist-count">
						{t("{{count}} enabled", { count: enabledRuleCount(commandRules) })}
					</span>
				) : null}
			</div>
			{focusedToolRule ? (
				<output className="settings-helper">
					{t("{{name}} is a tool permission. This list manages command rules.", {
						name: displayName(focusedToolRule),
					})}
				</output>
			) : null}
			{nearCapacity ? (
				<p className="permission-rules-capacity">
					{t("{{count}} of {{max}} custom rules used", { count: users, max: MAX_USER_PERMISSION_RULES })}
				</p>
			) : null}
			{loadError ? (
				<>
					<p className="settings-inline-error" role="alert">
						{loadError}
					</p>
					<button
						className="settings-secondary-button"
						disabled={!serverReady}
						onClick={() => {
							setLoadError(null);
							setLoadRequest((request) => request + 1);
						}}
						type="button"
					>
						{t("Retry")}
					</button>
				</>
			) : null}
			{!view && !loadError ? (
				<output aria-label={t("Loading permission rules")} className="status-block settings-loading" />
			) : null}
			{view ? (
				<div className="settings-card permission-rules-card">
					<div className="permission-rules-toolbar">
						<div className="permission-rules-search">
							<MagnifyingGlass aria-hidden="true" size={15} />
							<input
								aria-label={t("Search commands")}
								onChange={(event) => setSearch(event.target.value)}
								placeholder={t("Search commands and directories")}
								type="search"
								value={search}
							/>
						</div>
						<button
							className="settings-primary-button"
							disabled={!serverReady || busy}
							onClick={() => {
								setSaveError(null);
								setEditor("new");
							}}
							type="button"
						>
							<Plus aria-hidden="true" size={14} />
							{t("Add command")}
						</button>
						<button
							aria-label={t("Rule list actions")}
							className="permission-rules-menu-button"
							disabled={!serverReady || busy}
							onClick={() =>
								cardMenuAnchor.current &&
								setMenu({
									anchor: cardMenuAnchor.current,
									ariaLabel: t("Rule list actions"),
									items: [
										{
											key: "restore",
											label: t("Restore default rules"),
											onSelect: openRestore,
										},
									],
								})
							}
							ref={cardMenuAnchor}
							type="button"
						>
							<DotsThree aria-hidden="true" size={18} />
						</button>
					</div>
					{saveError ? (
						<p className="settings-inline-error permission-rules-error" role="alert">
							{saveError}
						</p>
					) : null}
					<div className="permission-rules-scroll" ref={scrollRef}>
						{filtered.length === 0 ? (
							<p className="permission-rule-empty permission-rules-empty">
								{search ? t("No commands match your search.") : t("No command rules yet.")}
							</p>
						) : (
							<ul aria-label={t("Permission rules")} className="permission-rules-list">
								{filtered.map((rule) => {
									const unsupported = rule.support !== "supported";
									const name = displayName(rule);
									return (
										<li
											className={`permission-rule-row permission-rules-row ${highlightId === rule.id ? "is-focused" : ""}`}
											data-rule-id={rule.id}
											key={rule.id}
										>
											<button
												aria-label={t("Edit {{name}}", { name })}
												className="permission-rule-edit"
												disabled={unsupported || busy || !serverReady}
												onClick={() => openEditor(rule)}
												title={
													unsupported
														? (rule.supportReason ?? t("This rule cannot run automatically right now."))
														: t("Edit rule")
												}
												type="button"
											>
												<code>{name}</code>
											</button>
											{!rule.enabled ? (
												<span className="permission-rule-disabled">{t("Disabled")}</span>
											) : null}
											{unsupported ? (
												<span className="permission-rule-support" title={rule.supportReason}>
													{t("Not supported yet")}
												</span>
											) : null}
											<span className="permission-rule-mode">{ruleModesText(rule)}</span>
											{rule.scope === "directories" ? (
												<span className="permission-rule-directory" title={rule.directories.join("\n")}>
													{t("Directories ({{count}})", { count: rule.directories.length })}
												</span>
											) : null}
											<button
												aria-label={t("Delete {{name}}", { name })}
												className="permission-rule-delete"
												disabled={busy || !serverReady}
												onClick={() => void deleteRule(rule)}
												title={t("Delete rule")}
												type="button"
											>
												<Trash aria-hidden="true" size={15} />
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
					<p className="permission-rules-note">
						{t("Sensitive and dangerous actions always need confirmation or stay blocked.")}
					</p>
				</div>
			) : null}
			{menu ? (
				<WorkspaceTabMenu
					anchor={{ kind: "element", element: menu.anchor }}
					ariaLabel={menu.ariaLabel}
					items={menu.items}
					onClose={() => setMenu(null)}
					restoreFocusTo={menu.anchor}
					portalContainer={menu.anchor.closest<HTMLElement>(".settings-dialog") ?? undefined}
				/>
			) : null}
			{editor ? (
				<PermissionRuleDialog
					busy={busy}
					error={saveError}
					key={editor === "new" ? "new" : editor.id}
					kind={editor === "new" ? "command" : editor.kind}
					onCancel={() => {
						setEditor(null);
						setSaveError(null);
					}}
					onSave={saveRule}
					rule={editor === "new" ? null : editor}
					hasConversation={false}
					scopePreview={scopePreview}
					serverReady={serverReady}
					userRuleCount={users}
				/>
			) : null}
			{restoreEntries ? (
				<RestoreDefaultsDialog
					busy={busy}
					entries={restoreEntries}
					error={saveError}
					onCancel={() => {
						setRestoreEntries(null);
						setSaveError(null);
					}}
					onConfirm={() => void confirmRestore()}
					onToggle={(id, selected) =>
						setRestoreEntries(restoreEntries.map((entry) => (entry.id === id ? { ...entry, selected } : entry)))
					}
				/>
			) : null}
			{pendingUndo ? (
				<FloatingSystemNotice
					action={{ label: t("Undo"), onClick: () => void undoDelete() }}
					onDismiss={() => setPendingUndo(null)}
					title={t("Rule deleted.")}
					tone="info"
				/>
			) : notice ? (
				<FloatingSystemNotice title={notice} tone="success" />
			) : null}
		</section>
	);
}
