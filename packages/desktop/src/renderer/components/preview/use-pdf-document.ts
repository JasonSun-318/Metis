import * as pdfjsLib from "pdfjs-dist";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { pdfCMapUrl, pdfStandardFontDataUrl, pdfWorkerSrc } from "./pdf-assets.ts";
import type { PreviewSize } from "./preview-layout.ts";

const workerSrc = pdfWorkerSrc();
if (workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const defaultSize: PreviewSize = { width: 800, height: 1130 };

export interface PdfDocumentState {
	readonly doc: pdfjsLib.PDFDocumentProxy | null;
	readonly initialSize: PreviewSize;
	readonly error: string | null;
}

interface PdfDocumentPayload {
	readonly bytes: Uint8Array;
	readonly doc: pdfjsLib.PDFDocumentProxy | null;
	readonly initialSize: PreviewSize;
	readonly error: string | null;
}

function pdfLoadError(cause: unknown, fallback: string): string {
	const name = typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
	const message = cause instanceof Error && cause.message ? cause.message : "";
	if (name === "PasswordException") return `${fallback} (${message || "password required"})`;
	if (name === "InvalidPDFException") return `${fallback} (${message || "invalid PDF file"})`;
	return message || fallback;
}

export function usePdfDocument(bytes: Uint8Array): PdfDocumentState {
	const { t } = useTranslation();
	const [payload, setPayload] = useState<PdfDocumentPayload | null>(null);

	useEffect(() => {
		let cancelled = false;
		setPayload({ bytes, doc: null, initialSize: defaultSize, error: null });
		if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
			setPayload({ bytes, doc: null, initialSize: defaultSize, error: t("Failed to load PDF document") });
			return;
		}
		// PDF.js transfers ownership to its worker. Keep the caller's bytes intact.
		const task = pdfjsLib.getDocument({
			data: Uint8Array.from(bytes),
			cMapUrl: pdfCMapUrl(),
			cMapPacked: true,
			standardFontDataUrl: pdfStandardFontDataUrl(),
		});
		void task.promise
			.then(async (document) => {
				const first = await document.getPage(1);
				if (cancelled) return;
				const viewport = first.getViewport({ scale: 1 });
				setPayload({
					bytes,
					doc: document,
					initialSize: { width: viewport.width, height: viewport.height },
					error: null,
				});
			})
			.catch((cause) => {
				if (!cancelled)
					setPayload({
						bytes,
						doc: null,
						initialSize: defaultSize,
						error: pdfLoadError(cause, t("Failed to load PDF document")),
					});
			});
		return () => {
			cancelled = true;
			void task.destroy();
		};
	}, [bytes, t]);

	// Effects run after render; without this guard the first render of a new bytes payload would still expose the previous document.
	if (!payload || payload.bytes !== bytes) return { doc: null, initialSize: defaultSize, error: null };
	return { doc: payload.doc, initialSize: payload.initialSize, error: payload.error };
}
