import { ArrowUp, Stop } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";

interface ComposerProps {
	readonly disabled: boolean;
	readonly running: boolean;
	readonly onInterrupt: () => Promise<void>;
	readonly onSubmit: (text: string) => Promise<void>;
}

export function Composer({ disabled, running, onInterrupt, onSubmit }: ComposerProps) {
	const [text, setText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const prompt = text.trim();
		if (!prompt || disabled || submitting) return;
		setSubmitting(true);
		try {
			await onSubmit(prompt);
			setText("");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="composer-dock">
			<form className="composer" onSubmit={(event) => void submit(event)}>
				<label className="sr-only" htmlFor="composer-input">Message ArcMind</label>
				<textarea
					disabled={disabled || submitting}
					id="composer-input"
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={running ? "Steer the active task…" : "Ask ArcMind anything, or describe a task…"}
					rows={2}
					value={text}
				/>
				<div className="composer-actions">
					<span>Enter to send · Shift+Enter for a new line</span>
					<div>
						{running && (
							<button aria-label="Stop task" className="composer-icon-button button-secondary" disabled={disabled} onClick={() => void onInterrupt()} type="button">
								<Stop aria-hidden="true" size={16} weight="fill" />
							</button>
						)}
						<button aria-label={running ? "Steer task" : "Send message"} className="composer-icon-button composer-send" disabled={disabled || submitting || text.trim().length === 0} type="submit">
							<ArrowUp aria-hidden="true" size={19} weight="bold" />
						</button>
					</div>
				</div>
			</form>
		</div>
	);
}
