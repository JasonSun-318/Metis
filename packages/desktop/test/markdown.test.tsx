// @vitest-environment jsdom

import { marked } from "marked";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/renderer/i18n.ts";
import { Markdown } from "../src/renderer/components/Markdown.tsx";

const DOCS = [
	"# Title\n\nHere is **some** text and `code`.\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\n- item one\n- item two\n- item three\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> a quote\n\nfinal paragraph\n",
	"opening words\n\nsecond block\n===\n\n- loose one\n\n- loose two\n\ntrailing text\n",
	"first [ref] mention\n\nmore body\n\n[ref]: https://example.com\n\nclosing\n",
	"para one\n\npara two\n\npara three\n===\n\ndone\n",
];

async function renderFresh(text: string): Promise<string> {
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => root.render(<Markdown text={text} />));
	const html = container.innerHTML;
	await act(async () => root.unmount());
	return html;
}

describe("Markdown", () => {
	afterEach(() => {
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it.each(DOCS)("streams prefixes into the same DOM as a fresh render", async (doc) => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			const expected = await renderFresh(doc);
			for (let cut = 1; cut <= doc.length; cut += 3) {
				await act(async () => root.render(<Markdown text={doc.slice(0, cut)} />));
			}
			await act(async () => root.render(<Markdown text={doc} />));
			expect(container.innerHTML).toBe(expected);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("does not re-lex the whole text while the tail is still growing", async () => {
		const doc = DOCS[0]!;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const lexer = vi.spyOn(marked, "lexer");
		try {
			await act(async () => root.render(<Markdown text={doc.slice(0, 16)} />));
			lexer.mockClear();
			for (let cut = 32; cut <= doc.length; cut += 16) {
				await act(async () => root.render(<Markdown text={doc.slice(0, cut)} />));
			}
			await act(async () => root.render(<Markdown text={doc} />));
			expect(lexer).toHaveBeenCalled();
			// A tail window is always a strict suffix of the rendered text, so no
			// call may receive a full rendered prefix — that would be a full lex.
			const renderedTexts = new Set<string>();
			for (let cut = 16; cut <= doc.length; cut += 16) renderedTexts.add(doc.slice(0, cut));
			for (const [source] of lexer.mock.calls) {
				expect(renderedTexts.has(source)).toBe(false);
			}
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps block element identity stable across append frames", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<Markdown text={"first block\n\nsecond block"} />));
			const stable = container.querySelector("p");
			expect(stable).not.toBeNull();
			await act(async () => root.render(<Markdown text={"first block\n\nsecond block grows"} />));
			expect(container.querySelector("p")).toBe(stable);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("re-renders translated inline content when the language changes", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<Markdown text={"![diagram](diagram.png)"} />));
			expect(container.querySelector("a")?.textContent).toBe("[Image: diagram]");
			await act(async () => {
				await i18n.changeLanguage("zh-CN");
			});
			expect(container.querySelector("a")?.textContent).toBe("[图片：diagram]");
		} finally {
			await act(async () => {
				await i18n.changeLanguage("en");
			});
			await act(async () => root.unmount());
		}
	});
});
