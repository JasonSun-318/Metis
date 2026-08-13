import type { InteractionResponseInput, InteractionView } from "@metis/app-protocol";
import {
	ArrowBendDownLeft,
	ArrowRight,
	ArrowUp,
	CaretLeft,
	CaretRight,
	Check,
	PencilSimple,
	X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

type AskUserInteraction = Extract<InteractionView, { kind: "ask_user" }>;

interface AskUserPanelProps {
	readonly interaction: AskUserInteraction;
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
}

interface AnswerDraft {
	readonly choiceIds: readonly string[];
	readonly customAnswer: string;
}

function blankDraft(): AnswerDraft {
	return { choiceIds: [], customAnswer: "" };
}

function draftHasAnswer(draft: AnswerDraft): boolean {
	return draft.choiceIds.length > 0 || draft.customAnswer.trim().length > 0;
}

export function AskUserPanel({ interaction, onRespond }: AskUserPanelProps) {
	const { t } = useTranslation();
	const [questionIndex, setQuestionIndex] = useState(0);
	const [drafts, setDrafts] = useState<readonly AnswerDraft[]>(() =>
		interaction.questions.map(() => blankDraft()),
	);
	const [customQuestionId, setCustomQuestionId] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const firstOption = useRef<HTMLButtonElement>(null);
	const customInput = useRef<HTMLInputElement>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const question = interaction.questions[questionIndex]!;
	const questionHeadingId = `ask-user-title-${interaction.interactionId}`;
	const draft = drafts[questionIndex] ?? blankDraft();
	const customOpen = customQuestionId === question.id || draft.customAnswer.length > 0;
	const hasAnswer = draftHasAnswer(draft);
	const allAnswered = drafts.every(draftHasAnswer);
	const selectedCount = draft.choiceIds.length + (draft.customAnswer.trim().length > 0 ? 1 : 0);

	useEffect(() => {
		previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		queueMicrotask(() => firstOption.current?.focus());
		return () => previousFocus.current?.focus();
	}, []);

	useEffect(() => {
		queueMicrotask(() => firstOption.current?.focus());
	}, [questionIndex]);

	const respond = async (response: InteractionResponseInput) => {
		setBusy(true);
		setError(undefined);
		try {
			await onRespond(response);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The response could not be sent.");
			setBusy(false);
		}
	};

	const cancel = () => respond({
		interactionId: interaction.interactionId,
		kind: "ask_user",
		cancelled: true,
		answers: [],
	});

	const submitAnswers = (nextDrafts: readonly AnswerDraft[]) => respond({
		interactionId: interaction.interactionId,
		kind: "ask_user",
		cancelled: false,
		answers: interaction.questions.map((candidate, index) => {
			const answer = nextDrafts[index] ?? blankDraft();
			const customAnswer = answer.customAnswer.trim();
			return {
				questionId: candidate.id,
				choiceIds: [...answer.choiceIds],
				...(customAnswer ? { customAnswer } : {}),
			};
		}),
	});

	const continueWith = (nextDrafts: readonly AnswerDraft[]) => {
		if (questionIndex < interaction.questions.length - 1) {
			setQuestionIndex((current) => current + 1);
			return;
		}
		const unansweredIndex = nextDrafts.findIndex((candidate) => !draftHasAnswer(candidate));
		if (unansweredIndex >= 0) {
			setQuestionIndex(unansweredIndex);
			return;
		}
		void submitAnswers(nextDrafts);
	};

	const replaceCurrentDraft = (nextDraft: AnswerDraft): AnswerDraft[] => {
		const next = [...drafts];
		next[questionIndex] = nextDraft;
		setDrafts(next);
		return next;
	};

	const choose = (choiceId: string) => {
		if (busy) return;
		if (!question.multiple) {
			const next = replaceCurrentDraft({ choiceIds: [choiceId], customAnswer: "" });
			continueWith(next);
			return;
		}
		const selected = draft.choiceIds.includes(choiceId)
			? draft.choiceIds.filter((id) => id !== choiceId)
			: [...draft.choiceIds, choiceId];
		replaceCurrentDraft({ ...draft, choiceIds: selected });
	};

	const openCustom = () => {
		if (busy) return;
		setCustomQuestionId(question.id);
		if (!question.multiple && draft.choiceIds.length > 0) {
			replaceCurrentDraft({ choiceIds: [], customAnswer: draft.customAnswer });
		}
		queueMicrotask(() => customInput.current?.focus());
	};

	const updateCustom = (value: string) => {
		replaceCurrentDraft({
			choiceIds: question.multiple ? draft.choiceIds : [],
			customAnswer: value,
		});
	};

	const continueCurrent = () => {
		if (!hasAnswer || busy) return;
		continueWith(drafts);
	};

	const previousQuestion = () => {
		if (busy || questionIndex === 0) return;
		setQuestionIndex((current) => current - 1);
	};

	const nextQuestion = () => {
		if (busy || questionIndex === interaction.questions.length - 1) return;
		setQuestionIndex((current) => current + 1);
	};

	const submitCustom = (event: FormEvent) => {
		event.preventDefault();
		continueCurrent();
	};

	const handlePanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape" && !busy) {
			event.preventDefault();
			void cancel();
			return;
		}
		if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
		const optionIndex = Number(event.key) - 1;
		if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.choices.length) return;
		event.preventDefault();
		choose(question.choices[optionIndex]!.id);
	};

	return (
		<div className="ask-user-slot">
			<section
				aria-busy={busy}
				aria-labelledby={questionHeadingId}
				className="ask-user-panel"
				onKeyDown={handlePanelKeyDown}
				role="dialog"
			>
				<header className="ask-user-header">
					<h2 aria-atomic="true" aria-live="polite" id={questionHeadingId}>{question.question}</h2>
					<div className="ask-user-header-actions">
						{interaction.questions.length > 1 && (
							<div className="ask-user-progress">
								<button
									aria-label={t("Previous question")}
									disabled={busy || questionIndex === 0}
									onClick={previousQuestion}
									type="button"
								>
									<CaretLeft aria-hidden="true" size={14} />
								</button>
								<small aria-live="polite">
									{t("{{current}} of {{total}}", {
										current: questionIndex + 1,
										total: interaction.questions.length,
									})}
								</small>
								<button
									aria-label={t("Next question")}
									disabled={busy || questionIndex === interaction.questions.length - 1}
									onClick={nextQuestion}
									type="button"
								>
									<CaretRight aria-hidden="true" size={14} />
								</button>
							</div>
						)}
					<button
						aria-label={t("Skip questions")}
						className="ask-user-close"
						disabled={busy}
						onClick={() => void cancel()}
						type="button"
					>
						<X aria-hidden="true" size={15} />
					</button>
					</div>
				</header>

				<div
					aria-labelledby={questionHeadingId}
					className="ask-user-options"
					role={question.multiple ? "group" : "radiogroup"}
				>
					{question.choices.map((choice, index) => {
						const selected = draft.choiceIds.includes(choice.id);
						return (
							<button
								aria-checked={selected}
								className={`ask-user-option${question.multiple ? " is-multiple" : " is-single"}${selected ? " is-selected" : ""}`}
								disabled={busy}
								key={choice.id}
								onClick={() => choose(choice.id)}
								ref={index === 0 ? firstOption : undefined}
								role={question.multiple ? "checkbox" : "radio"}
								type="button"
							>
								{question.multiple ? (
									<span className="ask-user-checkbox" aria-hidden="true">
										{selected && <Check size={13} weight="bold" />}
									</span>
								) : (
									<span className="ask-user-option-number" aria-hidden="true">{index + 1}</span>
								)}
								<span className="ask-user-option-copy">
									<strong>{choice.label}</strong>
									{choice.description && <small>{choice.description}</small>}
								</span>
								{!question.multiple && <ArrowBendDownLeft aria-hidden="true" size={15} />}
							</button>
						);
					})}

					<div className={`ask-user-custom${question.multiple ? " is-multiple" : " is-single"}${customOpen ? " is-open" : ""}`}>
						{question.multiple ? (
							<span className={`ask-user-checkbox${draft.customAnswer.trim() ? " is-selected" : ""}`} aria-hidden="true">
								{draft.customAnswer.trim() && <Check size={13} weight="bold" />}
							</span>
						) : <PencilSimple aria-hidden="true" size={15} />}
						{customOpen ? (
							<form onSubmit={submitCustom}>
								<label className="sr-only" htmlFor={`ask-user-custom-${interaction.interactionId}`}>
									{t("Something else")}
								</label>
								<input
									autoComplete="off"
									disabled={busy}
									id={`ask-user-custom-${interaction.interactionId}`}
									maxLength={4096}
									onChange={(event) => updateCustom(event.target.value)}
									placeholder={t("Type your own answer…")}
									ref={customInput}
									value={draft.customAnswer}
								/>
								<button aria-label={t("Use custom answer")} disabled={!draft.customAnswer.trim() || busy} type="submit">
									<ArrowBendDownLeft aria-hidden="true" size={15} />
								</button>
							</form>
						) : (
							<button
								aria-checked={question.multiple ? false : undefined}
								disabled={busy}
								onClick={openCustom}
								role={question.multiple ? "checkbox" : undefined}
								type="button"
							>
								{t("Something else")}
							</button>
						)}
						{!question.multiple && (
							<button className="ask-user-skip" disabled={busy} onClick={() => void cancel()} type="button">
								{t("Skip")}
							</button>
						)}
					</div>
				</div>

				{question.multiple && (
					<footer className="ask-user-actions">
						<span aria-live="polite">{t("{{count}} selected", { count: selectedCount })}</span>
						<div>
							<button className="ask-user-skip" disabled={busy} onClick={() => void cancel()} type="button">
								{t("Skip")}
							</button>
							<button
								aria-label={t(questionIndex === interaction.questions.length - 1 && allAnswered ? "Submit answers" : "Next question")}
								className={`ask-user-step${questionIndex === interaction.questions.length - 1 && allAnswered ? " is-submit" : ""}`}
								disabled={!hasAnswer || busy}
								onClick={continueCurrent}
								type="button"
							>
								{questionIndex === interaction.questions.length - 1 && allAnswered
									? <ArrowUp aria-hidden="true" size={16} />
									: <ArrowRight aria-hidden="true" size={16} />}
							</button>
						</div>
					</footer>
				)}
				{error && <p className="error-copy ask-user-error" role="alert">{t(error)}</p>}
			</section>
		</div>
	);
}
