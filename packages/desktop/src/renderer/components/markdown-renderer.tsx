import type { TFunction } from "i18next";
import type { Token, Tokens } from "marked";
import { createElement, Fragment, type ReactNode, useId } from "react";
import { MarkdownCallout, parseCallout } from "./MarkdownCallout.tsx";
import { useMarkdownDocument } from "./MarkdownDocumentContext.tsx";
import { MarkdownEmbed, type RenderEmbeddedNote } from "./MarkdownEmbed.tsx";
import { MarkdownMath } from "./MarkdownMath.tsx";
import { markdownBlockId, markdownHeadingText, withoutMarkdownBlockId } from "./markdown-fragments.ts";
import { BLOCK_MATH_TYPE, INLINE_MATH_TYPE, type MathToken } from "./markdown-math.ts";
import { isLocalMarkdownReference, type MarkdownReference } from "./markdown-references.ts";

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

function inline(tokens: readonly Token[], t: TFunction, renderNote: RenderEmbeddedNote): ReactNode[] {
	return tokens.map((token, index) => {
		const key = `${token.type}-${index}`;
		switch (token.type) {
			case "text":
				return <Fragment key={key}>{token.tokens ? inline(token.tokens, t, renderNote) : token.text}</Fragment>;
			case "escape":
				return <Fragment key={key}>{token.text}</Fragment>;
			case "strong":
				return <strong key={key}>{inline(token.tokens ?? [], t, renderNote)}</strong>;
			case "em":
				return <em key={key}>{inline(token.tokens ?? [], t, renderNote)}</em>;
			case "del":
				return <del key={key}>{inline(token.tokens ?? [], t, renderNote)}</del>;
			case "codespan":
				return <code key={key}>{token.text}</code>;
			case "br":
				return <br key={key} />;
			case "checkbox":
				return null;
			case "link": {
				if (isLocalMarkdownReference(token.href))
					return (
						<MarkdownEmbed
							key={key}
							embed={false}
							reference={{ reference: token.href, kind: "markdown", label: token.text }}
							renderNote={renderNote}
						/>
					);
				const href = safeHref(token.href);
				return (
					<a href={href} key={key} {...externalLinkProps(href)}>
						{inline(token.tokens ?? [], t, renderNote)}
					</a>
				);
			}
			case "image": {
				if (isLocalMarkdownReference(token.href))
					return (
						<MarkdownEmbed
							key={key}
							reference={{ reference: token.href, kind: "markdown", label: token.text }}
							renderNote={renderNote}
						/>
					);
				const href = safeHref(token.href);
				return (
					<a className="markdown-image-link" href={href} key={key} {...externalLinkProps(href)}>
						{t("[Image: {{name}}]", { name: token.text || t("image") })}
					</a>
				);
			}
			case "html":
				return <Fragment key={key}>{token.raw}</Fragment>;
			case "wikiReference":
				return (
					<MarkdownEmbed
						key={key}
						embed={Boolean(token.embed)}
						reference={token as unknown as MarkdownReference}
						renderNote={renderNote}
					/>
				);
			case INLINE_MATH_TYPE: {
				const math = token as unknown as MathToken;
				return <MarkdownMath displayMode={math.displayMode} key={key} tex={math.text} raw={math.raw} />;
			}
			default:
				return <Fragment key={key}>{token.raw}</Fragment>;
		}
	});
}

function containsEmbed(tokens: readonly Token[]): boolean {
	return tokens.some(
		(token) =>
			(token.type === "wikiReference" && token.embed) ||
			(token.type === "image" && isLocalMarkdownReference(token.href)) ||
			("tokens" in token && token.tokens && containsEmbed(token.tokens)),
	);
}

function paragraph(tokens: readonly Token[], key: string, t: TFunction, renderNote: RenderEmbeddedNote) {
	if (!containsEmbed(tokens)) return <p key={key}>{inline(tokens, t, renderNote)}</p>;
	// Embeds contain articles/figures. Split paragraphs at token boundaries, including nested rich text.
	const pieces: ReactNode[] = [];
	let group: Token[] = [];
	const flush = () => {
		if (group.length) pieces.push(<p key={`p-${pieces.length}`}>{inline(group, t, renderNote)}</p>);
		group = [];
	};
	for (const token of tokens) {
		if (containsEmbed([token])) {
			flush();
			pieces.push(
				<div className="markdown-embed-block" key={`embed-${pieces.length}`}>
					{inline([token], t, renderNote)}
				</div>,
			);
		} else group.push(token);
	}
	flush();
	return (
		<div className="markdown-paragraph-group" key={key}>
			{pieces}
		</div>
	);
}

function MarkdownHeading({
	depth,
	title,
	children,
	...attributes
}: {
	readonly depth: number;
	readonly title: string;
	readonly children: ReactNode;
	readonly "data-quote-item"?: string;
}) {
	const context = useMarkdownDocument();
	const id = useId();
	return createElement(
		`h${Math.min(6, Math.max(1, depth))}`,
		{
			...attributes,
			...(context ? { id: `markdown-heading-${id}`, "data-markdown-heading": markdownHeadingText(title) } : {}),
		},
		children,
	);
}

function listItem(item: Tokens.ListItem, index: number, t: TFunction, renderNote: RenderEmbeddedNote): ReactNode {
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
			{blocks(item.tokens, t, renderNote)}
		</li>
	);
}

function tableCell(cell: Tokens.TableCell, index: number, t: TFunction, renderNote: RenderEmbeddedNote): ReactNode {
	const Tag = cell.header ? "th" : "td";
	return (
		<Tag key={`cell-${index}`} style={cell.align ? { textAlign: cell.align } : undefined}>
			{inline(cell.tokens, t, renderNote)}
		</Tag>
	);
}

export function renderMarkdownBlock(
	token: Token,
	index: number,
	t: TFunction,
	renderNote: RenderEmbeddedNote,
): ReactNode {
	const id = markdownBlockId(token);
	return id ? (
		<MarkdownBlockAnchor key={`${token.type}-${index}`} blockId={id}>
			{blockContent(withoutMarkdownBlockId(token, id), index, t, renderNote)}
		</MarkdownBlockAnchor>
	) : (
		blockContent(token, index, t, renderNote)
	);
}

function MarkdownBlockAnchor({
	blockId,
	children,
	...attributes
}: {
	readonly blockId: string;
	readonly children: ReactNode;
	readonly "data-quote-item"?: string;
}) {
	const id = useId();
	const context = useMarkdownDocument();
	return (
		<div id={context ? `markdown-block-${id}` : undefined} data-markdown-block-id={blockId} {...attributes}>
			{children}
		</div>
	);
}

function blockContent(token: Token, index: number, t: TFunction, renderNote: RenderEmbeddedNote): ReactNode {
	const key = `${token.type}-${index}`;
	switch (token.type) {
		case "space":
		case "def":
		case "checkbox":
			return null;
		case "paragraph":
			return paragraph(token.tokens ?? [], key, t, renderNote);
		case "text":
			return token.tokens && containsEmbed(token.tokens) ? (
				paragraph(token.tokens, key, t, renderNote)
			) : (
				<Fragment key={key}>{token.tokens ? inline(token.tokens, t, renderNote) : token.text}</Fragment>
			);
		case "heading":
			return (
				<MarkdownHeading key={key} depth={token.depth} title={token.text}>
					{inline(token.tokens ?? [], t, renderNote)}
				</MarkdownHeading>
			);
		case "code":
			return (
				<pre key={key}>
					<code className={token.lang ? `language-${token.lang}` : undefined}>{token.text}</code>
				</pre>
			);
		case BLOCK_MATH_TYPE: {
			// Pending (unclosed) math streams as raw text and typesets once the
			// closer arrives; the native wrapper keeps quote/source attribution.
			const math = token as unknown as MathToken;
			return math.closed ? (
				<div className="markdown-math-block" key={key}>
					<MarkdownMath displayMode tex={math.text} raw={math.raw} />
				</div>
			) : (
				<pre className="markdown-math-pending" key={key}>
					{token.raw}
				</pre>
			);
		}
		case "blockquote": {
			const quote = token as Tokens.Blockquote;
			const callout = parseCallout(quote);
			return callout ? (
				<div className="markdown-callout-host" key={key}>
					<MarkdownCallout body={blocks(callout.bodyTokens, t, renderNote)} callout={callout} />
				</div>
			) : (
				<blockquote key={key}>{blocks(quote.tokens ?? [], t, renderNote)}</blockquote>
			);
		}
		case "list": {
			const children = token.items.map((item: Tokens.ListItem, itemIndex: number) =>
				listItem(item, itemIndex, t, renderNote),
			);
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
								{token.header.map((cell: Tokens.TableCell, cellIndex: number) =>
									tableCell(cell, cellIndex, t, renderNote),
								)}
							</tr>
						</thead>
						<tbody>
							{token.rows.map((row: Tokens.TableCell[], rowIndex: number) => (
								/* biome-ignore lint/suspicious/noArrayIndexKey: Markdown tokens and table rows stream in source order; positional keys preserve the active block while its text grows. */
								<tr key={`row-${rowIndex}`}>
									{row.map((cell, cellIndex) => tableCell(cell, cellIndex, t, renderNote))}
								</tr>
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

function blocks(tokens: readonly Token[], t: TFunction, renderNote: RenderEmbeddedNote): ReactNode[] {
	return tokens.map((token, index) => renderMarkdownBlock(token, index, t, renderNote));
}

export function renderMarkdownBlocks(
	tokens: readonly Token[],
	t: TFunction,
	renderNote: RenderEmbeddedNote,
): ReactNode[] {
	return blocks(tokens, t, renderNote);
}
