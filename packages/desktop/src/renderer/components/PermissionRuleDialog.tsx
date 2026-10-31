import type { PermissionRuleView } from "@metis/app-protocol";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "../icons.tsx";
import { trapDialogTab } from "./dialog-focus.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import {
	MAX_USER_PERMISSION_RULES,
	type PermissionScopePreview,
	ruleScopeNote,
	ruleScopeText,
	scopeRangeEntries,
} from "./permission-rule-presentation.ts";

type RuleKind = PermissionRuleView["kind"];
type RuleMode = PermissionRuleView["modes"][number];
type RuleScope = PermissionRuleView["scope"];
type NetworkTarget = NonNullable<PermissionRuleView["networkTargets"]>[number];

interface TargetDraft {
	readonly key: string;
	readonly hostname: string;
	readonly port: string;
}

interface RuleDraft {
	readonly command: string;
	readonly enabled: boolean;
	readonly modes: readonly RuleMode[];
	readonly scope: RuleScope;
	readonly directories: string;
	readonly allowNetwork: boolean;
	readonly targets: readonly TargetDraft[];
}

const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function isValidHostname(value: string): boolean {
	const hostname = value.trim();
	if (!hostname || hostname.length > 253 || !HOSTNAME_PATTERN.test(hostname)) return false;
	return hostname.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

function parsePort(value: string): number | null {
	if (!/^\d{1,5}$/.test(value.trim())) return null;
	const port = Number(value.trim());
	return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function scopeChoices(kind: RuleKind, current: RuleScope): readonly RuleScope[] {
	if (kind === "compatibility") return [current];
	if (kind === "command") return ["workspace", "directories"];
	// Shell and script rules are bound to the analyzed workspace, not arbitrary directories.
	return ["workspace"];
}

function scopeLabel(scope: RuleScope, t: (key: string) => string): string {
	switch (scope) {
		case "workspace":
			return t("Current workspace");
		case "directories":
			return t("Selected directories");
		case "memory":
			return t("Metis memory");
		case "session":
			return t("Current session");
		case "declared":
			return t("Existing tool scope");
		case "all":
			return t("All ordinary paths (existing rule)");
	}
}

function baseDraft(rule: PermissionRuleView | null): RuleDraft {
	if (!rule) {
		return {
			command: "",
			enabled: true,
			modes: ["auto"],
			scope: "workspace",
			directories: "",
			allowNetwork: false,
			targets: [],
		};
	}
	return {
		command: rule.command ?? "",
		enabled: rule.enabled,
		modes: rule.modes,
		scope: rule.scope,
		directories: rule.directories.join("\n"),
		allowNetwork: rule.allowNetwork,
		targets: (rule.networkTargets ?? []).map((target) => ({
			key: crypto.randomUUID(),
			hostname: target.hostname,
			port: String(target.port),
		})),
	};
}

function fixedConditions(kind: RuleKind, t: (key: string) => string): readonly string[] {
	switch (kind) {
		case "command":
			return [
				t("Matches by argv prefix, not any substring of the full Shell text."),
				t("Only fully analyzed read-only commands match this rule."),
				t("Sensitive files, writes, network access, and unknown options still need your approval."),
			];
		case "shell":
			return [
				t("Only commands the Shell analyzer can fully explain match this rule."),
				t("Deletions, writes, and network access are never granted by a Shell rule."),
			];
		case "script":
			return [
				t("Only literal inline scripts with the supported flags match this rule."),
				t("Script files, dynamic execution, writes, and network access are not granted."),
			];
		case "tool":
			return [
				t("Matches the real built-in tool, not only a tool with the same name."),
				t("Write access never covers protected or read-only paths."),
			];
		case "compatibility":
			return [
				t("Keeps the existing tool permission and its execution environment."),
				t("Disabling or deleting this rule removes only this direct allowance."),
			];
	}
}

/**
 * One focused editor for command rules. Existing default rules keep their curated
 * command prefix; users can only tune modes and explicit directory constraints,
 * so editing a default never widens the argv match.
 */
export function PermissionRuleDialog({
	busy,
	error,
	hasConversation = true,
	kind,
	onCancel,
	onSave,
	rule,
	scopePreview,
	serverReady,
	userRuleCount,
}: {
	readonly busy: boolean;
	readonly error: string | null;
	readonly hasConversation?: boolean;
	readonly kind: RuleKind;
	readonly onCancel: () => void;
	readonly onSave: (rule: PermissionRuleView) => Promise<boolean>;
	readonly rule: PermissionRuleView | null;
	readonly scopePreview?: PermissionScopePreview;
	readonly serverReady: boolean;
	readonly userRuleCount: number;
}) {
	const { t } = useTranslation();
	const fieldId = useId();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [draft, setDraft] = useState<RuleDraft>(() => baseDraft(rule));
	const [validation, setValidation] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const working = busy || submitting;

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		dialog
			.querySelector<HTMLInputElement | HTMLButtonElement>("input:not(:disabled), button:not(:disabled)")
			?.focus();
		return () => {
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
			if (previous?.isConnected) previous.focus();
		};
	}, []);

	const isCommand = kind === "command" || kind === "shell" || kind === "script";
	const showsCommand = isCommand || (kind === "compatibility" && Boolean(rule?.command));
	const commandEditable = rule === null || rule.origin === "user";
	// Existing tool rules may carry exact network targets; compatibility rules keep their
	// original policy and never gain editable network fields here.
	const supportsNetwork =
		kind !== "compatibility" && (isCommand || Boolean(rule?.allowNetwork) || (rule?.networkTargets?.length ?? 0) > 0);
	// Command rules only ever apply in Auto; compatibility keeps its curated ceiling.
	const allowedModes: readonly RuleMode[] =
		kind === "compatibility" && rule?.id !== "E04" ? ["ask", "auto"] : ["auto"];
	const scopes = scopeChoices(kind, draft.scope);
	const draftDirectories = draft.directories
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const rangeEntries = scopeRangeEntries(
		{
			kind,
			toolName: rule?.toolName,
			scope: draft.scope,
			directories: draftDirectories,
			hasConversation,
			preview: scopePreview,
		},
		t,
	);
	const compatibilityNote = kind === "compatibility" && rule ? ruleScopeText(rule, t, hasConversation) : null;

	const validate = (): string | null => {
		if (isCommand && !draft.command.trim()) return t("Enter a command prefix.");
		if (draft.modes.length === 0) return t("Choose at least one mode.");
		if (draft.scope === "directories") {
			if (draftDirectories.length === 0) return t("Enter at least one absolute directory.");
			if (draftDirectories.some((directory) => !directory.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(directory))) {
				return t("Directories must be absolute paths.");
			}
		}
		if (supportsNetwork && draft.allowNetwork) {
			if (draft.targets.length === 0) return t("Add an exact hostname and port for every network target.");
			for (const target of draft.targets) {
				if (!isValidHostname(target.hostname) || parsePort(target.port) === null) {
					return t("Network rules need an exact hostname and port for every destination.");
				}
			}
		}
		if (!rule && userRuleCount >= MAX_USER_PERMISSION_RULES) {
			return t("You can add at most {{max}} custom rules.", { max: MAX_USER_PERMISSION_RULES });
		}
		return null;
	};

	const save = async () => {
		if (working) return;
		const message = validate();
		if (message) {
			setValidation(message);
			return;
		}
		setValidation(null);
		const networkTargets: NetworkTarget[] = draft.targets.map((target) => ({
			hostname: target.hostname.trim(),
			port: parsePort(target.port)!,
		}));
		const command = draft.command.trim().replace(/\s+/g, " ");
		const payload: PermissionRuleView = {
			id: rule?.id ?? `user-${crypto.randomUUID()}`,
			kind: rule?.kind ?? kind,
			origin: rule?.origin ?? "user",
			// Default rules keep their curated name and command identity.
			name: rule ? (rule.origin === "default" ? rule.name : isCommand ? command : rule.name) : command,
			enabled: draft.enabled,
			modes: [...draft.modes],
			scope: draft.scope,
			directories: draft.scope === "directories" ? draftDirectories : [...(rule?.directories ?? [])],
			...(isCommand ? { command } : rule?.command ? { command: rule.command } : {}),
			...(rule?.toolName ? { toolName: rule.toolName } : {}),
			allowNetwork: supportsNetwork ? draft.allowNetwork : Boolean(rule?.allowNetwork),
			...(supportsNetwork
				? draft.allowNetwork
					? { networkTargets }
					: {}
				: rule?.networkTargets
					? { networkTargets: rule.networkTargets.map((target) => ({ ...target })) }
					: {}),
			support: rule?.support ?? "supported",
			...(rule?.supportReason ? { supportReason: rule.supportReason } : {}),
		};
		setSubmitting(true);
		try {
			await onSave(payload);
		} finally {
			setSubmitting(false);
		}
	};

	const toggleMode = (mode: RuleMode, checked: boolean) => {
		const modes = checked ? [...draft.modes, mode] : draft.modes.filter((candidate) => candidate !== mode);
		setDraft({ ...draft, modes });
	};

	const updateTarget = (key: string, patch: Partial<Omit<TargetDraft, "key">>) => {
		setDraft({
			...draft,
			targets: draft.targets.map((target) => (target.key === key ? { ...target, ...patch } : target)),
		});
	};

	const title = rule ? t("Edit rule") : t("Add command");
	const errorMessage = validation ?? error;

	return (
		<dialog
			aria-label={title}
			className="model-provider-dialog permission-rule-dialog"
			onCancel={(event) => {
				event.preventDefault();
				if (!working) onCancel();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && !working) onCancel();
			}}
			onKeyDown={(event) => {
				trapDialogTab(event.nativeEvent, event.currentTarget);
				if (event.key !== "Escape" || event.defaultPrevented) return;
				event.preventDefault();
				if (!working) onCancel();
			}}
			ref={dialogRef}
		>
			<div className="model-provider-dialog-content">
				<form
					className="model-provider-editor"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<header className="model-provider-editor-header">
						<div>
							<h2>{title}</h2>
							<p>
								{t(
									"Rules decide which commands can run without asking. Full mode always runs with full access.",
								)}
							</p>
						</div>
						<button
							aria-label={t("Close")}
							className="model-provider-dialog-close"
							disabled={working}
							onClick={onCancel}
							type="button"
						>
							<X aria-hidden="true" size={18} />
						</button>
					</header>
					<div className="model-provider-editor-body">
						{showsCommand ? (
							commandEditable ? (
								<label className="permission-rule-field">
									<span>{t("Command or argument prefix")}</span>
									<input
										autoComplete="off"
										disabled={working}
										onChange={(event) => setDraft({ ...draft, command: event.target.value })}
										placeholder="git status"
										type="text"
										value={draft.command}
									/>
									<small>
										{t("Matched by argv prefix; for example, git status does not allow git push.")}
									</small>
								</label>
							) : (
								<div className="permission-rule-field">
									<span>{t("Command or argument prefix")}</span>
									<p className="permission-rule-static">
										<code>{draft.command}</code>
									</p>
									<small>{t("Default commands keep their exact matching prefix.")}</small>
								</div>
							)
						) : null}
						<details
							className="permission-rule-advanced"
							onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
							open={advancedOpen}
						>
							<summary>{t("Advanced options")}</summary>
							<div className="permission-rule-advanced-body">
								<label className="permission-rule-check">
									<input
										checked={draft.enabled}
										disabled={working}
										onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
										type="checkbox"
									/>
									<span>{t("Enable rule")}</span>
								</label>
								<fieldset className="permission-rule-fieldset">
									<legend>{t("Applies in")}</legend>
									<label className="permission-rule-check">
										<input
											checked={draft.modes.includes("ask")}
											disabled={working || !allowedModes.includes("ask")}
											onChange={(event) => toggleMode("ask", event.target.checked)}
											type="checkbox"
										/>
										<span>Ask</span>
									</label>
									<label className="permission-rule-check">
										<input
											checked={draft.modes.includes("auto")}
											disabled={working || !allowedModes.includes("auto")}
											onChange={(event) => toggleMode("auto", event.target.checked)}
											type="checkbox"
										/>
										<span>Auto</span>
									</label>
									<span className="permission-rule-field-note">
										{t("Full always runs with full access and is not a rule mode.")}
									</span>
								</fieldset>
								{kind === "compatibility" ? (
									<div className="permission-rule-field">
										<span>{t("Existing scope")}</span>
										<p className="permission-rule-scope-value">{compatibilityNote}</p>
										{rule ? <p className="permission-rule-scope-note">{ruleScopeNote(rule, t)}</p> : null}
									</div>
								) : null}
								{kind !== "compatibility" ? (
									<label className="permission-rule-field" htmlFor={`${fieldId}-scope`}>
										<span>{t("File scope")}</span>
										<MenuSelect
											ariaLabel={t("File scope")}
											disabled={working || scopes.length === 1}
											id={`${fieldId}-scope`}
											onChange={(scope) => setDraft({ ...draft, scope })}
											options={scopes.map((scope) => ({ value: scope, label: scopeLabel(scope, t) }))}
											value={draft.scope}
										/>
									</label>
								) : null}
								{rangeEntries.length ? (
									<p className="permission-rule-scope-paths">
										{rangeEntries.map((entry) => `${entry.label}: ${entry.path}`).join(" · ")}
									</p>
								) : null}
								{draft.scope === "directories" ? (
									<label className="permission-rule-field">
										<span>{t("Directories")}</span>
										<textarea
											disabled={working}
											onChange={(event) => setDraft({ ...draft, directories: event.target.value })}
											placeholder={"/Users/you/project"}
											rows={3}
											value={draft.directories}
										/>
										<small>
											{t(
												"One absolute directory per line. Rules never make read-only directories writable.",
											)}
										</small>
									</label>
								) : null}
								{supportsNetwork ? (
									<fieldset className="permission-rule-fieldset">
										<legend>{t("Network")}</legend>
										<label className="permission-rule-check">
											<input
												checked={draft.allowNetwork}
												disabled={working}
												onChange={(event) => setDraft({ ...draft, allowNetwork: event.target.checked })}
												type="checkbox"
											/>
											<span>{t("Allow exact network destinations")}</span>
										</label>
										{draft.allowNetwork ? (
											<div className="permission-rule-targets">
												{draft.targets.map((target) => (
													<div className="permission-rule-target" key={target.key}>
														<input
															aria-label={t("Hostname")}
															disabled={working}
															onChange={(event) =>
																updateTarget(target.key, { hostname: event.target.value })
															}
															placeholder="api.example.com"
															type="text"
															value={target.hostname}
														/>
														<input
															aria-label={t("Port")}
															disabled={working}
															onChange={(event) =>
																updateTarget(target.key, { port: event.target.value })
															}
															placeholder="443"
															type="text"
															value={target.port}
														/>
														<button
															aria-label={t("Remove destination")}
															className="permission-rule-target-remove"
															disabled={working}
															onClick={() =>
																setDraft({
																	...draft,
																	targets: draft.targets.filter(
																		(candidate) => candidate.key !== target.key,
																	),
																})
															}
															type="button"
														>
															<X aria-hidden="true" size={14} />
														</button>
													</div>
												))}
												<button
													className="settings-secondary-button"
													disabled={working}
													onClick={() =>
														setDraft({
															...draft,
															targets: [
																...draft.targets,
																{ key: crypto.randomUUID(), hostname: "", port: "" },
															],
														})
													}
													type="button"
												>
													<Plus aria-hidden="true" size={13} />
													{t("Add destination")}
												</button>
												<small>{t("Only these exact hostname and port pairs are allowed.")}</small>
											</div>
										) : null}
									</fieldset>
								) : null}
								<div className="permission-rule-fixed">
									<span>{t("Fixed conditions")}</span>
									<ul>
										{fixedConditions(kind, t).map((condition) => (
											<li key={condition}>{condition}</li>
										))}
									</ul>
								</div>
							</div>
						</details>
					</div>
					<footer className="model-provider-editor-footer">
						{errorMessage ? (
							<p className="settings-action-message error" role="alert">
								{errorMessage}
							</p>
						) : null}
						<div className="settings-form-actions">
							<button className="settings-secondary-button" disabled={working} onClick={onCancel} type="button">
								{t("Cancel")}
							</button>
							<button className="settings-primary-button" disabled={working || !serverReady} type="submit">
								{submitting ? t("Saving…") : t("Save rule")}
							</button>
						</div>
					</footer>
				</form>
			</div>
		</dialog>
	);
}

export interface RestoreDefaultEntry {
	readonly id: string;
	readonly name: string;
	readonly state: "missing" | "disabled" | "modified";
	readonly selected: boolean;
}

export function RestoreDefaultsDialog({
	busy,
	entries,
	error,
	onCancel,
	onConfirm,
	onToggle,
}: {
	readonly busy: boolean;
	readonly entries: readonly RestoreDefaultEntry[];
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
	readonly onToggle: (id: string, selected: boolean) => void;
}) {
	const { t } = useTranslation();
	const dialogRef = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		dialog.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
		return () => {
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
			if (previous?.isConnected) previous.focus();
		};
	}, []);
	const selectedCount = entries.filter((entry) => entry.selected).length;
	return (
		<dialog
			aria-label={t("Restore default rules")}
			className="model-provider-dialog permission-rule-confirm-dialog"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onCancel();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
			onKeyDown={(event) => {
				trapDialogTab(event.nativeEvent, event.currentTarget);
				if (event.key !== "Escape" || event.defaultPrevented) return;
				event.preventDefault();
				if (!busy) onCancel();
			}}
			ref={dialogRef}
		>
			<div className="permission-rule-confirm">
				<h2>{t("Restore default rules")}</h2>
				<p>
					{t(
						"Restoring defaults never removes your custom rules, the approval model, remembered permissions, or the permission mode.",
					)}
				</p>
				{entries.length === 0 ? (
					<p className="permission-rule-empty">{t("All default rules are enabled and unchanged.")}</p>
				) : (
					<ul className="permission-rule-restore-list">
						{entries.map((entry) => (
							<li key={entry.id}>
								<label className="permission-rule-check">
									<input
										checked={entry.selected}
										disabled={busy}
										onChange={(event) => onToggle(entry.id, event.target.checked)}
										type="checkbox"
									/>
									<span>{entry.name}</span>
								</label>
								<span className={`permission-rule-restore-state ${entry.state}`}>
									{entry.state === "missing"
										? t("Missing")
										: entry.state === "disabled"
											? t("Disabled")
											: t("Modified")}
								</span>
							</li>
						))}
					</ul>
				)}
				{error ? (
					<p className="settings-action-message error" role="alert">
						{error}
					</p>
				) : null}
				<div className="settings-form-actions">
					<button className="settings-secondary-button" disabled={busy} onClick={onCancel} type="button">
						{t("Cancel")}
					</button>
					<button
						className="settings-primary-button"
						disabled={busy || selectedCount === 0}
						onClick={onConfirm}
						type="button"
					>
						{busy ? t("Restoring…") : t("Restore selected")}
					</button>
				</div>
			</div>
		</dialog>
	);
}
