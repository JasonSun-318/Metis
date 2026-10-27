import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationSubmission } from "../../composer-submission.ts";
import { X } from "../../icons.tsx";
import { DrawerDetails } from "../DrawerDetails.tsx";
import { type DraftFileSelection, selectionTargetLabel, validateSelectionSize } from "./file-selection.ts";

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
	enabled,
	onSubmit,
	children,
}: {
	enabled: boolean;
	onSubmit: (sessionId: string, input: ConversationSubmission) => Promise<void>;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	// Selections are keyed by the owning tab's session so each session's
	// composer stages and submits only its own references.
	const [drafts, setDrafts] = useState<ReadonlyMap<string, readonly DraftFileSelection[]>>(new Map());
	const current = useRef({ enabled });
	current.current = { enabled };
	const draftsRef = useRef(drafts);
	draftsRef.current = drafts;
	const mounted = useRef(true);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const selections = useMemo(() => [...drafts.values()].flat(), [drafts]);
	const assertReady = () => {
		if (!mounted.current || !current.current.enabled) throw new Error(t("This conversation is not ready to send"));
	};
	const replaceDrafts = (next: ReadonlyMap<string, readonly DraftFileSelection[]>) => {
		draftsRef.current = next;
		setDrafts(next);
	};
	return (
		<FileSelectionContext.Provider
			value={{
				enabled,
				selections,
				add(selection) {
					assertReady();
					const existing = draftsRef.current.get(selection.sessionId) ?? [];
					if (existing.some((item) => item.id === selection.id)) return;
					const next = [...existing, selection];
					validateSelectionSize(next.map((item) => item.input));
					replaceDrafts(new Map(draftsRef.current).set(selection.sessionId, next));
				},
				remove(ids) {
					if (!mounted.current) return;
					let changed = false;
					const next = new Map(draftsRef.current);
					for (const [sessionId, items] of next) {
						const kept = items.filter((item) => !ids.includes(item.id));
						if (kept.length === items.length) continue;
						changed = true;
						if (kept.length === 0) next.delete(sessionId);
						else next.set(sessionId, kept);
					}
					if (changed) replaceDrafts(next);
				},
				async requestChange(selection, instruction) {
					assertReady();
					if (!instruction.trim()) throw new Error(t("Describe the change first"));
					validateSelectionSize([selection.input]);
					await onSubmit(selection.sessionId, {
						text: t("Request changes to {{name}}: {{instruction}}", {
							name: selection.input.target
								? `${selection.name} · ${selectionTargetLabel(selection.input.target)}`
								: selection.name,
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

export function FileSelectionChips({ sessionId }: { readonly sessionId?: string | null }) {
	const context = useFileSelections();
	const { t } = useTranslation();
	const selections =
		sessionId === undefined
			? (context?.selections ?? [])
			: (context?.selections ?? []).filter((selection) => selection.sessionId === sessionId);
	if (!selections.length) return null;
	return (
		<DrawerDetails
			className="composer-selections"
			summary={t("{{count}} selected text fragments", { count: selections.length })}
		>
			<div className="composer-selection-list">
				{selections.map((selection) => (
					<div className="composer-selection" key={selection.id}>
						<div>
							<strong title={selection.name}>{selection.name}</strong>
							<button
								type="button"
								aria-label={t("Remove reference {{name}}", { name: selection.name })}
								onClick={() => context?.remove([selection.id])}
							>
								<X aria-hidden="true" size={14} />
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
		</DrawerDetails>
	);
}
