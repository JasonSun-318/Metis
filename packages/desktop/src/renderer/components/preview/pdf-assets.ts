export function pdfWorkerSrc(): string {
	return new URL("./pdf.worker.min.mjs", document.baseURI).toString();
}

export function pdfCMapUrl(): string {
	return new URL("./pdfjs/cmaps/", document.baseURI).toString();
}

export function pdfStandardFontDataUrl(): string {
	return new URL("./pdfjs/standard_fonts/", document.baseURI).toString();
}
