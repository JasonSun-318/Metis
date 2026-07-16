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
		<form className="composer" onSubmit={(event) => void submit(event)}>
			<label className="sr-only" htmlFor="composer-input">Message ArcMind</label>
			<textarea
				disabled={disabled || submitting}
				id="composer-input"
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
				}}
				placeholder={running ? "Steer the active turn…" : "Ask ArcMind to work on this project…"}
				rows={3}
				value={text}
			/>
			<div className="composer-actions">
				<span>⌘/Ctrl + Enter to send</span>
				<div>
					{running && (
						<button className="button-secondary" disabled={disabled} onClick={() => void onInterrupt()} type="button">
							Stop
						</button>
					)}
					<button disabled={disabled || submitting || text.trim().length === 0} type="submit">
						{running ? "Steer" : "Send"}
					</button>
				</div>
			</div>
		</form>
	);
}
