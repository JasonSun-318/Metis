import type { InteractionResponseInput, InteractionView, SessionSnapshot } from "@metis/app-protocol";
import { Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

type PermissionApprovalInteraction = Extract<InteractionView, { kind: "session_permission_approval" }>;

interface PermissionApprovalPanelProps {
	readonly interaction: PermissionApprovalInteraction;
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
	readonly sandboxHealth?: SessionSnapshot["sandboxHealth"];
}

function approvalErrorMessage(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : "The response could not be sent.";
	if (/stale|unavailable|cancelled|no longer/i.test(message)) return "This approval is no longer available.";
	return message;
}

function priorReviewCopy(
	outcome: PermissionApprovalInteraction["priorReviewerOutcome"],
): string {
	if (outcome === "deny") return "Automatic security review denied this action.";
	if (outcome === "unavailable") return "Automatic security review could not complete.";
	return "Automatic security review could not approve this action.";
}

const CHOICE_LABELS = {
	"allow-once": "Allow once",
	"deny-once": "Reject",
	"always-allow-exact": "Always allow this exact action",
	"always-deny-exact": "Always deny this exact action",
} as const;

export function PermissionApprovalPanel({
	interaction,
	onRespond,
	sandboxHealth = "healthy",
}: PermissionApprovalPanelProps) {
	const { t } = useTranslation();
	const firstControl = useRef<HTMLButtonElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
	const titleId = "permission-approval-title";
	const allowOnce = interaction.choices.includes("allow-once");
	const alwaysAllow = interaction.choices.includes("always-allow-exact");
	const denyOnce = interaction.choices.includes("deny-once");
	const alwaysDeny = interaction.choices.includes("always-deny-exact");
	const escapeChoice = denyOnce ? "deny-once" : alwaysDeny ? "always-deny-exact" : undefined;
	const sandboxBlocked = sandboxHealth !== "healthy" && interaction.executionTarget === "sandbox";
	const approvalBlocked = !interaction.scopeComplete || sandboxBlocked;
	const hostOrExternal = interaction.executionTarget !== "sandbox";
	const descriptionIds = [
		"permission-approval-execution-target",
		"permission-approval-reason",
		interaction.details.length > 0 ? "permission-approval-details" : undefined,
		interaction.priorReviewer ? "permission-approval-prior-review" : undefined,
		sandboxBlocked ? "permission-approval-sandbox-blocked" : undefined,
		!interaction.scopeComplete ? "permission-approval-incomplete" : undefined,
	]
		.filter(Boolean)
		.join(" ") || undefined;

	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		queueMicrotask(() => firstControl.current?.focus());
		return () => previous?.focus();
	}, [interaction.interactionId]);
	useEffect(() => {
		setDismissedInteractionId(null);
		setBusy(false);
		setError(null);
	}, [interaction.interactionId]);

	if (dismissedInteractionId === interaction.interactionId) {
		return <p className="toast toast-error" role="status">{t("This approval is no longer available.")}</p>;
	}

	const respond = async (response: InteractionResponseInput) => {
		setBusy(true);
		setError(null);
		try {
			await onRespond(response);
		} catch (cause) {
			const message = approvalErrorMessage(cause);
			if (message === "This approval is no longer available.") setDismissedInteractionId(response.interactionId);
			else {
				setError(message);
				setBusy(false);
			}
		}
	};
	const choose = (choice: (typeof interaction.choices)[number]) =>
		void respond({ interactionId: interaction.interactionId, kind: "session_permission_approval", choice });
	const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape" && !busy && escapeChoice) {
			event.preventDefault();
			choose(escapeChoice);
		}
	};

	return (
		<div className="permission-approval-slot">
			<section
				aria-busy={busy}
				aria-describedby={descriptionIds}
				aria-labelledby={titleId}
				className="permission-approval-panel"
				onKeyDown={handleKeyDown}
				role="dialog"
			>
				<header>
					<Warning aria-hidden="true" size={18} />
					<h2 id={titleId}>{t("Metis wants to use {{tool}}", { tool: interaction.toolLabel })}</h2>
				</header>
				<p
					className={hostOrExternal ? "permission-approval-warning" : "permission-approval-target"}
					id="permission-approval-execution-target"
				>
					{interaction.executionTarget === "sandbox"
						? t("This command remains limited to the displayed workspace sandbox.")
						: interaction.executionTarget === "external"
							? t("This action reaches a network or external service.")
							: t("This action will run outside the sandbox with your current user permissions.")}
				</p>
				<p id="permission-approval-reason">{t(interaction.reason)}</p>
				{interaction.details.length > 0 && (
					<dl className="permission-approval-details" id="permission-approval-details">
						{interaction.details.map((row, index) => (
							<div key={`${row.label}:${index}`}>
								<dt>{t(row.label)}</dt>
								<dd><code>{row.value}</code></dd>
							</div>
						))}
					</dl>
				)}
				{interaction.riskLevel === "critical" && (
					<p className="permission-approval-warning" id="permission-approval-irreversible">
						{t("This operation may not be reversible.")}
					</p>
				)}
				{interaction.priorReviewer && (
					<p className="permission-approval-warning" id="permission-approval-prior-review">
						{t(priorReviewCopy(interaction.priorReviewerOutcome))}
					</p>
				)}
				{sandboxBlocked && (
					<p className="permission-approval-warning" id="permission-approval-sandbox-blocked" role="alert">
						{t("Workspace sandbox is unavailable. This action stays blocked instead of running on the host.")}
					</p>
				)}
				{!interaction.scopeComplete && (
					<p className="permission-approval-warning" id="permission-approval-incomplete" role="alert">
						{t("This tool did not provide enough target details. Deny and retry with a specific target.")}
					</p>
				)}
				<p className="sr-only" aria-live="polite">
					{busy ? t("Sending your decision…") : error ? t(error) : ""}
				</p>
				{error && <p className="error-copy" role="alert">{t(error)}</p>}
				<footer>
					{denyOnce && (
						<button
							className="button-secondary"
							disabled={busy}
							onClick={() => choose("deny-once")}
							ref={firstControl}
							type="button"
						>
							{t(CHOICE_LABELS["deny-once"])} <kbd>Esc</kbd>
						</button>
					)}
					{alwaysDeny && (
						<button
							className="button-secondary"
							disabled={busy}
							onClick={() => choose("always-deny-exact")}
							type="button"
						>
							{t(CHOICE_LABELS["always-deny-exact"])}
						</button>
					)}
					{alwaysAllow && (
						<button
							className="button-secondary"
							disabled={busy || approvalBlocked}
							onClick={() => choose("always-allow-exact")}
							type="button"
						>
							{t(CHOICE_LABELS["always-allow-exact"])}
						</button>
					)}
					{allowOnce && (
						<button disabled={busy || approvalBlocked} onClick={() => choose("allow-once")} type="button">
							{t(CHOICE_LABELS["allow-once"])}
						</button>
					)}
				</footer>
			</section>
		</div>
	);
}
