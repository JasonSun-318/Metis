import { useMemo } from "react";
import { Markdown } from "../Markdown.tsx";
import { decodePreviewText, formatPreviewText } from "./preview-bytes.ts";
import { PreviewToolbar } from "./PreviewToolbar.tsx";

export interface TextViewerProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly kind: "markdown" | "text";
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

export function TextViewer({
	byteLength,
	bytes,
	fileName,
	kind,
	onClose,
	onOpenDefault,
	onReveal,
}: TextViewerProps) {
	const text = useMemo(() => {
		const decoded = decodePreviewText(bytes);
		return kind === "markdown" ? decoded : formatPreviewText(fileName, decoded);
	}, [bytes, fileName, kind]);
	return (
		<div className="universal-previewer text-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
			/>
			<div className="preview-viewport text-viewport code-turn-answer">
				{kind === "markdown" ? (
					<article className="file-markdown">
						<Markdown text={text} />
					</article>
				) : (
					<pre className="preview-plain-text">{text}</pre>
				)}
			</div>
		</div>
	);
}
