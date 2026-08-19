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
	mdx: "markdown",
	txt: "text",
	json: "text",
	jsonc: "text",
	js: "text",
	cjs: "text",
	mjs: "text",
	jsx: "text",
	ts: "text",
	cts: "text",
	mts: "text",
	tsx: "text",
	py: "text",
	pyw: "text",
	css: "text",
	scss: "text",
	less: "text",
	html: "text",
	htm: "text",
	xml: "text",
	yml: "text",
	yaml: "text",
	toml: "text",
	ini: "text",
	log: "text",
	sh: "text",
	bash: "text",
	sql: "text",
	rs: "text",
	go: "text",
	rb: "text",
	php: "text",
	c: "text",
	h: "text",
	cpp: "text",
	cs: "text",
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

export function isHostedPreviewKind(kind: PreviewKind): boolean {
	return isEnginePreviewKind(kind) || kind === "image";
}
