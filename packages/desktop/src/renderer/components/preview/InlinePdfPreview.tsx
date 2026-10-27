import { useTranslation } from "react-i18next";
import { SpinnerGap } from "../../icons.tsx";
import { PdfPage } from "./PdfPage.tsx";
import { usePreviewViewport } from "./preview-layout.ts";
import { usePdfDocument } from "./use-pdf-document.ts";

export interface InlinePdfPreviewProps {
	readonly bytes: Uint8Array;
	/** 1-based page number; validated against the document's real page count. */
	readonly page: number;
	readonly fileName: string;
	readonly onOpen?: () => void;
}

export function InlinePdfPreview({ bytes, page, fileName, onOpen }: InlinePdfPreviewProps) {
	const { t } = useTranslation();
	const { doc, initialSize, error } = usePdfDocument(bytes);
	const { ref, size } = usePreviewViewport();
	const outOfRange = doc !== null && (!Number.isInteger(page) || page < 1 || page > doc.numPages);
	return (
		<figure className="pdf-inline-preview" data-file-name={fileName}>
			{error ? (
				<div className="preview-error-state" role="alert">
					{error}
				</div>
			) : outOfRange ? (
				<div className="preview-error-state" role="alert">
					{t("PDF page out of range")} ({page} / {doc?.numPages})
				</div>
			) : !doc ? (
				<div className="preview-loading-state">
					<SpinnerGap className="is-spinning" size={20} />
					<span>{t("Loading PDF document…")}</span>
				</div>
			) : (
				<div ref={ref} className="pdf-inline-preview-viewport">
					{/* PdfPage caches its loaded page; remount per page so switching never shows the previous page. */}
					<PdfPage
						key={page}
						doc={doc}
						number={page}
						mode="width"
						viewport={size}
						initialSize={initialSize}
						scrollRef={ref}
					/>
				</div>
			)}
			<figcaption className="pdf-inline-preview-caption">
				<span className="pdf-inline-preview-name" title={fileName}>
					{fileName}
				</span>
				{doc && !outOfRange && (
					<span className="pdf-inline-preview-page">
						{page} / {doc.numPages}
					</span>
				)}
				{onOpen && (
					<button className="pdf-inline-preview-open" type="button" onClick={onOpen}>
						{t("Open full preview")}
					</button>
				)}
			</figcaption>
		</figure>
	);
}
