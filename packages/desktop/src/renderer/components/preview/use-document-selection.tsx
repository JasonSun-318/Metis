import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileSelections } from "./FileSelectionContext.tsx";
import { FileSelectionPopover } from "./FileSelectionPopover.tsx";
import { type DraftFileSelection, type FileSelectionInput, selectionFromDocument } from "./file-selection.ts";
import { usePreviewExpansion } from "./PreviewFrame.tsx";
import type { UniversalPreviewTarget } from "./PreviewHost.tsx";

export function useDocumentSelection(file: UniversalPreviewTarget | undefined, bytes: Uint8Array) {
	const actions = useFileSelections();
	const expansion = usePreviewExpansion();
	const { t } = useTranslation();
	const [selected, setSelected] = useState<{ draft: DraftFileSelection; anchor: Range | HTMLElement } | null>(null);
	const [error, setError] = useState("");
	const locked = useRef(false);
	const clear = () => {
		locked.current = false;
		setSelected(null);
		setError("");
	};
	useEffect(clear, [bytes, file?.sessionId, file?.relativePath, file?.fileId]);
	useEffect(() => {
		if (!selected || selected.anchor instanceof Range) return;
		const anchor = selected.anchor;
		anchor.classList.add("is-document-selected");
		return () => anchor.classList.remove("is-document-selected");
	}, [selected]);
	return {
		enabled: Boolean(file && actions?.enabled),
		clear,
		select(
			target: NonNullable<FileSelectionInput["target"]>,
			text: string,
			anchor: Range | HTMLElement,
			excerpt?: string,
		) {
			if (!file || !actions?.enabled || locked.current) return;
			try {
				const draft = selectionFromDocument(file, target, text, excerpt);
				if (draft) {
					setSelected((old) => (old?.draft.id === draft.id && old.anchor === anchor ? old : { draft, anchor }));
					setError("");
				}
			} catch (cause) {
				setSelected(null);
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		popover: (
			<>
				{error && (
					<div className="selection-error" role="alert">
						{t(error)}
					</div>
				)}
				{selected && actions && (
					<FileSelectionPopover
						key={selected.draft.id}
						selection={selected.draft}
						range={selected.anchor}
						open
						enabled={actions.enabled}
						requestOnly
						onAdd={() => {}}
						onEditing={() => {
							locked.current = true;
						}}
						onRequestChange={(instruction) => actions.requestChange(selected.draft, instruction)}
						onDismiss={clear}
						onAccepted={() => {
							if (expansion?.expanded) expansion.toggle();
							requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
						}}
					/>
				)}
			</>
		),
	};
}
