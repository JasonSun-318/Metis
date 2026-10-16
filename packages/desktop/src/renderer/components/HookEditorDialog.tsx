import type { DeclarativeHookView, HookEventNameView, HookProtocolView, HookRunModeView } from "@metis/app-protocol";
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
			return "Before finishing";
	}
}

export interface HookDraft {
	readonly id: string | null;
	name: string;
	enabled: boolean;
	event: HookEventNameView;
	protocol: HookProtocolView;
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
	const [protocol, setProtocol] = useState<HookProtocolView>(
		initial?.protocol ?? (mode === "create" ? "command-v1" : "legacy"),
	);
	const [matcher, setMatcher] = useState(initial?.matcher ?? "");
	const [runMode, setRunMode] = useState<HookRunModeView>(initial?.runMode ?? "process");
	const [command, setCommand] = useState(initial?.command ?? "");
	const [args, setArgs] = useState((initial?.args ?? []).join("\n"));
	const [timeout, setTimeoutVal] = useState(
		initial?.timeoutSeconds !== undefined ? String(initial?.timeoutSeconds) : "",
	);
	const [statusMessage, setStatusMessage] = useState(initial?.statusMessage ?? "");
	const [metadataJson, setMetadataJson] = useState(
		initial?.metadata !== undefined ? JSON.stringify(initial.metadata, null, 2) : "",
	);
	const [showAdvanced, setShowAdvanced] = useState(
		Boolean(mode === "edit" && initial?.protocol !== "command-v1") ||
			Boolean(
				initial?.timeoutSeconds ||
					initial?.statusMessage ||
					(initial?.metadata && Object.keys(initial.metadata).length > 0),
			),
	);
	const [localError, setLocalError] = useState<string | null>(null);

	const isMatcherApplicable =
		protocol === "legacy" ? TOOL_EVENTS.includes(event) : event === "SessionStart" || TOOL_EVENTS.includes(event);

	let matcherRegexError: string | null = null;
	if (protocol === "command-v1" && isMatcherApplicable && matcher.trim().length > 0 && matcher.trim() !== "*") {
		try {
			new RegExp(matcher.trim());
		} catch (err) {
			matcherRegexError = err instanceof Error ? err.message : String(err);
		}
	}

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
		if (protocol === "command-v1") {
			if (matcherRegexError) {
				setLocalError(`${t("Invalid regular expression.")}: ${matcherRegexError}`);
				return;
			}
		}
		const timeoutSeconds = timeout.trim() === "" ? undefined : Number(timeout);
		if (
			timeoutSeconds !== undefined &&
			(!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)
		) {
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
			protocol,
			matcher: isMatcherApplicable ? matcher.trim() : "",
			runMode,
			command: command.trim(),
			args,
			timeout,
			statusMessage: statusMessage.trim(),
			metadataJson,
		});
	};

	const eventHint: Record<HookEventNameView, string> = {
		SessionStart: "Run when a session starts. Your script can provide project context.",
		UserPromptSubmit: "Check each message before it reaches the model. Your script can add context or reject it.",
		PreToolUse: "Check a tool call before it runs. Your script can add context or block it.",
		PostToolUse: "Run after a tool succeeds. Your script can provide feedback to the model.",
		PostToolUseFailure: "Run after a tool fails. Your script can provide troubleshooting context.",
		Stop: "Check before the model finishes. Your script can request one more continuation.",
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
			<header className="hook-editor-header">
				<button
					aria-label={t("Close")}
					className="mcp-dialog-close"
					disabled={pending}
					onClick={onCancel}
					type="button"
				>
					<X aria-hidden="true" size={17} />
				</button>
				<h2 id="hook-editor-title">{t(mode === "create" ? "New Hook" : "Edit Hook")}</h2>
				<p id="hook-editor-description">
					{t("Run your script automatically at a chosen point in a conversation.")}
				</p>
			</header>
			<form onSubmit={submit}>
				<div className="hook-editor-body">
					<label>
						{t("Hook name")}
						<input
							disabled={pending}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("For example, check tool calls")}
							ref={nameInput}
							required
							value={name}
						/>
					</label>
					<fieldset className="hook-editor-section">
						<legend>{t("When to run")}</legend>
						<div className="hook-editor-field">
							<span>{t("Event")}</span>
							<MenuSelect
								ariaLabel={t("Event")}
								className="hook-menu-select"
								disabled={pending}
								onChange={(next) => {
									setEvent(next);
									if ((event === "SessionStart") !== (next === "SessionStart") || !TOOL_EVENTS.includes(next))
										setMatcher("");
								}}
								options={HOOK_EVENTS.map((ev) => ({ value: ev, label: t(eventLabelKey(ev)) }))}
								value={event}
							/>
							<p className="hook-field-hint">
								{protocol === "command-v1"
									? t(eventHint[event])
									: t("Runs your command at this point, preserving traditional hook behavior.")}
							</p>
						</div>
						{isMatcherApplicable && (
							<label>
								{event === "SessionStart" ? t("Session reasons (optional)") : t("Only these tools (optional)")}
								<input
									aria-invalid={Boolean(matcherRegexError)}
									disabled={pending}
									onChange={(e) => setMatcher(e.target.value)}
									placeholder={
										event === "SessionStart"
											? "startup|reload"
											: protocol === "legacy"
												? "bash, read, write"
												: "bash|read|write"
									}
									value={matcher}
								/>
								<p className="hook-field-hint">
									{t(
										protocol === "legacy"
											? "Leave empty for all tools. Separate tool names with commas."
											: event === "SessionStart"
												? "Leave empty for every start. Use a regular expression to filter reasons."
												: "Leave empty for all tools. Use a regular expression to filter names, such as bash|write.",
									)}
								</p>
								{matcherRegexError && (
									<p className="hook-field-error" role="alert">
										{t("Invalid regular expression.")}: {matcherRegexError}
									</p>
								)}
							</label>
						)}
					</fieldset>
					<fieldset className="hook-editor-section">
						<legend>{t("What to run")}</legend>
						<div className="hook-editor-field">
							<span>{t("Run mode")}</span>
							<MenuSelect
								ariaLabel={t("Run mode")}
								className="hook-menu-select"
								disabled={pending}
								onChange={setRunMode}
								options={[
									{ value: "process", label: t("Program and arguments") },
									{ value: "shell", label: t("Shell command") },
								]}
								value={runMode}
							/>
						</div>
						<label>
							{t("Command")}
							<input
								aria-label={t("Command")}
								disabled={pending}
								onChange={(e) => setCommand(e.target.value)}
								placeholder={runMode === "shell" ? "node ./scripts/check.js" : "node"}
								required
								value={command}
							/>
							<p className="hook-field-hint">
								{t(
									runMode === "shell"
										? "Enter the complete command as you would in a terminal."
										: "Enter a program name or path. Put its arguments in the field below.",
								)}
							</p>
						</label>
						{runMode === "process" && (
							<label>
								{t("Arguments (one per line)")}
								<textarea
									disabled={pending}
									onChange={(e) => setArgs(e.target.value)}
									placeholder={"./scripts/check.js\n--verbose"}
									rows={2}
									value={args}
								/>
							</label>
						)}
					</fieldset>
					<div className="hook-advanced-group">
						<button
							aria-controls="hook-advanced-fields"
							aria-expanded={showAdvanced}
							className="hook-advanced-toggle"
							onClick={() => setShowAdvanced((v) => !v)}
							type="button"
						>
							{showAdvanced ? (
								<CaretDown aria-hidden="true" size={14} />
							) : (
								<CaretRight aria-hidden="true" size={14} />
							)}
							<span>{t("Advanced options")}</span>
						</button>
						{showAdvanced && (
							<div className="hook-advanced-content" id="hook-advanced-fields">
								<div className="hook-editor-field">
									<span>{t("Protocol")}</span>
									<MenuSelect
										ariaLabel={t("Protocol")}
										className="hook-menu-select"
										disabled={pending}
										onChange={setProtocol}
										options={[
											{ value: "command-v1", label: t("Structured command (recommended)") },
											{ value: "legacy", label: t("Traditional command (compatibility)") },
										]}
										value={protocol}
									/>
									<p className="hook-field-hint">
										{t(
											protocol === "command-v1"
												? "command-v1: your script receives JSON and can return context or decisions. Keep this for new hooks."
												: "legacy: keeps existing scripts working as before. Choose this only for older hooks.",
										)}
									</p>
								</div>
								<label>
									{t("Timeout (seconds, optional)")}
									<input
										disabled={pending}
										max={600}
										min={1}
										onChange={(e) => setTimeoutVal(e.target.value)}
										placeholder="60"
										type="number"
										value={timeout}
									/>
									<p className="hook-field-hint">
										{t("Stops a script that takes too long. Default: 60 seconds.")}
									</p>
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
										placeholder={'{ "env": "development" }'}
										rows={2}
										value={metadataJson}
									/>
								</label>
							</div>
						)}
					</div>
				</div>
				<footer className="hook-editor-footer">
					{(localError || error) && (
						<p className="mcp-dialog-error" role="alert">
							{localError || error}
						</p>
					)}
					<div className="hook-editor-footer-row">
						<label className="hook-enabled-checkbox">
							<input
								checked={enabled}
								disabled={pending}
								onChange={(e) => setEnabled(e.target.checked)}
								type="checkbox"
							/>
							<span>{t("Enable this hook")}</span>
						</label>
						<div className="mcp-dialog-actions">
							<button className="button-secondary" disabled={pending} onClick={onCancel} type="button">
								{t("Cancel")}
							</button>
							<button disabled={pending} type="submit">
								{t(pending ? "Saving…" : mode === "create" ? "Create" : "Save")}
							</button>
						</div>
					</div>
				</footer>
			</form>
		</DialogFrame>
	);
}
