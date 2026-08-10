import type { SessionTaskView, SkillSummaryView } from "@metis/app-protocol";
import { ArrowUp, Paperclip, Scroll, Stop, X } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { ComposerAddMenu } from "./ComposerAddMenu.tsx";
import { TaskList } from "./TaskList.tsx";

export interface ComposerSubmission {
	readonly text: string;
	readonly attachments: readonly DesktopAttachmentSelection[];
	readonly skill?: SkillSummaryView;
}

interface ComposerProps {
	readonly disabled: boolean;
	readonly running: boolean;
	readonly onInterrupt: () => Promise<void>;
	readonly onSubmit: (input: ComposerSubmission) => Promise<void>;
	readonly onManageSkills?: () => void;
	readonly onPickFiles?: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly appearance?: "chat" | "code";
	readonly interactionControl?: ReactNode;
	readonly modelControl?: ReactNode;
	readonly permissionControl?: ReactNode;
	readonly placeholder?: string;
	readonly skills?: readonly SkillSummaryView[];
	readonly submitDisabled?: boolean;
	readonly tasks?: readonly SessionTaskView[];
	readonly taskListEpoch?: string | null;
	readonly thinkingControl?: ReactNode;
}

export function Composer({
	disabled,
	running,
	onInterrupt,
	onSubmit,
	onManageSkills,
	onPickFiles,
	appearance = "code",
	interactionControl,
	modelControl,
	permissionControl,
	placeholder,
	skills = [],
	submitDisabled = false,
	tasks = [],
	taskListEpoch,
	thinkingControl,
}: ComposerProps) {
	const { t } = useTranslation();
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<readonly DesktopAttachmentSelection[]>([]);
	const [selectedSkill, setSelectedSkill] = useState<SkillSummaryView>();
	const [submitting, setSubmitting] = useState(false);
	const hasInput = text.trim().length > 0 || attachments.length > 0;
	useEffect(() => {
		setSelectedSkill((current) => current && skills.some(({ name }) => name === current.name) ? current : undefined);
	}, [skills]);
	const addFiles = async () => {
		if (!onPickFiles) return;
		const selected = await onPickFiles();
		setAttachments((current) => {
			const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
			for (const attachment of selected) byPath.set(attachment.path, attachment);
			return [...byPath.values()].slice(0, 16);
		});
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const prompt = text.trim();
		if ((!prompt && attachments.length === 0) || disabled || submitDisabled || submitting) return;
		setSubmitting(true);
		try {
			await onSubmit({
				text: prompt,
				attachments,
				...(selectedSkill ? { skill: selectedSkill } : {}),
			});
			setText("");
			setAttachments([]);
			setSelectedSkill(undefined);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="composer-dock">
			<TaskList key={taskListEpoch ?? undefined} tasks={tasks} />
			{interactionControl}
			<form className={`composer composer-${appearance}`} onSubmit={(event) => void submit(event).catch(() => undefined)}>
				<label className="sr-only" htmlFor="composer-input">{t("Message Metis")}</label>
				<textarea
					disabled={disabled || submitting}
					id="composer-input"
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={placeholder ?? t(running ? "Steer the active task…" : "Ask Metis anything, or describe a task…")}
					rows={1}
					value={text}
				/>
				{(selectedSkill || attachments.length > 0) && (
					<div aria-label={t("Message additions")} className="composer-chips">
						{selectedSkill && (
							<button aria-label={t("Remove skill {{name}}", { name: selectedSkill.name })} onClick={() => setSelectedSkill(undefined)} type="button">
								<Scroll aria-hidden="true" size={14} />
								<span>{selectedSkill.name}</span>
								<X aria-hidden="true" size={12} />
							</button>
						)}
						{attachments.map((attachment) => (
							<button aria-label={t("Remove file {{name}}", { name: attachment.name })} key={attachment.path} onClick={() => setAttachments((current) => current.filter(({ path }) => path !== attachment.path))} type="button">
								<Paperclip aria-hidden="true" size={14} />
								<span>{attachment.name}</span>
								<X aria-hidden="true" size={12} />
							</button>
						))}
					</div>
				)}
				<div className="composer-actions">
					<div className="composer-leading">
						<ComposerAddMenu
							disabled={disabled || submitting}
							onAddFiles={() => void addFiles().catch(() => undefined)}
							onManageSkills={() => onManageSkills?.()}
							onSelectSkill={setSelectedSkill}
							skills={skills}
						/>
						{permissionControl}
					</div>
					<div className="composer-trailing">
						{modelControl}
						{thinkingControl}
						{running && !hasInput ? (
							<button aria-label={t("Stop task")} className="composer-icon-button composer-stop button-secondary" disabled={disabled} onClick={() => void onInterrupt().catch(() => undefined)} type="button">
								<Stop aria-hidden="true" size={16} weight="fill" />
							</button>
						) : <button aria-label={t(running ? "Steer task" : "Send message")} className="composer-icon-button composer-send" disabled={disabled || submitDisabled || submitting || !hasInput} type="submit">
							<ArrowUp aria-hidden="true" size={19} weight="bold" />
						</button>}
					</div>
				</div>
			</form>
			{appearance === "chat" && (
				<p className="composer-disclaimer">{t("Metis is AI and can make mistakes. Please double-check responses.")}</p>
			)}
		</div>
	);
}
