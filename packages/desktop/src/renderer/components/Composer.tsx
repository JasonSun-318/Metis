import type { McpServerSummaryView, SessionTaskView, SkillSummaryView } from "@metis/app-protocol";
import { ArrowUp, Stop, X } from "@phosphor-icons/react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type FormEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { type GoalSlashCommand, parseGoalSlash } from "../goal-slash.ts";
import { ComposerAddMenu } from "./ComposerAddMenu.tsx";
import { ContextUsageRing } from "./ContextUsageRing.tsx";
import {
	composerSlashCommands,
	type ComposerSlashCommand,
	SlashCommandMenu,
} from "./SlashCommandMenu.tsx";
import { TaskList } from "./TaskList.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

const noSlashCommands = new Set<ComposerSlashCommand>();

const SCROLL_SVG =
	'<svg aria-hidden="true" viewBox="0 0 256 256" width="14" height="14" fill="currentColor"><path d="M216,40H56A16,16,0,0,0,40,56V200a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A8,8,0,0,0,216,40ZM56,56H200V88H56ZM200,200H56a8,8,0,0,1-8-8V96H200v96A8,8,0,0,1,200,200Z"></path></svg>';

const TARGET_SVG =
	'<svg aria-hidden="true" viewBox="0 0 256 256" width="14" height="14" fill="currentColor"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm0-144a56,56,0,1,0,56,56A56.06,56.06,0,0,0,128,72Zm0,96a40,40,0,1,1,40-40A40,40,0,0,1,128,168Zm0-48a8,8,0,1,0,8,8A8,8,0,0,0,128,120Z"></path></svg>';

function createSkillTokenNode(skill: SkillSummaryView, onRemove?: () => void): HTMLElement {
	const span = document.createElement("span");
	span.className = "composer-skill-token";
	span.contentEditable = "false";
	span.setAttribute("data-token-kind", "skill");
	span.setAttribute("data-token-name", skill.name);
	span.setAttribute("aria-label", `Remove skill ${skill.name}`);
	span.setAttribute("role", "button");
	span.tabIndex = -1;

	const icon = document.createElement("span");
	icon.className = "composer-token-icon";
	icon.innerHTML = SCROLL_SVG;
	span.appendChild(icon);

	const nameSpan = document.createElement("span");
	nameSpan.className = "composer-token-name";
	nameSpan.textContent = skill.name;
	span.appendChild(nameSpan);

	span.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		span.remove();
		onRemove?.();
	};

	return span;
}

function createGoalTokenNode(onRemove?: () => void): HTMLElement {
	const span = document.createElement("span");
	span.className = "composer-skill-token composer-goal-token";
	span.contentEditable = "false";
	span.setAttribute("data-token-kind", "goal");
	span.setAttribute("data-token-name", "goal");
	span.setAttribute("aria-label", "Remove goal");
	span.setAttribute("role", "button");
	span.tabIndex = -1;

	const icon = document.createElement("span");
	icon.className = "composer-token-icon";
	icon.innerHTML = TARGET_SVG;
	span.appendChild(icon);

	const nameSpan = document.createElement("span");
	nameSpan.className = "composer-token-name";
	nameSpan.textContent = "goal";
	span.appendChild(nameSpan);

	span.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		span.remove();
		onRemove?.();
	};

	return span;
}

interface ParsedComposerContent {
	readonly rawText: string;
	readonly cleanText: string;
	readonly hasGoalToken: boolean;
	readonly goalObjective: string;
	readonly tokenSkills: readonly string[];
}

function parseComposerContent(container: HTMLElement | null): ParsedComposerContent {
	if (!container) {
		return { rawText: "", cleanText: "", hasGoalToken: false, goalObjective: "", tokenSkills: [] };
	}

	let cleanText = "";
	let hasGoalToken = false;
	let goalObjective = "";
	const tokenSkills: string[] = [];
	const blockTags = new Set(["DIV", "P", "LI"]);
	const appendText = (text: string) => {
		cleanText += text;
		if (hasGoalToken) goalObjective += text;
	};
	const visit = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			appendText(node.textContent ?? "");
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const el = node as HTMLElement;
			if (el.tagName === "BR") {
				appendText("\n");
			} else if (el.classList.contains("composer-goal-token") || el.getAttribute("data-token-kind") === "goal") {
				hasGoalToken = true;
			} else if (el.classList.contains("composer-skill-token")) {
				const name = el.getAttribute("data-token-name") ?? el.querySelector(".composer-token-name")?.textContent;
				if (name && name !== "goal") {
					tokenSkills.push(name);
				}
			} else {
				for (const child of Array.from(el.childNodes)) visit(child);
				if (blockTags.has(el.tagName) && !cleanText.endsWith("\n")) appendText("\n");
			}
		}
	};
	for (const node of Array.from(container.childNodes)) visit(node);

	return {
		rawText: container.textContent ?? "",
		cleanText: cleanText.trim(),
		hasGoalToken,
		goalObjective: goalObjective.trim(),
		tokenSkills,
	};
}

function insertPlainTextAtSelection(container: HTMLElement, text: string): void {
	const textNode = document.createTextNode(text);
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || !container.contains(selection.getRangeAt(0).startContainer)) {
		container.appendChild(textNode);
		return;
	}

	const range = selection.getRangeAt(0);
	range.deleteContents();
	range.insertNode(textNode);
	range.setStartAfter(textNode);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

function getSlashQueryAtCursor(container: HTMLElement): string | undefined {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0 || !container.contains(sel.getRangeAt(0).startContainer)) {
		const text = (container.textContent ?? "").trim();
		if (text.startsWith("/") && !/\s/u.test(text.slice(1))) {
			return text.slice(1);
		}
		return undefined;
	}

	const range = sel.getRangeAt(0);
	const startNode = range.startContainer;
	if (startNode.nodeType === Node.TEXT_NODE) {
		const textBefore = (startNode.textContent ?? "").slice(0, range.startOffset);
		const lastSlash = textBefore.lastIndexOf("/");
		if (lastSlash !== -1) {
			const query = textBefore.slice(lastSlash + 1);
			if (!/\s/u.test(query)) {
				return query;
			}
		}
	} else if (startNode === container) {
		const text = (container.textContent ?? "").trim();
		if (text.startsWith("/") && !/\s/u.test(text.slice(1))) {
			return text.slice(1);
		}
	}

	return undefined;
}

function insertTokenAtCursor(container: HTMLElement, tokenNode: HTMLElement) {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0 || !container.contains(sel.getRangeAt(0).startContainer)) {
		container.appendChild(tokenNode);
		const space = document.createTextNode(" ");
		container.appendChild(space);
		const range = document.createRange();
		range.setStartAfter(space);
		range.collapse(true);
		sel?.removeAllRanges();
		sel?.addRange(range);
		container.focus();
		return;
	}

	const range = sel.getRangeAt(0);
	const startNode = range.startContainer;

	if (startNode.nodeType === Node.TEXT_NODE) {
		const text = startNode.textContent ?? "";
		const before = text.slice(0, range.startOffset);
		const after = text.slice(range.startOffset);
		const lastSlash = before.lastIndexOf("/");

		if (lastSlash !== -1 && !/\s/u.test(before.slice(lastSlash + 1))) {
			const textBeforeSlash = before.slice(0, lastSlash);
			const parent = startNode.parentNode ?? container;

			const beforeNode = document.createTextNode(textBeforeSlash);
			const spaceNode = document.createTextNode(" ");
			const afterNode = document.createTextNode(after);

			parent.insertBefore(beforeNode, startNode);
			parent.insertBefore(tokenNode, startNode);
			parent.insertBefore(spaceNode, startNode);
			parent.insertBefore(afterNode, startNode);
			parent.removeChild(startNode);

			const newRange = document.createRange();
			newRange.setStart(spaceNode, spaceNode.length);
			newRange.collapse(true);
			sel.removeAllRanges();
			sel.addRange(newRange);
			container.focus();
			return;
		}
	}

	range.deleteContents();
	range.insertNode(tokenNode);
	const space = document.createTextNode(" ");
	range.setStartAfter(tokenNode);
	range.insertNode(space);
	const newRange = document.createRange();
	newRange.setStart(space, space.length);
	newRange.collapse(true);
	sel.removeAllRanges();
	sel.addRange(newRange);
	container.focus();
}

function attachmentTypeLabel(name: string): string {
	const extension = name.match(/\.([^.]+)$/u)?.[1];
	return extension ? extension.slice(0, 8).toLocaleUpperCase("en-US") : "FILE";
}

export interface ComposerSubmission {
	readonly text: string;
	readonly attachments: readonly DesktopAttachmentSelection[];
	readonly skill?: SkillSummaryView;
	readonly skills?: readonly SkillSummaryView[];
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
	readonly onResolveDroppedFiles?: (files: readonly File[]) => readonly DesktopAttachmentSelection[];
	readonly onManageMcp?: () => void;
	readonly onManageSkills?: () => void;
	readonly onPickFiles?: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onSlashCommand?: (command: ComposerSlashCommand) => void | Promise<void>;
	readonly onGoalCommand?: (command: GoalSlashCommand) => void | Promise<void>;
	readonly appearance?: "chat" | "code";
	readonly collaborationControl?: ReactNode;
	readonly contextControl?: ReactNode;
	readonly interactionControl?: ReactNode;
	readonly goalControl?: ReactNode;
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
	readonly contextUsageExpanded?: boolean;
	readonly contextUsagePercent?: number | null;
	readonly onOpenContextUsage?: () => void;
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
	onResolveDroppedFiles,
	onSlashCommand,
	onGoalCommand,
	appearance = "code",
	collaborationControl,
	contextControl,
	contextUsageExpanded = false,
	contextUsagePercent,
	onOpenContextUsage,
	interactionControl,
	goalControl,
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
	const [hasInput, setHasInput] = useState(false);
	const [attachments, setAttachments] = useState<readonly DesktopAttachmentSelection[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [slashQuery, setSlashQuery] = useState<string>();
	const [dismissedSlashText, setDismissedSlashText] = useState<string>();
	const editorRef = useRef<HTMLDivElement>(null);
	const selectionOffset = useRef(0);

	const syncEditorState = useCallback(() => {
		const el = editorRef.current;
		if (!el) {
			setHasInput(attachments.length > 0);
			setSlashQuery(undefined);
			return;
		}

		const parsed = parseComposerContent(el);
		const inputExists =
			parsed.cleanText.length > 0 ||
			attachments.length > 0 ||
			parsed.tokenSkills.length > 0 ||
			parsed.hasGoalToken;
		setHasInput(inputExists);

		if (!inputExists && (el.innerHTML === "<br>" || el.innerHTML === "<br/>" || el.innerHTML === "<div><br></div>")) {
			el.replaceChildren();
		}

		const currentQuery = getSlashQueryAtCursor(el);
		const raw = parsed.rawText;
		if (currentQuery !== undefined && dismissedSlashText !== raw) {
			setSlashQuery(currentQuery);
		} else {
			setSlashQuery(undefined);
		}
	}, [attachments.length, dismissedSlashText]);

	const processFiles = useCallback(async (files: readonly File[]) => {
		if (files.length === 0) return;
		const incoming: DesktopAttachmentSelection[] = [];
		for (const file of files) {
			const resolved = onResolveDroppedFiles ? onResolveDroppedFiles([file])[0] : undefined;
			const filePath = resolved?.path || (file as unknown as { path?: string }).path || "";
			if (file.type.startsWith("image/")) {
				const previewDataUrl = await new Promise<string>((resolve) => {
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result as string);
					reader.onerror = () => resolve("");
					reader.readAsDataURL(file);
				});
				incoming.push({
					path: filePath || `clipboard-${Date.now()}-${file.name}`,
					name: file.name || "pasted-image.png",
					previewDataUrl: previewDataUrl || undefined,
				});
			} else if (filePath) {
				incoming.push({
					path: filePath,
					name: file.name,
				});
			}
		}

		if (incoming.length > 0) {
			setAttachments((current) => {
				const byPath = new Map(current.map((att) => [att.path, att]));
				for (const att of incoming) byPath.set(att.path, att);
				return [...byPath.values()].slice(0, 16);
			});
			setHasInput(true);
		}
	}, [onResolveDroppedFiles]);

	const handlePaste = useCallback((event: React.ClipboardEvent) => {
		const files = Array.from(event.clipboardData.files);
		if (files.length > 0) {
			event.preventDefault();
			void processFiles(files);
			return;
		}

		const text = event.clipboardData.getData("text/plain");
		const editor = editorRef.current;
		if (text && editor) {
			event.preventDefault();
			insertPlainTextAtSelection(editor, text);
			syncEditorState();
		}
	}, [processFiles, syncEditorState]);

	const handleDrop = useCallback((event: React.DragEvent) => {
		const files = Array.from(event.dataTransfer.files);
		if (files.length > 0) {
			event.preventDefault();
			void processFiles(files);
		}
	}, [processFiles]);

	useEffect(() => {
		const el = editorRef.current;
		if (!el) return;

		// Support .value, .form, and .disabled properties for test runners and compatibility
		if (!Object.getOwnPropertyDescriptor(el, "form")) {
			Object.defineProperty(el, "form", {
				get() {
					return el.closest("form");
				},
				configurable: true,
			});
		}
		if (!Object.getOwnPropertyDescriptor(el, "disabled")) {
			Object.defineProperty(el, "disabled", {
				get() {
					return el.getAttribute("contenteditable") === "false";
				},
				set(val: boolean) {
					el.setAttribute("contenteditable", val ? "false" : "true");
				},
				configurable: true,
			});
		}
		if (!Object.getOwnPropertyDescriptor(el, "value")) {
			Object.defineProperty(el, "value", {
				get() {
					return parseComposerContent(el).cleanText;
				},
				set(val: string) {
					if (!val) {
						const tokens = Array.from(el.querySelectorAll(".composer-skill-token"));
						if (tokens.length > 0) {
							el.replaceChildren(...tokens);
						} else {
							el.replaceChildren();
						}
						syncEditorState();
						return;
					}
					if (val.startsWith("/skill:")) {
						const skillName = val.slice("/skill:".length).trim();
						const matchedSkill = skills.find((s) => s.name === skillName || s.name.startsWith(skillName));
						if (matchedSkill) {
							el.replaceChildren(createSkillTokenNode(matchedSkill, syncEditorState), document.createTextNode(" "));
							syncEditorState();
							return;
						}
					}
					if (val === "/goal" || val.startsWith("/goal ")) {
						const goalToken = createGoalTokenNode(syncEditorState);
						const rest = val.slice("/goal".length).trimStart();
						el.replaceChildren(goalToken, document.createTextNode(rest ? ` ${rest}` : " "));
						syncEditorState();
						return;
					}
					const existingTokens = Array.from(el.querySelectorAll(".composer-skill-token"));
					if (existingTokens.length > 0) {
						el.replaceChildren(...existingTokens, document.createTextNode(` ${val}`));
					} else {
						el.textContent = val;
					}
					syncEditorState();
				},
				configurable: true,
			});
		}
	}, [skills, syncEditorState]);

	const handleSlashDismiss = useCallback(() => {
		setDismissedSlashText(editorRef.current?.textContent ?? "");
		setSlashQuery(undefined);
	}, []);

	const handleSelectCommand = useCallback((command: ComposerSlashCommand) => {
		if (disabledSlashCommands.has(command)) return;
		if (command === "goal") {
			const editor = editorRef.current;
			if (editor) {
				const goalToken = createGoalTokenNode(syncEditorState);
				insertTokenAtCursor(editor, goalToken);
				syncEditorState();
			}
			setSlashQuery(undefined);
			return;
		}

		if (editorRef.current) {
			editorRef.current.replaceChildren();
			syncEditorState();
		}
		setSlashQuery(undefined);
		void Promise.resolve(onSlashCommand?.(command)).catch(() => undefined);
	}, [disabledSlashCommands, onSlashCommand, syncEditorState]);

	const handleSelectSkill = useCallback((skill: SkillSummaryView) => {
		const editor = editorRef.current;
		if (editor) {
			const skillToken = createSkillTokenNode(skill, syncEditorState);
			insertTokenAtCursor(editor, skillToken);
			syncEditorState();
		}
		setSlashQuery(undefined);
	}, [syncEditorState]);

	const handleAddSkill = useCallback((skill: SkillSummaryView) => {
		const editor = editorRef.current;
		if (editor) {
			const existingSkillToken = editor.querySelector(".composer-skill-token:not(.composer-goal-token)");
			const skillToken = createSkillTokenNode(skill, syncEditorState);
			if (existingSkillToken) {
				existingSkillToken.replaceWith(skillToken);
			} else {
				insertTokenAtCursor(editor, skillToken);
			}
			syncEditorState();
		}
	}, [syncEditorState]);

	const addFiles = async () => {
		if (!onPickFiles) return;
		const selected = await onPickFiles();
		setAttachments((current) => {
			const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
			for (const attachment of selected) byPath.set(attachment.path, attachment);
			return [...byPath.values()].slice(0, 16);
		});
		setHasInput(true);
	};

	const removeAttachment = (path: string) => {
		setAttachments((current) => {
			const next = current.filter((attachment) => attachment.path !== path);
			const editor = editorRef.current;
			const parsed = parseComposerContent(editor);
			setHasInput(
				parsed.cleanText.length > 0 ||
				next.length > 0 ||
				parsed.tokenSkills.length > 0 ||
				parsed.hasGoalToken,
			);
			return next;
		});
	};

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.defaultPrevented || event.nativeEvent.isComposing) return;

		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			event.currentTarget.closest("form")?.requestSubmit();
			return;
		}

		if (event.key === "Backspace") {
			const editor = editorRef.current;
			if (!editor) return;
			const parsed = parseComposerContent(editor);
			if (parsed.cleanText === "" && (parsed.tokenSkills.length > 0 || parsed.hasGoalToken)) {
				// Remove the last token if text is empty
				const tokens = editor.querySelectorAll(".composer-skill-token");
				if (tokens.length > 0) {
					tokens[tokens.length - 1]?.remove();
					syncEditorState();
					return;
				}
			}
		}
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const editor = editorRef.current;
		const parsed = parseComposerContent(editor);
		const prompt = parsed.cleanText;
		const hasContent =
			prompt.length > 0 ||
			attachments.length > 0 ||
			parsed.tokenSkills.length > 0 ||
			parsed.hasGoalToken;

		if (!hasContent || disabled || submitDisabled || submitting) return;

		// 1. Check Goal Token
		if (parsed.hasGoalToken && onGoalCommand) {
			if (disabledSlashCommands.has("goal")) return;
			const goalObjective = parsed.goalObjective || prompt;
			const goalCommand =
				parseGoalSlash(`/goal ${goalObjective}`) ??
				(goalObjective ? { kind: "set", objective: goalObjective } : { kind: "usage" });
			if (editor) editor.replaceChildren();
			syncEditorState();
			await onGoalCommand(goalCommand);
			return;
		}

		// 2. Check fallback raw /goal command
		const goalCommand = parseGoalSlash(parsed.rawText);
		if (goalCommand && onGoalCommand) {
			if (disabledSlashCommands.has("goal")) return;
			if (editor) editor.replaceChildren();
			syncEditorState();
			await onGoalCommand(goalCommand);
			return;
		}

		// 3. Check exact slash commands (e.g. /compact, /status, /model, /thinking, /mcp)
		const exactCommand = composerSlashCommands.find((cmd) => parsed.rawText.trim() === `/${cmd}`);
		if (exactCommand && onSlashCommand) {
			if (disabledSlashCommands.has(exactCommand)) return;
			if (editor) editor.replaceChildren();
			syncEditorState();
			await onSlashCommand(exactCommand);
			return;
		}

		// 4. Standard submission
		setSubmitting(true);
		try {
			const matchedSkills = parsed.tokenSkills
				.map((name) => skills.find((s) => s.name === name))
				.filter((s): s is SkillSummaryView => s !== undefined);

			await onSubmit({
				text: prompt,
				attachments,
				...(matchedSkills.length > 0 ? { skill: matchedSkills[0], skills: matchedSkills } : {}),
			});

			if (editor) editor.replaceChildren();
			setAttachments([]);
			syncEditorState();
		} finally {
			setSubmitting(false);
		}
	};

	const isCode = appearance === "code";

	return (
		<div className={`composer-dock composer-dock-${appearance}`}>
			<TaskList key={taskListEpoch ?? undefined} tasks={tasks} />
			{goalControl}
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
			<form
				className={`composer composer-${appearance}`}
				onDragOver={(event) => event.preventDefault()}
				onDrop={handleDrop}
				onPaste={handlePaste}
				onSubmit={(event) => void submit(event).catch(() => undefined)}
			>
				<label className="sr-only" htmlFor="composer-input">{t("Message Metis")}</label>
				<div className="composer-box">
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
									<span className="composer-file-card-icon"><WorkspaceFileIcon path={attachment.name} size={15} /></span>
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
					{contextControl}
					<div className="composer-input-line">
						<div
							aria-label={t("Message Metis")}
							className="composer-editable-input"
							contentEditable={!disabled && !submitting}
							data-empty={!hasInput ? "true" : undefined}
							data-placeholder={placeholder ?? (isCode ? t("Describe a task or ask a question") : t(running || queueing ? "Add a queued message…" : "Ask Metis anything, or describe a task…"))}
							id="composer-input"
							onInput={syncEditorState}
							onKeyDown={handleKeyDown}
							onSelect={() => {
								const sel = window.getSelection();
								if (sel && sel.rangeCount > 0) {
									selectionOffset.current = sel.getRangeAt(0).startOffset;
								}
							}}
							ref={editorRef}
							role="textbox"
							spellCheck={false}
							tabIndex={0}
						/>
						{isCode && (
							<div className="composer-code-action">
								{running && !hasInput ? (
									<button aria-label={t("Stop task")} className="composer-code-stop" disabled={disabled} onClick={() => void onInterrupt().catch(() => undefined)} type="button">
										<Stop aria-hidden="true" size={13} weight="fill" />
									</button>
								) : (
									<button aria-label={t(running || queueing ? "Queue message" : "Send message")} className={`composer-code-submit ${hasInput ? "is-active" : ""}`} disabled={disabled || submitDisabled || submitting || !hasInput} type="submit">
										<svg aria-hidden="true" fill="currentColor" height="13" viewBox="0 0 256 256" width="13">
											<path d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z" transform="scale(-1, 1) translate(-256, 0)" />
										</svg>
									</button>
								)}
							</div>
						)}
					</div>
				</div>
				<div className="composer-actions">
					<div className="composer-leading">
						<ComposerAddMenu
							commandRequest={commandRequest}
							disabled={disabled || submitting}
							iconSize={isCode ? 13 : 16}
							mcpServers={mcpServers}
							onAddFiles={() => void addFiles().catch(() => undefined)}
							onManageMcp={() => onManageMcp?.()}
							onManageSkills={() => onManageSkills?.()}
							onSelectSkill={handleAddSkill}
							skills={skills}
						/>
						{permissionControl}
						{collaborationControl}
						{mcpConnectionState === "connecting" && <span className="composer-mcp-status" role="status">{t("MCP connecting")}</span>}
						{mcpConnectionState === "failed" && <button className="composer-mcp-status is-error" onClick={() => onManageMcp?.()} type="button">{t("MCP connection failed")}</button>}
					</div>
					<div className="composer-trailing">
						{onOpenContextUsage && (
							<ContextUsageRing
								controls="session-status-panel"
								expanded={contextUsageExpanded}
								onClick={onOpenContextUsage}
								percent={contextUsagePercent ?? null}
							/>
						)}
						{modelControl}
						{thinkingControl}
						{!isCode && (
							running && !hasInput ? (
								<button aria-label={t("Stop task")} className="composer-icon-button composer-stop button-secondary" disabled={disabled} onClick={() => void onInterrupt().catch(() => undefined)} type="button">
									<Stop aria-hidden="true" size={16} weight="fill" />
								</button>
							) : <button aria-label={t(running || queueing ? "Queue message" : "Send message")} className="composer-icon-button composer-send" disabled={disabled || submitDisabled || submitting || !hasInput} type="submit">
								<ArrowUp aria-hidden="true" size={19} weight="bold" />
							</button>
						)}
					</div>
				</div>
			</form>
		</div>
	);
}
