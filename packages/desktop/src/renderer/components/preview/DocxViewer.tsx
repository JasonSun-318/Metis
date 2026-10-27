import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SpinnerGap } from "../../icons.tsx";
import { PreviewToolbar } from "./PreviewToolbar.tsx";

export interface DocxViewerProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

export function DocxViewer({ fileName, byteLength, bytes, onClose, onOpenDefault, onReveal }: DocxViewerProps) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const [zoom, setZoom] = useState(100);
	const [inverted, setInverted] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		const host = containerRef.current;
		if (!host) return;
		host.replaceChildren();
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		void import("docx-preview")
			.then((docx) =>
				docx.renderAsync(buffer, host, undefined, {
					className: "docx-document",
					inWrapper: true,
					ignoreWidth: false,
					ignoreHeight: false,
					useBase64URL: false,
				}),
			)
			.then(
				() => {
					if (!active) return;
					setLoading(false);
				},
				(cause) => {
					if (!active) return;
					setError(cause instanceof Error ? cause.message : t("Failed to render Word document"));
					setLoading(false);
				},
			);
		return () => {
			active = false;
		};
	}, [bytes, t]);

	return (
		<div className="universal-previewer docx-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				fileName={fileName}
				isInverted={inverted}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
				onToggleInvert={() => setInverted((value) => !value)}
				onZoomIn={() => setZoom((value) => Math.min(250, value + 15))}
				onZoomOut={() => setZoom((value) => Math.max(60, value - 15))}
				onZoomReset={() => setZoom(100)}
				showInvertToggle
				zoom={zoom}
			/>
			<div className={`preview-viewport docx-viewport${inverted ? " is-inverted" : ""}`}>
				{loading && (
					<div className="preview-loading-state">
						<SpinnerGap aria-hidden="true" className="is-spinning" size={28} />
						<span>{t("Rendering Word document…")}</span>
					</div>
				)}
				{error && (
					<div className="preview-error-state">
						<span>{error}</span>
					</div>
				)}
				<div className="docx-render-wrapper" ref={containerRef} style={{ zoom: `${zoom}%` }} />
			</div>
		</div>
	);
}
