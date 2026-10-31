import type { ClientParams, McpServerSummaryView, SkillSummaryView } from "@metis/app-protocol";
import {
	type FormEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Scroll as createScrollIcon } from "reicon/icons/Scroll";
import { Target as createTargetIcon } from "reicon/icons/Target";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { type GoalSlashCommand, parseGoalSlash } from "../goal-slash.ts";
import { ArrowRight, ArrowUp, Stop, X } from "../icons.tsx";
import { ComposerAddMenu } from "./ComposerAddMenu.tsx";
import { ComposerPanelStack } from "./ComposerPanelStack.tsx";
import { ContextUsageRing } from "./ContextUsageRing.tsx";
import { ConversationQuoteChips, useConversationQuotes } from "./ConversationQuoteContext.tsx";
import type { KnowledgeLinkMenuProps } from "./KnowledgeLinkMenu.tsx";
import { FileSelectionChips, useFileSelections } from "./preview/FileSelectionContext.tsx";
import { type ComposerSlashCommand, composerSlashCommands, SlashCommandMenu } from "./SlashCommandMenu.tsx";
import { SystemNotice } from "./SystemNotice.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

const noSlashCommands = new Set<ComposerSlashCommand>();
const MAX_COMPOSER_ATTACHMENTS = 16;

function canFocusComposer(editor: HTMLElement): boolean {
	const active = document.activeElement;
	const owner = editor.closest(".conversation-column") ?? editor.closest(".composer-dock");
	return active === document.body || (active !== null && owner?.contains(active) === true);
}

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
	icon.appendChild(createScrollIcon({ size: 14, attrs: { "aria-hidden": "true", focusable: "false" } }));
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
	icon.appendChild(createTargetIcon({ size: 14, attrs: { "aria-hidden": "true", focusable: "false" } }));
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
	readonly fileSelections?: ClientParams<"turn/start">["fileSelections"];
	readonly conversationQuotes?: ClientParams<"turn/start">["conversationQuotes"];
	readonly text: string;
	readonly attachments: readonly DesktopAttachmentSelection[];
	readonly skill?: SkillSummaryView;
	readonly skills?: readonly SkillSummaryView[];
}

export interface ComposerPrefillRequest {
	readonly id: number;
	readonly text: string;
}

interface ComposerProps {
	readonly disabled: boolean;
	readonly awaitingAnswer?: boolean;
	readonly interactionPending?: boolean;
	readonly running: boolean;
	readonly queueing?: boolean;
	readonly commandPanel?: ReactNode;
	readonly commandPanelClosing?: boolean;
	readonly commandRequest?: { readonly id: number; readonly open: boolean };
	readonly disabledSlashCommands?: ReadonlySet<ComposerSlashCommand>;
	readonly disabledSlashReasons?: Partial<Record<ComposerSlashCommand, string>>;
	readonly formRef?: Ref<HTMLFormElement>;
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
	readonly knowledge?: KnowledgeLinkMenuProps;
	readonly interactionControl?: ReactNode;
	readonly goalControl?: ReactNode;
	readonly queuedTurnControl?: ReactNode;
	readonly modelControl?: ReactNode;
	readonly mcpConnectionState?: "connecting" | "failed";
	readonly mcpServers?: readonly McpServerSummaryView[];
	readonly permissionControl?: ReactNode;
	readonly placeholder?: string;
	readonly prefillRequest?: ComposerPrefillRequest;
	readonly skills?: readonly SkillSummaryView[];
	readonly submitDisabled?: boolean;
	readonly thinkingControl?: ReactNode;
	readonly contextUsageExpanded?: boolean;
	readonly contextUsageControls?: string;
	readonly contextUsagePercent?: number | null;
	readonly onOpenContextUsage?: () => void;
	readonly inputId?: string;
	readonly selectionSessionId?: string | null;
}

export function Composer({
	disabled,
	awaitingAnswer = false,
	interactionPending = false,
	running,
	queueing = false,
	commandPanel,
	commandPanelClosing,
	commandRequest,
	disabledSlashCommands = noSlashCommands,
	disabledSlashReasons,
	formRef,
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
	knowledge,
	contextUsageExpanded = false,
	contextUsageControls = "session-status-panel",
	contextUsagePercent,
	onOpenContextUsage,
	inputId = "composer-input",
	selectionSessionId,
	interactionControl,
	goalControl,
	queuedTurnControl,
	modelControl,
	mcpConnectionState,
	mcpServers = [],
	permissionControl,
	placeholder,
	prefillRequest,
	skills = [],
	submitDisabled = false,
	thinkingControl,
}: ComposerProps) {
	const { t } = useTranslation();
	const inputBlocked = awaitingAnswer || interactionPending;
	const fileSelections = useFileSelections();
	const conversationQuotes = useConversationQuotes();
	const [hasInput, setHasInput] = useState(false);
	const [attachments, setAttachments] = useState<readonly DesktopAttachmentSelection[]>([]);
	const [attachmentOverflow, setAttachmentOverflow] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [slashQuery, setSlashQuery] = useState<string>();
	const [dismissedSlashText, setDismissedSlashText] = useState<string>();
	const editorRef = useRef<HTMLDivElement>(null);
	const attachmentsRef = useRef<readonly DesktopAttachmentSelection[]>([]);
	const selectionOffset = useRef(0);

	const mergeAttachments = useCallback((incoming: readonly DesktopAttachmentSelection[]) => {
		if (incoming.length === 0) return;
		const current = attachmentsRef.current;
		const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
		let added = 0;
		let omitted = 0;
		for (const attachment of incoming) {
			if (byPath.has(attachment.path)) {
				byPath.set(attachment.path, attachment);
				continue;
			}
			if (byPath.size >= MAX_COMPOSER_ATTACHMENTS) {
				omitted += 1;
				continue;
			}
			byPath.set(attachment.path, attachment);
			added += 1;
		}
		const next = [...byPath.values()];
		attachmentsRef.current = next;
		setAttachments(next);
		if (omitted > 0) setAttachmentOverflow(true);
		else if (added > 0) setAttachmentOverflow(false);
		if (next.length > 0) setHasInput(true);
	}, []);

	const syncEditorState = useCallback(() => {
		const el = editorRef.current;
		if (!el) {
			setHasInput(attachments.length > 0);
			setSlashQuery(undefined);
			return;
		}

		const parsed = parseComposerContent(el);
		const inputExists =
			parsed.cleanText.length > 0 || attachments.length > 0 || parsed.tokenSkills.length > 0 || parsed.hasGoalToken;
		setHasInput(inputExists);

		if (!inputExists && (el.innerHTML === "<br>" || el.innerHTML === "<br/>" || el.innerHTML === "<div><br></div>")) {
			el.replaceChildren();
		}

		const currentQuery = getSlashQueryAtCursor(el);
		const raw = parsed.rawText;
		if (dismissedSlashText !== undefined && dismissedSlashText !== raw) {
			setDismissedSlashText(undefined);
		}
		if (currentQuery !== undefined && dismissedSlashText !== raw) {
			setSlashQuery(currentQuery);
		} else {
			setSlashQuery(undefined);
		}
	}, [attachments.length, dismissedSlashText]);

	const consumedPrefillId = useRef<number | null>(null);
	const untouchedPrefillText = useRef<string | null>(null);

	useEffect(() => {
		const editor = editorRef.current;
		if (
			!editor ||
			!prefillRequest ||
			inputBlocked ||
			disabled ||
			submitting ||
			consumedPrefillId.current === prefillRequest.id
		)
			return;
		const text = prefillRequest.text.trim();
		if (!text) return;
		const parsed = parseComposerContent(editor);
		const replaceTemplate =
			!parsed.hasGoalToken &&
			untouchedPrefillText.current !== null &&
			parsed.cleanText === untouchedPrefillText.current;
		if (replaceTemplate) {
			const skillTokens = Array.from(editor.querySelectorAll(".composer-skill-token"));
			editor.replaceChildren(...skillTokens, document.createTextNode(text));
		} else {
			editor.append(document.createTextNode(`${parsed.cleanText ? "\n\n" : ""}${text}`));
		}
		untouchedPrefillText.current = !parsed.cleanText || replaceTemplate ? text : null;
		consumedPrefillId.current = prefillRequest.id;
		if (canFocusComposer(editor)) {
			editor.focus({ preventScroll: true });
			const range = document.createRange();
			range.selectNodeContents(editor);
			range.collapse(false);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
		setDismissedSlashText(undefined);
		syncEditorState();
	}, [prefillRequest, inputBlocked, disabled, submitting, syncEditorState]);

	const processFiles = useCallback(
		async (files: readonly File[]) => {
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

			if (incoming.length > 0) mergeAttachments(incoming);
		},
		[mergeAttachments, onResolveDroppedFiles],
	);

	const handlePaste = useCallback(
		(event: React.ClipboardEvent) => {
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
		},
		[processFiles, syncEditorState],
	);

	const handleDrop = useCallback(
		(event: React.DragEvent) => {
			const files = Array.from(event.dataTransfer.files);
			if (files.length > 0) {
				event.preventDefault();
				void processFiles(files);
			}
		},
		[processFiles],
	);

	const handleSlashDismiss = useCallback(() => {
		setDismissedSlashText(editorRef.current?.textContent ?? "");
		setSlashQuery(undefined);
	}, []);

	const handleSelectCommand = useCallback(
		(command: ComposerSlashCommand) => {
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
		},
		[disabledSlashCommands, onSlashCommand, syncEditorState],
	);

	const handleSelectSkill = useCallback(
		(skill: SkillSummaryView) => {
			const editor = editorRef.current;
			if (editor) {
				const skillToken = createSkillTokenNode(skill, syncEditorState);
				insertTokenAtCursor(editor, skillToken);
				syncEditorState();
			}
			setSlashQuery(undefined);
		},
		[syncEditorState],
	);

	const handleAddSkill = useCallback(
		(skill: SkillSummaryView) => {
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
		},
		[syncEditorState],
	);

	const addFiles = async () => {
		if (!onPickFiles) return;
		const selected = await onPickFiles();
		mergeAttachments(selected);
	};

	const removeAttachment = (path: string) => {
		const next = attachmentsRef.current.filter((attachment) => attachment.path !== path);
		attachmentsRef.current = next;
		setAttachments(next);
		const parsed = parseComposerContent(editorRef.current);
		setHasInput(
			parsed.cleanText.length > 0 || next.length > 0 || parsed.tokenSkills.length > 0 || parsed.hasGoalToken,
		);
		setAttachmentOverflow(false);
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
			prompt.length > 0 || attachments.length > 0 || parsed.tokenSkills.length > 0 || parsed.hasGoalToken;

		if (!hasContent || disabled || inputBlocked || submitDisabled || submitting) return;

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

		const goalCommand = parseGoalSlash(parsed.rawText);
		if (goalCommand && onGoalCommand) {
			if (disabledSlashCommands.has("goal")) return;
			if (editor) editor.replaceChildren();
			syncEditorState();
			await onGoalCommand(goalCommand);
			return;
		}

		const exactCommand = composerSlashCommands.find((cmd) => parsed.rawText.trim() === `/${cmd}`);
		if (exactCommand && onSlashCommand) {
			if (disabledSlashCommands.has(exactCommand)) return;
			if (editor) editor.replaceChildren();
			syncEditorState();
			await onSlashCommand(exactCommand);
			return;
		}

		const selected = (fileSelections?.selections ?? []).filter(
			(item) => selectionSessionId === undefined || item.sessionId === selectionSessionId,
		);
		const quotes = selectionSessionId
			? (conversationQuotes?.drafts ?? []).filter((item) => item.sessionId === selectionSessionId)
			: [];
		if ((selected.length || quotes.length) && !prompt.trim()) return;
		setSubmitting(true);
		try {
			const matchedSkills = parsed.tokenSkills
				.map((name) => skills.find((s) => s.name === name))
				.filter((s): s is SkillSummaryView => s !== undefined);

			await onSubmit({
				text: prompt,
				attachments,
				...(selected.length ? { fileSelections: selected.map((item) => item.input) } : {}),
				...(quotes.length ? { conversationQuotes: quotes.map((item) => item.input) } : {}),
				...(matchedSkills.length > 0 ? { skill: matchedSkills[0], skills: matchedSkills } : {}),
			});

			if (editor) editor.replaceChildren();
			fileSelections?.remove(selected.map((item) => item.id));
			conversationQuotes?.remove(quotes.map((item) => item.id));
			attachmentsRef.current = [];
			setAttachments([]);
			setAttachmentOverflow(false);
			syncEditorState();
		} finally {
			setSubmitting(false);
		}
	};

	const previouslyInputBlocked = useRef(inputBlocked);
	useEffect(() => {
		const editor = editorRef.current;
		const active = document.activeElement;
		const surface = editor?.closest(".composer-surface");
		if (
			previouslyInputBlocked.current &&
			!inputBlocked &&
			!disabled &&
			!submitting &&
			(active === document.body || (active !== null && surface?.contains(active)))
		)
			editor?.focus({ preventScroll: true });
		previouslyInputBlocked.current = inputBlocked;
	}, [disabled, inputBlocked, submitting]);

	const isCode = appearance === "code";

	return (
		<div className={`composer-dock composer-dock-${appearance}`}>
			<div className="composer-surface">
				<ComposerPanelStack
					transientClosing={slashQuery === undefined && commandPanelClosing}
					transient={
						!inputBlocked && slashQuery !== undefined ? (
							<SlashCommandMenu
								disabledCommands={disabledSlashCommands}
								disabledReasons={disabledSlashReasons}
								onDismiss={handleSlashDismiss}
								onSelectCommand={handleSelectCommand}
								onSelectSkill={handleSelectSkill}
								query={slashQuery}
								skills={skills}
							/>
						) : (
							commandPanel
						)
					}
				>
					{goalControl}
					{queuedTurnControl}
					{interactionControl}
				</ComposerPanelStack>
				<form
					className={`composer composer-${appearance}${awaitingAnswer ? " is-awaiting-answer" : ""}${inputBlocked ? " is-awaiting-interaction" : ""}`}
					ref={formRef}
					onDragOver={(event) => event.preventDefault()}
					onDrop={handleDrop}
					onPaste={handlePaste}
					onSubmit={(event) => void submit(event).catch(() => undefined)}
				>
					<label className="sr-only" htmlFor={inputId}>
						{t("Message Metis")}
					</label>
					<div className="composer-box">
						<FileSelectionChips sessionId={selectionSessionId} />
						<ConversationQuoteChips sessionId={selectionSessionId} />
						{attachmentOverflow && (
							<SystemNotice
								message="Only 16 attachments can be added. Remove one before adding more."
								onDismiss={() => setAttachmentOverflow(false)}
								title="Some files were not added"
								tone="warning"
							/>
						)}
						{attachments.length > 0 && (
							<section aria-label={t("Message additions")} className="composer-attachments">
								{attachments.map((attachment) =>
									attachment.previewDataUrl ? (
										<div className="composer-image-preview" key={attachment.path}>
											<img alt={attachment.name} src={attachment.previewDataUrl} />
											<button
												aria-label={t("Remove file {{name}}", { name: attachment.name })}
												onClick={() => removeAttachment(attachment.path)}
												type="button"
											>
												<X aria-hidden="true" size={12} />
											</button>
										</div>
									) : (
										<div className="composer-file-card" key={attachment.path}>
											<span className="composer-file-card-icon">
												<WorkspaceFileIcon path={attachment.name} size={15} />
											</span>
											<span className="composer-file-card-copy">
												<strong title={attachment.name}>{attachment.name}</strong>
												<small>{attachmentTypeLabel(attachment.name)}</small>
											</span>
											<button
												aria-label={t("Remove file {{name}}", { name: attachment.name })}
												onClick={() => removeAttachment(attachment.path)}
												type="button"
											>
												<X aria-hidden="true" size={12} />
											</button>
										</div>
									),
								)}
							</section>
						)}
						{contextControl}
						<div className="composer-input-line">
							{/* biome-ignore lint/a11y/useSemanticElements: The contenteditable textbox embeds skill and goal tokens that native text controls cannot render. */}
							<div
								aria-label={t("Message Metis")}
								className="composer-editable-input"
								aria-disabled={disabled || undefined}
								contentEditable={!disabled && !submitting}
								data-empty={!hasInput ? "true" : undefined}
								data-placeholder={
									(inputBlocked
										? t(
												awaitingAnswer
													? "Answer the questions above to continue."
													: "Approve or reject the action above to continue.",
											)
										: placeholder) ??
									(isCode
										? t("Describe a task or ask a question")
										: t(
												running || queueing
													? "Add a queued message…"
													: "Ask Metis anything, or describe a task…",
											))
								}
								id={inputId}
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
									{running && (!hasInput || inputBlocked) ? (
										<button
											aria-label={t("Stop task")}
											className="composer-code-stop"
											disabled={disabled}
											onClick={() => void onInterrupt().catch(() => undefined)}
											type="button"
										>
											<Stop aria-hidden="true" size={13} weight="fill" />
										</button>
									) : (
										<button
											aria-label={t(running || queueing ? "Queue message" : "Send message")}
											className={`composer-code-submit ${hasInput ? "is-active" : ""}`}
											disabled={disabled || inputBlocked || submitDisabled || submitting || !hasInput}
											type="submit"
										>
											<ArrowRight aria-hidden="true" size={13} />
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
								iconSize={isCode ? 13 : 14}
								knowledge={knowledge}
								mcpServers={mcpServers}
								onAddFiles={() => void addFiles().catch(() => undefined)}
								onManageMcp={() => onManageMcp?.()}
								onManageSkills={() => onManageSkills?.()}
								onSelectSkill={handleAddSkill}
								skills={skills}
							/>
							{permissionControl}
							{collaborationControl}
							{mcpConnectionState === "connecting" && (
								<output className="composer-mcp-status">{t("MCP connecting")}</output>
							)}
							{mcpConnectionState === "failed" && (
								<button className="composer-mcp-status is-error" onClick={() => onManageMcp?.()} type="button">
									{t("MCP connection failed")}
								</button>
							)}
						</div>
						<div className="composer-trailing">
							{onOpenContextUsage && (
								<ContextUsageRing
									controls={contextUsageControls}
									expanded={contextUsageExpanded}
									onClick={onOpenContextUsage}
									percent={contextUsagePercent ?? null}
								/>
							)}
							{modelControl}
							{thinkingControl}
							{!isCode &&
								(running && (!hasInput || inputBlocked) ? (
									<button
										aria-label={t("Stop task")}
										className="composer-icon-button composer-stop button-secondary"
										disabled={disabled}
										onClick={() => void onInterrupt().catch(() => undefined)}
										type="button"
									>
										<Stop aria-hidden="true" size={13} weight="fill" />
									</button>
								) : (
									<button
										aria-label={t(running || queueing ? "Queue message" : "Send message")}
										className="composer-icon-button composer-send"
										disabled={disabled || inputBlocked || submitDisabled || submitting || !hasInput}
										type="submit"
									>
										<ArrowUp aria-hidden="true" size={16} />
									</button>
								))}
						</div>
					</div>
				</form>
			</div>
		</div>
	);
}
