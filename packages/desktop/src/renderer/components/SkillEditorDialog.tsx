import type { SkillDetailView, WritableSkillSourceView } from "@metis/app-protocol";
import { X } from "@phosphor-icons/react";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogFrame } from "./DialogFrame.tsx";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function SkillEditorDialog({
	error,
	initial,
	mode,
	onCancel,
	onSubmit,
	pending,
}: {
	readonly mode: "create" | "edit";
	readonly source: WritableSkillSourceView;
	readonly initial?: SkillDetailView;
	readonly pending: boolean;
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onSubmit: (name: string, content: string) => void;
}) {
	const { t } = useTranslation();
	const nameInput = useRef<HTMLInputElement>(null);
	const contentInput = useRef<HTMLTextAreaElement>(null);
	const instructionsInput = useRef<HTMLTextAreaElement>(null);
	const keepEditingButton = useRef<HTMLButtonElement>(null);
	const [name, setName] = useState(initial?.name ?? "");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const [content, setContent] = useState(initial?.content ?? "");
	const [localError, setLocalError] = useState<string | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const dirty =
		mode === "create"
			? name !== "" || description !== "" || instructions !== ""
			: content !== (initial?.content ?? "");
	const focusEditor = () => (mode === "create" ? nameInput : contentInput).current?.focus();
	const close = () => {
		if (pending) return;
		if (confirmDiscard) {
			setConfirmDiscard(false);
			focusEditor();
			return;
		}
		if (dirty) setConfirmDiscard(true);
		else onCancel();
	};
	const keepEditing = () => {
		setConfirmDiscard(false);
		focusEditor();
	};
	const discard = () => {
		if (pending) return;
		setConfirmDiscard(false);
		onCancel();
	};
	useLayoutEffect(() => {
		if (confirmDiscard) keepEditingButton.current?.focus();
	}, [confirmDiscard]);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (confirmDiscard) return;
		if (!SKILL_NAME.test(name)) {
			setLocalError(t("Use lowercase letters, numbers, and single hyphens for the Skill name."));
			return;
		}
		if (mode === "create" && !description.trim()) {
			setLocalError(t("Description cannot be empty."));
			return;
		}
		if (mode === "create" && !instructions.trim()) {
			setLocalError(t("Instructions cannot be empty."));
			return;
		}
		if (mode === "edit" && !content.trim()) {
			setLocalError(t("SKILL.md cannot be empty."));
			return;
		}
		setLocalError(null);
		onSubmit(
			name,
			mode === "create"
				? `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${instructions.trim()}\n`
				: content,
		);
	};
	return (
		<DialogFrame
			cancellable={!pending}
			className={`mcp-dialog dialog-form-dialog skill-editor-dialog is-${mode}`}
			descriptionId="skill-editor-description"
			initialFocus={mode === "create" ? nameInput : contentInput}
			onCancel={close}
			titleId="skill-editor-title"
		>
			<button aria-label={t("Close")} className="mcp-dialog-close" disabled={pending} onClick={close} type="button">
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="skill-editor-title">{t(mode === "create" ? "Write skill instructions" : "Edit Skill")}</h2>
			<p className="sr-only" id="skill-editor-description">
				{t("Create or update the Skill instructions stored in SKILL.md.")}
			</p>
			<form className="dialog-form-layout" onSubmit={submit}>
				<div className="dialog-form-body">
					<label>
						{t(mode === "create" ? "Skill name" : "Name")}
						<input
							disabled={mode === "edit" || pending}
							onChange={(event) => {
								setName(event.target.value);
								setLocalError(null);
							}}
							placeholder={mode === "create" ? "weekly-status-report" : undefined}
							ref={nameInput}
							required
							value={name}
						/>
					</label>
					{mode === "create" ? (
						<>
							<label>
								{t("Description")}
								<textarea
									className="skill-editor-description"
									disabled={pending}
									onChange={(event) => {
										setDescription(event.target.value);
										setLocalError(null);
									}}
									placeholder={t(
										"Generate weekly status reports from recent work. Use when asked for updates or progress summaries.",
									)}
									required
									value={description}
								/>
							</label>
							<label>
								{t("Instructions")}
								<textarea
									className="skill-editor-instructions"
									disabled={pending}
									onChange={(event) => {
										setInstructions(event.target.value);
										setLocalError(null);
									}}
									placeholder={t("Summarize recent work in three sections: wins, blockers, and next steps.")}
									ref={instructionsInput}
									required
									value={instructions}
								/>
							</label>
						</>
					) : (
						<label>
							{t("SKILL.md")}
							<textarea
								disabled={pending}
								onChange={(event) => {
									setContent(event.target.value);
									setLocalError(null);
								}}
								ref={contentInput}
								value={content}
							/>
						</label>
					)}
					{(localError || error) && (
						<p className="mcp-dialog-error" role="alert">
							{localError || error}
						</p>
					)}
				</div>
				{confirmDiscard ? (
					<div className="mcp-dialog-actions skill-editor-discard">
						<p role="alert" style={{ margin: "0 auto 0 0" }}>
							{t("Your changes have not been saved. Keep editing to save them, or discard them to leave.")}
						</p>
						<button className="button-secondary" onClick={keepEditing} ref={keepEditingButton} type="button">
							{t("Keep editing")}
						</button>
						<button className="mcp-danger" disabled={pending} onClick={discard} type="button">
							{t("Discard changes")}
						</button>
					</div>
				) : (
					<div className="mcp-dialog-actions">
						<button className="button-secondary" disabled={pending} onClick={close} type="button">
							{t("Cancel")}
						</button>
						<button disabled={pending} type="submit">
							{t(pending ? "Saving…" : mode === "create" ? "Create" : "Save")}
						</button>
					</div>
				)}
			</form>
		</DialogFrame>
	);
}
