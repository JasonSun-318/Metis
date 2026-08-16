import type { DeclarativeHookView, HookEventNameView, HookRunModeView, HooksListView } from "@metis/app-protocol";
import { CaretRight, CheckCircle, Lightning, PencilSimple, Plus, Trash, XCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { MenuSelect } from "./MenuSelect.tsx";

const HOOK_EVENTS: readonly HookEventNameView[] = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
];

const HOOK_RUN_MODES: readonly HookRunModeView[] = ["process", "shell"];

const TOOL_EVENTS: readonly HookEventNameView[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

function eventLabelKey(event: HookEventNameView): string {
	switch (event) {
		case "SessionStart":
			return "Session start";
		case "UserPromptSubmit":
			return "User prompt submit";
		case "PreToolUse":
			return "Pre tool use";
		case "PostToolUse":
			return "Post tool use";
		case "PostToolUseFailure":
			return "Post tool use failure";
		case "Stop":
			return "Stop";
	}
}

interface HookDraft {
	readonly id: string | null;
	name: string;
	enabled: boolean;
	event: HookEventNameView;
	matcher: string;
	runMode: HookRunModeView;
	command: string;
	args: string;
	timeout: string;
	statusMessage: string;
	metadataJson: string;
}

function emptyDraft(): HookDraft {
	return {
		id: null,
		name: "",
		enabled: true,
		event: "PreToolUse",
		matcher: "",
		runMode: "process",
		command: "",
		args: "",
		timeout: "",
		statusMessage: "",
		metadataJson: "",
	};
}

function draftFromHook(hook: DeclarativeHookView): HookDraft {
	return {
		id: hook.id,
		name: hook.name,
		enabled: hook.enabled,
		event: hook.event,
		matcher: hook.matcher ?? "",
		runMode: hook.runMode,
		command: hook.command,
		args: (hook.args ?? []).join("\n"),
		timeout: hook.timeoutSeconds !== undefined ? String(hook.timeoutSeconds) : "",
		statusMessage: hook.statusMessage ?? "",
		metadataJson: hook.metadata !== undefined ? JSON.stringify(hook.metadata, null, 2) : "",
	};
}

export function HooksSettingsPanel({ api, serverReady }: {
	readonly api: Pick<MetisDesktopApi, "listHooks" | "upsertHook" | "deleteHook">;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [list, setList] = useState<HooksListView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [draft, setDraft] = useState<HookDraft | null>(null);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.listHooks().then(
			(result) => {
				if (current) setList(result);
			},
			(cause) => {
				if (current) setError(cause instanceof Error ? cause.message : t("Couldn’t load hooks."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, serverReady, reloadKey, t]);

	if (!list && !error) return <div aria-label={t("Hooks")} className="settings-loading" role="status" />;

	const applyResult = (result: HooksListView) => {
		setList(result);
		setNotice(t("Hooks apply to new sessions; running sessions keep their current hooks."));
	};

	const save = async () => {
		if (!draft) return;
		if (!draft.name.trim()) {
			setError(t("Enter a hook name."));
			return;
		}
		if (!draft.command.trim()) {
			setError(t("Enter a command."));
			return;
		}
		const timeoutSeconds = draft.timeout.trim() === "" ? undefined : Number(draft.timeout);
		if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)) {
			setError(t("Timeout must be between 1 and 600 seconds."));
			return;
		}
		let metadata: Record<string, unknown> | undefined;
		if (draft.metadataJson.trim() !== "") {
			try {
				const parsed = JSON.parse(draft.metadataJson) as unknown;
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					setError(t("Custom fields must be a JSON object."));
					return;
				}
				metadata = parsed as Record<string, unknown>;
			} catch {
				setError(t("Custom fields must be a JSON object."));
				return;
			}
		}
		const args = draft.runMode === "process"
			? draft.args.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
			: undefined;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.upsertHook({
				hook: {
					id: draft.id ?? crypto.randomUUID(),
					name: draft.name.trim(),
					enabled: draft.enabled,
					event: draft.event,
					...(TOOL_EVENTS.includes(draft.event) && draft.matcher.trim() !== ""
						? { matcher: draft.matcher.trim() }
						: {}),
					runMode: draft.runMode,
					command: draft.command.trim(),
					...(args !== undefined && args.length > 0 ? { args } : {}),
					...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
					...(draft.statusMessage.trim() !== "" ? { statusMessage: draft.statusMessage.trim() } : {}),
					...(metadata !== undefined ? { metadata } : {}),
				},
			});
			applyResult(result);
			setDraft(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t save the hook."));
		} finally {
			setBusy(false);
		}
	};

	const toggleEnabled = async (hook: DeclarativeHookView) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.upsertHook({ hook: { ...hook, enabled: !hook.enabled } });
			setList(result);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t save the hook."));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (hook: DeclarativeHookView) => {
		if (!window.confirm(t("Delete “{{name}}”? This cannot be undone.", { name: hook.name }))) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.deleteHook({ id: hook.id });
			setList(result);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t delete the hook."));
		} finally {
			setBusy(false);
		}
	};

	const update = (patch: Partial<HookDraft>) => {
		setDraft((current) => (current ? { ...current, ...patch } : current));
		setError(null);
	};

	return (
		<section className="settings-page hooks-page">
			{draft ? (
				<form
					className="personalization-section hooks-editor"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<header className="hooks-editor-header">
						<button className="settings-back-button" onClick={() => setDraft(null)} type="button">
							{t("Back to hooks")}
						</button>
						<h2>{draft.id ? t("Edit hook") : t("New hook")}</h2>
						<p>{t("Run a command automatically when the event occurs.")}</p>
					</header>
					<div className="settings-card hooks-editor-card">
						<label className="hooks-field">
							<span>{t("Hook name")}</span>
							<input
								onChange={(event) => update({ name: event.target.value })}
								placeholder={t("Block dangerous bash")}
								value={draft.name}
							/>
						</label>
						<div className="hooks-field-row">
							<label className="hooks-field">
								<span>{t("Scope")}</span>
								<input disabled readOnly value={t("User")} />
							</label>
							<label className="hooks-field">
								<span>{t("Event")}</span>
								<MenuSelect
									ariaLabel={t("Event")}
									className="hooks-event-select"
									onChange={(event) => update({ event })}
									options={HOOK_EVENTS.map((value) => ({ value, label: t(eventLabelKey(value)) }))}
									value={draft.event}
								/>
							</label>
							<label className="hooks-field">
								<span>{t("Run mode")}</span>
								<MenuSelect
									ariaLabel={t("Run mode")}
									className="hooks-runmode-select"
									onChange={(runMode) => update({ runMode })}
									options={[
										{ value: "process", label: t("Process") },
										{ value: "shell", label: t("Shell command") },
									]}
									value={draft.runMode}
								/>
							</label>
						</div>
						{TOOL_EVENTS.includes(draft.event) ? (
							<label className="hooks-field">
								<span>{t("Matcher")}</span>
								<input
									onChange={(event) => update({ matcher: event.target.value })}
									placeholder="bash, write, edit"
									value={draft.matcher}
								/>
								<small>{t("Comma-separated tool names; leave empty to match all tools.")}</small>
							</label>
						) : null}
						<label className="hooks-field">
							<span>{t("Command")}</span>
							{draft.runMode === "shell" ? (
								<input
									onChange={(event) => update({ command: event.target.value })}
									placeholder="echo 'Hello from hook'"
									value={draft.command}
								/>
							) : (
								<input
									onChange={(event) => update({ command: event.target.value })}
									placeholder="/usr/bin/env"
									value={draft.command}
								/>
							)}
							{draft.runMode === "shell" ? (
								<small>{t("Run through the shell; pipes and redirection work.")}</small>
							) : null}
						</label>
						{draft.runMode === "process" ? (
							<label className="hooks-field">
								<span>{t("Arguments")}</span>
								<textarea
									onChange={(event) => update({ args: event.target.value })}
									placeholder={t("One argument per line")}
									rows={3}
									value={draft.args}
								/>
							</label>
						) : null}
						<details className="hooks-advanced">
							<summary>
								<CaretRight aria-hidden="true" className="hooks-advanced-chevron" size={14} />
								<span>{t("Advanced")}</span>
							</summary>
							<div className="hooks-field-row">
								<label className="hooks-field">
									<span>{t("Timeout (seconds)")}</span>
									<input
										inputMode="numeric"
										onChange={(event) => update({ timeout: event.target.value })}
										placeholder="60"
										value={draft.timeout}
									/>
								</label>
								<label className="hooks-field">
									<span>{t("Status message")}</span>
									<input
										onChange={(event) => update({ statusMessage: event.target.value })}
										value={draft.statusMessage}
									/>
								</label>
							</div>
							<label className="hooks-field">
								<span>{t("Custom fields (JSON)")}</span>
								<textarea
									onChange={(event) => update({ metadataJson: event.target.value })}
									placeholder={'{ "channel": "ops" }'}
									rows={3}
									value={draft.metadataJson}
								/>
							</label>
						</details>
						<div className="settings-form-actions">
							<button className="settings-secondary-button" disabled={busy} onClick={() => setDraft(null)} type="button">
								{t("Cancel")}
							</button>
							<button className="settings-primary-button" disabled={busy || !serverReady} type="submit">
								{busy ? t("Saving…") : t("Save")}
							</button>
						</div>
					</div>
					{error ? (
						<p className="settings-action-message error" role="alert">
							<XCircle aria-hidden="true" size={15} />
							{error}
						</p>
					) : null}
				</form>
			) : (
				<div className="personalization-section">
					<header className="general-section-heading hooks-list-heading">
						<div>
							<h2>{t("Hooks")}</h2>
							<p>{t("Hooks apply to new sessions; running sessions keep their current hooks.")}</p>
						</div>
						<button
							className="settings-secondary-button hooks-add-button"
							disabled={!serverReady || busy}
							onClick={() => {
								setNotice(null);
								setError(null);
								setDraft(emptyDraft());
							}}
							type="button"
						>
							<Plus aria-hidden="true" size={14} />
							{t("New hook")}
						</button>
					</header>
					{list?.loadErrors.length ? (
						<div className="settings-inline-error" role="alert">
							{t("Some hooks could not be loaded:")}
							<ul>
								{list.loadErrors.map((loadError) => (
									<li key={loadError}>{loadError}</li>
								))}
							</ul>
						</div>
					) : null}
					<div className="settings-card hooks-list">
						{list && list.hooks.length > 0 ? (
							list.hooks.map((hook) => (
								<div className="hooks-list-row" key={hook.id}>
									<div className="hooks-list-copy">
										<strong title={hook.name}>{hook.name}</strong>
										<span>
											{t(eventLabelKey(hook.event))}
											{hook.matcher ? ` · ${hook.matcher}` : ""} ·{" "}
											{hook.runMode === "shell" ? t("Shell command") : t("Process")}
											{!hook.enabled ? ` · ${t("Disabled")}` : ""}
										</span>
										<code title={hook.command}>{hook.command}</code>
									</div>
									<div className="hooks-list-actions">
										<label className="web-search-toggle">
											<span className="sr-only">{t("Enabled")}</span>
											<input
												checked={hook.enabled}
												disabled={!serverReady || busy}
												onChange={() => void toggleEnabled(hook)}
												type="checkbox"
											/>
											<span aria-hidden="true" className="web-search-toggle-track" />
										</label>
										<button
											aria-label={t("Edit hook")}
											className="hooks-icon-button"
											disabled={busy}
											onClick={() => {
												setNotice(null);
												setError(null);
												setDraft(draftFromHook(hook));
											}}
											type="button"
										>
											<PencilSimple aria-hidden="true" size={15} />
										</button>
										<button
											aria-label={t("Delete")}
											className="hooks-icon-button danger"
											disabled={busy}
											onClick={() => void remove(hook)}
											type="button"
										>
											<Trash aria-hidden="true" size={15} />
										</button>
									</div>
								</div>
							))
						) : (
							<div className="hooks-empty">
								<Lightning aria-hidden="true" size={22} />
								<p>{t("No hooks configured")}</p>
								<span>{t("Create a hook to run a command automatically when an event occurs.")}</span>
							</div>
						)}
					</div>
					{error ? (
						<p className="settings-action-message error" role="alert">
							<XCircle aria-hidden="true" size={15} />
							{error}
						</p>
					) : null}
					{notice ? (
						<p className="settings-action-message" role="status">
							<CheckCircle aria-hidden="true" size={15} />
							{notice}
						</p>
					) : null}
				</div>
			)}
		</section>
	);
}
