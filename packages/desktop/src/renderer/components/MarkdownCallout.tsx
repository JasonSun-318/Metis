import type { Token, Tokens } from "marked";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Icon } from "../icons.tsx";
import {
	Article,
	Bug,
	CaretRight,
	CheckCircle,
	Exam,
	Info,
	Lightbulb,
	ListChecks,
	Notebook,
	Question,
	Quotes,
	Warning,
	WarningCircle,
	XCircle,
} from "../icons.tsx";
import { lexMarkdown } from "./markdown-parser.ts";

interface CalloutMeta {
	readonly canonical: string;
	readonly defaultTitle: string;
	readonly icon: Icon;
	/** `undefined` = always expanded, `-` = collapsed, `+` = expanded but foldable. */
	readonly fold: undefined | "-" | "+";
	readonly title: string | undefined;
	/** Body tokens with the marker line removed (fresh objects; originals untouched). */
	readonly bodyTokens: readonly Token[];
}

// Aliases and defaults follow the Obsidian callout vocabulary; unknown but
// syntactically valid types render with the note style and keep their title.
const CALLOUT_ALIASES: Readonly<Record<string, string>> = {
	note: "note",
	abstract: "abstract",
	summary: "abstract",
	tldr: "abstract",
	info: "info",
	todo: "todo",
	tip: "tip",
	hint: "tip",
	important: "tip",
	success: "success",
	check: "success",
	done: "success",
	question: "question",
	help: "question",
	faq: "question",
	warning: "warning",
	caution: "warning",
	attention: "warning",
	failure: "failure",
	fail: "failure",
	missing: "failure",
	danger: "danger",
	error: "danger",
	bug: "bug",
	example: "example",
	quote: "quote",
	cite: "quote",
};

const CALLOUT_ICONS: Readonly<Record<string, Icon>> = {
	note: Notebook,
	abstract: Article,
	info: Info,
	todo: ListChecks,
	tip: Lightbulb,
	success: CheckCircle,
	question: Question,
	warning: Warning,
	failure: XCircle,
	danger: WarningCircle,
	bug: Bug,
	example: Exam,
	quote: Quotes,
};

const CALLOUT_DEFAULT_TITLES: Readonly<Record<string, string>> = {
	note: "Note",
	abstract: "Abstract",
	info: "Info",
	todo: "Todo",
	tip: "Tip",
	success: "Success",
	question: "Question",
	warning: "Warning",
	failure: "Failure",
	danger: "Danger",
	bug: "Bug",
	example: "Example",
	quote: "Quote",
};

const CALLOUT_HEADER = /^\[!([A-Za-z][\w-]*)\]([+-])?[ \t]*(.*)$/u;

// The marker lives in the blockquote's first paragraph. Only a complete,
// syntactically valid `[!type]` header makes a callout; anything else stays a
// plain quote. Original tokens are never mutated: the body is re-lexed from
// the paragraph's remaining source so nested blocks (lists, code, math, other
// callouts) keep full fidelity.
export function parseCallout(token: Tokens.Blockquote): CalloutMeta | null {
	const first = token.tokens[0];
	if (!first || first.type !== "paragraph") return null;
	const header = CALLOUT_HEADER.exec(first.raw.split("\n")[0] ?? "");
	if (!header) return null;
	const canonical = CALLOUT_ALIASES[header[1]!.toLowerCase()] ?? "note";
	const title = header[3] && header[3].length > 0 ? header[3] : undefined;
	const lines = first.raw.split("\n");
	const rest = lines.slice(1).join("\n");
	const bodyTokens: Token[] = rest.trim().length > 0 ? lexMarkdown(rest) : [];
	const tail = token.tokens.slice(1);
	return {
		canonical,
		defaultTitle: CALLOUT_DEFAULT_TITLES[canonical] ?? CALLOUT_DEFAULT_TITLES.note!,
		icon: CALLOUT_ICONS[canonical] ?? CALLOUT_ICONS.note!,
		fold: (header[2] as "-" | "+" | undefined) ?? undefined,
		title,
		bodyTokens: [...bodyTokens, ...tail],
	};
}

// The rendered body is supplied by the Markdown dispatcher as children, so
// this component never imports back into Markdown.tsx (no runtime cycle).
export function MarkdownCallout({ callout, body }: { readonly callout: CalloutMeta; readonly body: ReactNode }) {
	const { t } = useTranslation();
	const Icon = callout.icon;
	const identity = `${callout.canonical}|${callout.fold ?? ""}|${callout.title ?? ""}`;
	// Streaming grows the body while the header stays put: the open state is
	// kept across frames and only resets when the header (or document) changes.
	const [state, setState] = useState<{ identity: string; open: boolean }>(() => ({
		identity,
		open: callout.fold !== "-",
	}));
	if (state.identity !== identity) setState({ identity, open: callout.fold !== "-" });
	const title = callout.title ?? t(callout.defaultTitle);
	const className = `markdown-callout markdown-callout-${callout.canonical}`;
	if (callout.fold === undefined) {
		return (
			<div className={className}>
				<div className="markdown-callout-title">
					<Icon aria-hidden="true" className="markdown-callout-icon" weight="bold" />
					<span>{title}</span>
				</div>
				<div className="markdown-callout-body">{body}</div>
			</div>
		);
	}
	return (
		<details
			className={className}
			onToggle={(event) => setState({ identity, open: event.currentTarget.open })}
			open={state.open}
		>
			<summary className="markdown-callout-title">
				<Icon aria-hidden="true" className="markdown-callout-icon" weight="bold" />
				<span>{title}</span>
				<CaretRight aria-hidden="true" className="markdown-callout-caret" />
			</summary>
			<div className="markdown-callout-body">{body}</div>
		</details>
	);
}
