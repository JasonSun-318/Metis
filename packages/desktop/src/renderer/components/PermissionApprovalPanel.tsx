import type { InteractionResponseInput, InteractionView, SessionSnapshot } from "@metis/app-protocol";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { approvalErrorMessage } from "../approval-error.ts";
import "../styles/permission-approval.css";
import { MenuSelect } from "./MenuSelect.tsx";

type PermissionApprovalInteraction = Extract<InteractionView, { kind: "session_permission_approval" }>;
type PermissionChoice = PermissionApprovalInteraction["choices"][number];

interface PermissionApprovalPanelProps {
	readonly interaction: PermissionApprovalInteraction;
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
	readonly sandboxHealth?: SessionSnapshot["sandboxHealth"];
	readonly disabled?: boolean;
}

const CHOICE_LABELS: Record<PermissionChoice, string> = {
	"allow-once": "Allow once",
	"deny-once": "Reject",
	"allow-session-exact": "Allow for this session",
	"always-allow-exact": "Remember for this project",
	"always-deny-exact": "Deny for this project",
};

// Emitted by the app server only for Windows sandbox Bash approvals, where the
// grant covers whole directories instead of one exact file.
const WRITABLE_DIRECTORY_LABEL = "Writable directory";

export function PermissionApprovalPanel({
	interaction,
	onRespond,
	sandboxHealth = "healthy",
	disabled = false,
}: PermissionApprovalPanelProps) {
	const { t } = useTranslation();
	const anchor = useRef<HTMLDivElement>(null);
	const firstControl = useRef<HTMLElement>(null);
	const focusHeld = useRef(false);
	const respondingRef = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
	const titleId = useId();
	const commandId = useId();
	const scopeId = useId();
	const statusId = useId();
	const errorId = useId();
	const interactionId = interaction.interactionId;
	const interactionIdRef = useRef<string | null>(interactionId);
	interactionIdRef.current = interactionId;

	const isShell = interaction.toolLabel === "bash";
	const command = isShell ? interaction.command : undefined;
	const missingCommand = isShell && command === undefined;
	const writableDirectories = isShell
		? [
				...new Set(
					interaction.details.filter((row) => row.label === WRITABLE_DIRECTORY_LABEL).map((row) => row.value),
				),
			]
		: [];
	const describedBy = writableDirectories.length > 0 ? `${commandId} ${scopeId}` : commandId;
	const sandboxBlocked = sandboxHealth !== "healthy" && interaction.executionTarget === "sandbox";
	const cannotAllow = disabled || busy || sandboxBlocked || missingCommand;
	const canRemember =
		interaction.scopeComplete && interaction.riskLevel !== "critical" && !sandboxBlocked && !missingCommand;
	const persistentChoices = interaction.choices.filter((choice) =>
		choice === "allow-session-exact"
			? canRemember && interaction.rememberSessionEligible === true
			: canRemember && (choice === "always-allow-exact" || choice === "always-deny-exact"),
	);
	const allowOnce = interaction.choices.includes("allow-once");
	const escapeChoice: PermissionChoice | undefined = interaction.choices.includes("deny-once")
		? "deny-once"
		: persistentChoices.includes("always-deny-exact")
			? "always-deny-exact"
			: undefined;
	const operation = [
		interaction.toolLabel,
		...interaction.details
			.filter((row) => !["Details", "Command", "Working directory"].includes(row.label))
			.map((row) => `${t(row.label)}: ${row.value}`),
	].join("\n");

	useEffect(() => {
		interactionIdRef.current = interactionId;
		respondingRef.current = false;
		setDismissedInteractionId(null);
		setBusy(false);
		setError(null);

		const owner = anchor.current;
		const column = owner?.closest(".conversation-column");
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const previousColumn = previous?.closest(".conversation-column");
		if (!owner?.closest(".conversation-interaction-card") && (!previousColumn || previousColumn === column)) {
			queueMicrotask(() => {
				if (interactionIdRef.current !== interactionId || !owner?.isConnected) return;
				if (document.activeElement !== previous && document.activeElement !== document.body) return;
				(firstControl.current ?? owner.querySelector<HTMLElement>('[role="dialog"]'))?.focus({
					preventScroll: true,
				});
			});
		}
		return () => {
			interactionIdRef.current = null;
			if (!focusHeld.current) return;
			queueMicrotask(() => {
				const active = document.activeElement;
				if (active !== document.body && active !== null && !owner?.contains(active)) return;
				if (previous?.isConnected && !previous.closest("[hidden], [inert]") && !previous.matches(":disabled"))
					previous.focus({ preventScroll: true });
				else column?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
			});
		};
	}, [interactionId]);

	if (dismissedInteractionId === interaction.interactionId) {
		return <output className="conversation-card-status">{t("This approval is no longer available.")}</output>;
	}

	const respond = (choice: PermissionChoice) => {
		if (
			disabled ||
			respondingRef.current ||
			interaction.interactionId !== interactionIdRef.current ||
			!interaction.choices.includes(choice)
		)
			return;
		if (
			(choice === "allow-once" || choice === "allow-session-exact" || choice === "always-allow-exact") &&
			cannotAllow
		)
			return;
		if (choice !== "allow-once" && choice !== "deny-once" && !persistentChoices.includes(choice)) return;
		respondingRef.current = true;
		setBusy(true);
		setError(null);
		const response: InteractionResponseInput = {
			interactionId: interaction.interactionId,
			kind: "session_permission_approval",
			choice,
		};
		void Promise.resolve()
			.then(() => {
				if (response.interactionId !== interactionIdRef.current) return;
				return onRespond(response);
			})
			.catch((cause) => {
				if (response.interactionId !== interactionIdRef.current) return;
				const message = approvalErrorMessage(cause);
				if (message === "This approval is no longer available.") setDismissedInteractionId(response.interactionId);
				else setError(message);
				respondingRef.current = false;
				setBusy(false);
			});
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) {
			if (event.key === "Enter" || event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
		if (event.defaultPrevented || disabled || busy) return;
		const target = event.target instanceof Element ? event.target : null;
		// The split menu owns its own keyboard interaction, including Escape.
		if (target?.closest('[role="listbox"], [aria-expanded="true"]')) return;
		if (event.key === "Escape" && escapeChoice) {
			event.preventDefault();
			event.stopPropagation();
			respond(escapeChoice);
			return;
		}
		if (
			event.key !== "Enter" ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			target?.closest('button, input, textarea, select, [contenteditable="true"]') ||
			cannotAllow ||
			!allowOnce
		)
			return;
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) return;
		event.preventDefault();
		event.stopPropagation();
		respond("allow-once");
	};

	return (
		<div
			className="permission-approval-slot"
			ref={anchor}
			onFocusCapture={() => {
				focusHeld.current = true;
			}}
			onBlurCapture={(event) => {
				if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusHeld.current = false;
			}}
		>
			<section
				aria-busy={busy}
				aria-describedby={describedBy}
				aria-labelledby={titleId}
				className="permission-approval-panel"
				onKeyDown={handleKeyDown}
				ref={firstControl}
				role="dialog"
				tabIndex={-1}
			>
				<header>
					<span className="permission-approval-label">{t("Permissions")}</span>
					<h2 id={titleId}>
						{t(
							isShell
								? "Allow Metis to execute the following command?"
								: "Allow Metis to perform the following action?",
						)}
					</h2>
				</header>
				<div className="permission-approval-body">
					{!missingCommand && (
						<pre className="permission-approval-command" id={commandId}>
							<code>{isShell ? command : operation}</code>
						</pre>
					)}
					{missingCommand && (
						<p className="error-copy" id={commandId} role="alert">
							{t("This approval is missing its complete command. Retry the action.")}
						</p>
					)}
					{writableDirectories.length > 0 && (
						<div className="permission-approval-scope" id={scopeId}>
							<p className="permission-approval-scope-title">{t("Writable directories")}</p>
							<ul>
								{writableDirectories.map((directory) => (
									<li key={directory}>
										<code>{directory}</code>
									</li>
								))}
							</ul>
							<p className="permission-approval-scope-note">{t("Includes new files and subdirectories.")}</p>
						</div>
					)}
					{sandboxBlocked && (
						<p className="error-copy" role="alert">
							{t("Workspace sandbox is unavailable. Retry after checking the execution environment.")}
						</p>
					)}
					<p aria-live="polite" className="sr-only" id={statusId}>
						{busy ? t("Sending your decision…") : ""}
					</p>
					{error && (
						<p className="error-copy" id={errorId} role="alert">
							{t(error)}
						</p>
					)}
					<footer>
						{escapeChoice && (
							<button
								aria-label={t("Reject")}
								aria-keyshortcuts="Escape"
								className="button-secondary permission-approval-reject"
								disabled={disabled || busy}
								onClick={(event) => {
									if (event.detail <= 1) respond(escapeChoice);
								}}
								type="button"
							>
								{t("Reject")} <kbd>Esc</kbd>
							</button>
						)}
						{(allowOnce || persistentChoices.length > 0) && (
							<div className="permission-approval-split">
								{allowOnce && (
									<button
										aria-label={t("Allow once")}
										aria-keyshortcuts="Enter"
										className="permission-approval-allow"
										disabled={cannotAllow}
										onClick={(event) => {
											if (event.detail <= 1) respond("allow-once");
										}}
										type="button"
									>
										{t("Allow once")} <kbd>↵</kbd>
									</button>
								)}
								{persistentChoices.length > 0 && (
									<MenuSelect<PermissionChoice>
										ariaLabel={t("More approval options")}
										className="permission-approval-split-selector"
										disabled={disabled || busy}
										menuAlign="end"
										menuBoundary="viewport"
										menuMinWidth={230}
										onChange={respond}
										options={persistentChoices.map((choice) => ({
											value: choice,
											label: t(CHOICE_LABELS[choice]),
										}))}
										placeholder=""
										value="allow-once"
									/>
								)}
							</div>
						)}
					</footer>
				</div>
			</section>
		</div>
	);
}
