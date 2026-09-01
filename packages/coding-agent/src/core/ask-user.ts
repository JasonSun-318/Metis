import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "./extensions/types.ts";
import { permissionClaim, permissionDescriptor } from "./tool-permission-adapter.ts";

export const MAX_ASK_USER_QUESTIONS = 4;
export const MAX_ASK_USER_OPTIONS = 4;
export const MAX_ASK_USER_CUSTOM_ANSWER_LENGTH = 4096;

const AskUserOptionSchema = Type.Object(
	{
		label: Type.String({ minLength: 1, maxLength: 120 }),
		description: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
	},
	{ additionalProperties: false },
);

const AskUserQuestionSchema = Type.Object(
	{
		question: Type.String({ minLength: 1, maxLength: 512 }),
		multiple: Type.Boolean(),
		options: Type.Array(AskUserOptionSchema, { minItems: 2, maxItems: MAX_ASK_USER_OPTIONS }),
	},
	{ additionalProperties: false },
);

export const AskUserParams = Type.Object(
	{
		questions: Type.Array(AskUserQuestionSchema, { minItems: 1, maxItems: MAX_ASK_USER_QUESTIONS }),
	},
	{ additionalProperties: false },
);

export type AskUserInput = Static<typeof AskUserParams>;
export type AskUserOption = AskUserInput["questions"][number]["options"][number];
export type AskUserQuestion = AskUserInput["questions"][number];

export interface AskUserRequest {
	readonly questions: readonly AskUserQuestion[];
	readonly signal?: AbortSignal;
}

export interface AskUserResponseAnswer {
	readonly selectedOptionIndexes: readonly number[];
	readonly customAnswer?: string;
}

export interface AskUserResponse {
	readonly cancelled: boolean;
	readonly answers: readonly AskUserResponseAnswer[];
}

export type RequestUserInput = (request: AskUserRequest) => Promise<AskUserResponse>;

export interface AskUserAnswer {
	readonly question: string;
	readonly selected: readonly string[];
	readonly customAnswer?: string;
}

export interface AskUserDetails {
	readonly questions: readonly AskUserQuestion[];
	readonly cancelled: boolean;
	readonly answers: readonly AskUserAnswer[];
}

function normalizeInput(input: AskUserInput): AskUserQuestion[] {
	if (!Value.Check(AskUserParams, input)) throw new TypeError("Invalid ask_user arguments");
	return input.questions.map((candidate) => {
		const question = candidate.question.trim();
		if (!question) throw new TypeError("Question text cannot be blank");
		const options = candidate.options.map((candidateOption) => {
			const label = candidateOption.label.trim();
			if (!label) throw new TypeError("Option labels cannot be blank");
			const description = candidateOption.description?.trim();
			if (candidateOption.description !== undefined && !description) {
				throw new TypeError("Option descriptions cannot be blank");
			}
			return { label, ...(description === undefined ? {} : { description }) };
		});
		const uniqueLabels = new Set(options.map(({ label }) => label.toLowerCase()));
		if (uniqueLabels.size !== options.length) {
			throw new TypeError("Option labels must be unique within a question");
		}
		return { question, multiple: candidate.multiple, options };
	});
}

function validatedAnswers(questions: readonly AskUserQuestion[], response: AskUserResponse): AskUserAnswer[] {
	if (typeof response !== "object" || response === null || typeof response.cancelled !== "boolean") {
		throw new TypeError("ask_user received an invalid response");
	}
	if (!Array.isArray(response.answers)) throw new TypeError("ask_user response answers must be an array");
	if (response.cancelled) {
		if (response.answers.length !== 0) throw new TypeError("A cancelled ask_user response cannot contain answers");
		return [];
	}
	if (response.answers.length !== questions.length) {
		throw new TypeError("ask_user must receive one answer for every question");
	}

	return questions.map((question, questionIndex) => {
		const answer = response.answers[questionIndex];
		if (!answer || !Array.isArray(answer.selectedOptionIndexes)) {
			throw new TypeError("ask_user selected option indexes must be an array");
		}
		const selectedOptionIndexes = [...answer.selectedOptionIndexes];
		if (
			selectedOptionIndexes.some(
				(index) => !Number.isInteger(index) || index < 0 || index >= question.options.length,
			)
		) {
			throw new TypeError("ask_user selected an unknown option");
		}
		if (new Set(selectedOptionIndexes).size !== selectedOptionIndexes.length) {
			throw new TypeError("ask_user cannot select the same option twice");
		}
		const customAnswer = answer.customAnswer?.trim();
		if (answer.customAnswer !== undefined) {
			if (!customAnswer) throw new TypeError("A custom answer cannot be blank");
			if (customAnswer.length > MAX_ASK_USER_CUSTOM_ANSWER_LENGTH) {
				throw new TypeError("A custom answer is too long");
			}
		}
		const answerSources = selectedOptionIndexes.length + (customAnswer === undefined ? 0 : 1);
		if (question.multiple ? answerSources === 0 : answerSources !== 1) {
			throw new TypeError(
				question.multiple
					? "A multi-select question requires at least one answer"
					: "A single-select question requires exactly one answer",
			);
		}
		return {
			question: question.question,
			selected: selectedOptionIndexes.map((index) => question.options[index]!.label),
			...(customAnswer === undefined ? {} : { customAnswer }),
		};
	});
}

export function createAskUserToolDefinition(
	requestUserInput?: RequestUserInput,
): ToolDefinition<typeof AskUserParams, AskUserDetails> {
	return {
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user 1-4 questions when a choice or preference is required to continue. Each question must provide 2-4 options and set multiple. The user can also write a custom answer. Do not use for permissions, destructive confirmations, or secrets.",
		promptSnippet: "Ask the user to choose a direction",
		parameters: AskUserParams,
		permission: permissionDescriptor(() => permissionClaim()),
		executionMode: "sequential",
		async execute(_toolCallId, input, signal) {
			if (signal?.aborted) throw new Error("Ask user was aborted");
			if (!requestUserInput) throw new Error("No interactive session owner is available");
			const questions = normalizeInput(input);
			const response = await requestUserInput({ questions, signal });
			if (signal?.aborted) throw new Error("Ask user was aborted");
			const answers = validatedAnswers(questions, response);
			const details: AskUserDetails = { questions, cancelled: response.cancelled, answers };
			return {
				content: [
					{
						type: "text",
						text: response.cancelled
							? "The user cancelled these questions. Do not assume an answer."
							: `User answers:\n${JSON.stringify(answers, null, 2)}`,
					},
				],
				details,
			};
		},
	};
}
