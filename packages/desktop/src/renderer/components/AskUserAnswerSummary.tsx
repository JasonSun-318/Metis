import { useTranslation } from "react-i18next";
import { DrawerDetails } from "./DrawerDetails.tsx";
import { askAnswers, type ToolResultBlock } from "./transcript-turn-model.ts";

export function AskUserAnswerSummary({
	result,
	answers: suppliedAnswers,
}: {
	readonly result?: ToolResultBlock;
	readonly answers?: ReturnType<typeof askAnswers>;
}) {
	const { t } = useTranslation();
	if (!suppliedAnswers && (!result || result.isError)) return null;
	const answers = suppliedAnswers ?? askAnswers(result);
	if (answers.length === 0) return null;
	return (
		<DrawerDetails className="conversation-interaction-card ask-user-answer-summary" summary={t("Your answers")}>
			<dl>
				{answers.map((answer, index) => (
					/* biome-ignore lint/suspicious/noArrayIndexKey: Answers are an immutable ordered result without question IDs; rows contain no local state. */
					<div key={index}>
						<dt>{answer.question}</dt>
						<dd>{answer.answer}</dd>
					</div>
				))}
			</dl>
		</DrawerDetails>
	);
}
