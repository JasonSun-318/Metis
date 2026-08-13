import type { SkillDetailView, WritableSkillSourceView } from "@metis/app-protocol";
import { X } from "@phosphor-icons/react";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogFrame } from "./ProjectActions.tsx";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function SkillEditorDialog({ error, initial, mode, onCancel, onSubmit, pending, source }: {
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
	const [name, setName] = useState(initial?.name ?? "");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const [content, setContent] = useState(initial?.content ?? "");
	const [localError, setLocalError] = useState<string | null>(null);
	const submit = (event: FormEvent) => {
		event.preventDefault();
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
		onSubmit(name, mode === "create"
			? `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${instructions.trim()}\n`
			: content);
	};
	return (
		<DialogFrame
			cancellable={!pending}
			className={`mcp-dialog skill-editor-dialog is-${mode}`}
			descriptionId="skill-editor-description"
			initialFocus={mode === "create" ? nameInput : contentInput}
			onCancel={onCancel}
			titleId="skill-editor-title"
		>
			<button aria-label={t("Close")} className="mcp-dialog-close" disabled={pending} onClick={onCancel} type="button"><X aria-hidden="true" size={17} /></button>
			<h2 id="skill-editor-title">{t(mode === "create" ? "Write skill instructions" : "Edit Skill")}</h2>
			<p className="sr-only" id="skill-editor-description">{t("Create or update the Skill instructions stored in SKILL.md.")}</p>
			<form onSubmit={submit}>
				<label>{t(mode === "create" ? "Skill name" : "Name")}<input disabled={mode === "edit" || pending} onChange={(event) => setName(event.target.value)} placeholder={mode === "create" ? "weekly-status-report" : undefined} ref={nameInput} required value={name} /></label>
				{mode === "create" ? <>
					<label>{t("Description")}<textarea className="skill-editor-description" disabled={pending} onChange={(event) => setDescription(event.target.value)} placeholder={t("Generate weekly status reports from recent work. Use when asked for updates or progress summaries.")} required value={description} /></label>
					<label>{t("Instructions")}<textarea className="skill-editor-instructions" disabled={pending} onChange={(event) => setInstructions(event.target.value)} placeholder={t("Summarize recent work in three sections: wins, blockers, and next steps.")} ref={instructionsInput} required value={instructions} /></label>
				</> : <label>{t("SKILL.md")}<textarea disabled={pending} onChange={(event) => setContent(event.target.value)} ref={contentInput} value={content} /></label>}
				{(localError || error) && <p className="mcp-dialog-error" role="alert">{localError || error}</p>}
				<div className="mcp-dialog-actions"><button className="button-secondary" disabled={pending} onClick={onCancel} type="button">{t("Cancel")}</button><button disabled={pending} type="submit">{t(pending ? "Saving…" : mode === "create" ? "Create" : "Save")}</button></div>
			</form>
		</DialogFrame>
	);
}
