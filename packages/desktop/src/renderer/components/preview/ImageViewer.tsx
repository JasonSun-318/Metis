import { useMemo, useState } from "react";
import { PreviewToolbar } from "./PreviewToolbar.tsx";
import { bytesToDataUrl, previewImageMediaType } from "./preview-bytes.ts";

export interface ImageViewerProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly mediaType?: string;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

export function ImageViewer({
	byteLength,
	bytes,
	fileName,
	mediaType,
	onClose,
	onOpenDefault,
	onReveal,
}: ImageViewerProps) {
	const [zoom, setZoom] = useState(100);
	const src = useMemo(
		() => bytesToDataUrl(bytes, previewImageMediaType(fileName, mediaType)),
		[bytes, fileName, mediaType],
	);
	return (
		<div className="universal-previewer image-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
				onZoomIn={() => setZoom((value) => Math.min(300, value + 20))}
				onZoomOut={() => setZoom((value) => Math.max(50, value - 20))}
				onZoomReset={() => setZoom(100)}
				zoom={zoom}
			/>
			<div className="preview-viewport image-viewport">
				<img
					alt={fileName}
					className="preview-image-element file-image"
					src={src}
					style={{ maxHeight: `${zoom}%`, maxWidth: `${zoom}%` }}
				/>
			</div>
		</div>
	);
}
