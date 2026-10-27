import type { TFunction } from "i18next";
import {
	cloneElement,
	Fragment,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { MarkdownDocumentProvider, type MarkdownDocumentState } from "./MarkdownDocumentContext.tsx";
import { lexMarkdownBlocks, type MarkdownLexCache } from "./markdown-lexer.ts";
import { lexMarkdown } from "./markdown-parser.ts";
import { renderMarkdownBlock, renderMarkdownBlocks } from "./markdown-renderer.tsx";
import { type MarkdownDocument, markdownSourceKey } from "./markdown-resources.ts";

export interface MarkdownFragment {
	readonly target: string;
	readonly requestId: string;
}

interface MarkdownProps {
	readonly text: string;
	readonly sourcePositions?: boolean;
	readonly quoteItemId?: string;
	readonly document?: MarkdownDocument;
	readonly fragment?: MarkdownFragment;
}

function renderEmbeddedNote(text: string, state: MarkdownDocumentState): ReactNode {
	return (
		<MarkdownDocumentProvider state={state}>
			<DocumentBoundary text={text}>
				<MarkdownBody key={state.trail.at(-1)} text={text} />
			</DocumentBoundary>
		</MarkdownDocumentProvider>
	);
}

function DocumentBoundary({
	children,
	fragment,
	text,
}: {
	readonly children: ReactNode;
	readonly fragment?: MarkdownFragment;
	readonly text: string;
}) {
	const root = useRef<HTMLDivElement>(null);
	const { t } = useTranslation();
	const [error, setError] = useState("");
	// biome-ignore lint/correctness/useExhaustiveDependencies(text): Source changes replace heading/block nodes even when the requested fragment is unchanged.
	useLayoutEffect(() => {
		setError("");
		if (!fragment || !root.current) return;
		if (!fragment.target) {
			root.current.scrollIntoView?.({ block: "start" });
			return;
		}
		let locator: string;
		try {
			locator = decodeURIComponent(fragment.target.replace(/^#/u, ""));
		} catch {
			setError("Heading was not found");
			return;
		}
		const nodes = Array.from(
			root.current.querySelectorAll<HTMLElement>("[data-markdown-heading], [data-markdown-block-id]"),
		)
			.filter((node) => node.closest("[data-markdown-document]") === root.current)
			.filter((node) =>
				locator.startsWith("^")
					? node.dataset.markdownBlockId === locator.slice(1)
					: node.dataset.markdownHeading?.toLocaleLowerCase() === locator.toLocaleLowerCase(),
			);
		if (nodes.length !== 1) {
			setError(
				locator.startsWith("^")
					? nodes.length
						? "Ambiguous block ID"
						: "Block ID was not found"
					: nodes.length
						? "Ambiguous heading"
						: "Heading was not found",
			);
			return;
		}
		for (
			let ancestor = nodes[0]!.parentElement;
			ancestor && ancestor !== root.current;
			ancestor = ancestor.parentElement
		)
			if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
		nodes[0]!.scrollIntoView?.({ block: "start" });
	}, [fragment, text]);
	return (
		<div ref={root} data-markdown-document="true">
			{error && <p role="alert">{t(error)}</p>}
			{children}
		</div>
	);
}

export function Markdown({ document, fragment, ...props }: MarkdownProps) {
	return (
		<MarkdownDocumentProvider document={document}>
			{document ? (
				<DocumentBoundary fragment={fragment} text={props.text}>
					<MarkdownBody key={markdownSourceKey(document.owner)} {...props} />
				</DocumentBoundary>
			) : (
				<MarkdownBody {...props} />
			)}
		</MarkdownDocumentProvider>
	);
}

function MarkdownBody({
	text,
	sourcePositions = false,
	quoteItemId,
}: {
	readonly text: string;
	readonly sourcePositions?: boolean;
	readonly quoteItemId?: string;
}) {
	const { t, i18n } = useTranslation();
	// Streaming deltas re-render for every append, so the lexed tokens and the
	// rendered node of each top-level block are kept across frames. Token reuse
	// is proven inside lexMarkdownBlocks; node reuse keys on the block's
	// position, type and raw, and both caches reset when the language changes
	// or a link definition alters earlier inline resolution.
	const renderCache = useRef<{
		lex: MarkdownLexCache | null;
		defSalt: string;
		nodes: ReadonlyMap<string, ReactNode>;
		language: string | undefined;
		t: TFunction | null;
	}>({ lex: null, defSalt: "", nodes: new Map(), language: undefined, t: null });
	const content = useMemo(() => {
		try {
			if (sourcePositions) {
				const normalized = text.replace(/\r\n?/gu, "\n");
				const tokens = lexMarkdown(normalized);
				if (tokens.map((token) => token.raw).join("") !== normalized)
					return renderMarkdownBlocks(tokens, t, renderEmbeddedNote);
				let offset = 0;
				return tokens.map((token, index) => {
					const start = offset;
					offset += token.raw.length;
					const content = renderMarkdownBlock(token, index, t, renderEmbeddedNote);
					return content === null ? null : (
						/* biome-ignore lint/suspicious/noArrayIndexKey: Markdown tokens and table rows stream in source order; positional keys preserve the active block while its text grows. */
						<div className="markdown-source-block" data-source-start={start} data-source-end={offset} key={index}>
							{content}
						</div>
					);
				});
			}
			const cached = renderCache.current;
			if (cached.t !== t || cached.language !== i18n.resolvedLanguage) {
				cached.nodes = new Map();
				cached.t = t;
				cached.language = i18n.resolvedLanguage;
			}
			const { tokens, cache, defSalt } = lexMarkdownBlocks(text, cached.lex);
			cached.lex = cache;
			if (defSalt !== cached.defSalt) cached.nodes = new Map();
			cached.defSalt = defSalt;
			const previous = cached.nodes;
			const next = new Map<string, ReactNode>();
			const rendered = tokens.map((token, index) => {
				const key = `${index}:${token.type}:${token.raw}`;
				const node = previous.get(key) ?? renderMarkdownBlock(token, index, t, renderEmbeddedNote);
				next.set(key, node);
				return node;
			});
			cached.nodes = next;
			return rendered;
		} catch {
			return <p>{text}</p>;
		}
	}, [i18n.resolvedLanguage, t, text, sourcePositions]);
	const sourcedContent = useMemo(
		() =>
			!quoteItemId
				? content
				: (Array.isArray(content) ? content : [content]).map((node) =>
						isValidElement(node) && node.type !== Fragment
							? cloneElement(node as ReactElement<Record<string, unknown>>, { "data-quote-item": quoteItemId })
							: node,
					),
		[content, quoteItemId],
	);
	return <>{sourcedContent}</>;
}
