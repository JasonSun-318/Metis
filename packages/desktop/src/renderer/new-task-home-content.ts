export type HomePeriod = "morning" | "noon" | "afternoon" | "evening" | "late";

export interface HomeGreeting {
	readonly id: string;
	readonly period: HomePeriod | "anytime";
	readonly key: string;
	readonly anonymousKey: string;
}

export type HomeStarterId =
	| "report"
	| "slides"
	| "spreadsheet"
	| "research"
	| "document"
	| "plan"
	| "writing"
	| "compare"
	| "meeting"
	| "feature"
	| "debug"
	| "explain"
	| "review"
	| "test"
	| "performance";

export interface HomeStarter {
	readonly id: HomeStarterId;
	readonly title: string;
	readonly description: string;
	readonly prompt: string;
}

export const HOME_GREETINGS: readonly HomeGreeting[] = [
	{
		id: "morning-hello",
		period: "morning",
		key: "Good morning, {{name}}.",
		anonymousKey: "Good morning.",
	},
	{
		id: "morning-start",
		period: "morning",
		key: "{{name}}, a good day starts now.",
		anonymousKey: "A good day starts now.",
	},
	{
		id: "morning-first",
		period: "morning",
		key: "{{name}}, ready for your first win?",
		anonymousKey: "Ready for your first win?",
	},
	{
		id: "noon-hello",
		period: "noon",
		key: "Hello, {{name}}.",
		anonymousKey: "Hello.",
	},
	{
		id: "noon-idea",
		period: "noon",
		key: "{{name}}, what's today's idea?",
		anonymousKey: "What's today's idea?",
	},
	{
		id: "noon-small",
		period: "noon",
		key: "{{name}}, one small step?",
		anonymousKey: "One small step?",
	},
	{
		id: "afternoon-hello",
		period: "afternoon",
		key: "Good afternoon, {{name}}.",
		anonymousKey: "Good afternoon.",
	},
	{
		id: "afternoon-progress",
		period: "afternoon",
		key: "{{name}}, keep the momentum going.",
		anonymousKey: "Keep the momentum going.",
	},
	{
		id: "afternoon-unblock",
		period: "afternoon",
		key: "{{name}}, clear a roadblock?",
		anonymousKey: "Clear a roadblock?",
	},
	{
		id: "evening-hello",
		period: "evening",
		key: "Good evening, {{name}}.",
		anonymousKey: "Good evening.",
	},
	{
		id: "evening-wrap",
		period: "evening",
		key: "{{name}}, wrap up today or start fresh.",
		anonymousKey: "Wrap up today or start fresh.",
	},
	{
		id: "evening-tomorrow",
		period: "evening",
		key: "{{name}}, set tomorrow up well.",
		anonymousKey: "Set tomorrow up well.",
	},
	{
		id: "late-idea",
		period: "late",
		key: "{{name}}, still chasing an idea?",
		anonymousKey: "Still chasing an idea?",
	},
	{
		id: "late-company",
		period: "late",
		key: "I'm here, {{name}}.",
		anonymousKey: "I'm here.",
	},
	{
		id: "anytime-idea",
		period: "anytime",
		key: "{{name}}, what shall we try?",
		anonymousKey: "What shall we try?",
	},
	{
		id: "anytime-shape",
		period: "anytime",
		key: "{{name}}, let's shape an idea.",
		anonymousKey: "Let's shape an idea.",
	},
	{
		id: "anytime-task",
		period: "anytime",
		key: "{{name}}, what can I take on?",
		anonymousKey: "What can I take on?",
	},
	{
		id: "anytime-result",
		period: "anytime",
		key: "{{name}}, let's make it shareable.",
		anonymousKey: "Let's make it shareable.",
	},
	{
		id: "anytime-start",
		period: "anytime",
		key: "{{name}}, let's start with a chat.",
		anonymousKey: "Let's start with a chat.",
	},
];

const CODE_ONLY_GREETINGS: readonly HomeGreeting[] = [
	{
		id: "code-morning-idea",
		period: "morning",
		key: "{{name}}, ready to build?",
		anonymousKey: "Ready to build?",
	},
	{
		id: "code-afternoon-change",
		period: "afternoon",
		key: "{{name}}, ready to ship a change?",
		anonymousKey: "Ready to ship a change?",
	},
	{
		id: "code-evening-clearer",
		period: "evening",
		key: "{{name}}, leave the code better.",
		anonymousKey: "Leave the code better.",
	},
	{
		id: "code-anytime-build",
		period: "anytime",
		key: "{{name}}, what shall we build?",
		anonymousKey: "What shall we build?",
	},
];

export const CODE_HOME_GREETINGS: readonly HomeGreeting[] = [...HOME_GREETINGS, ...CODE_ONLY_GREETINGS];

export const HOME_STARTERS: readonly HomeStarter[] = [
	{
		id: "report",
		title: "Prepare a report",
		description: "Summarize progress, results, and next steps",
		prompt:
			"Help me prepare a report about [topic] for [audience]. Use the materials I provide to organize the background, progress, results, challenges, and next steps. Highlight the key takeaways. Ask a few focused questions first if essential information is missing.",
	},
	{
		id: "slides",
		title: "Create a presentation",
		description: "Turn a topic into a slide deck",
		prompt:
			"Help me create an editable presentation about [topic] for [audience], for [occasion], with approximately [number of slides] slides. First confirm the key message and outline with me, then develop the slide content and layout. Ask me for reference materials when needed.",
	},
	{
		id: "spreadsheet",
		title: "Analyze a spreadsheet",
		description: "Find trends and key takeaways",
		prompt:
			"Analyze the spreadsheet I provide, focusing on [my question]. Check the field definitions and data quality, then summarize key metrics, trends, and anomalies. Use charts where helpful and explain the evidence and limitations. First remind me to attach the spreadsheet.",
	},
	{
		id: "research",
		title: "Research a topic",
		description: "Gather sources and build a research report",
		prompt:
			"Research [topic], focusing on [questions or scope]. Gather relevant material, compare different perspectives, and produce a structured report with verifiable sources. Confirm the scope and desired depth with me before starting.",
	},
	{
		id: "document",
		title: "Organize a document",
		description: "Extract key points and improve structure",
		prompt:
			"Organize the document I provide: extract the main ideas, merge repeated material, improve the structure, and list information that needs to be added or confirmed. Preserve the original meaning. First ask me to attach the document or paste its contents.",
	},
	{
		id: "plan",
		title: "Make a plan",
		description: "Break a goal into practical steps",
		prompt:
			"I want to achieve [goal] within [timeframe], with [resources or constraints]. Break it into stages, concrete actions, priorities, and checkpoints to create a practical plan. Clarify anything essential that is unclear.",
	},
	{
		id: "writing",
		title: "Polish writing",
		description: "Refine the wording and sharpen the message",
		prompt:
			"Polish the text I will provide for [audience] and [occasion], using a [tone] style. Preserve its meaning and facts while improving structure, clarity, and wording. Briefly explain the main changes. Wait for me to paste the original text first.",
	},
	{
		id: "compare",
		title: "Compare options",
		description: "Compare differences and tradeoffs",
		prompt:
			"Compare [option A] and [option B]. My goal is [goal], and I care most about [criteria]. Explain the relevant differences, advantages, disadvantages, costs, and risks, then give a reasoned recommendation and identify information still needing confirmation.",
	},
	{
		id: "meeting",
		title: "Summarize a meeting",
		description: "Capture decisions, actions, and owners",
		prompt:
			"Turn the meeting notes I provide into a summary with key discussion points, decisions, action items, owners, and deadlines. Mark missing information as unconfirmed instead of inventing it. First remind me to paste the notes or attach a file.",
	},
];

export const CODE_HOME_STARTERS: readonly HomeStarter[] = [
	{
		id: "feature",
		title: "Implement a feature",
		description: "Turn a requirement into a working change",
		prompt:
			"Help me implement [feature] in this project. First inspect the relevant code and explain the current behavior, then propose a small implementation plan. Clarify acceptance criteria, constraints, and affected files when they are missing. Implement the change only after the approach is clear, and verify it with focused tests.",
	},
	{
		id: "debug",
		title: "Fix a bug",
		description: "Trace the cause and make a safe repair",
		prompt:
			"Help me investigate and fix [bug] in this project. Start by reproducing or tracing the behavior and identify the root cause. Ask for the expected behavior, error details, and reproduction steps if essential information is missing. Propose the smallest safe fix, implement it, and verify the regression with a focused test.",
	},
	{
		id: "explain",
		title: "Understand this project",
		description: "Map the structure, flow, and key entry points",
		prompt:
			"Explain this project's structure and how [area or feature] works. Trace the relevant entry points, data flow, and key dependencies from the repository. Point out where I should make a change and note any uncertainty instead of guessing. Ask me to specify the area if needed.",
	},
	{
		id: "review",
		title: "Review the code",
		description: "Find concrete defects, risks, and missing tests",
		prompt:
			"Review the current changes in this project for concrete bugs, regressions, security issues, and missing tests. Start with the highest-risk findings, cite the relevant files and lines, and explain why each matters. Ask me to provide a diff or clarify the review scope if it is unavailable. Do not modify files.",
	},
	{
		id: "test",
		title: "Add tests",
		description: "Cover important behavior and edge cases",
		prompt:
			"Add focused tests for [behavior] in this project. First inspect the existing test conventions and identify the cases that matter, including edge cases and failure paths. Ask for the expected behavior if it is unclear, then implement the tests and run the narrowest relevant checks.",
	},
	{
		id: "performance",
		title: "Improve performance",
		description: "Measure a bottleneck and optimize with evidence",
		prompt:
			"Investigate and improve the performance of [operation] in this project. First measure or trace the current bottleneck and establish a useful baseline. Ask for the target workload or constraints if essential information is missing. Propose the smallest evidence-based optimization and verify that behavior remains correct with focused checks.",
	},
];

export function getHomeStarters(mode: "chat" | "code"): readonly HomeStarter[] {
	return mode === "code" ? CODE_HOME_STARTERS : HOME_STARTERS;
}

export function getHomePeriod(date: Date): HomePeriod {
	const hour = date.getHours();
	if (hour >= 5 && hour < 11) return "morning";
	if (hour >= 11 && hour < 14) return "noon";
	if (hour >= 14 && hour < 18) return "afternoon";
	if (hour >= 18 && hour < 23) return "evening";
	return "late";
}

export function pickHomeGreeting(
	date: Date,
	previousId?: string,
	random: () => number = Math.random,
	mode: "chat" | "code" = "chat",
): HomeGreeting {
	const period = getHomePeriod(date);
	const greetings = mode === "code" ? CODE_HOME_GREETINGS : HOME_GREETINGS;
	const pool = greetings.filter(
		(item) => (item.period === period || item.period === "anytime") && item.id !== previousId,
	);
	const eligible =
		pool.length > 0 ? pool : greetings.filter((item) => item.period === period || item.period === "anytime");
	const sample = random();
	const index = Number.isFinite(sample)
		? Math.min(eligible.length - 1, Math.max(0, Math.floor(sample * eligible.length)))
		: 0;
	return eligible[index]!;
}
