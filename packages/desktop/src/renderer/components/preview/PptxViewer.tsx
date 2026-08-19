import { SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PreviewToolbar } from "./PreviewToolbar.tsx";

export interface PptxViewerProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

export function PptxViewer({ fileName, byteLength, bytes, onClose, onOpenDefault, onReveal }: PptxViewerProps) {
	const { t } = useTranslation();
	const hostRef = useRef<HTMLDivElement>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let cancelled = false;
		let handle: { destroy?: () => void; cleanup?: () => void } | undefined;
		setLoading(true);
		setError(null);
		void (async () => {
			try {
				const { PptxViewer: PptxRenderer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
				if (cancelled) return;
				handle = await PptxRenderer.open(Uint8Array.from(bytes).buffer, host, {
					zipLimits: RECOMMENDED_ZIP_LIMITS,
					listOptions: { windowed: true },
					scrollContainer: host.parentElement instanceof HTMLElement ? host.parentElement : host,
				});
				if (cancelled) {
					handle?.destroy?.();
					handle?.cleanup?.();
					return;
				}
				setLoading(false);
			} catch (cause) {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : t("Failed to parse PowerPoint presentation"));
				setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
			handle?.destroy?.();
			handle?.cleanup?.();
			host.replaceChildren();
		};
	}, [bytes, t]);

	return (
		<div className="universal-previewer pptx-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
			/>
			<div className="preview-viewport pptx-viewport">
				{loading && (
					<div className="preview-loading-state">
						<SpinnerGap aria-hidden="true" className="is-spinning" size={28} />
						<span>{t("Loading PowerPoint presentation…")}</span>
					</div>
				)}
				{error && (
					<div className="preview-error-state">
						<span>{error}</span>
					</div>
				)}
				<div className="pptx-render-host" ref={hostRef} />
			</div>
		</div>
	);
}
