import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../Markdown.tsx";
import { useFileSelections } from "./FileSelectionContext.tsx";
import { FileSelectionPopover } from "./FileSelectionPopover.tsx";
import { type DraftFileSelection, selectionFromRange } from "./file-selection.ts";
import { usePreviewExpansion } from "./PreviewFrame.tsx";
import { PreviewToolbar } from "./PreviewToolbar.tsx";
import { decodePreviewText, formatPreviewText } from "./preview-bytes.ts";
import type { UniversalPreviewTarget } from "./preview-kinds.ts";

export interface TextViewerProps {
	readonly fileName: string;
	readonly file?: UniversalPreviewTarget;
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
	file,
	kind,
	onClose,
	onOpenDefault,
	onReveal,
}: TextViewerProps) {
	const { t } = useTranslation();
	const actions = useFileSelections();
	const expansion = usePreviewExpansion();
	const bodyRef = useRef<HTMLDivElement>(null);
	const [selection, setSelection] = useState<{ draft: DraftFileSelection; range: Range } | null>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState("");
	const sourceText = useMemo(() => decodePreviewText(bytes), [bytes]);
	const text = useMemo(
		() => (kind === "markdown" ? sourceText : formatPreviewText(fileName, sourceText)),
		[sourceText, fileName, kind],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies(file?.fileId): New content or file identity invalidates the previous text selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies(file?.relativePath): New content or file identity invalidates the previous text selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies(file?.sessionId): New content or file identity invalidates the previous text selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies(sourceText): New content or file identity invalidates the previous text selection.
	useEffect(() => {
		setSelection(null);
		setOpen(false);
		setError("");
	}, [sourceText, file?.sessionId, file?.relativePath, file?.fileId]);
	const capture = () => {
		const native = window.getSelection();
		const root = bodyRef.current;
		if (!actions?.enabled || !file || !root || !native?.rangeCount) return;
		try {
			const range = native.getRangeAt(0).cloneRange();
			const draft = selectionFromRange({
				root,
				range,
				file,
				sourceText,
				displayText: text,
				kind,
				selectedText: native.toString(),
			});
			if (draft) {
				setSelection({ draft, range });
				setOpen(true);
				setError("");
			}
		} catch (cause) {
			setOpen(false);
			setError(cause instanceof Error ? cause.message : "Failed to add reference");
		}
	};
	const focusComposer = () => {
		if (expansion?.expanded) expansion.toggle();
		requestAnimationFrame(() =>
			(
				document.getElementById(`composer-input-${selection?.draft.sessionId}`) ??
				document.getElementById("composer-input")
			)?.focus(),
		);
	};

	return (
		<div className="universal-previewer text-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
			/>
			<div
				className="preview-viewport text-viewport code-turn-answer"
				role="document"
				aria-label={fileName}
				ref={bodyRef}
				onPointerUp={(event) => {
					if (event.button === 0) capture();
				}}
				onKeyUp={(event) => {
					if (event.key === "Shift") capture();
				}}
			>
				{kind === "markdown" ? (
					<article className="file-markdown">
						<Markdown text={text} sourcePositions />
					</article>
				) : (
					<pre className="preview-plain-text">{text}</pre>
				)}
			</div>
			{error && (
				<div className="selection-error" role="alert">
					{t(error)}
				</div>
			)}
			{selection && actions && (
				<FileSelectionPopover
					key={selection.draft.id}
					selection={selection.draft}
					range={selection.range}
					open={open}
					enabled={actions.enabled}
					onAdd={() => actions.add(selection.draft)}
					onRequestChange={(instruction) => actions.requestChange(selection.draft, instruction)}
					onDismiss={() => setOpen(false)}
					onAccepted={focusComposer}
				/>
			)}
		</div>
	);
}
