import type { InteractionResponseInput, InteractionView, SessionSnapshot } from "@metis/app-protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AskUserDraft, AskUserPanel } from "./AskUserPanel.tsx";
import { PermissionApprovalPanel } from "./PermissionApprovalPanel.tsx";

interface InteractionHostProps {
	readonly interaction: InteractionView | undefined;
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
	readonly askUserDrafts?: Map<string, AskUserDraft>;
	readonly disabled?: boolean;
	readonly sandboxHealth?: SessionSnapshot["sandboxHealth"];
}

function approvalErrorMessage(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : "The response could not be sent.";
	if (/stale|unavailable|cancelled|no longer/i.test(message)) return "This approval is no longer available.";
	return message;
}

export function InteractionHost({
	interaction,
	onRespond,
	askUserDrafts,
	disabled,
	sandboxHealth = "healthy",
}: InteractionHostProps) {
	const { t } = useTranslation();
	const firstControl = useRef<HTMLElement>(null);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!interaction || interaction.kind === "ask_user" || interaction.kind === "session_permission_approval") return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		queueMicrotask(() => firstControl.current?.focus());
		return () => previous?.focus();
	}, [interaction]);
	// biome-ignore lint/correctness/useExhaustiveDependencies(interaction?.interactionId): A different interaction starts with fresh busy and error state.
	useEffect(() => {
		setBusy(false);
		setError(null);
	}, [interaction?.interactionId]);

	if (!interaction) return null;
	if (interaction.kind === "ask_user") {
		return (
			<AskUserPanel interaction={interaction} onRespond={onRespond} draftCache={askUserDrafts} disabled={disabled} />
		);
	}
	if (interaction.kind === "session_permission_approval") {
		return <PermissionApprovalPanel interaction={interaction} onRespond={onRespond} sandboxHealth={sandboxHealth} />;
	}
	const respond = async (response: InteractionResponseInput) => {
		setBusy(true);
		setError(null);
		try {
			await onRespond(response);
		} catch (cause) {
			setError(approvalErrorMessage(cause));
			setBusy(false);
		}
	};
	const submitInput = (event: FormEvent) => {
		event.preventDefault();
		if (interaction.kind !== "input") return;
		void respond({ interactionId: interaction.interactionId, kind: "input", value: input });
	};

	return (
		<div className="modal-backdrop">
			<section
				aria-describedby="interaction-message"
				aria-labelledby="interaction-title"
				aria-modal="true"
				className="interaction-dialog"
				role="dialog"
			>
				<h2 id="interaction-title">{t(interaction.title)}</h2>
				<p id="interaction-message">{t(interaction.message)}</p>
				{(interaction.kind === "project_trust" || interaction.kind === "select") && (
					<div className="interaction-options">
						{interaction.choices.map((choice, index) => (
							<button
								disabled={busy}
								key={choice.id}
								onClick={() =>
									void respond({
										interactionId: interaction.interactionId,
										kind: interaction.kind,
										choiceId: choice.id,
									})
								}
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
							onClick={() =>
								void respond({ interactionId: interaction.interactionId, kind: "confirm", confirmed: false })
							}
							ref={firstControl as React.RefObject<HTMLButtonElement>}
							type="button"
						>
							{interaction.cancelLabel ? t(interaction.cancelLabel) : t("Cancel")}
						</button>
						<button
							disabled={busy}
							onClick={() =>
								void respond({ interactionId: interaction.interactionId, kind: "confirm", confirmed: true })
							}
							type="button"
						>
							{interaction.confirmLabel ? t(interaction.confirmLabel) : t("Confirm")}
						</button>
					</div>
				)}
				{interaction.kind === "input" && (
					<form onSubmit={submitInput}>
						<label className="sr-only" htmlFor="interaction-input">
							{t("Response")}
						</label>
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
						<button disabled={busy} type="submit">
							{t("Submit")}
						</button>
					</form>
				)}
				{error && (
					<p className="error-copy" role="alert">
						{t(error)}
					</p>
				)}
			</section>
		</div>
	);
}
