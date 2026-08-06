import { marked, type Token, type Tokens } from "marked";
import type { TFunction } from "i18next";
import { createElement, Fragment, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
				return <a href={href} key={key} {...externalLinkProps(href)}>{inline(token.tokens ?? [], t)}</a>;
			}
			case "image": {
				const href = safeHref(token.href);
				return <a className="markdown-image-link" href={href} key={key} {...externalLinkProps(href)}>{t("[Image: {{name}}]", { name: token.text || t("image") })}</a>;
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
			{item.task && <input aria-label={t(item.checked ? "Completed" : "Not completed")} checked={item.checked} disabled type="checkbox" />}
			{blocks(item.tokens, t)}
		</li>
	);
}

function tableCell(cell: Tokens.TableCell, index: number, t: TFunction): ReactNode {
	const Tag = cell.header ? "th" : "td";
	return <Tag key={`cell-${index}`} style={cell.align ? { textAlign: cell.align } : undefined}>{inline(cell.tokens, t)}</Tag>;
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
			return <pre key={key}><code className={token.lang ? `language-${token.lang}` : undefined}>{token.text}</code></pre>;
		case "blockquote":
			return <blockquote key={key}>{blocks(token.tokens ?? [], t)}</blockquote>;
		case "list": {
			const children = token.items.map((item: Tokens.ListItem, itemIndex: number) => listItem(item, itemIndex, t));
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
						<thead><tr>{token.header.map((cell: Tokens.TableCell, cellIndex: number) => tableCell(cell, cellIndex, t))}</tr></thead>
						<tbody>{token.rows.map((row: Tokens.TableCell[], rowIndex: number) => <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => tableCell(cell, cellIndex, t))}</tr>)}</tbody>
					</table>
				</div>
			);
		case "html":
			return <p className="markdown-raw-html" key={key}>{token.raw}</p>;
		default:
			return <p key={key}>{token.raw}</p>;
	}
}

function blocks(tokens: readonly Token[], t: TFunction): ReactNode[] {
	return tokens.map((token, index) => block(token, index, t));
}

export function Markdown({ text }: { readonly text: string }) {
	const { t, i18n } = useTranslation();
	const content = useMemo(() => {
		try {
			return blocks(marked.lexer(text), t);
		} catch {
			return <p>{text}</p>;
		}
	}, [i18n.resolvedLanguage, t, text]);
	return <>{content}</>;
}
