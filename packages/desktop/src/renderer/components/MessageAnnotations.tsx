import type { ItemView } from "@metis/app-protocol";
import { ArrowUpRight, ChatText, X } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export function MessageAnnotations({
	quotes,
	onJumpToSource,
}: {
	readonly quotes: ItemView["conversationQuotes"];
	readonly onJumpToSource?: (itemId: string, liveItemId?: string) => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => {
		const panel = popup.current;
		if (!open || !panel) return;
		const position = () => {
			const anchor = trigger.current?.getBoundingClientRect();
			if (!anchor) return;
			const width = document.documentElement.clientWidth,
				height = window.innerHeight;
			const bounds = panel.getBoundingClientRect();
			const below = anchor.bottom + 6;
			panel.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, width - bounds.width - 8))}px`;
			panel.style.top = `${Math.max(8, Math.min(below + bounds.height <= height - 8 ? below : anchor.top - bounds.height - 6, height - bounds.height - 8))}px`;
		};
		panel.showPopover?.();
		position();
		close.current?.focus();
		const outside = (event: PointerEvent) => {
			if (!panel.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
		};
		const observer = new ResizeObserver(position);
		observer.observe(panel);
		const visibility =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver((entries) => {
						if (entries.some((entry) => !entry.isIntersecting)) setOpen(false);
					});
		if (trigger.current) visibility?.observe(trigger.current);
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", handleEscape);
		window.addEventListener("resize", position);
		document.addEventListener("scroll", position, true);
		return () => {
			observer.disconnect();
			visibility?.disconnect();
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", handleEscape);
			window.removeEventListener("resize", position);
			document.removeEventListener("scroll", position, true);
			if (trigger.current?.isConnected) trigger.current.focus();
		};
	}, [open]);
	if (!quotes?.length) return null;
	return (
		<div className="message-annotations">
			<button
				className="message-annotations-trigger"
				type="button"
				ref={trigger}
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => setOpen((value) => !value)}
			>
				<ChatText aria-hidden="true" size={13} />
				{t("{{count}} annotations", { count: quotes.length })}
			</button>
			{open &&
				createPortal(
					<div
						className="message-annotations-popover"
						popover="manual"
						role="dialog"
						aria-label={t("Conversation annotations")}
						ref={popup}
					>
						<header>
							<strong>{t("{{count}} annotations", { count: quotes.length })}</strong>
							<button
								type="button"
								aria-label={t("Close annotations")}
								ref={close}
								onClick={() => setOpen(false)}
							>
								<X aria-hidden="true" size={14} />
							</button>
						</header>
						<div className="message-annotations-list">
							{quotes.map((quote, index) => (
								<section key={`${index}-${quote.sourceItemId}`}>
									<div className="message-annotation-source">
										<span>{t(quote.sourceRole === "assistant" ? "From Metis" : "From you")}</span>
										{onJumpToSource && (
											<button
												type="button"
												onClick={() => {
													setOpen(false);
													onJumpToSource(quote.sourceItemId, quote.sourceLiveItemId);
												}}
											>
												<ArrowUpRight aria-hidden="true" size={12} />
												{t("Go to original message")}
											</button>
										)}
									</div>
									<blockquote>{quote.selectedText}</blockquote>
									{quote.selectedTextTruncated && <small>{t("Reference preview shortened")}</small>}
								</section>
							))}
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}
