export type PreviewKind = "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "image" | "markdown" | "text" | "unsupported";

const ENGINE_KINDS = new Set<PreviewKind>(["pdf", "docx", "pptx", "xlsx", "csv"]);

const KIND_BY_EXT: Record<string, PreviewKind> = {
	pdf: "pdf",
	docx: "docx",
	pptx: "pptx",
	xlsx: "xlsx",
	csv: "csv",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	svg: "image",
	md: "markdown",
	markdown: "markdown",
	txt: "text",
	json: "text",
	js: "text",
	jsx: "text",
	ts: "text",
	tsx: "text",
	py: "text",
	css: "text",
	html: "text",
	yml: "text",
	yaml: "text",
};

export function fileExtension(fileName: string): string {
	const lastDot = fileName.lastIndexOf(".");
	if (lastDot <= 0) return "";
	return fileName.slice(lastDot + 1).toLowerCase();
}

export function classifyPreviewKind(fileName: string): PreviewKind {
	return KIND_BY_EXT[fileExtension(fileName)] ?? "unsupported";
}

export function isEnginePreviewKind(kind: PreviewKind): boolean {
	return ENGINE_KINDS.has(kind);
}
