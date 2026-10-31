import type { ClientResult } from "@metis/app-protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MagnifyingGlass, ShieldCheck, X } from "../icons.tsx";
import { trapDialogTab } from "./dialog-focus.ts";
import { MenuSelect } from "./MenuSelect.tsx";

export type RememberedGroups = ClientResult<"permission/rules/catalog">["groups"];
export type RememberedGroup = RememberedGroups[number];
export type RememberedRule = RememberedGroup["rules"][number];

type ScopeFilter = "all" | "project" | "session";
type DecisionFilter = "all" | "allow" | "deny";

export interface RememberedFocus {
	readonly id: string;
	readonly scope?: string;
}

function ruleLabel(rule: RememberedRule): string {
	return rule.command ?? rule.toolName;
}

function ruleHaystack(rule: RememberedRule): string {
	return [
		rule.command ?? "",
		rule.toolName,
		...rule.paths,
		...(rule.details ?? []).flatMap((row) => [row.label, row.value]),
		rule.executionTarget,
	]
		.join(" ")
		.toLocaleLowerCase();
}

function matchingFocusGroup(groups: RememberedGroups, focus: RememberedFocus | undefined): RememberedGroup | undefined {
	if (!focus) return undefined;
	return groups.find(
		(group) =>
			((focus.scope !== "project" && focus.scope !== "session") || group.scope === focus.scope) &&
			group.rules.some((rule) => rule.id === focus.id),
	);
}

/**
 * Focused manager for global remembered grants. Project and live-session grants
 * keep their original owner; revocation always targets the group that produced
 * the row, never the currently selected conversation.
 */
export function RememberedPermissionsDialog({
	busyRuleId,
	error,
	focus,
	groups,
	loading,
	onClose,
	onRetry,
	onRevoke,
}: {
	readonly busyRuleId: string | null;
	readonly error: string | null;
	readonly focus?: RememberedFocus;
	readonly groups: RememberedGroups;
	readonly loading: boolean;
	readonly onClose: () => void;
	readonly onRetry: () => void;
	readonly onRevoke: (group: RememberedGroup, rule: RememberedRule) => void;
}) {
	const { t } = useTranslation();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	// Filters are seeded once from the audit link so the matching group is visible at once.
	const initialFocusGroup = matchingFocusGroup(groups, focus);
	const [project, setProject] = useState(initialFocusGroup?.projectPath ?? "");
	const [scope, setScope] = useState<ScopeFilter>(initialFocusGroup?.scope ?? "all");
	const [decision, setDecision] = useState<DecisionFilter>("all");
	const [search, setSearch] = useState("");
	const [highlightId, setHighlightId] = useState<string | null>(focus?.id ?? null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		searchRef.current?.focus();
		return () => {
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
			if (previous?.isConnected) previous.focus();
		};
	}, []);

	useEffect(() => {
		if (!highlightId || !scrollRef.current) return;
		const row = [...scrollRef.current.querySelectorAll<HTMLElement>("[data-remembered-rule-id]")].find(
			(candidate) => candidate.getAttribute("data-remembered-rule-id") === highlightId,
		);
		if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
		const timer = setTimeout(() => setHighlightId(null), 2_500);
		return () => clearTimeout(timer);
	}, [highlightId]);

	const projectOptions = new Map<string, string>();
	for (const group of groups) projectOptions.set(group.projectPath, group.projectName);
	const needle = search.trim().toLocaleLowerCase();
	const visibleGroups = groups.flatMap((group) => {
		if (project && group.projectPath !== project) return [];
		if (scope !== "all" && group.scope !== scope) return [];
		const rules = group.rules.filter((rule) => {
			if (decision !== "all" && rule.decision !== decision) return false;
			return !needle || ruleHaystack(rule).includes(needle);
		});
		return rules.length ? [{ group, rules }] : [];
	});
	const totalCount = groups.reduce((total, group) => total + group.rules.length, 0);
	const visibleCount = visibleGroups.reduce((total, entry) => total + entry.rules.length, 0);

	return (
		<dialog
			aria-label={t("Remembered permissions")}
			className="model-provider-dialog remembered-permissions-dialog"
			onCancel={(event) => {
				event.preventDefault();
				if (!busyRuleId) onClose();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && !busyRuleId) onClose();
			}}
			onKeyDown={(event) => {
				trapDialogTab(event.nativeEvent, event.currentTarget);
				if (event.key !== "Escape" || event.defaultPrevented) return;
				event.preventDefault();
				if (!busyRuleId) onClose();
			}}
			ref={dialogRef}
		>
			<div className="remembered-permissions">
				<header className="model-provider-editor-header remembered-permissions-header">
					<div>
						<h2>{t("Remembered permissions")}</h2>
						<p>{t("Review or revoke permissions you chose to remember.")}</p>
					</div>
					<button
						aria-label={t("Close")}
						className="model-provider-dialog-close"
						disabled={busyRuleId !== null}
						onClick={onClose}
						type="button"
					>
						<X aria-hidden="true" size={18} />
					</button>
				</header>
				{totalCount > 0 ? (
					<div className="remembered-permissions-toolbar">
						<div className="remembered-permissions-search">
							<MagnifyingGlass aria-hidden="true" size={18} />
							<input
								aria-label={t("Search remembered permissions")}
								onChange={(event) => setSearch(event.target.value)}
								placeholder={t("Search commands, tools, and paths")}
								ref={searchRef}
								type="search"
								value={search}
							/>
						</div>
						<div className="remembered-permissions-filters">
							<MenuSelect
								ariaLabel={t("Project")}
								className="remembered-permissions-project"
								popoverClassName="remembered-project-menu"
								disabled={busyRuleId !== null}
								value={project}
								onChange={setProject}
								options={[
									{ value: "", label: t("All projects") },
									...[...projectOptions].map(([path, name]) => ({
										value: path,
										label: name,
										description: path,
									})),
								]}
							/>
							<MenuSelect<ScopeFilter>
								ariaLabel={t("Scope")}
								disabled={busyRuleId !== null}
								value={scope}
								onChange={setScope}
								options={[
									{ value: "all", label: t("All scopes") },
									{ value: "project", label: t("Project") },
									{ value: "session", label: t("Session") },
								]}
							/>
							<MenuSelect<DecisionFilter>
								ariaLabel={t("Decision")}
								disabled={busyRuleId !== null}
								value={decision}
								onChange={setDecision}
								options={[
									{ value: "all", label: t("All decisions") },
									{ value: "allow", label: t("Allow") },
									{ value: "deny", label: t("Deny") },
								]}
							/>
						</div>
					</div>
				) : null}
				{error ? (
					<div className="remembered-permissions-error">
						<p className="settings-inline-error" role="alert">
							{error}
						</p>
						<button className="settings-secondary-button" disabled={loading} onClick={onRetry} type="button">
							{t("Retry")}
						</button>
					</div>
				) : null}
				<div className="remembered-permissions-scroll" ref={scrollRef}>
					{loading && groups.length === 0 ? (
						<output aria-label={t("Loading remembered permissions")} className="status-block settings-loading" />
					) : visibleGroups.length === 0 ? (
						<div className="remembered-permissions-empty">
							<ShieldCheck aria-hidden="true" size={28} />
							<strong>
								{totalCount === 0
									? t("No remembered permissions yet.")
									: t("No permissions match these filters.")}
							</strong>
							<p>
								{totalCount === 0
									? t("Permissions you choose to remember will appear here.")
									: t("Try a different search or filter.")}
							</p>
						</div>
					) : (
						visibleGroups.map(({ group, rules }) => (
							<section
								className="remembered-group"
								key={`${group.scope}:${group.projectPath}:${group.sessionId ?? ""}`}
							>
								<header className="remembered-group-header">
									<h3 title={group.projectPath}>{group.projectName}</h3>
									<span className="remembered-group-scope">
										{group.scope === "project" ? t("Project") : t("Session")}
									</span>
									{group.scope === "session" ? (
										<span className="remembered-group-session">
											{group.sessionTitle ?? t("Live session")}
										</span>
									) : null}
									<span className="permission-scope-count">{rules.length}</span>
								</header>
								<ul className="remembered-rule-list">
									{rules.map((rule) => {
										const label = ruleLabel(rule);
										const allow = rule.decision === "allow";
										return (
											<li
												className={`remembered-rule-row ${highlightId === rule.id ? "is-focused" : ""}`}
												data-remembered-rule-id={rule.id}
												key={rule.id}
											>
												<div className="remembered-rule-main">
													<div className="remembered-rule-title">
														<code>{label}</code>
														<span className={`permission-rule-badge ${rule.decision}`}>
															{allow ? t("Allow") : t("Deny")}
														</span>
													</div>
													<details className="remembered-rule-details">
														<summary>{t("Details")}</summary>
														<dl>
															{rule.paths.length ? (
																<div>
																	<dt>{t("Paths")}</dt>
																	<dd>
																		{rule.paths.map((path) => (
																			<code key={path}>{path}</code>
																		))}
																	</dd>
																</div>
															) : null}
															{rule.details
																.filter((row) => row.label !== "Command")
																.map((row) => (
																	<div key={`${rule.id}-${row.label}`}>
																		<dt>{row.label}</dt>
																		<dd>{row.value}</dd>
																	</div>
																))}
															<div>
																<dt>{t("Execution")}</dt>
																<dd>{rule.executionTarget}</dd>
															</div>
															<div>
																<dt>{t("Recorded")}</dt>
																<dd>{rule.createdAt}</dd>
															</div>
														</dl>
													</details>
												</div>
												<button
													aria-label={t("Revoke {{name}}", { name: label })}
													className="settings-secondary-button"
													disabled={busyRuleId !== null}
													onClick={() => onRevoke(group, rule)}
													type="button"
												>
													{busyRuleId === rule.id ? t("Revoking…") : t("Revoke")}
												</button>
											</li>
										);
									})}
								</ul>
							</section>
						))
					)}
				</div>
				{totalCount > 0 ? (
					<footer className="remembered-permissions-footer">
						<span>{t("Remembered: {{count}}", { count: visibleCount })}</span>
					</footer>
				) : null}
			</div>
		</dialog>
	);
}
