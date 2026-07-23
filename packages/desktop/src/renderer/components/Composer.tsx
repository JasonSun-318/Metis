import { ArrowUp, FolderPlus, Plus, Stop } from "@phosphor-icons/react";
import { useState, type FormEvent, type ReactNode } from "react";

interface ComposerProps {
	readonly disabled: boolean;
	readonly running: boolean;
	readonly onInterrupt: () => Promise<void>;
	readonly onSubmit: (text: string) => Promise<void>;
	readonly appearance?: "chat" | "code";
	readonly placeholder?: string;
	readonly thinkingControl?: ReactNode;
}

export function Composer({
	disabled,
	running,
	onInterrupt,
	onSubmit,
	appearance = "code",
	placeholder,
	thinkingControl,
}: ComposerProps) {
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
			<form className={`composer composer-${appearance}`} onSubmit={(event) => void submit(event).catch(() => undefined)}>
				<label className="sr-only" htmlFor="composer-input">Message ArcMind</label>
				<textarea
					disabled={disabled || submitting}
					id="composer-input"
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={placeholder ?? (running ? "Steer the active task…" : "Ask ArcMind anything, or describe a task…")}
					rows={1}
					value={text}
				/>
				<div className="composer-actions">
					<div className="composer-leading">
						{appearance === "chat" ? (
							<>
								<button aria-label="Attach files (coming soon)" className="composer-plain-button" disabled title="Coming soon" type="button">
									<Plus aria-hidden="true" size={20} />
								</button>
								<button aria-label="Add folder (coming soon)" className="composer-plain-button" disabled title="Coming soon" type="button">
									<FolderPlus aria-hidden="true" size={19} />
								</button>
							</>
						) : (
							<span>Enter to send · Shift+Enter for a new line</span>
						)}
					</div>
					<div className="composer-trailing">
						{thinkingControl}
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
			{appearance === "chat" && (
				<p className="composer-disclaimer">ArcMind is AI and can make mistakes. Please double-check responses.</p>
			)}
		</div>
	);
}
