import type { KnowledgeLibrary } from "@metis/app-protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Trash } from "../icons.tsx";
import { DialogFrame } from "./DialogFrame.tsx";

export function KnowledgeLibraryRemove({
	libraries,
	disabled,
	pending,
	active,
	onRemove,
}: {
	readonly libraries: readonly KnowledgeLibrary[];
	readonly disabled: boolean;
	readonly pending: boolean;
	readonly active: boolean;
	readonly onRemove: (ids: readonly string[]) => Promise<string[]>;
}) {
	const { t } = useTranslation();
	const id = useId();
	const list = useRef<HTMLUListElement>(null);
	const submitting = useRef(false);
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<readonly string[]>([]);
	const [partialFailure, setPartialFailure] = useState(false);
	const close = useCallback(() => {
		setOpen(false);
		setSelected([]);
		setPartialFailure(false);
	}, []);
	// A hidden panel or an externally changed catalog invalidates the open draft.
	useEffect(() => {
		if (!active) close();
	}, [active, close]);
	useEffect(() => {
		setSelected((current) => current.filter((libraryId) => libraries.some((library) => library.id === libraryId)));
	}, [libraries]);
	const confirm = async () => {
		if (submitting.current || pending || disabled || selected.length === 0) return;
		submitting.current = true;
		setPartialFailure(false);
		try {
			const removed = await onRemove(selected);
			if (removed.length >= selected.length) {
				close();
				return;
			}
			const succeeded = new Set(removed);
			setSelected((current) => current.filter((libraryId) => !succeeded.has(libraryId)));
			setPartialFailure(true);
		} catch {
			setPartialFailure(true);
		} finally {
			submitting.current = false;
		}
	};
	return (
		<>
			<button
				type="button"
				className="knowledge-remove-button"
				aria-controls={open ? `${id}-portal` : undefined}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={t("Remove knowledge libraries")}
				disabled={disabled || pending || libraries.length === 0}
				title={t("Remove only from Metis. Local directories and files are kept.")}
				onClick={() => setOpen(true)}
			>
				<Trash aria-hidden="true" size={15} />
				<span>{t("Remove knowledge libraries")}</span>
			</button>
			{open &&
				createPortal(
					<div className="knowledge-remove-portal" id={`${id}-portal`}>
						<DialogFrame
							cancellable={!pending}
							className="project-dialog knowledge-remove-dialog"
							descriptionId={`${id}-description`}
							initialFocus={list}
							onCancel={close}
							titleId={`${id}-title`}
						>
							<h2 id={`${id}-title`}>{t("Remove knowledge libraries")}</h2>
							<p id={`${id}-description`}>
								{t("Remove only from Metis. Local directories and files are kept.")}{" "}
								{t("Conversation links to removed libraries are cleared.")}
							</p>
							<ul className="knowledge-remove-list" ref={list} tabIndex={-1}>
								{libraries.map((library) => (
									<li key={library.id}>
										<label>
											<input
												aria-label={library.name}
												aria-describedby={`${id}-${library.id}-path`}
												checked={selected.includes(library.id)}
												disabled={pending}
												type="checkbox"
												onChange={(event) =>
													setSelected((current) =>
														event.target.checked
															? [...current, library.id]
															: current.filter((item) => item !== library.id),
													)
												}
											/>
											<span className="knowledge-remove-copy">
												<span>{library.name}</span>
												<small id={`${id}-${library.id}-path`}>{library.path}</small>
											</span>
										</label>
									</li>
								))}
							</ul>
							{partialFailure && (
								<p className="knowledge-remove-partial" role="alert">
									{t("Some knowledge libraries could not be removed. Try again.")}
								</p>
							)}
							<div className="project-dialog-actions">
								<button className="button-secondary" disabled={pending} onClick={close} type="button">
									{t("Cancel")}
								</button>
								<button
									className="knowledge-remove-confirm"
									disabled={pending || selected.length === 0}
									onClick={() => void confirm()}
									type="button"
								>
									{pending ? t("Removing…") : t("Remove {{count}} libraries", { count: selected.length })}
								</button>
							</div>
						</DialogFrame>
					</div>,
					document.body,
				)}
		</>
	);
}
