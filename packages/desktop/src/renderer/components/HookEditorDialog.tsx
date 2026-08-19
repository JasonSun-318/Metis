import type { DeclarativeHookView, HookEventNameView, HookRunModeView } from "@metis/app-protocol";
import { CaretDown, CaretRight, X } from "@phosphor-icons/react";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MenuSelect } from "./MenuSelect.tsx";
import { DialogFrame } from "./ProjectActions.tsx";

const HOOK_EVENTS: readonly HookEventNameView[] = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
];

const TOOL_EVENTS: readonly HookEventNameView[] = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
];

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

export interface HookDraft {
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

export function HookEditorDialog({
	error,
	initial,
	mode,
	onCancel,
	onSubmit,
	pending,
}: {
	readonly mode: "create" | "edit";
	readonly initial?: DeclarativeHookView;
	readonly pending: boolean;
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onSubmit: (draft: HookDraft) => void;
}) {
	const { t } = useTranslation();
	const nameInput = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(initial?.name ?? "");
	const [enabled, setEnabled] = useState(initial?.enabled ?? true);
	const [event, setEvent] = useState<HookEventNameView>(initial?.event ?? "PreToolUse");
	const [matcher, setMatcher] = useState(initial?.matcher ?? "");
	const [runMode, setRunMode] = useState<HookRunModeView>(initial?.runMode ?? "process");
	const [command, setCommand] = useState(initial?.command ?? "");
	const [args, setArgs] = useState((initial?.args ?? []).join("\n"));
	const [timeout, setTimeoutVal] = useState(initial?.timeoutSeconds !== undefined ? String(initial?.timeoutSeconds) : "");
	const [statusMessage, setStatusMessage] = useState(initial?.statusMessage ?? "");
	const [metadataJson, setMetadataJson] = useState(initial?.metadata !== undefined ? JSON.stringify(initial.metadata, null, 2) : "");
	const [showAdvanced, setShowAdvanced] = useState(
		Boolean(initial?.timeoutSeconds || initial?.statusMessage || (initial?.metadata && Object.keys(initial.metadata).length > 0)),
	);
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			setLocalError(t("Enter a hook name."));
			return;
		}
		if (!command.trim()) {
			setLocalError(t("Enter a command."));
			return;
		}
		const timeoutSeconds = timeout.trim() === "" ? undefined : Number(timeout);
		if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)) {
			setLocalError(t("Timeout must be between 1 and 600 seconds."));
			return;
		}
		if (metadataJson.trim() !== "") {
			try {
				const parsed = JSON.parse(metadataJson) as unknown;
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					setLocalError(t("Custom fields must be a JSON object."));
					return;
				}
			} catch {
				setLocalError(t("Custom fields must be a JSON object."));
				return;
			}
		}
		setLocalError(null);
		onSubmit({
			id: initial?.id ?? null,
			name: name.trim(),
			enabled,
			event,
			matcher: matcher.trim(),
			runMode,
			command: command.trim(),
			args,
			timeout,
			statusMessage: statusMessage.trim(),
			metadataJson,
		});
	};

	return (
		<DialogFrame
			cancellable={!pending}
			className={`mcp-dialog hook-editor-dialog is-${mode}`}
			descriptionId="hook-editor-description"
			initialFocus={nameInput}
			onCancel={onCancel}
			titleId="hook-editor-title"
		>
			<button aria-label={t("Close")} className="mcp-dialog-close" disabled={pending} onClick={onCancel} type="button">
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="hook-editor-title">{t(mode === "create" ? "New Hook" : "Edit Hook")}</h2>
			<p className="sr-only" id="hook-editor-description">{t("Configure lifecycle hook details and execution parameters.")}</p>
			<form onSubmit={submit}>
				<label>
					{t("Hook name")}
					<input
						disabled={pending}
						onChange={(e) => setName(e.target.value)}
						placeholder="pre-commit-lint"
						ref={nameInput}
						required
						value={name}
					/>
				</label>
				<label>
					{t("Event")}
					<MenuSelect
						ariaLabel={t("Event")}
						className="hook-menu-select"
						disabled={pending}
						onChange={(val) => setEvent(val as HookEventNameView)}
						options={HOOK_EVENTS.map((ev) => ({
							value: ev,
							label: `${ev} (${t(eventLabelKey(ev))})`,
						}))}
						value={event}
					/>
				</label>
				{TOOL_EVENTS.includes(event) && (
					<label>
						{t("Tool matcher (Regex / Tool name)")}
						<input
							disabled={pending}
							onChange={(e) => setMatcher(e.target.value)}
							placeholder="write_to_file|edit_file"
							value={matcher}
						/>
					</label>
				)}
				<label>
					{t("Run mode")}
					<MenuSelect
						ariaLabel={t("Run mode")}
						className="hook-menu-select"
						disabled={pending}
						onChange={(val) => setRunMode(val as HookRunModeView)}
						options={[
							{ value: "process", label: t("Process (Binary + Arguments)") },
							{ value: "shell", label: t("Shell command") },
						]}
						value={runMode}
					/>
				</label>
				<label>
					{t("Command")}
					<input
						disabled={pending}
						onChange={(e) => setCommand(e.target.value)}
						placeholder={runMode === "shell" ? "echo 'Checking...' && ./test.sh" : "/usr/local/bin/node"}
						required
						value={command}
					/>
				</label>
				{runMode === "process" && (
					<label>
						{t("Arguments (one per line)")}
						<textarea
							disabled={pending}
							onChange={(e) => setArgs(e.target.value)}
							placeholder={"--config\n.eslintrc.js"}
							rows={3}
							value={args}
						/>
					</label>
				)}

				<label className="hook-enabled-checkbox">
					<input
						checked={enabled}
						disabled={pending}
						onChange={(e) => setEnabled(e.target.checked)}
						type="checkbox"
					/>
					<span>{t("Enable this hook")}</span>
				</label>

				<div className="hook-advanced-group">
					<button
						aria-expanded={showAdvanced}
						className="hook-advanced-toggle"
						onClick={() => setShowAdvanced((v) => !v)}
						type="button"
					>
						{showAdvanced ? <CaretDown aria-hidden="true" size={14} /> : <CaretRight aria-hidden="true" size={14} />}
						<span>{t("Advanced options")}</span>
					</button>
					{showAdvanced && (
						<div className="hook-advanced-content">
							<label>
								{t("Timeout (seconds, optional)")}
								<input
									disabled={pending}
									max={600}
									min={1}
									onChange={(e) => setTimeoutVal(e.target.value)}
									placeholder="30"
									type="number"
									value={timeout}
								/>
							</label>
							<label>
								{t("Status message (optional)")}
								<input
									disabled={pending}
									onChange={(e) => setStatusMessage(e.target.value)}
									placeholder={t("Running pre-flight checks...")}
									value={statusMessage}
								/>
							</label>
							<label>
								{t("Custom fields (JSON, optional)")}
								<textarea
									disabled={pending}
									onChange={(e) => setMetadataJson(e.target.value)}
									placeholder={'{\n  "env": "production"\n}'}
									rows={3}
									value={metadataJson}
								/>
							</label>
						</div>
					)}
				</div>

				{(localError || error) && <p className="mcp-dialog-error" role="alert">{localError || error}</p>}
				<div className="mcp-dialog-actions">
					<button className="button-secondary" disabled={pending} onClick={onCancel} type="button">
						{t("Cancel")}
					</button>
					<button disabled={pending} type="submit">
						{t(pending ? "Saving…" : mode === "create" ? "Create" : "Save")}
					</button>
				</div>
			</form>
		</DialogFrame>
	);
}
