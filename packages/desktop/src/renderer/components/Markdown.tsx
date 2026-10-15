import type { TFunction } from "i18next";
import { marked, type Token, type Tokens } from "marked";
import { cloneElement, createElement, Fragment, isValidElement, type ReactElement, type ReactNode, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { lexMarkdownBlocks, type MarkdownLexCache } from "./markdown-lexer.ts";

function safeHref(href: string): string | undefined {
	if (href.startsWith("#")) return href;
	try {
		const protocol = new URL(href).protocol;
		return protocol === "https:" || protocol === "http:" || protocol === "mailto:" ? href : undefined;
	} catch {
		return undefined;
	}
}

function externalLinkProps(href: string | undefined) {
	return href?.startsWith("#") ? {} : { rel: href ? "noreferrer" : undefined, target: href ? "_blank" : undefined };
}

function inline(tokens: readonly Token[], t: TFunction): ReactNode[] {
	return tokens.map((token, index) => {
		const key = `${token.type}-${index}`;
		switch (token.type) {
			case "text":
				return <Fragment key={key}>{token.tokens ? inline(token.tokens, t) : token.text}</Fragment>;
			case "escape":
				return <Fragment key={key}>{token.text}</Fragment>;
			case "strong":
				return <strong key={key}>{inline(token.tokens ?? [], t)}</strong>;
			case "em":
				return <em key={key}>{inline(token.tokens ?? [], t)}</em>;
			case "del":
				return <del key={key}>{inline(token.tokens ?? [], t)}</del>;
			case "codespan":
				return <code key={key}>{token.text}</code>;
			case "br":
				return <br key={key} />;
			case "checkbox":
				return null;
			case "link": {
				const href = safeHref(token.href);
				return (
					<a href={href} key={key} {...externalLinkProps(href)}>
						{inline(token.tokens ?? [], t)}
					</a>
				);
			}
			case "image": {
				const href = safeHref(token.href);
				return (
					<a className="markdown-image-link" href={href} key={key} {...externalLinkProps(href)}>
						{t("[Image: {{name}}]", { name: token.text || t("image") })}
					</a>
				);
			}
			case "html":
				return <Fragment key={key}>{token.raw}</Fragment>;
			default:
				return <Fragment key={key}>{token.raw}</Fragment>;
		}
	});
}

function listItem(item: Tokens.ListItem, index: number, t: TFunction): ReactNode {
	return (
		<li key={`item-${index}`}>
			{item.task && (
				<input
					aria-label={t(item.checked ? "Completed" : "Not completed")}
					checked={item.checked}
					disabled
					type="checkbox"
				/>
			)}
			{blocks(item.tokens, t)}
		</li>
	);
}

function tableCell(cell: Tokens.TableCell, index: number, t: TFunction): ReactNode {
	const Tag = cell.header ? "th" : "td";
	return (
		<Tag key={`cell-${index}`} style={cell.align ? { textAlign: cell.align } : undefined}>
			{inline(cell.tokens, t)}
		</Tag>
	);
}

function block(token: Token, index: number, t: TFunction): ReactNode {
	const key = `${token.type}-${index}`;
	switch (token.type) {
		case "space":
		case "def":
		case "checkbox":
			return null;
		case "paragraph":
			return <p key={key}>{inline(token.tokens ?? [], t)}</p>;
		case "text":
			return <Fragment key={key}>{token.tokens ? inline(token.tokens, t) : token.text}</Fragment>;
		case "heading":
			return createElement(`h${Math.min(6, Math.max(1, token.depth))}`, { key }, inline(token.tokens ?? [], t));
		case "code":
			return (
				<pre key={key}>
					<code className={token.lang ? `language-${token.lang}` : undefined}>{token.text}</code>
				</pre>
			);
		case "blockquote":
			return <blockquote key={key}>{blocks(token.tokens ?? [], t)}</blockquote>;
		case "list": {
			const children = token.items.map((item: Tokens.ListItem, itemIndex: number) => listItem(item, itemIndex, t));
			return token.ordered ? (
				<ol key={key} start={typeof token.start === "number" ? token.start : undefined}>
					{children}
				</ol>
			) : (
				<ul key={key}>{children}</ul>
			);
		}
		case "hr":
			return <hr key={key} />;
		case "table":
			return (
				<div className="markdown-table-scroll" key={key}>
					<table>
						<thead>
							<tr>
								{token.header.map((cell: Tokens.TableCell, cellIndex: number) => tableCell(cell, cellIndex, t))}
							</tr>
						</thead>
						<tbody>
							{token.rows.map((row: Tokens.TableCell[], rowIndex: number) => (
								<tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => tableCell(cell, cellIndex, t))}</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "html":
			return (
				<p className="markdown-raw-html" key={key}>
					{token.raw}
				</p>
			);
		default:
			return <p key={key}>{token.raw}</p>;
	}
}

function blocks(tokens: readonly Token[], t: TFunction): ReactNode[] {
	return tokens.map((token, index) => block(token, index, t));
}

export function Markdown({
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
				const tokens = marked.lexer(normalized);
				if (tokens.map((token) => token.raw).join("") !== normalized) return blocks(tokens, t);
				let offset = 0;
				return tokens.map((token, index) => {
					const start = offset;
					offset += token.raw.length;
					const content = block(token, index, t);
					return content === null ? null : (
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
				const node = previous.get(key) ?? block(token, index, t);
				next.set(key, node);
				return node;
			});
			cached.nodes = next;
			return rendered;
		} catch {
			return <p>{text}</p>;
		}
	}, [i18n.resolvedLanguage, t, text, sourcePositions]);
	const sourcedContent = useMemo(() => !quoteItemId ? content : (Array.isArray(content) ? content : [content]).map((node) =>
		isValidElement(node) && typeof node.type === "string"
			? cloneElement(node as ReactElement<Record<string, unknown>>, { "data-quote-item": quoteItemId }) : node,
	), [content, quoteItemId]);
	return <>{sourcedContent}</>;
}
