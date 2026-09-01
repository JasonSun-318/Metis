import type { InteractionResponseInput, InteractionView } from "@metis/app-protocol";
import { Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AskUserPanel } from "./AskUserPanel.tsx";

interface InteractionHostProps {
	readonly interaction: InteractionView | undefined;
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
}

const CHOICE_LABELS = {
	"allow-once": "Allow once",
	"deny-once": "Reject",
	"always-allow-exact": "Always allow this exact action",
	"always-deny-exact": "Always deny this exact action",
} as const;

export function InteractionHost({ interaction, onRespond }: InteractionHostProps) {
	const { t } = useTranslation();
	const firstControl = useRef<HTMLElement>(null);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!interaction || interaction.kind === "ask_user") return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		queueMicrotask(() => firstControl.current?.focus());
		return () => previous?.focus();
	}, [interaction]);

	if (!interaction) return null;
	if (interaction.kind === "ask_user") {
		return <AskUserPanel interaction={interaction} onRespond={onRespond} />;
	}
	const respond = async (response: InteractionResponseInput) => {
		setBusy(true);
		setError(null);
		try {
			await onRespond(response);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The response could not be sent.");
			setBusy(false);
		}
	};
	const submitInput = (event: FormEvent) => {
		event.preventDefault();
		if (interaction.kind !== "input") return;
		void respond({ interactionId: interaction.interactionId, kind: "input", value: input });
	};
	if (interaction.kind === "permission_approval") {
		const allowOnce = interaction.choices.includes("allow-once");
		const alwaysAllow = interaction.choices.includes("always-allow-exact");
		const denyOnce = interaction.choices.includes("deny-once");
		const alwaysDeny = interaction.choices.includes("always-deny-exact");
		const escapeChoice = denyOnce ? "deny-once" : alwaysDeny ? "always-deny-exact" : undefined;
		const approvalBlocked = !interaction.scopeComplete;
		const hostOrExternal = interaction.executionTarget !== "sandbox";
		const descriptionIds = [
			"permission-approval-execution-target",
			"permission-approval-reason",
			interaction.details.length > 0 ? "permission-approval-details" : undefined,
			interaction.priorReviewer ? "permission-approval-prior-review" : undefined,
			approvalBlocked ? "permission-approval-incomplete" : undefined,
		].filter(Boolean).join(" ") || undefined;
		const choose = (choice: (typeof interaction.choices)[number]) =>
			void respond({ interactionId: interaction.interactionId, kind: "permission_approval", choice });
		return (
			<div className="permission-approval-slot">
				<section
					aria-describedby={descriptionIds}
					aria-labelledby="permission-approval-title"
					className="permission-approval-panel"
					onKeyDown={(event) => {
						if (event.key !== "Escape" || busy || !escapeChoice) return;
						event.preventDefault();
						choose(escapeChoice);
					}}
					role="alertdialog"
				>
					<header>
						<Warning aria-hidden="true" size={18} />
						<h2 id="permission-approval-title">
							{t("Metis wants to use {{tool}}", { tool: interaction.toolLabel })}
						</h2>
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
					<p id="permission-approval-reason">{interaction.reason}</p>
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
							{t("Automatic security review could not approve this action.")}
						</p>
					)}
					{approvalBlocked && (
						<p className="permission-approval-warning" id="permission-approval-incomplete" role="alert">
							{t("This tool did not provide enough target details. Deny and retry with a specific target.")}
						</p>
					)}
					{error && <p className="error-copy" role="alert">{t(error)}</p>}
					<footer>
						{denyOnce && (
							<button
								className="button-secondary"
								disabled={busy}
								onClick={() => choose("deny-once")}
								ref={firstControl as React.RefObject<HTMLButtonElement>}
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
							<button
								disabled={busy || approvalBlocked}
								onClick={() => choose("allow-once")}
								type="button"
							>
								{t(CHOICE_LABELS["allow-once"])}
							</button>
						)}
					</footer>
				</section>
			</div>
		);
	}

	return (
		<div className="modal-backdrop">
		<section aria-describedby="interaction-message" aria-labelledby="interaction-title" aria-modal="true" className="interaction-dialog" role="dialog">
			<h2 id="interaction-title">{t(interaction.title)}</h2>
			<p id="interaction-message">{t(interaction.message)}</p>
			{(interaction.kind === "project_trust" || interaction.kind === "select") && (
				<div className="interaction-options">
					{interaction.choices.map((choice, index) => (
						<button
							disabled={busy}
							key={choice.id}
							onClick={() => void respond({ interactionId: interaction.interactionId, kind: interaction.kind, choiceId: choice.id })}
							ref={index === 0 ? (firstControl as React.RefObject<HTMLButtonElement>) : undefined}
							type="button"
						>
							<strong>{t(choice.label)}</strong>
							{choice.description && <span>{t(choice.description)}</span>}
						</button>
					))}
				</div>
			)}
			{interaction.kind === "confirm" && (
				<div className="interaction-actions">
					<button
						className="button-secondary"
						disabled={busy}
						onClick={() => void respond({ interactionId: interaction.interactionId, kind: "confirm", confirmed: false })}
						ref={firstControl as React.RefObject<HTMLButtonElement>}
						type="button"
					>
						{interaction.cancelLabel ? t(interaction.cancelLabel) : t("Cancel")}
					</button>
					<button disabled={busy} onClick={() => void respond({ interactionId: interaction.interactionId, kind: "confirm", confirmed: true })} type="button">
						{interaction.confirmLabel ? t(interaction.confirmLabel) : t("Confirm")}
					</button>
				</div>
			)}
			{interaction.kind === "input" && (
				<form onSubmit={submitInput}>
					<label className="sr-only" htmlFor="interaction-input">{t("Response")}</label>
					<input
						autoComplete="off"
						disabled={busy}
						id="interaction-input"
						onChange={(event) => setInput(event.target.value)}
						placeholder={interaction.placeholder ? t(interaction.placeholder) : undefined}
						ref={firstControl as React.RefObject<HTMLInputElement>}
						type={interaction.secret ? "password" : "text"}
						value={input}
					/>
					<button disabled={busy} type="submit">{t("Submit")}</button>
				</form>
			)}
			{error && <p className="error-copy" role="alert">{t(error)}</p>}
		</section>
	</div>
	);
}
