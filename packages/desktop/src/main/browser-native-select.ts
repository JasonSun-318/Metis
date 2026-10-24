import type { BrowserOperationDetails } from "@metis/app-protocol";

interface DomNode {
	readonly nodeName?: string;
	readonly nodeValue?: string;
	readonly attributes?: readonly string[];
	readonly children?: readonly DomNode[];
}

export interface NativeOption {
	readonly index: number;
	readonly value: string;
	readonly label: string;
	readonly disabled: boolean;
	readonly group?: string;
}

export interface NativeSelect {
	readonly multiple: boolean;
	readonly options: readonly NativeOption[];
	readonly truncated: boolean;
}

/** Read-only DOM metadata; values remain internal and never enter observation text. */
export function nativeSelectMetadata(response: unknown): NativeSelect | undefined {
	const root = (response as { node?: DomNode } | null)?.node;
	if (root?.nodeName !== "SELECT") return undefined;
	const attributes = (node: DomNode) =>
		new Map(
			Array.from(
				{ length: Math.floor((node.attributes?.length ?? 0) / 2) },
				(_, index) => [node.attributes![index * 2]!, node.attributes![index * 2 + 1]!] as const,
			),
		);
	const text = (node: DomNode): string =>
		node.nodeName === "SCRIPT"
			? ""
			: node.nodeName === "#text"
				? (node.nodeValue ?? "")
				: (node.children ?? []).map(text).join("");
	const normalize = (value: string) => value.replace(/[\t\n\f\r ]+/gu, " ").replace(/^ | $/gu, "");
	const options: NativeOption[] = [];
	let count = 0;
	const visit = (node: DomNode, disabled: boolean, group?: string) => {
		const attrs = attributes(node);
		const unavailable = disabled || attrs.has("disabled") || attrs.has("hidden");
		if (node.nodeName === "OPTION") {
			const index = count++;
			if (index < 1000)
				options.push({
					index,
					value: attrs.get("value") ?? normalize(text(node)),
					label: attrs.get("label") || normalize(text(node)),
					disabled: unavailable,
					...(group ? { group } : {}),
				});
			return;
		}
		for (const child of node.children ?? [])
			visit(child, unavailable, node.nodeName === "OPTGROUP" ? attrs.get("label") : group);
	};
	visit(root, false);
	return { multiple: attributes(root).has("multiple"), options, truncated: count > options.length };
}

// Fixed code executed only against a resolved select in an isolated world.
// Literal arguments are either a legacy value or an observed option identity.
export const SELECT_NATIVE_OPTION = `function(choice) {
  if (!(this instanceof HTMLSelectElement) || !this.isConnected) return { failure: "select_unavailable" };
  if (this.multiple) return { failure: "unsupported_select" };
  if (this.matches(":disabled")) return { failure: "select_unavailable" };
  const matches = typeof choice === "string" ? Array.from(this.options).filter(option => option.value === choice) : [this.options.item(choice.index)].filter(Boolean);
  if (matches.length !== 1) return { failure: matches.length ? "option_ambiguous" : "option_not_found" };
  const option = matches[0];
  const value = option.value;
  if (typeof choice !== "string" && (option.value !== choice.value || option.label !== choice.label)) return { failure: "option_changed" };
  if (option.matches(":disabled") || option.hidden || option.parentElement.hidden) return { failure: "option_unavailable" };
  if (!this.getClientRects().length || getComputedStyle(this).visibility === "hidden") return { failure: "select_unavailable" };
  this.focus();
  // Focus handlers may replace or disable either the control or its option.
  if (!this.isConnected || this.matches(":disabled") || this.multiple || !Array.from(this.options).includes(option) || option.value !== value || option.matches(":disabled") || (typeof choice !== "string" && (option.index !== choice.index || option.label !== choice.label))) return { failure: "select_changed" };
  if (this.selectedIndex !== option.index) {
    this.selectedIndex = option.index;
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (!this.isConnected || this.value !== value || this.selectedOptions.length !== 1 || this.selectedOptions[0] !== option) return { failure: "selection_changed" };
  return { selected: true };
}`;

type SelectionFailure = Extract<BrowserOperationDetails, { status: "failed" }>;
const SELECTION_FAILURES = {
	select_unavailable: {
		execution: "not_started",
		recovery: "observe",
		message:
			"Selection was not applied: the native select is unavailable, disabled or hidden. Call browser_observe before choosing another action.",
	},
	unsupported_select: {
		execution: "not_started",
		recovery: "use_supported_action",
		message:
			"Selection was not applied: multiple selection is unsupported by this action. Do not retry this select action; use supported page controls or browser_handoff.",
	},
	option_not_found: {
		execution: "not_started",
		recovery: "observe",
		message:
			"Selection was not applied: the option was not found or was not observed. Call browser_observe and use an available optionIndex.",
	},
	option_ambiguous: {
		execution: "not_started",
		recovery: "observe",
		message:
			"Selection was not applied: the value matches multiple options. Call browser_observe and choose the exact optionIndex by label and group.",
	},
	option_changed: {
		execution: "not_started",
		recovery: "observe",
		message:
			"Selection was not applied: the observed option changed. Call browser_observe before choosing a new optionIndex.",
	},
	option_unavailable: {
		execution: "not_started",
		recovery: "observe",
		message:
			"Selection was not applied: the option or its group is disabled or hidden. Call browser_observe and choose an available option.",
	},
	select_changed: {
		execution: "unknown",
		recovery: "observe",
		message:
			"The page changed the select while it was being focused; focus handlers may have had effects. Call browser_observe and inspect the current state before deciding whether to retry.",
	},
	selection_changed: {
		execution: "dispatched",
		recovery: "observe",
		message:
			"Selection input/change events were dispatched, but the page changed the selection. Call browser_observe and verify the current state before deciding whether to retry; do not blindly repeat the action.",
	},
	selection_unconfirmed: {
		execution: "unknown",
		recovery: "observe",
		message:
			"The selection outcome could not be confirmed; the action may have had effects. Call browser_observe and inspect the result before deciding whether to retry.",
	},
} as const satisfies Record<SelectionFailure["reason"], Omit<SelectionFailure, "status" | "reason">>;

/** Only local fixed messages may cross RPC; never return page/CDP exception text. */
export class NativeSelectionError extends Error {
	readonly details: SelectionFailure;
	constructor(reason: unknown) {
		const code =
			typeof reason === "string" && Object.hasOwn(SELECTION_FAILURES, reason)
				? (reason as SelectionFailure["reason"])
				: "selection_unconfirmed";
		const failure = SELECTION_FAILURES[code];
		super(failure.message);
		this.details = { status: "failed", reason: code, ...failure };
	}
}
