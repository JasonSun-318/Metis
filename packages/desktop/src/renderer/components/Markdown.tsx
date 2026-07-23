import { marked, type Token, type Tokens } from "marked";
import { createElement, Fragment, useMemo, type ReactNode } from "react";

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

function inline(tokens: readonly Token[]): ReactNode[] {
	return tokens.map((token, index) => {
		const key = `${token.type}-${index}`;
		switch (token.type) {
			case "text":
				return <Fragment key={key}>{token.tokens ? inline(token.tokens) : token.text}</Fragment>;
			case "escape":
				return <Fragment key={key}>{token.text}</Fragment>;
			case "strong":
				return <strong key={key}>{inline(token.tokens ?? [])}</strong>;
			case "em":
				return <em key={key}>{inline(token.tokens ?? [])}</em>;
			case "del":
				return <del key={key}>{inline(token.tokens ?? [])}</del>;
			case "codespan":
				return <code key={key}>{token.text}</code>;
			case "br":
				return <br key={key} />;
			case "checkbox":
				return null;
			case "link": {
				const href = safeHref(token.href);
				return <a href={href} key={key} {...externalLinkProps(href)}>{inline(token.tokens ?? [])}</a>;
			}
			case "image": {
				const href = safeHref(token.href);
				return <a className="markdown-image-link" href={href} key={key} {...externalLinkProps(href)}>[Image: {token.text || "image"}]</a>;
			}
			case "html":
				return <Fragment key={key}>{token.raw}</Fragment>;
			default:
				return <Fragment key={key}>{token.raw}</Fragment>;
		}
	});
}

function listItem(item: Tokens.ListItem, index: number): ReactNode {
	return (
		<li key={`item-${index}`}>
			{item.task && <input aria-label={item.checked ? "Completed" : "Not completed"} checked={item.checked} disabled type="checkbox" />}
			{blocks(item.tokens)}
		</li>
	);
}

function tableCell(cell: Tokens.TableCell, index: number): ReactNode {
	const Tag = cell.header ? "th" : "td";
	return <Tag key={`cell-${index}`} style={cell.align ? { textAlign: cell.align } : undefined}>{inline(cell.tokens)}</Tag>;
}

function block(token: Token, index: number): ReactNode {
	const key = `${token.type}-${index}`;
	switch (token.type) {
		case "space":
		case "def":
		case "checkbox":
			return null;
		case "paragraph":
			return <p key={key}>{inline(token.tokens ?? [])}</p>;
		case "text":
			return <Fragment key={key}>{token.tokens ? inline(token.tokens) : token.text}</Fragment>;
		case "heading":
			return createElement(`h${Math.min(6, Math.max(1, token.depth))}`, { key }, inline(token.tokens ?? []));
		case "code":
			return <pre key={key}><code className={token.lang ? `language-${token.lang}` : undefined}>{token.text}</code></pre>;
		case "blockquote":
			return <blockquote key={key}>{blocks(token.tokens ?? [])}</blockquote>;
		case "list": {
			const children = token.items.map(listItem);
			return token.ordered
				? <ol key={key} start={typeof token.start === "number" ? token.start : undefined}>{children}</ol>
				: <ul key={key}>{children}</ul>;
		}
		case "hr":
			return <hr key={key} />;
		case "table":
			return (
				<div className="markdown-table-scroll" key={key}>
					<table>
						<thead><tr>{token.header.map(tableCell)}</tr></thead>
						<tbody>{token.rows.map((row: Tokens.TableCell[], rowIndex: number) => <tr key={`row-${rowIndex}`}>{row.map(tableCell)}</tr>)}</tbody>
					</table>
				</div>
			);
		case "html":
			return <p className="markdown-raw-html" key={key}>{token.raw}</p>;
		default:
			return <p key={key}>{token.raw}</p>;
	}
}

function blocks(tokens: readonly Token[]): ReactNode[] {
	return tokens.map(block);
}

export function Markdown({ text }: { readonly text: string }) {
	const content = useMemo(() => {
		try {
			return blocks(marked.lexer(text));
		} catch {
			return <p>{text}</p>;
		}
	}, [text]);
	return <>{content}</>;
}
