export type HomePeriod = "morning" | "noon" | "afternoon" | "evening" | "late";

export interface HomeGreeting {
	readonly id: string;
	readonly period: HomePeriod | "anytime";
	readonly key: string;
	readonly anonymousKey?: string;
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
	| "meeting";

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
		key: "Good morning, {{name}}. Where shall we start?",
		anonymousKey: "Good morning. Where shall we start?",
	},
	{ id: "morning-start", period: "morning", key: "A good day starts with an idea." },
	{
		id: "morning-first",
		period: "morning",
		key: "{{name}}, let me help with the first task of the day.",
		anonymousKey: "Let me help with the first task of the day.",
	},
	{
		id: "noon-hello",
		period: "noon",
		key: "Hello, {{name}}. What shall we work on this lunchtime?",
		anonymousKey: "What shall we work on this lunchtime?",
	},
	{ id: "noon-idea", period: "noon", key: "A lunchtime idea? Let's explore it." },
	{ id: "noon-small", period: "noon", key: "Start with one small task for an easier afternoon." },
	{
		id: "afternoon-hello",
		period: "afternoon",
		key: "Good afternoon, {{name}}. Let's move an idea forward.",
		anonymousKey: "Good afternoon. Let's move an idea forward.",
	},
	{
		id: "afternoon-progress",
		period: "afternoon",
		key: "Make room for an idea and a little progress this afternoon.",
	},
	{
		id: "afternoon-unblock",
		period: "afternoon",
		key: "{{name}}, let's untangle anything that's stuck.",
		anonymousKey: "Let's untangle anything that's stuck.",
	},
	{
		id: "evening-hello",
		period: "evening",
		key: "Good evening, {{name}}. Any ideas on your mind?",
		anonymousKey: "Good evening. Any ideas on your mind?",
	},
	{ id: "evening-wrap", period: "evening", key: "Reflect on today, or start with a new idea." },
	{ id: "evening-tomorrow", period: "evening", key: "Make a clear starting point for tomorrow." },
	{ id: "late-idea", period: "late", key: "It's late, and an idea is still glowing." },
	{
		id: "late-company",
		period: "late",
		key: "I'm here, {{name}}. What's on your mind?",
		anonymousKey: "I'm here. What's on your mind?",
	},
	{ id: "anytime-idea", period: "anytime", key: "Have an idea you'd like to try together?" },
	{ id: "anytime-shape", period: "anytime", key: "Bring an idea. Let's make it clearer." },
	{
		id: "anytime-task",
		period: "anytime",
		key: "{{name}}, what would you like a hand with today?",
		anonymousKey: "What would you like a hand with today?",
	},
	{ id: "anytime-result", period: "anytime", key: "From a question to something worth sharing." },
	{ id: "anytime-start", period: "anytime", key: "It doesn't need to be fully formed. We can start by talking." },
];

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

export function getHomePeriod(date: Date): HomePeriod {
	const hour = date.getHours();
	if (hour >= 5 && hour < 11) return "morning";
	if (hour >= 11 && hour < 14) return "noon";
	if (hour >= 14 && hour < 18) return "afternoon";
	if (hour >= 18 && hour < 23) return "evening";
	return "late";
}

export function pickHomeGreeting(date: Date, previousId?: string, random: () => number = Math.random): HomeGreeting {
	const period = getHomePeriod(date);
	const pool = HOME_GREETINGS.filter(
		(item) => (item.period === period || item.period === "anytime") && item.id !== previousId,
	);
	return pool[Math.floor(random() * pool.length)]!;
}
