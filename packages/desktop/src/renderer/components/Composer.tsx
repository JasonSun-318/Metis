import type { McpServerSummaryView, SessionTaskView, SkillSummaryView } from "@metis/app-protocol";
import { ArrowUp, Scroll, Stop, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { ComposerAddMenu } from "./ComposerAddMenu.tsx";
import {
	composerSlashCommands,
	type ComposerSlashCommand,
	SlashCommandMenu,
} from "./SlashCommandMenu.tsx";
import { TaskList } from "./TaskList.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

const noSlashCommands = new Set<ComposerSlashCommand>();

function attachmentTypeLabel(name: string): string {
	const extension = name.match(/\.([^.]+)$/u)?.[1];
	return extension ? extension.slice(0, 8).toLocaleUpperCase("en-US") : "FILE";
}

export interface ComposerSubmission {
	readonly text: string;
	readonly attachments: readonly DesktopAttachmentSelection[];
	readonly skill?: SkillSummaryView;
}

interface ComposerProps {
	readonly disabled: boolean;
	readonly running: boolean;
	readonly queueing?: boolean;
	readonly commandPanel?: ReactNode;
	readonly commandRequest?: { readonly id: number; readonly open: boolean };
	readonly disabledSlashCommands?: ReadonlySet<ComposerSlashCommand>;
	readonly disabledSlashReasons?: Partial<Record<ComposerSlashCommand, string>>;
	readonly onInterrupt: () => Promise<void>;
	readonly onSubmit: (input: ComposerSubmission) => Promise<void>;
	readonly onManageMcp?: () => void;
	readonly onManageSkills?: () => void;
	readonly onPickFiles?: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onSlashCommand?: (command: ComposerSlashCommand) => void | Promise<void>;
	readonly appearance?: "chat" | "code";
	readonly interactionControl?: ReactNode;
	readonly queuedTurnControl?: ReactNode;
	readonly modelControl?: ReactNode;
	readonly mcpConnectionState?: "connecting" | "failed";
	readonly mcpServers?: readonly McpServerSummaryView[];
	readonly permissionControl?: ReactNode;
	readonly placeholder?: string;
	readonly skills?: readonly SkillSummaryView[];
	readonly submitDisabled?: boolean;
	readonly tasks?: readonly SessionTaskView[];
	readonly taskListEpoch?: string | null;
	readonly thinkingControl?: ReactNode;
	/** Live cache hit percentage for the active session; null when there is no usage yet. */
	readonly cacheHitPercent?: number | null;
}

export function Composer({
	disabled,
	running,
	queueing = false,
	commandPanel,
	commandRequest,
	disabledSlashCommands = noSlashCommands,
	disabledSlashReasons,
	onInterrupt,
	onSubmit,
	onManageMcp,
	onManageSkills,
	onPickFiles,
	onSlashCommand,
	appearance = "code",
	cacheHitPercent,
	interactionControl,
	queuedTurnControl,
	modelControl,
	mcpConnectionState,
	mcpServers = [],
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
	const [skillPrefix, setSkillPrefix] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [dismissedSlashText, setDismissedSlashText] = useState<string>();
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const selectionOffset = useRef(0);
	const fullText = `${skillPrefix}${text}`;
	const textRef = useRef(fullText);
	textRef.current = fullText;
	const hasInput = fullText.trim().length > 0 || attachments.length > 0 || selectedSkill !== undefined;
	const slashQuery = !selectedSkill && text.startsWith("/") && !/\s/u.test(text.slice(1)) && dismissedSlashText !== text
		? text.slice(1)
		: undefined;
	const exactCommand = selectedSkill ? undefined : composerSlashCommands.find((command) => text.trim() === `/${command}`);
	useEffect(() => {
		if (!selectedSkill || skills.some(({ name }) => name === selectedSkill.name)) return;
		setText(fullText);
		setSkillPrefix("");
		setSelectedSkill(undefined);
	}, [fullText, selectedSkill, skills]);
	const handleSlashDismiss = useCallback(() => setDismissedSlashText(textRef.current), []);
	const handleSelectCommand = useCallback((command: ComposerSlashCommand) => {
		if (disabledSlashCommands.has(command)) return;
		setText("");
		void Promise.resolve(onSlashCommand?.(command)).catch(() => undefined);
	}, [disabledSlashCommands, onSlashCommand]);
	const handleSelectSkill = useCallback((skill: SkillSummaryView) => {
		setSelectedSkill(skill);
		setSkillPrefix("");
		setText("");
	}, []);
	const handleAddSkill = useCallback((skill: SkillSummaryView) => {
		if (selectedSkill) {
			setSelectedSkill(skill);
			return;
		}
		const offset = Math.max(0, Math.min(inputRef.current?.selectionStart ?? selectionOffset.current, text.length));
		setSkillPrefix(text.slice(0, offset));
		setText(text.slice(offset));
		setSelectedSkill(skill);
		queueMicrotask(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(0, 0);
		});
	}, [selectedSkill, text]);
	const removeSkill = useCallback(() => {
		const offset = skillPrefix.length;
		setText(fullText);
		setSkillPrefix("");
		setSelectedSkill(undefined);
		queueMicrotask(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(offset, offset);
		});
	}, [fullText, skillPrefix.length]);
	const addFiles = async () => {
		if (!onPickFiles) return;
		const selected = await onPickFiles();
		setAttachments((current) => {
			const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
			for (const attachment of selected) byPath.set(attachment.path, attachment);
			return [...byPath.values()].slice(0, 16);
		});
	};
	const removeAttachment = (path: string) => {
		setAttachments((current) => current.filter((attachment) => attachment.path !== path));
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const prompt = fullText.trim();
		if (!hasInput || disabled || submitDisabled || submitting) return;
		if (exactCommand && onSlashCommand) {
			if (disabledSlashCommands.has(exactCommand)) return;
			setText("");
			await onSlashCommand(exactCommand);
			return;
		}
		setSubmitting(true);
		try {
			await onSubmit({
				text: prompt,
				attachments,
				...(selectedSkill ? { skill: selectedSkill } : {}),
			});
			setText("");
			setSkillPrefix("");
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
			{commandPanel}
			{slashQuery !== undefined && (
				<SlashCommandMenu
					disabledCommands={disabledSlashCommands}
					disabledReasons={disabledSlashReasons}
					onDismiss={handleSlashDismiss}
					onSelectCommand={handleSelectCommand}
					onSelectSkill={handleSelectSkill}
					query={slashQuery}
					skills={skills}
				/>
			)}
			{queuedTurnControl}
			<form className={`composer composer-${appearance}`} onSubmit={(event) => void submit(event).catch(() => undefined)}>
				<label className="sr-only" htmlFor="composer-input">{t("Message Metis")}</label>
				{attachments.length > 0 && (
					<div aria-label={t("Message additions")} className="composer-attachments">
						{attachments.map((attachment) => attachment.previewDataUrl ? (
							<div className="composer-image-preview" key={attachment.path}>
								<img alt={attachment.name} src={attachment.previewDataUrl} />
								<button aria-label={t("Remove file {{name}}", { name: attachment.name })} onClick={() => removeAttachment(attachment.path)} type="button">
									<X aria-hidden="true" size={12} />
								</button>
							</div>
						) : (
							<div className="composer-file-card" key={attachment.path}>
								<span className="composer-file-card-icon"><WorkspaceFileIcon path={attachment.name} size={22} /></span>
								<span className="composer-file-card-copy">
									<strong title={attachment.name}>{attachment.name}</strong>
									<small>{attachmentTypeLabel(attachment.name)}</small>
								</span>
								<button aria-label={t("Remove file {{name}}", { name: attachment.name })} onClick={() => removeAttachment(attachment.path)} type="button">
									<X aria-hidden="true" size={12} />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="composer-input-line">
					{selectedSkill && skillPrefix !== "" && (
						<textarea
							aria-label={t("Message before selected Skill")}
							className="composer-input-before"
							disabled={disabled || submitting}
							onChange={(event) => setSkillPrefix(event.target.value)}
							onKeyDown={(event) => {
								if (event.defaultPrevented || event.nativeEvent.isComposing) return;
								if (event.key === "Delete" && event.currentTarget.selectionStart === skillPrefix.length && event.currentTarget.selectionEnd === skillPrefix.length) {
									event.preventDefault();
									removeSkill();
									return;
								}
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									event.currentTarget.form?.requestSubmit();
								}
							}}
							rows={1}
							value={skillPrefix}
						/>
					)}
					{selectedSkill && (
						<button aria-label={t("Remove skill {{name}}", { name: selectedSkill.name })} className="composer-skill-token" onClick={removeSkill} type="button">
							<Scroll aria-hidden="true" size={16} />
							<span>{selectedSkill.name}</span>
						</button>
					)}
					<textarea
						disabled={disabled || submitting}
						id="composer-input"
						onChange={(event) => {
							const next = event.target.value;
							setText(next);
							selectionOffset.current = event.target.selectionStart ?? next.length;
							// Re-arm the slash menu when the query diverges from the one
							// the user dismissed, so clearing and retyping the same
							// command opens it again.
							if (dismissedSlashText !== undefined && next !== dismissedSlashText) {
								setDismissedSlashText(undefined);
							}
						}}
						onKeyDown={(event) => {
							if (event.defaultPrevented) return;
							if (event.key === "Backspace" && selectedSkill && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0 && !event.nativeEvent.isComposing) {
								event.preventDefault();
								removeSkill();
								return;
							}
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								event.currentTarget.form?.requestSubmit();
							}
						}}
						placeholder={placeholder ?? t(running || queueing ? "Add a queued message…" : "Ask Metis anything, or describe a task…")}
						onSelect={(event) => {
							selectionOffset.current = event.currentTarget.selectionStart ?? text.length;
						}}
						ref={inputRef}
						rows={1}
						value={text}
					/>
				</div>
				<div className="composer-actions">
					<div className="composer-leading">
						<ComposerAddMenu
							commandRequest={commandRequest}
							disabled={disabled || submitting}
							mcpServers={mcpServers}
							onAddFiles={() => void addFiles().catch(() => undefined)}
							onManageMcp={() => onManageMcp?.()}
							onManageSkills={() => onManageSkills?.()}
							onSelectSkill={handleAddSkill}
							skills={skills}
						/>
						{permissionControl}
						{mcpConnectionState === "connecting" && <span className="composer-mcp-status" role="status">{t("MCP connecting")}</span>}
						{mcpConnectionState === "failed" && <button className="composer-mcp-status is-error" onClick={() => onManageMcp?.()} type="button">{t("MCP connection failed")}</button>}
					</div>
					<div className="composer-trailing">
						{cacheHitPercent !== null && cacheHitPercent !== undefined && (
							<span
								aria-label={`${t("Cache hit rate")} ${Math.round(cacheHitPercent)}%`}
								className="composer-cache-hit"
							>
								<span className="composer-cache-hit-label">{t("Cache")}</span>
								<strong>{Math.round(cacheHitPercent)}%</strong>
							</span>
						)}
						{modelControl}
						{thinkingControl}
						{running && !hasInput ? (
							<button aria-label={t("Stop task")} className="composer-icon-button composer-stop button-secondary" disabled={disabled} onClick={() => void onInterrupt().catch(() => undefined)} type="button">
								<Stop aria-hidden="true" size={16} weight="fill" />
							</button>
						) : <button aria-label={t(running || queueing ? "Queue message" : "Send message")} className="composer-icon-button composer-send" disabled={disabled || submitDisabled || submitting || !hasInput} type="submit">
							<ArrowUp aria-hidden="true" size={19} weight="bold" />
						</button>}
					</div>
				</div>
			</form>
		</div>
	);
}
