import type { InteractionResponseInput, InteractionView } from "@arcmind/app-protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";

interface InteractionHostProps {
	readonly interaction: InteractionView | undefined;
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
}

export function InteractionHost({ interaction, onRespond }: InteractionHostProps) {
	const firstControl = useRef<HTMLElement>(null);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!interaction) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		queueMicrotask(() => firstControl.current?.focus());
		return () => previous?.focus();
	}, [interaction]);

	if (!interaction) return null;
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

	return (
		<div className="modal-backdrop">
		<section aria-describedby="interaction-message" aria-labelledby="interaction-title" aria-modal="true" className="interaction-dialog" role="dialog">
			<h2 id="interaction-title">{interaction.title}</h2>
			<p id="interaction-message">{interaction.message}</p>
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
							<strong>{choice.label}</strong>
							{choice.description && <span>{choice.description}</span>}
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
						{interaction.cancelLabel || "Cancel"}
					</button>
					<button disabled={busy} onClick={() => void respond({ interactionId: interaction.interactionId, kind: "confirm", confirmed: true })} type="button">
						{interaction.confirmLabel || "Confirm"}
					</button>
				</div>
			)}
			{interaction.kind === "input" && (
				<form onSubmit={submitInput}>
					<label className="sr-only" htmlFor="interaction-input">Response</label>
					<input
						autoComplete="off"
						disabled={busy}
						id="interaction-input"
						onChange={(event) => setInput(event.target.value)}
						placeholder={interaction.placeholder}
						ref={firstControl as React.RefObject<HTMLInputElement>}
						type={interaction.secret ? "password" : "text"}
						value={input}
					/>
					<button disabled={busy} type="submit">Submit</button>
				</form>
			)}
			{error && <p className="error-copy" role="alert">{error}</p>}
		</section>
	</div>
	);
}
