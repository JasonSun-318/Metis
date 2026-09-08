import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationSubmission } from "../../composer-submission.ts";
import { type DraftFileSelection, validateSelectionSize } from "./file-selection.ts";

interface FileSelectionActions {
	readonly enabled: boolean;
	readonly selections: readonly DraftFileSelection[];
	add(selection: DraftFileSelection): void;
	remove(ids: readonly string[]): void;
	requestChange(selection: DraftFileSelection, instruction: string): Promise<void>;
}
const FileSelectionContext = createContext<FileSelectionActions | null>(null);
export const useFileSelections = () => useContext(FileSelectionContext);

export function FileSelectionProvider({
	sessionId,
	enabled,
	onSubmit,
	children,
}: {
	sessionId: string | null;
	enabled: boolean;
	onSubmit: (input: ConversationSubmission) => Promise<void>;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<{ sessionId: string | null; selections: readonly DraftFileSelection[] }>({
		sessionId,
		selections: [],
	});
	const generation = useMemo(() => ({}), [sessionId]);
	const current = useRef({ sessionId, enabled, generation });
	current.current = { sessionId, enabled, generation };
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const mounted = useRef(true);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useLayoutEffect(() => {
		setDraft({ sessionId, selections: [] });
	}, [sessionId]);
	const selections = draft.sessionId === sessionId ? draft.selections : [];
	const assertCurrent = (selection: DraftFileSelection) => {
		if (
			!mounted.current ||
			!current.current.enabled ||
			!sessionId ||
			current.current.generation !== generation ||
			selection.sessionId !== sessionId
		)
			throw new Error(t("This conversation is not ready to send"));
	};
	return (
		<FileSelectionContext.Provider
			value={{
				enabled,
				selections,
				add(selection) {
					assertCurrent(selection);
					const existing = draftRef.current.sessionId === sessionId ? draftRef.current.selections : [];
					if (existing.some((item) => item.id === selection.id)) return;
					const next = [...existing, selection];
					validateSelectionSize(next.map((item) => item.input));
					draftRef.current = { sessionId, selections: next };
					setDraft(draftRef.current);
				},
				remove(ids) {
					if (!mounted.current || current.current.generation !== generation) return;
					const value = draftRef.current;
					if (value.sessionId !== sessionId) return;
					draftRef.current = { ...value, selections: value.selections.filter((item) => !ids.includes(item.id)) };
					setDraft(draftRef.current);
				},
				async requestChange(selection, instruction) {
					assertCurrent(selection);
					if (!instruction.trim()) throw new Error(t("Describe the change first"));
					validateSelectionSize([selection.input]);
					await onSubmit({
						text: t("Request changes to {{name}}: {{instruction}}", {
							name: selection.name,
							instruction: instruction.trim(),
						}),
						attachments: [],
						fileSelections: [selection.input],
					});
				},
			}}
		>
			{children}
		</FileSelectionContext.Provider>
	);
}

export function FileSelectionChips() {
	const context = useFileSelections();
	const { t } = useTranslation();
	if (!context?.selections.length) return null;
	return (
		<details className="composer-selections">
			<summary>{t("{{count}} selected text fragments", { count: context.selections.length })}</summary>
			<div className="composer-selection-list">
				{context.selections.map((selection) => (
					<div className="composer-selection" key={selection.id}>
						<div>
							<strong title={selection.name}>{selection.name}</strong>
							<button
								type="button"
								aria-label={t("Remove reference {{name}}", { name: selection.name })}
								onClick={() => context.remove([selection.id])}
							>
								×
							</button>
						</div>
						<small>
							{selection.input.source === "workspace" ? selection.input.relativePath : t("Delivered version")}
							{selection.input.startLine !== undefined
								? ` · ${t("Lines {{start}}–{{end}}", { start: selection.input.startLine, end: selection.input.endLine })}`
								: ""}
						</small>
						<blockquote>{selection.input.selectedText}</blockquote>
					</div>
				))}
			</div>
		</details>
	);
}
