// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/renderer/components/Markdown.tsx";
import { BLOCK_MATH_TYPE } from "../src/renderer/components/markdown-math.ts";
import { lexMarkdown, markdownParser } from "../src/renderer/components/markdown-parser.ts";
import i18n from "../src/renderer/i18n.ts";

const DOCS = [
	"# Title\n\nHere is **some** text and `code`.\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\n- item one\n- item two\n- item three\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> a quote\n\nfinal paragraph\n",
	"opening words\n\nsecond block\n===\n\n- loose one\n\n- loose two\n\ntrailing text\n",
	"first [ref] mention\n\nmore body\n\n[ref]: https://example.com\n\nclosing\n",
	"para one\n\npara two\n\npara three\n===\n\ndone\n",
	"$$\n\\begin{aligned}\na &= 1 + 2\n\nb &= a \\cdot 3\n\\end{aligned}\n$$\n\nText with $E=mc^2$ inline, \\(x^2 + y^2\\) too, and a price $5 shared with $10.\n\n```\n$not math$\n```\n",
	"> [!note] Custom heading\n> body with **bold** and $a+b$\n\n> [!faq]- Folded question\n> hidden answer\n\n> [!warning]\n> alias-less default title\n\n> not a callout header\n",
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
		const lexer = vi.spyOn(markdownParser, "lexer");
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

	it("typesets inline and block formulas with KaTeX", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(<Markdown text={"Inline $E=mc^2$ and \\(x^2\\).\n\n$$\na = \\frac{1}{2}\n$$"} />),
			);
			const mathHosts = container.querySelectorAll(".markdown-math");
			expect(mathHosts.length).toBe(3);
			expect(mathHosts[0]?.querySelector(".katex")).not.toBeNull();
			expect(mathHosts[2]?.closest(".markdown-math-block")).not.toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps prices, escaped dollars and code as plain text", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<Markdown
						text={
							"It costs $5 now and $10 later.\n\nEscaped \\$5 stays literal.\n\n`$not math$`\n\n```\n$$ fenced $$\n```"
						}
					/>,
				),
			);
			expect(container.querySelector(".markdown-math, .markdown-math-block")).toBeNull();
			expect(container.textContent).toContain("$5 now and $10 later.");
			expect(container.textContent).toContain("$not math$");
			expect(container.textContent).toContain("$$ fenced $$");
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("renders an unclosed block formula as pending raw text that tiles the input", () => {
		const partial = "before\n\n$$\nx = 1\n\nstill open";
		const tokens = lexMarkdown(partial);
		expect(tokens.map((token) => token.raw).join("")).toBe(partial);
		const pending = tokens.find((token) => token.type === BLOCK_MATH_TYPE);
		expect(pending?.raw).toBe("$$\nx = 1\n\nstill open");
	});

	it("streams every prefix of an unclosed formula through the pending token", async () => {
		const doc = "intro\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\noutro\n";
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			const expected = await renderFresh(doc);
			for (let cut = 1; cut <= doc.length; cut += 1) {
				await act(async () => root.render(<Markdown text={doc.slice(0, cut)} />));
			}
			expect(container.innerHTML).toBe(expected);
			expect(container.querySelector(".markdown-math-block .katex")).not.toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("falls back to source text for a broken formula without blanking the document", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<Markdown text={"good $a+b$ then $\\broken{$ then final"} />));
			expect(container.querySelector(".markdown-math-fallback")).not.toBeNull();
			expect(container.textContent).toContain("then final");
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("renders callout types, aliases, custom titles and unknown types", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<Markdown
						text={
							"> [!WARNING] Watch out\n> body\n\n> [!tldr] Summary alias\n> body\n\n> [!custom-thing] Unknown type\n> body\n\n> [!unfinished\n> still a quote"
						}
					/>,
				),
			);
			const callouts = container.querySelectorAll(".markdown-callout");
			expect(callouts.length).toBe(3);
			expect(callouts[0]?.className).toContain("markdown-callout-warning");
			expect(callouts[0]?.textContent).toContain("Watch out");
			expect(callouts[1]?.className).toContain("markdown-callout-abstract");
			expect(callouts[2]?.className).toContain("markdown-callout-note");
			expect(callouts[2]?.textContent).toContain("Unknown type");
			expect(container.querySelector("blockquote")?.textContent).toContain("still a quote");
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("supports nested callouts and preserves fold state across streaming appends", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			const prefix = "> [!question]+ Nested\n> > [!note] Inner\n> > inner body\n";
			await act(async () => root.render(<Markdown text={prefix} />));
			const inner = container.querySelector(".markdown-callout-note");
			expect(inner?.textContent).toContain("inner body");
			const details = container.querySelector("details.markdown-callout") as HTMLDetailsElement | null;
			expect(details?.open).toBe(true);
			details!.open = false;
			await act(async () => details!.dispatchEvent(new Event("toggle")));
			await act(async () => root.render(<Markdown text={`${prefix}> more streamed body\n`} />));
			expect((container.querySelector("details.markdown-callout") as HTMLDetailsElement | null)?.open).toBe(false);
			expect(container.querySelector(".markdown-callout-note")?.textContent).toContain("inner body");
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps the native wrapper so quote attribution reaches callouts and block math", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<Markdown quoteItemId="q1" text={"> [!note] T\n> b\n\n$$x$$"} />));
			expect(container.querySelector(".markdown-callout-host")?.getAttribute("data-quote-item")).toBe("q1");
			expect(container.querySelector(".markdown-math-block")?.getAttribute("data-quote-item")).toBe("q1");
		} finally {
			await act(async () => root.unmount());
		}
	});
});
