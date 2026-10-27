import type { ItemView } from "@metis/app-protocol";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChatText } from "../icons.tsx";
import { type ConversationQuoteInput, useConversationQuotes } from "./ConversationQuoteContext.tsx";

function elementOf(node: Node): Element | null {
	return node instanceof Element ? node : node.parentElement;
}

export function selectedConversationQuote(
	root: HTMLElement,
	sessionId: string,
	items: ReadonlyMap<string, ItemView>,
	selection: Selection | null,
): { range: Range; input: ConversationQuoteInput } | null {
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0);
	const start = elementOf(range.startContainer),
		end = elementOf(range.endContainer);
	if (!start || !end || !root.contains(start) || !root.contains(end)) return null;
	if (
		start.closest('button, summary, input, textarea, [contenteditable="true"]') ||
		end.closest('button, summary, input, textarea, [contenteditable="true"]')
	)
		return null;
	const first = start.closest<HTMLElement>("[data-quote-item]"),
		last = end.closest<HTMLElement>("[data-quote-item]");
	if (!first?.dataset.quoteItem || first.dataset.quoteItem !== last?.dataset.quoteItem) return null;
	const item = items.get(first.dataset.quoteItem);
	if (!item || item.sessionId !== sessionId || (item.role !== "user" && item.role !== "assistant")) return null;
	const selectedText = selection.toString();
	if (!selectedText.trim()) return null;
	return { range: range.cloneRange(), input: { sourceItemId: item.itemId, sourceRole: item.role, selectedText } };
}

export function TranscriptQuoteSelection({
	root,
	sessionId,
	items,
	onSelectText,
}: {
	readonly root: RefObject<HTMLElement | null>;
	readonly sessionId?: string;
	readonly items: ReadonlyMap<string, ItemView>;
	readonly onSelectText?: () => void;
}) {
	const actions = useConversationQuotes();
	const { t } = useTranslation();
	const [selected, setSelected] = useState<ReturnType<typeof selectedConversationQuote>>(null);
	const [error, setError] = useState("");
	const popup = useRef<HTMLDivElement>(null);
	const source = selected ? items.get(selected.input.sourceItemId) : undefined;
	const sourceReady = source?.state === "completed" || source?.state === "interrupted";
	const current = useRef({ items, enabled: actions?.enabled, onSelectText });
	current.current = { items, enabled: actions?.enabled, onSelectText };
	useEffect(() => {
		const transcript = root.current;
		if (!transcript || !sessionId || !actions?.enabled) {
			setSelected(null);
			return;
		}
		const capture = (event: Event) => {
			if (event instanceof KeyboardEvent && !(event.key === "Shift" || event.shiftKey)) return;
			if (popup.current?.contains(event.target as Node)) return;
			setError("");
			const quote = current.current.enabled
				? selectedConversationQuote(transcript, sessionId, current.current.items, window.getSelection())
				: null;
			if (quote) current.current.onSelectText?.();
			setSelected(quote);
		};
		const collapse = () => {
			if (window.getSelection()?.isCollapsed && !popup.current?.contains(document.activeElement)) setSelected(null);
			else if (selectedConversationQuote(transcript, sessionId, current.current.items, window.getSelection()))
				current.current.onSelectText?.();
		};
		transcript.addEventListener("pointerup", capture);
		transcript.addEventListener("keyup", capture);
		document.addEventListener("selectionchange", collapse);
		return () => {
			transcript.removeEventListener("pointerup", capture);
			transcript.removeEventListener("keyup", capture);
			document.removeEventListener("selectionchange", collapse);
		};
	}, [root, sessionId, actions?.enabled]);
	useLayoutEffect(() => {
		const panel = popup.current;
		if (!selected || !panel) return;
		const position = () => {
			const clip = root.current?.getBoundingClientRect();
			const width = document.documentElement.clientWidth,
				height = window.innerHeight;
			const rects = Array.from(selected.range.getClientRects()).filter(
				(rect) =>
					rect.width > 0 &&
					rect.right > Math.max(0, clip?.left ?? 0) &&
					rect.left < Math.min(width, clip?.right ?? width) &&
					rect.bottom > Math.max(0, clip?.top ?? 0) &&
					rect.top < Math.min(height, clip?.bottom ?? height),
			);
			const anchor = rects.at(-1);
			panel.style.visibility = anchor && selected.range.startContainer.isConnected ? "visible" : "hidden";
			if (!anchor) return;
			const bounds = panel.getBoundingClientRect();
			const above = rects[0]!.top - bounds.height - 8;
			panel.style.left = `${Math.max(8, Math.min(anchor.left, width - bounds.width - 8))}px`;
			panel.style.top = `${Math.max(8, Math.min(above >= Math.max(8, clip?.top ?? 8) ? above : anchor.bottom + 8, height - bounds.height - 8))}px`;
		};
		const frame = requestAnimationFrame(() => {
			panel.showPopover();
			position();
		});
		const observer = new ResizeObserver(position);
		observer.observe(panel);
		window.addEventListener("resize", position);
		document.addEventListener("scroll", position, true);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", position);
			document.removeEventListener("scroll", position, true);
		};
	}, [selected, root]);
	if (!selected || !sessionId || !actions?.enabled) return null;
	return createPortal(
		<div
			className="file-selection-popover conversation-selection-popover"
			ref={popup}
			popover="auto"
			role="dialog"
			aria-label={t("Selected text actions")}
			onToggle={(event) => {
				if (event.newState === "closed") setSelected(null);
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					setSelected(null);
				}
			}}
		>
			<div className="selection-actions">
				<button
					type="button"
					disabled={!sourceReady}
					onPointerDown={(event) => event.preventDefault()}
					onClick={() => {
						try {
							if (!sourceReady) return;
							actions.add({ id: crypto.randomUUID(), sessionId, input: selected.input });
							setSelected(null);
							window.getSelection()?.removeAllRanges();
							(
								document.getElementById(`composer-input-${sessionId}`) ??
								document.getElementById("composer-input")
							)?.focus();
						} catch (cause) {
							setError(cause instanceof Error ? t(cause.message) : t("Failed to add reference"));
						}
					}}
				>
					<ChatText aria-hidden="true" size={14} />
					{t("Add to conversation")}
				</button>
			</div>
			{!sourceReady && (
				<output className="status-block conversation-selection-notice">
					{t("Wait for this reply to finish before quoting")}
				</output>
			)}
			{error && (
				<div className="selection-error" role="alert">
					{error}
				</div>
			)}
		</div>,
		document.body,
	);
}
