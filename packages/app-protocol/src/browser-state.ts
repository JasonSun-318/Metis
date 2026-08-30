import type { BrowserAction } from "./methods.ts";

export interface BrowserStateNode {
	readonly depth: number;
	readonly elementId?: string;
	readonly role: string;
	readonly label?: string;
	readonly flags?: readonly string[];
}

export interface BrowserStateElement {
	readonly elementId: string;
	readonly role: string;
	readonly label?: string;
}

export function formatBrowserStateNode(node: BrowserStateNode): string {
	const label = node.label?.replace(/[\r\n\t]+/gu, " ").trim();
	const flags = node.flags?.filter(Boolean) ?? [];
	return `${"  ".repeat(node.depth)}${node.elementId ? `${node.elementId} ` : ""}${node.role}${label ? ` ${JSON.stringify(label)}` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

export function findBrowserStateElement(state: string, elementId: string): BrowserStateElement | undefined {
	const prefix = `${elementId} `;
	const line = state.split("\n").find((candidate) => candidate.trimStart().startsWith(prefix));
	if (!line) return undefined;
	const remainder = line.trimStart().slice(prefix.length);
	const role = remainder.split(/[\s[]/u, 1)[0] ?? "";
	const encodedLabel = remainder.match(/"(?:\\.|[^"\\])*"/u)?.[0];
	if (!encodedLabel) return { elementId, role };
	try {
		const label = JSON.parse(encodedLabel) as unknown;
		return { elementId, role, ...(typeof label === "string" && label !== "" ? { label } : {}) };
	} catch {
		return { elementId, role };
	}
}

export function browserActionElementIds(action: BrowserAction): readonly string[] {
	switch (action.type) {
		case "click":
		case "hover":
			return "elementId" in action.target ? [action.target.elementId] : [];
		case "type":
		case "select":
			return [action.elementId];
		case "scroll":
			return action.elementId ? [action.elementId] : [];
		case "drag":
			return [action.to, action.from].flatMap((target) => ("elementId" in target ? [target.elementId] : []));
		case "press":
		case "dialog":
			return [];
	}
}
