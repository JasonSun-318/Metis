// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Markdown } from "../src/renderer/components/Markdown.tsx";
import { selectionFromRange, validateSelectionSize } from "../src/renderer/components/preview/file-selection.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let reactRoot: Root | undefined;
afterEach(() => {
	if (reactRoot) act(() => reactRoot!.unmount());
	reactRoot = undefined;
	document.body.replaceChildren();
});
const file = { source: "workspace" as const, sessionId: "one", relativePath: "notes.md", name: "notes.md" };
function select(root: HTMLElement, text: string, occurrence = 0): Range {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const offset = node.textContent!.indexOf(text);
		if (offset < 0 || occurrence-- > 0) continue;
		const range = document.createRange();
		range.setStart(node, offset);
		range.setEnd(node, offset + text.length);
		return range;
	}
	throw new Error("Missing selection text");
}
it("locates plain text without trimming its indentation and excludes outside selections", () => {
	const root = document.createElement("pre");
	const sourceText = "first\n  second\nthird";
	root.textContent = sourceText;
	document.body.append(root);
	const range = select(root, "  second");
	expect(
		selectionFromRange({ root, range, file, sourceText, displayText: sourceText, kind: "text" })?.input,
	).toMatchObject({ basis: "source", selectedText: "  second", startLine: 2, endLine: 2 });
	const outside = document.createTextNode("outside");
	document.body.append(outside);
	range.setEnd(outside, 3);
	expect(selectionFromRange({ root, range, file, sourceText, displayText: sourceText, kind: "text" })).toBeNull();
});
it("anchors the second identical rendered Markdown phrase to its source block", () => {
	const sourceText = "# Heading\r\n\r\n**same** text\r\n\r\n**same** text\r\n";
	const root = document.createElement("article");
	document.body.append(root);
	reactRoot = createRoot(root);
	act(() => reactRoot!.render(<Markdown text={sourceText} sourcePositions />));
	const result = selectionFromRange({
		root,
		range: select(root, "same", 1),
		file,
		sourceText,
		displayText: sourceText,
		kind: "markdown",
	});
	expect(result?.input).toMatchObject({
		selectedText: "same",
		sourceExcerpt: "**same** text\n",
		startLine: 5,
		endLine: 5,
		basis: "markdown",
	});
});
it("does not invent source positions for formatted JSON or silently clip long selections", () => {
	const root = document.createElement("pre");
	const sourceText = '{"a":1}';
	const displayText = JSON.stringify(JSON.parse(sourceText), null, 2);
	root.textContent = displayText;
	document.body.append(root);
	const input = selectionFromRange({
		root,
		range: select(root, '"a"'),
		file,
		sourceText,
		displayText,
		kind: "text",
	})!.input;
	expect(input.basis).toBe("formatted");
	expect(input.startLine).toBeUndefined();
	expect(() => validateSelectionSize([{ ...input, selectedText: "x".repeat(8001) }])).toThrow("smaller");
	expect(() =>
		validateSelectionSize(Array.from({ length: 8 }, () => ({ ...input, selectedText: "中".repeat(2000) }))),
	).toThrow("32 KiB");
});
it("keeps normal Markdown unmarked and supports lists, tables and code source blocks", () => {
	const sourceText =
		"- **bold**\n- [link](https://example.com)\n\n| Name | Value |\n| --- | --- |\n| row | value |\n\n```js\nconst answer = 42;\n```\n";
	const root = document.createElement("article");
	document.body.append(root);
	reactRoot = createRoot(root);
	act(() => reactRoot!.render(<Markdown text={sourceText} />));
	expect(root.querySelector("[data-source-start]")).toBeNull();
	act(() => reactRoot!.render(<Markdown text={sourceText} sourcePositions />));
	for (const text of ["bold", "link", "value", "const answer = 42;"]) {
		const input = selectionFromRange({
			root,
			range: select(root, text),
			file,
			sourceText,
			displayText: sourceText,
			kind: "markdown",
		})!.input;
		expect(input.selectedText).toBe(text);
		expect(input.startLine).toBeGreaterThan(0);
		expect(input.sourceExcerpt).toContain(text);
	}
});

it("falls back to a quote when rendered Markdown has no source metadata", () => {
	const sourceText = "[label][target]\n\n[target]: https://example.com\n";
	const root = document.createElement("article");
	document.body.append(root);
	reactRoot = createRoot(root);
	act(() => reactRoot!.render(<Markdown text={sourceText} />));
	const input = selectionFromRange({
		root,
		range: select(root, "label"),
		file,
		sourceText,
		displayText: sourceText,
		kind: "markdown",
	})!.input;
	expect(input.selectedText).toBe("label");
	expect(input.basis).toBe("markdown");
	expect(input.startLine).toBeUndefined();
});

it("uses TeX once instead of duplicate visual and MathML content", () => {
	const root = document.createElement("article");
	root.innerHTML =
		'<div data-source-start="0" data-source-end="11"><span data-markdown-math-source="x^2"><span>hidden</span><span>visual</span></span></div>';
	document.body.append(root);
	const input = selectionFromRange({
		root,
		range: select(root, "visual"),
		file,
		sourceText: "$x^2$\r\n",
		displayText: "$x^2$\n",
		kind: "markdown",
	})!.input;
	expect(input.selectedText).toBe("x^2");
	expect(input.sourceExcerpt).toContain("$x^2$");
	expect(input.startLine).toBe(1);
});

it("rejects parent-file references when a selection intersects a child embed", () => {
	const root = document.createElement("article");
	root.innerHTML =
		'<div data-source-start="0" data-source-end="10">parent<div data-markdown-embed="true">child text</div></div>';
	document.body.append(root);
	const range = document.createRange();
	range.selectNodeContents(root);
	expect(
		selectionFromRange({ root, range, file, sourceText: "![[child]]", displayText: "![[child]]", kind: "markdown" }),
	).toBeNull();
});
