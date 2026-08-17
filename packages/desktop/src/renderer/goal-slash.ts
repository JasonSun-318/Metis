export type GoalSlashCommand =
	| { readonly kind: "usage" }
	| { readonly kind: "clear" }
	| { readonly kind: "pause" }
	| { readonly kind: "resume" }
	| { readonly kind: "set"; readonly objective: string };

export const GOAL_SLASH_USAGE = "Usage: /goal [<objective>|clear|pause|resume]";

export function parseGoalSlash(text: string): GoalSlashCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/goal")) return null;
	if (trimmed === "/goal" || trimmed === "/goal ") return { kind: "usage" };
	if (!trimmed.startsWith("/goal ")) return null;
	const args = trimmed.slice("/goal ".length).trim();
	const key = args.toLocaleLowerCase();
	if (key === "clear") return { kind: "clear" };
	if (key === "pause") return { kind: "pause" };
	if (key === "resume") return { kind: "resume" };
	if (key === "edit") return { kind: "usage" };
	return { kind: "set", objective: args };
}
