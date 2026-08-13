import type { McpServerSummaryView, SessionTaskView, SkillSummaryView } from "@metis/app-protocol";
import { ArrowUp, Paperclip, Scroll, Stop, X } from "@phosphor-icons/react";
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

const noSlashCommands = new Set<ComposerSlashCommand>();

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
	const [submitting, setSubmitting] = useState(false);
	const [dismissedSlashText, setDismissedSlashText] = useState<string>();
	const textRef = useRef(text);
	textRef.current = text;
	const hasInput = text.trim().length > 0 || attachments.length > 0 || selectedSkill !== undefined;
	const slashQuery = text.startsWith("/") && !/\s/u.test(text.slice(1)) && dismissedSlashText !== text
		? text.slice(1)
		: undefined;
	const exactCommand = composerSlashCommands.find((command) => text.trim() === `/${command}`);
	useEffect(() => {
		setSelectedSkill((current) => current && skills.some(({ name }) => name === current.name) ? current : undefined);
	}, [skills]);
	const handleSlashDismiss = useCallback(() => setDismissedSlashText(textRef.current), []);
	const handleSelectCommand = useCallback((command: ComposerSlashCommand) => {
		if (disabledSlashCommands.has(command)) return;
		setText("");
		void Promise.resolve(onSlashCommand?.(command)).catch(() => undefined);
	}, [disabledSlashCommands, onSlashCommand]);
	const handleSelectSkill = useCallback((skill: SkillSummaryView) => {
		setSelectedSkill(skill);
		setText("");
	}, []);
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
				<textarea
					disabled={disabled || submitting}
					id="composer-input"
						onChange={(event) => {
							const next = event.target.value;
							setText(next);
							// Re-arm the slash menu when the query diverges from the one
							// the user dismissed, so clearing and retyping the same
							// command opens it again.
							if (dismissedSlashText !== undefined && next !== dismissedSlashText) {
								setDismissedSlashText(undefined);
							}
						}}
					onKeyDown={(event) => {
						if (event.defaultPrevented) return;
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={placeholder ?? t(running || queueing ? "Add a queued message…" : "Ask Metis anything, or describe a task…")}
					rows={1}
					value={text}
				/>
				{(selectedSkill || attachments.length > 0) && (
					<div aria-label={t("Message additions")} className="composer-chips">
						{selectedSkill && (
							<button aria-label={t("Remove skill {{name}}", { name: selectedSkill.name })} className="is-skill" onClick={() => setSelectedSkill(undefined)} type="button">
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
							commandRequest={commandRequest}
							disabled={disabled || submitting}
							mcpServers={mcpServers}
							onAddFiles={() => void addFiles().catch(() => undefined)}
							onManageMcp={() => onManageMcp?.()}
							onManageSkills={() => onManageSkills?.()}
							onSelectSkill={setSelectedSkill}
							skills={skills}
						/>
						{permissionControl}
						{mcpConnectionState === "connecting" && <span className="composer-mcp-status" role="status">{t("MCP connecting")}</span>}
						{mcpConnectionState === "failed" && <button className="composer-mcp-status is-error" onClick={() => onManageMcp?.()} type="button">{t("MCP connection failed")}</button>}
					</div>
					<div className="composer-trailing">
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
			{appearance === "chat" && (
				<p className="composer-disclaimer">{t("Metis is AI and can make mistakes. Please double-check responses.")}</p>
			)}
		</div>
	);
}
