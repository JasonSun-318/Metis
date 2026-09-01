import { getModel } from "@metis/ai/compat";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.ts";
import {
	type AskUserInput,
	AskUserParams,
	type AskUserRequest,
	createAskUserToolDefinition,
} from "../src/core/ask-user.ts";
import { classifyAction } from "../src/core/permissions/classify.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

function validInput(): AskUserInput {
	return {
		questions: [
			{
				question: "Where should task data be stored?",
				multiple: false,
				options: [
					{ label: "Local database", description: "Works offline" },
					{ label: "Cloud sync", description: "Works across devices" },
				],
			},
			{
				question: "Which clients should be supported?",
				multiple: true,
				options: [{ label: "Desktop" }, { label: "Web" }, { label: "Mobile" }],
			},
		],
	};
}

describe("ask_user", () => {
	it("publishes a bounded strict model contract", () => {
		const tool = createAskUserToolDefinition();
		expect(tool.name).toBe("ask_user");
		expect(tool.promptSnippet).toBe("Ask the user to choose a direction");
		expect(tool.description).toBe(
			"Ask the user 1-4 questions when a choice or preference is required to continue. " +
				"Each question must provide 2-4 options and set multiple. The user can also write a custom answer. " +
				"Do not use for permissions, destructive confirmations, or secrets.",
		);
		expect(Object.keys(AskUserParams.properties)).toEqual(["questions"]);
		expect(Value.Check(AskUserParams, validInput())).toBe(true);
		expect(Value.Check(AskUserParams, { questions: [] })).toBe(false);
		expect(
			Value.Check(AskUserParams, {
				questions: Array.from({ length: 5 }, () => validInput().questions[0]),
			}),
		).toBe(false);
		expect(
			Value.Check(AskUserParams, {
				questions: [
					{
						question: "Choose",
						multiple: false,
						options: Array.from({ length: 5 }, (_, index) => ({ label: `Option ${index + 1}` })),
					},
				],
			}),
		).toBe(false);
		expect(
			Value.Check(AskUserParams, {
				questions: [{ question: "Choose", multiple: false, options: [{ label: "Only" }] }],
			}),
		).toBe(false);
		expect(
			Value.Check(AskUserParams, {
				questions: [{ question: "Choose", options: [{ label: "A" }, { label: "B" }] }],
			}),
		).toBe(false);
		expect(Value.Check(AskUserParams, { ...validInput(), extra: true })).toBe(false);
	});

	it("normalizes questions and returns single, multi, and custom answers", async () => {
		let received: AskUserRequest | undefined;
		const tool = createAskUserToolDefinition(async (request) => {
			received = request;
			return {
				cancelled: false,
				answers: [
					{ selectedOptionIndexes: [1] },
					{ selectedOptionIndexes: [0, 2], customAnswer: "  Linux later  " },
				],
			};
		});
		const input = validInput();
		input.questions[0]!.question = "  Where should task data be stored?  ";
		input.questions[0]!.options[0]!.label = "  Local database  ";

		const result = await tool.execute("ask-1", input, undefined, undefined, {} as never);

		expect(received?.questions[0]).toEqual({
			question: "Where should task data be stored?",
			multiple: false,
			options: [
				{ label: "Local database", description: "Works offline" },
				{ label: "Cloud sync", description: "Works across devices" },
			],
		});
		expect(result.details).toEqual({
			cancelled: false,
			questions: received?.questions,
			answers: [
				{ question: "Where should task data be stored?", selected: ["Cloud sync"] },
				{
					question: "Which clients should be supported?",
					selected: ["Desktop", "Mobile"],
					customAnswer: "Linux later",
				},
			],
		});
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Cloud sync");
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Linux later");
	});

	it("returns explicit cancellation without treating it as a tool error", async () => {
		const tool = createAskUserToolDefinition(async () => ({ cancelled: true, answers: [] }));
		const result = await tool.execute("ask-cancel", validInput(), undefined, undefined, {} as never);

		expect(result.details).toMatchObject({ cancelled: true, answers: [] });
		expect(result.content).toEqual([
			{ type: "text", text: "The user cancelled these questions. Do not assume an answer." },
		]);
	});

	it("rejects blank and duplicate normalized labels", async () => {
		const handler = vi.fn();
		const tool = createAskUserToolDefinition(handler);
		const blank = validInput();
		blank.questions[0]!.question = "   ";
		await expect(tool.execute("blank", blank, undefined, undefined, {} as never)).rejects.toThrow(
			"Question text cannot be blank",
		);

		const duplicate = validInput();
		duplicate.questions[0]!.options = [{ label: "Local" }, { label: " local " }];
		await expect(tool.execute("duplicate", duplicate, undefined, undefined, {} as never)).rejects.toThrow(
			"Option labels must be unique within a question",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("rejects malformed handler answers", async () => {
		const cases = [
			{ cancelled: false, answers: [{ selectedOptionIndexes: [0] }] },
			{
				cancelled: false,
				answers: [{ selectedOptionIndexes: [0], customAnswer: "Both" }, { selectedOptionIndexes: [0] }],
			},
			{
				cancelled: false,
				answers: [{ selectedOptionIndexes: [8] }, { selectedOptionIndexes: [0] }],
			},
			{
				cancelled: false,
				answers: [{ selectedOptionIndexes: [0] }, { selectedOptionIndexes: [] }],
			},
			{ cancelled: true, answers: [{ selectedOptionIndexes: [0] }] },
		] as const;

		for (const [index, response] of cases.entries()) {
			const tool = createAskUserToolDefinition(async () => response);
			await expect(
				tool.execute(`invalid-${index}`, validInput(), undefined, undefined, {} as never),
			).rejects.toThrow();
		}
	});

	it("does not invoke the handler after execution has been aborted", async () => {
		const handler = vi.fn();
		const tool = createAskUserToolDefinition(handler);
		const controller = new AbortController();
		controller.abort();

		await expect(tool.execute("aborted", validInput(), controller.signal, undefined, {} as never)).rejects.toThrow(
			"Ask user was aborted",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("is permission-safe but remains absent from the built-in registry", () => {
		const action = classifyAction({
			actionId: "ask-1",
			toolName: "ask_user",
			provenance: "builtin",
			args: validInput(),
			cwd: process.cwd(),
			workspaceRoots: [process.cwd()],
		});
		expect(action.risks).toEqual(["ordinary-read"]);
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).not.toContain("ask_user");
	});

	it("is not exposed to a normal model session before the UI capability is enabled", async () => {
		const services = await createAgentSessionServices({
			cwd: process.cwd(),
			resourceLoaderOptions: {
				noContextFiles: true,
				noExtensions: true,
				noPromptTemplates: true,
				noSkills: true,
				noThemes: true,
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(process.cwd(), { mode: "code" }),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		expect(result.session.getAllTools().map(({ name }) => name)).not.toContain("ask_user");
		expect(result.session.getActiveToolNames()).not.toContain("ask_user");
		expect(result.session.systemPrompt).not.toContain("ask_user");
		result.session.dispose();
	});
});
