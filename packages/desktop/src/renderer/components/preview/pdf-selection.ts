/** Native text selection only. Screen rectangles never enter the model context. */
export function pdfTextSelection(root: HTMLElement, range: Range, text: string) {
	if (range.collapsed || !text.trim() || !root.contains(range.startContainer) || !root.contains(range.endContainer))
		return null;
	const pageFor = (node: Node) => {
		const element = node instanceof Element ? node : node.parentElement;
		return element?.closest(".textLayer")?.closest<HTMLElement>("[data-page]");
	};
	const start = pageFor(range.startContainer),
		end = pageFor(range.endContainer);
	if (!start || !end) return null;
	const page = Number(start.dataset.page),
		endPage = Number(end.dataset.page);
	if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(endPage) || endPage < page) return null;
	return { target: { kind: "pdf" as const, page, ...(endPage === page ? {} : { endPage }) }, text };
}
