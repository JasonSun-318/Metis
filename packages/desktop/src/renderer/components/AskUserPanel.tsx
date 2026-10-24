import type { InteractionResponseInput, InteractionView } from "@metis/app-protocol";
import {
	ArrowRight,
	CaretDown,
	CaretLeft,
	CaretRight,
	ChatCircleDots,
	Check,
	PencilSimple,
} from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type AskUserInteraction = Extract<InteractionView, { kind: "ask_user" }>;
interface AnswerDraft {
	readonly choiceIds: readonly string[];
	readonly customAnswer: string;
}
export interface AskUserDraft {
	readonly sessionId: string;
	readonly questionIndex: number;
	readonly answers: readonly AnswerDraft[];
	readonly collapsed: boolean;
}
interface AskUserPanelProps {
	readonly interaction: AskUserInteraction;
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
	readonly draftCache?: Map<string, AskUserDraft>;
	readonly disabled?: boolean;
}
function hasAnswer(answer: AnswerDraft): boolean {
	return answer.choiceIds.length > 0 || answer.customAnswer.trim().length > 0;
}

export function AskUserPanel({ interaction, onRespond, draftCache, disabled = false }: AskUserPanelProps) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<AskUserDraft>(
		() =>
			draftCache?.get(interaction.interactionId) ?? {
				sessionId: interaction.sessionId,
				questionIndex: 0,
				answers: interaction.questions.map(() => ({ choiceIds: [], customAnswer: "" })),
				collapsed: false,
			},
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const busyRef = useRef(false);
	const mounted = useRef(true);
	const panel = useRef<HTMLElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const resume = useRef<HTMLButtonElement>(null);
	const question = interaction.questions[draft.questionIndex]!;
	const answer = draft.answers[draft.questionIndex]!;
	const titleId = `ask-user-title-${interaction.interactionId}`;
	const finalQuestion = draft.questionIndex === interaction.questions.length - 1;
	const unavailable = busy || disabled;

	const update = (next: AskUserDraft) => {
		draftCache?.set(interaction.interactionId, next);
		setDraft(next);
	};
	const updateAnswer = (next: AnswerDraft) => {
		setError(undefined);
		update({
			...draft,
			answers: draft.answers.map((value, index) => (index === draft.questionIndex ? next : value)),
		});
	};

	useEffect(() => {
		mounted.current = true;
		const conversation =
			panel.current?.closest(".conversation-column") ?? resume.current?.closest(".conversation-column");
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		return () => {
			mounted.current = false;
			queueMicrotask(() => {
				if (conversation?.isConnected && !conversation.querySelector(".ask-user-slot, .ask-user-resume")) {
					conversation.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
				} else if (previous?.isConnected && !previous.closest("[hidden]")) previous.focus();
			});
		};
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies(draft.questionIndex): Each question change moves focus to its newly rendered heading.
	useEffect(() => {
		(draft.collapsed ? resume.current : heading.current)?.focus();
	}, [draft.collapsed, draft.questionIndex]);

	const choose = (choiceId: string) => {
		if (unavailable) return;
		if (!question.multiple) {
			updateAnswer({ choiceIds: [choiceId], customAnswer: "" });
			return;
		}
		updateAnswer({
			...answer,
			choiceIds: answer.choiceIds.includes(choiceId)
				? answer.choiceIds.filter((id) => id !== choiceId)
				: [...answer.choiceIds, choiceId],
		});
	};
	const respond = async (cancelled: boolean) => {
		if (busyRef.current || disabled) return;
		const missing = draft.answers.findIndex((candidate) => !hasAnswer(candidate));
		if (!cancelled && missing >= 0) {
			setError(t("Answer question {{number}} before submitting.", { number: missing + 1 }));
			update({ ...draft, questionIndex: missing });
			return;
		}
		busyRef.current = true;
		setBusy(true);
		setError(undefined);
		// Allow the exit transition to finish; never send if this interaction was removed meanwhile.
		const reduced = document.documentElement.dataset.motion === "reduced";
		await new Promise((resolve) => setTimeout(resolve, reduced ? 0 : 140));
		if (!mounted.current) return;
		try {
			await onRespond({
				interactionId: interaction.interactionId,
				kind: "ask_user",
				cancelled,
				answers: cancelled
					? []
					: interaction.questions.map((candidate, index) => ({
							questionId: candidate.id,
							choiceIds: [...draft.answers[index]!.choiceIds],
							...(draft.answers[index]!.customAnswer.trim()
								? { customAnswer: draft.answers[index]!.customAnswer.trim() }
								: {}),
						})),
			});
		} catch (cause) {
			if (!mounted.current) return;
			setError(cause instanceof Error ? cause.message : "The response could not be sent.");
			busyRef.current = false;
			setBusy(false);
		}
	};
	const navigate = (questionIndex: number) => {
		if (unavailable || questionIndex < 0 || questionIndex >= interaction.questions.length) return;
		setError(undefined);
		update({ ...draft, questionIndex });
	};
	const continueCurrent = () => {
		if (unavailable) return;
		if (finalQuestion) void respond(false);
		else if (hasAnswer(answer)) navigate(draft.questionIndex + 1);
	};
	const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229 || unavailable) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			update({ ...draft, collapsed: true });
			return;
		}
		if (event.target instanceof HTMLTextAreaElement || event.metaKey || event.ctrlKey || event.altKey) return;
		const controls = [...(panel.current?.querySelectorAll<HTMLButtonElement>(".ask-user-option") ?? [])];
		const current = controls.indexOf(event.target as HTMLButtonElement);
		if (current >= 0 && ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
			event.preventDefault();
			const index =
				event.key === "Home"
					? 0
					: event.key === "End"
						? controls.length - 1
						: (current + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + controls.length) %
							controls.length;
			if (!question.multiple) choose(question.choices[index]!.id);
			controls[index]?.focus();
			return;
		}
		const index = Number(event.key) - 1;
		if (/^[1-4]$/.test(event.key) && question.choices[index]) {
			event.preventDefault();
			choose(question.choices[index]!.id);
			controls[index]?.focus();
		}
	};

	if (draft.collapsed)
		return (
			<div className="ask-user-resume">
				<ChatCircleDots aria-hidden="true" size={20} />
				<div>
					<strong>{t("Waiting for your answer")}</strong>
					<span>{question.question}</span>
				</div>
				<button
					className="button-secondary"
					onClick={() => update({ ...draft, collapsed: false })}
					ref={resume}
					type="button"
				>
					{t("Continue answering")}
				</button>
			</div>
		);

	return (
		<div className={`ask-user-slot${busy ? " is-submitting" : ""}`}>
			<section
				aria-busy={busy}
				aria-labelledby={titleId}
				className="ask-user-panel"
				onKeyDown={handleKeyDown}
				ref={panel}
				role="dialog"
			>
				<div className="ask-user-content" key={question.id}>
					<header className="ask-user-header">
						<h2 id={titleId} ref={heading} tabIndex={-1}>
							{question.question}
						</h2>
						<div className="ask-user-header-actions">
							<button
								aria-label={t("Previous question")}
								disabled={unavailable || draft.questionIndex === 0}
								onClick={() => navigate(draft.questionIndex - 1)}
								type="button"
							>
								<CaretLeft aria-hidden="true" size={16} />
							</button>
							<small>
								<span className="sr-only">
									{t("{{current}} of {{total}}", {
										current: draft.questionIndex + 1,
										total: interaction.questions.length,
									})}
								</span>
								<span aria-hidden="true">
									{draft.questionIndex + 1} / {interaction.questions.length}
								</span>
							</small>
							<button
								aria-label={t("Next question")}
								disabled={unavailable || finalQuestion}
								onClick={() => navigate(draft.questionIndex + 1)}
								type="button"
							>
								<CaretRight aria-hidden="true" size={16} />
							</button>
						</div>
					</header>
					{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both conditional roles support this attribute: group/radiogroup labels and checkbox/radio checked state. */}
					<div
						aria-labelledby={titleId}
						className="ask-user-options"
						role={question.multiple ? "group" : "radiogroup"}
					>
						{question.choices.map((choice, index) => {
							const selected = answer.choiceIds.includes(choice.id);
							return (
								/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both conditional roles support this attribute: group/radiogroup labels and checkbox/radio checked state. */
								<button
									aria-checked={selected}
									className={`ask-user-option${selected ? " is-selected" : ""}`}
									disabled={unavailable}
									key={choice.id}
									onClick={() => choose(choice.id)}
									role={question.multiple ? "checkbox" : "radio"}
									tabIndex={
										question.multiple || selected || (answer.choiceIds.length === 0 && index === 0) ? 0 : -1
									}
									type="button"
								>
									<span
										aria-hidden="true"
										className={question.multiple ? "ask-user-checkbox" : "ask-user-option-number"}
									>
										{selected ? <Check size={12} weight="bold" /> : !question.multiple && index + 1}
									</span>
									<span className="ask-user-option-copy">
										<strong>{choice.label}</strong>
										{choice.description && <small>{choice.description}</small>}
									</span>
								</button>
							);
						})}
					</div>
					<div className={`ask-user-custom${answer.customAnswer.trim() ? " is-selected" : ""}`}>
						<span className="ask-user-option-number" aria-hidden="true">
							<PencilSimple size={14} />
						</span>
						<label className="ask-user-option-copy">
							<strong>{t("Something else")}</strong>
							<textarea
								aria-label={t("Something else")}
								disabled={unavailable}
								maxLength={4096}
								onChange={(event) =>
									updateAnswer({
										choiceIds: question.multiple ? answer.choiceIds : [],
										customAnswer: event.target.value,
									})
								}
								placeholder={t("Type your own answer…")}
								rows={1}
								value={answer.customAnswer}
							/>
						</label>
					</div>
					{disabled && <output className="status-paragraph">{t("Reconnecting. Your answers are kept.")}</output>}
					{error && (
						<p className="error-copy ask-user-error" role="alert">
							{t(error)}
						</p>
					)}
				</div>
				<footer className="ask-user-actions">
					<div>
						<button
							aria-label={t("Collapse questions")}
							className="composer-panel-toggle"
							disabled={busy}
							onClick={() => update({ ...draft, collapsed: true })}
							type="button"
						>
							<CaretDown aria-hidden="true" size={16} />
						</button>
					</div>
					<div>
						<button
							aria-label={t("Skip all questions")}
							className="ask-user-skip"
							disabled={unavailable}
							onClick={() => void respond(true)}
							type="button"
						>
							{t("Skip all")}
						</button>
						<button
							className="ask-user-step"
							disabled={(!finalQuestion && !hasAnswer(answer)) || unavailable}
							onClick={continueCurrent}
							type="button"
						>
							{t(busy ? "Sending…" : finalQuestion ? "Confirm and continue" : "Continue")}
							<ArrowRight aria-hidden="true" size={15} />
						</button>
					</div>
				</footer>
			</section>
		</div>
	);
}
