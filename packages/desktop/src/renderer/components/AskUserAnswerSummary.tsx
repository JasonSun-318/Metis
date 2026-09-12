import { useTranslation } from "react-i18next";
import { askAnswers, type ToolResultBlock } from "./transcript-turn-model.ts";

export function AskUserAnswerSummary({ result }: { readonly result?: ToolResultBlock }) {
	const { t } = useTranslation();
	if (!result || result.isError) return null;
	const answers = askAnswers(result);
	if (answers.length === 0) return null;
	return <details className="ask-user-answer-summary">
		<summary>{t("Your answers")}</summary>
		<dl>{answers.map((answer, index) => <div key={index}><dt>{answer.question}</dt><dd>{answer.answer}</dd></div>)}</dl>
	</details>;
}
