import { ArrowUp, ChatText, NotePencil, SpinnerGap, X } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DraftFileSelection } from "./file-selection.ts";

export function FileSelectionPopover({
	selection,
	range,
	open,
	enabled,
	disabledReason,
	onAdd,
	onRequestChange,
	onDismiss,
	onAccepted,
	requestOnly = false,
	onEditing,
}: {
	selection: DraftFileSelection;
	range: Range | HTMLElement;
	open: boolean;
	enabled: boolean;
	disabledReason?: string;
	onAdd: () => void;
	onRequestChange: (instruction: string) => Promise<void>;
	onDismiss: () => void;
	onAccepted: () => void;
	requestOnly?: boolean;
	onEditing?: () => void;
}) {
	const { t } = useTranslation();
	const ref = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [editing, setEditing] = useState(false);
	const [instruction, setInstruction] = useState("");
	const [error, setError] = useState("");
	const [sending, setSending] = useState(false);
	const pending = useRef(false);
	const alive = useRef(true);
	useLayoutEffect(() => {
		setEditing(false);
	}, [range]);
	useLayoutEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	useLayoutEffect(() => {
		const popup = ref.current;
		if (!popup || !open) {
			popup?.hidePopover();
			return;
		}
		popup.showPopover();
		const position = () => {
			const isText = range instanceof Range;
			if (!(isText ? range.startContainer : range).isConnected) {
				popup.style.visibility = "hidden";
				return;
			}
			const element = !isText
				? range
				: range.startContainer instanceof Element
					? range.startContainer
					: range.startContainer.parentElement;
			const clip = element?.closest(".preview-viewport, .cm-scroller, .file-preview-body")?.getBoundingClientRect();
			const width = document.documentElement.clientWidth,
				height = window.innerHeight;
			const rects = Array.from(range.getClientRects());
			const visibleRects = rects.filter(
				(rect) =>
					rect.width > 0 &&
					rect.right > Math.max(0, clip?.left ?? 0) &&
					rect.left < Math.min(width, clip?.right ?? width) &&
					rect.bottom > Math.max(0, clip?.top ?? 0) &&
					rect.top < Math.min(height, clip?.bottom ?? height),
			);
			const anchor = visibleRects.at(-1);
			popup.style.visibility = anchor ? "visible" : "hidden";
			if (!anchor) return;
			const bounds = popup.getBoundingClientRect();
			const above = visibleRects[0]!.top - bounds.height - 8;
			const below = anchor.bottom + 8;
			const top = !editing && above >= 8 ? above : below + bounds.height <= height - 8 ? below : above;
			popup.style.left = `${Math.max(8, Math.min(anchor.left, width - bounds.width - 8))}px`;
			popup.style.top = `${Math.max(8, Math.min(top, height - bounds.height - 8))}px`;
		};
		position();
		const observer = new ResizeObserver(position);
		observer.observe(popup);
		window.addEventListener("resize", position);
		document.addEventListener("scroll", position, true);
		if (editing) inputRef.current?.focus();
		const highlights = globalThis.CSS?.highlights as unknown as Map<string, Highlight> | undefined;
		const key = "metis-file-selection";
		const highlight =
			typeof Highlight === "undefined" || !(range instanceof Range) ? undefined : new Highlight(range);
		if (highlight && highlights) highlights.set(key, highlight);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", position);
			document.removeEventListener("scroll", position, true);
			if (highlights?.get(key) === highlight) highlights?.delete(key);
		};
	}, [open, range, editing]);
	const submit = async () => {
		if (!enabled || pending.current || !instruction.trim()) return;
		pending.current = true;
		setSending(true);
		setError("");
		try {
			await onRequestChange(instruction);
			if (alive.current) {
				setInstruction("");
				onDismiss();
				onAccepted();
			}
		} catch (cause) {
			if (alive.current) setError(cause instanceof Error ? cause.message : t("Failed to send request"));
		} finally {
			pending.current = false;
			if (alive.current) setSending(false);
		}
	};
	return (
		<div
			ref={ref}
			popover="auto"
			className={`file-selection-popover${editing ? " is-editing" : ""}`}
			role="dialog"
			aria-label={t("Selected text actions")}
			onToggle={(event) => {
				if (event.newState === "closed" && open) onDismiss();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onDismiss();
				}
			}}
		>
			{editing ? (
				<form
					aria-busy={sending}
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<div className="selection-request-heading">
						<div className="selection-request-context">
							<strong title={selection.name}>{selection.name}</strong>
							<blockquote title={selection.input.selectedText}>{selection.input.selectedText}</blockquote>
						</div>
						<button type="button" aria-label={t("Cancel")} onClick={onDismiss}>
							<X size={14} />
						</button>
					</div>
					<div className="selection-request-input">
						<textarea
							rows={1}
							ref={inputRef}
							aria-label={t("Describe the change")}
							placeholder={t("Describe the change…")}
							value={instruction}
							disabled={sending}
							onChange={(event) => setInstruction(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void submit();
								}
							}}
						/>
						<button
							className="selection-send"
							type="submit"
							aria-label={t("Send change request")}
							disabled={!enabled || sending || !instruction.trim()}
						>
							{sending ? (
								<SpinnerGap aria-hidden="true" className="is-spinning" size={16} />
							) : (
								<ArrowUp aria-hidden="true" size={17} />
							)}
						</button>
					</div>
				</form>
			) : (
				<div className="selection-actions">
					<button
						type="button"
						disabled={!enabled}
						onClick={() => {
							setError("");
							setEditing(true);
							onEditing?.();
						}}
					>
						<NotePencil aria-hidden="true" size={14} />
						{t("Request changes")}
					</button>
					{!requestOnly && (
						<button
							type="button"
							disabled={!enabled}
							onClick={() => {
								try {
									onAdd();
									onDismiss();
									onAccepted();
								} catch (cause) {
									setError(cause instanceof Error ? cause.message : t("Failed to add reference"));
								}
							}}
						>
							<ChatText aria-hidden="true" size={14} />
							{t("Add to conversation")}
						</button>
					)}
				</div>
			)}
			{(error || disabledReason) && (
				<div role="alert" className="selection-error">
					{disabledReason || t(error)}
				</div>
			)}
		</div>
	);
}
