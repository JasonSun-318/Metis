import type { InteractionResponseInput, InteractionView, SessionSnapshot } from "@metis/app-protocol";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { approvalErrorMessage } from "../approval-error.ts";
import { CaretDown } from "../icons.tsx";
import "../styles/permission-approval.css";
import { FloatingSystemNotice } from "./SystemNotice.tsx";

type PermissionApprovalInteraction = Extract<InteractionView, { kind: "session_permission_approval" }>;
type PermissionChoice = PermissionApprovalInteraction["choices"][number];

interface PermissionApprovalPanelProps {
	readonly interaction: PermissionApprovalInteraction;
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
	readonly sandboxHealth?: SessionSnapshot["sandboxHealth"];
}

function priorReviewCopy(outcome: PermissionApprovalInteraction["priorReviewerOutcome"]): string {
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

/** A value another row must be read against, such as `npm test` inside a working directory. */
function isRelative(value: string): boolean {
	return !value.startsWith("~") && !value.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/iu.test(value);
}

export function PermissionApprovalPanel({
	interaction,
	onRespond,
	sandboxHealth = "healthy",
}: PermissionApprovalPanelProps) {
	const { t } = useTranslation();
	const anchor = useRef<HTMLDivElement>(null);
	const firstControl = useRef<HTMLButtonElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(true);
	const bodyId = useId();
	const focusHeld = useRef(false);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const titleId = useId();
	const primaryId = useId();
	const workingDirectoryId = useId();
	const detailsId = useId();
	const moreId = useId();
	const executionTargetId = useId();
	const criticalId = useId();
	const sandboxBlockedId = useId();
	const incompleteId = useId();
	const statusId = useId();
	const errorId = useId();
	const interactionId = interaction.interactionId;
	const interactionIdRef = useRef<string | null>(interactionId);
	interactionIdRef.current = interactionId;
	const respondingRef = useRef(false);

	const allowOnce = interaction.choices.includes("allow-once");
	const denyOnce = interaction.choices.includes("deny-once");
	const alwaysDeny = interaction.choices.includes("always-deny-exact");
	const escapeChoice: PermissionChoice | undefined = denyOnce
		? "deny-once"
		: alwaysDeny
			? "always-deny-exact"
			: undefined;
	const persistentChoices = (["always-deny-exact", "always-allow-exact"] as const).filter((choice) =>
		interaction.choices.includes(choice),
	);
	const sandboxBlocked = sandboxHealth !== "healthy" && interaction.executionTarget === "sandbox";
	const allowOnceBlocked = sandboxBlocked;
	const alwaysAllowBlocked = !interaction.scopeComplete || sandboxBlocked;
	const hostOrExternal = interaction.executionTarget !== "sandbox";

	const primaryRows = interaction.details.filter(
		(row) => row.label !== "Working directory" && row.label !== "Details",
	);
	const targets = primaryRows.filter((row) => ["File", "Path", "Target", "Source", "Destination"].includes(row.label));
	const workingDirectory = interaction.details.find((row) => row.label === "Working directory");
	const showWorkingDirectory =
		workingDirectory !== undefined &&
		(targets.length
			? targets.some((row) => isRelative(row.value))
			: primaryRows.some((row) => row.label === "Command"));
	const secondaryRows = interaction.details.filter(
		(row) => row.label === "Details" || (row.label === "Working directory" && !showWorkingDirectory),
	);
	const hasDetails =
		interaction.executionTarget === "sandbox" ||
		secondaryRows.length > 0 ||
		interaction.reason.trim().length > 0 ||
		interaction.priorReviewer !== undefined ||
		(workingDirectory !== undefined && !showWorkingDirectory);

	const descriptionIds =
		[
			primaryRows.length > 0 ? primaryId : undefined,
			showWorkingDirectory ? workingDirectoryId : undefined,
			hostOrExternal ? executionTargetId : undefined,
			interaction.riskLevel === "critical" ? criticalId : undefined,
			sandboxBlocked ? sandboxBlockedId : undefined,
			!interaction.scopeComplete ? incompleteId : undefined,
		]
			.filter(Boolean)
			.join(" ") || undefined;

	useEffect(() => {
		interactionIdRef.current = interactionId;
		respondingRef.current = false;
		setDismissedInteractionId(null);
		setBusy(false);
		setError(null);
		setExpanded(true);
		setDetailsOpen(false);
		setMoreOpen(false);
		const owner = anchor.current;
		const column = owner?.closest(".conversation-column");
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const previousColumn = previous?.closest(".conversation-column");
		if (!previousColumn || previousColumn === column) {
			queueMicrotask(() => {
				if (interactionIdRef.current !== interactionId || !owner?.isConnected) return;
				if (document.activeElement !== previous && document.activeElement !== document.body) return;
				(firstControl.current ?? owner.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({
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
		return <FloatingSystemNotice title={t("This approval is no longer available.")} tone="warning" />;
	}

	const respond = (response: InteractionResponseInput) => {
		if (respondingRef.current || response.interactionId !== interactionIdRef.current) return;
		respondingRef.current = true;
		setBusy(true);
		void send(response);
	};
	const send = async (response: InteractionResponseInput) => {
		setError(null);
		try {
			await onRespond(response);
		} catch (cause) {
			if (response.interactionId !== interactionIdRef.current) return;
			const message = approvalErrorMessage(cause);
			if (message === "This approval is no longer available.") setDismissedInteractionId(response.interactionId);
			else setError(message);
			respondingRef.current = false;
			setBusy(false);
		}
	};
	const choose = (choice: PermissionChoice) =>
		void respond({ interactionId: interaction.interactionId, kind: "session_permission_approval", choice });
	const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape" && !respondingRef.current && escapeChoice) {
			event.preventDefault();
			event.stopPropagation();
			choose(escapeChoice);
		}
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
				aria-describedby={descriptionIds}
				aria-labelledby={titleId}
				className="permission-approval-panel"
				onKeyDown={handleKeyDown}
				role="dialog"
			>
				<header>
					<div>
						<h2 id={titleId}>{t("Metis wants to use {{tool}}", { tool: interaction.toolLabel })}</h2>
					</div>
					<button
						aria-controls={bodyId}
						aria-expanded={expanded}
						aria-label={t(expanded ? "Collapse approval" : "Expand approval")}
						className="composer-panel-toggle"
						disabled={busy}
						onClick={() => setExpanded((value) => !value)}
						type="button"
					>
						<CaretDown aria-hidden="true" size={16} />
					</button>
				</header>
				<div
					className="permission-approval-body"
					hidden={!expanded}
					aria-hidden={!expanded}
					inert={!expanded}
					id={bodyId}
				>
					{primaryRows.length > 0 && (
						<dl className="permission-approval-primary" id={primaryId}>
							{primaryRows.map((row, index) => (
								<div key={`${row.label}:${index}`}>
									<dt>{t(row.label)}</dt>
									<dd>
										<code>{row.value}</code>
									</dd>
								</div>
							))}
						</dl>
					)}
					{showWorkingDirectory && workingDirectory && (
						<p className="permission-approval-context" id={workingDirectoryId}>
							{t("Working directory")} <code>{workingDirectory.value}</code>
						</p>
					)}
					{hostOrExternal && (
						<p className="permission-approval-warning" id={executionTargetId}>
							{interaction.executionTarget === "external"
								? t("This action reaches a network or external service.")
								: t("This action will run outside the sandbox with your current user permissions.")}
						</p>
					)}
					{interaction.riskLevel === "critical" && (
						<p className="permission-approval-warning" id={criticalId}>
							{t("This operation may not be reversible.")}
						</p>
					)}
					{sandboxBlocked && (
						<p className="permission-approval-warning" id={sandboxBlockedId} role="alert">
							{t("Workspace sandbox is unavailable. This action stays blocked instead of running on the host.")}
						</p>
					)}
					{!interaction.scopeComplete && (
						<p className="permission-approval-warning" id={incompleteId} role="alert">
							{t("This tool did not provide enough target details. Deny and retry with a specific target.")}
						</p>
					)}
					{hasDetails && (
						<>
							<button
								aria-controls={detailsId}
								aria-expanded={detailsOpen}
								className="permission-approval-disclosure"
								disabled={busy}
								onClick={() => setDetailsOpen((value) => !value)}
								type="button"
							>
								{t("Details")}
								<CaretDown aria-hidden="true" size={12} />
							</button>
							<div
								className="permission-approval-details"
								hidden={!detailsOpen}
								inert={!detailsOpen}
								id={detailsId}
							>
								{interaction.executionTarget === "sandbox" && (
									<p>{t("This command remains limited to the displayed workspace sandbox.")}</p>
								)}
								{interaction.reason.trim().length > 0 && <p>{t(interaction.reason)}</p>}
								{secondaryRows.length > 0 && (
									<dl>
										{secondaryRows.map((row, index) => (
											<div key={`${row.label}:${index}`}>
												<dt>{t(row.label)}</dt>
												<dd>
													<code>{row.value}</code>
												</dd>
											</div>
										))}
									</dl>
								)}
								{interaction.priorReviewer && <p>{t(priorReviewCopy(interaction.priorReviewerOutcome))}</p>}
							</div>
						</>
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
						{allowOnce && (
							<button disabled={busy || allowOnceBlocked} onClick={() => choose("allow-once")} type="button">
								{t(CHOICE_LABELS["allow-once"])}
							</button>
						)}
						{persistentChoices.length > 0 && (
							<button
								aria-controls={moreId}
								aria-expanded={moreOpen}
								className="permission-approval-more button-secondary"
								disabled={busy}
								onClick={() => setMoreOpen((value) => !value)}
								type="button"
							>
								{t("More")}
								<CaretDown aria-hidden="true" size={12} />
							</button>
						)}
						<div hidden={!moreOpen} inert={!moreOpen} id={moreId}>
							{persistentChoices.map((choice) => (
								<button
									className="button-secondary"
									disabled={busy || (choice === "always-allow-exact" && alwaysAllowBlocked)}
									key={choice}
									onClick={() => choose(choice)}
									type="button"
								>
									{t(CHOICE_LABELS[choice])}
								</button>
							))}
						</div>
					</footer>
				</div>
			</section>
		</div>
	);
}
