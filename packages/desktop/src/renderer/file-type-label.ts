import type { TFunction } from "i18next";

const FILE_KIND_KEY_BY_EXTENSION: Record<string, string> = {
	csv: "Spreadsheet",
	xls: "Spreadsheet",
	xlsx: "Spreadsheet",
	doc: "Document",
	docx: "Document",
	md: "Document",
	markdown: "Document",
	pdf: "PDF",
	png: "Image",
	jpg: "Image",
	jpeg: "Image",
	gif: "Image",
	webp: "Image",
	svg: "Image",
	txt: "Text",
	json: "JSON",
	ts: "TypeScript",
	tsx: "TypeScript",
	js: "JavaScript",
	jsx: "JavaScript",
	py: "Python",
	html: "HTML",
	css: "Stylesheet",
	zip: "Archive",
};

export function fileTypeLabel(name: string, t: TFunction): string {
	const extension = name.match(/\.([^.]+)$/u)?.[1]?.toLowerCase();
	if (!extension) return t("File");
	const kindKey = FILE_KIND_KEY_BY_EXTENSION[extension] ?? "File";
	return `${t(kindKey)} · ${extension.toUpperCase()}`;
}

export function fileBaseName(name: string): string {
	const leaf = name.split(/[/\\]/u).at(-1) ?? name;
	return leaf.replace(/\.[^.]+$/u, "") || leaf;
}
