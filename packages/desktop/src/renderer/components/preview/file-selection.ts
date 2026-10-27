import type { ClientParams } from "@metis/app-protocol";
import type { UniversalPreviewTarget } from "./preview-kinds.ts";

export type FileSelectionInput = NonNullable<ClientParams<"turn/start">["fileSelections"]>[number];
export interface DraftFileSelection {
	readonly id: string;
	readonly sessionId: string;
	readonly name: string;
	readonly input: FileSelectionInput;
}

export function selectionFromDocument(
	file: UniversalPreviewTarget,
	target: NonNullable<FileSelectionInput["target"]>,
	selectedText: string,
	sourceExcerpt?: string,
): DraftFileSelection | null {
	const draft = selectionFromText({ file, sourceText: selectedText, selectedText, basis: "formatted" });
	if (!draft) return null;
	const input = { ...draft.input, target, ...(sourceExcerpt === undefined ? {} : { sourceExcerpt }) };
	validateSelectionSize([input]);
	return { ...draft, input, id: JSON.stringify([file.sessionId, input]) };
}

export function selectionTargetLabel(target: FileSelectionInput["target"]): string {
	if (!target) return "";
	if (target.kind === "spreadsheet") return `${target.sheet}!${target.range}`;
	if (target.kind === "pptx") return `${target.page} · ${target.objectName || target.objectId}`;
	return target.endPage && target.endPage !== target.page ? `${target.page}–${target.endPage}` : String(target.page);
}

export function validateSelectionSize(selections: readonly FileSelectionInput[]): void {
	if (selections.length > 8) throw new Error("Select at most 8 text fragments");
	let bytes = 0;
	for (const selection of selections) {
		if (!selection.selectedText.trim() || Array.from(selection.selectedText).length > 8000)
			throw new Error("Select a smaller text fragment");
		if (Array.from(selection.sourceExcerpt ?? "").length > 4000) throw new Error("Select a smaller text fragment");
		bytes += new TextEncoder().encode(selection.selectedText + (selection.sourceExcerpt ?? "")).byteLength;
	}
	if (bytes > 32768) throw new Error("Selected text exceeds 32 KiB. Remove or shorten a fragment");
}

export function selectionFromRange({
	root,
	range,
	file,
	sourceText,
	displayText,
	kind,
	selectedText = range.toString(),
}: {
	root: HTMLElement;
	range: Range;
	file: UniversalPreviewTarget;
	sourceText: string;
	displayText: string;
	kind: "markdown" | "text";
	selectedText?: string;
}): DraftFileSelection | null {
	if (
		range.collapsed ||
		!root.contains(range.startContainer) ||
		!root.contains(range.endContainer) ||
		!selectedText.trim()
	)
		return null;
	for (const button of Array.from(root.querySelectorAll("button, textarea, [contenteditable=true]")))
		if (!button.hasAttribute("data-math-copy") && range.intersectsNode(button)) return null;
	// Embedded content has another file owner and cannot inherit this document's line numbers.
	for (const embed of Array.from(root.querySelectorAll("[data-markdown-embed]")))
		if (range.intersectsNode(embed)) return null;
	if (kind === "markdown") {
		const startElement =
			range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
		const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
		const startMath = startElement?.closest<HTMLElement>("[data-markdown-math-source]");
		if (startMath && startMath === endElement?.closest("[data-markdown-math-source]")) {
			selectedText = startMath.dataset.markdownMathSource ?? selectedText;
		} else if (
			Array.from(root.querySelectorAll("[data-markdown-math-source]")).some((math) => range.intersectsNode(math))
		) {
			const fragment = range.cloneContents();
			for (const button of Array.from(fragment.querySelectorAll("[data-math-copy]"))) button.remove();
			for (const math of Array.from(fragment.querySelectorAll<HTMLElement>("[data-markdown-math-source]")))
				math.replaceWith(document.createTextNode(math.dataset.markdownMathSource ?? ""));
			selectedText = fragment.textContent ?? selectedText;
		}
	}
	const source = kind === "markdown" ? sourceText.replace(/\r\n?/gu, "\n") : sourceText;
	let start: number | undefined;
	let end: number | undefined;
	const basis = kind === "markdown" ? "markdown" : sourceText === displayText ? "source" : "formatted";
	if (basis === "source") {
		const prefix = document.createRange();
		prefix.selectNodeContents(root);
		prefix.setEnd(range.startContainer, range.startOffset);
		start = prefix.toString().length;
		prefix.setEnd(range.endContainer, range.endOffset);
		end = prefix.toString().length;
	} else if (basis === "markdown") {
		const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-source-start]")).filter((block) =>
			range.intersectsNode(block),
		);
		if (blocks.length) {
			start = Number(blocks[0]!.dataset.sourceStart);
			end = Number(blocks.at(-1)!.dataset.sourceEnd);
		}
	}
	return selectionFromText({ file, sourceText: source, selectedText, basis, start, end });
}

/** Positions come from the full document, including CodeMirror's unrendered lines. */
export function selectionFromText({
	file,
	sourceText: source,
	selectedText,
	basis,
	start,
	end,
}: {
	file: UniversalPreviewTarget;
	sourceText: string;
	selectedText: string;
	basis: FileSelectionInput["basis"];
	start?: number;
	end?: number;
}): DraftFileSelection | null {
	if (!selectedText.trim()) return null;
	const identity =
		file.source === "workspace" && file.relativePath
			? { source: "workspace" as const, relativePath: file.relativePath }
			: file.source === "delivered" && file.fileId
				? { source: "delivered" as const, fileId: file.fileId }
				: null;
	if (!identity) return null;
	const excerpt = start === undefined || end === undefined ? undefined : Array.from(source.slice(start, end));
	const sourceExcerpt = excerpt
		? excerpt.length > 4000
			? [...excerpt.slice(0, 2000), ...excerpt.slice(-2000)].join("")
			: excerpt.join("")
		: undefined;
	const input: FileSelectionInput = {
		...identity,
		basis,
		selectedText,
		...(sourceExcerpt === undefined
			? {}
			: { sourceExcerpt, ...(excerpt!.length > 4000 ? { excerptTruncated: true } : {}) }),
		...(start === undefined || end === undefined
			? {}
			: {
					startLine: source.slice(0, start).split("\n").length,
					endLine: source.slice(0, Math.max(start, end - 1)).split("\n").length,
				}),
	};
	validateSelectionSize([input]);
	return { id: JSON.stringify([file.sessionId, input]), sessionId: file.sessionId, name: file.name, input };
}
