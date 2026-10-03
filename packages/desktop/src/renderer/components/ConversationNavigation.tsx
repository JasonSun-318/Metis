import { DotsThree } from "@phosphor-icons/react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ConversationNavigationEntry {
	readonly itemId: string;
	readonly rowIndex: number;
	readonly text: string;
	readonly answer: string;
	readonly attachments: readonly string[];
}

export function ConversationNavigation({
	entries,
	activeIndex,
	hasOlder,
	loadingOlder,
	onLoadOlder,
	onJump,
}: {
	readonly entries: readonly ConversationNavigationEntry[];
	readonly activeIndex: number;
	readonly hasOlder: boolean;
	readonly loadingOlder: boolean;
	readonly onLoadOlder: () => void;
	readonly onJump: (entry: ConversationNavigationEntry) => void;
}) {
	const { t } = useTranslation();
	const hintId = useId();
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);
	const track = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState({ top: 0, height: 420 });
	const selectedIndex = Math.max(0, Math.min(entries.length - 1, previewIndex ?? activeIndex));
	const previewOpen = previewIndex !== null;
	useLayoutEffect(() => {
		const element = track.current;
		if (!element) return;
		const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		measure();
		return () => observer.disconnect();
	}, [entries.length]);
	useLayoutEffect(() => {
		const element = track.current;
		if (!element || previewOpen) return;
		element.scrollTop = Math.max(0, activeIndex * 10 + 10 - element.clientHeight / 2);
	}, [activeIndex, previewOpen, entries.length]);
	if (entries.length < 2) return null;
	const selected = entries[selectedIndex]!;
	// Every mark belongs to exactly one turn. Scroll the rail for longer histories
	// and render only the visible marks, never sample or merge turns.
	const start = Math.max(0, Math.floor(viewport.top / 10) - 2);
	const end = Math.min(entries.length, Math.ceil((viewport.top + viewport.height) / 10) + 2);
	const previewTop = Math.max(16, Math.min(viewport.height - 16, selectedIndex * 10 + 10 - viewport.top));
	const selectWithKeyboard = (index: number) => {
		const next = Math.max(0, Math.min(entries.length - 1, index));
		setPreviewIndex(next);
		const element = track.current;
		if (element && (next * 10 < element.scrollTop || next * 10 + 20 > element.scrollTop + element.clientHeight))
			element.scrollTop = Math.max(0, next * 10 + 10 - element.clientHeight / 2);
	};
	const title = selected.text.trim().split("\n")[0] || selected.attachments[0] || t("Attachment message");
	return (
		<nav
			className="conversation-navigation"
			aria-label={t("Conversation navigation")}
			style={{ height: `${Math.min(420, entries.length * 10 + 10)}px` }}
			onPointerLeave={() => setPreviewIndex(null)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setPreviewIndex(null);
			}}
		>
			{hasOlder && (
				<button
					type="button"
					className="conversation-navigation-older"
					aria-label={t("Earlier messages")}
					title={t("Earlier messages")}
					disabled={loadingOlder}
					onClick={onLoadOlder}
				>
					<DotsThree aria-hidden="true" size={18} />
				</button>
			)}
			<div
				className="conversation-navigation-track"
				ref={track}
				onScroll={(event) =>
					setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
				}
				role="slider"
				tabIndex={0}
				aria-label={t("Conversation navigation")}
				aria-describedby={hintId}
				aria-orientation="vertical"
				aria-valuemin={1}
				aria-valuemax={entries.length}
				aria-valuenow={selectedIndex + 1}
				aria-valuetext={`${t("Message {{index}} of {{count}}", { index: selectedIndex + 1, count: entries.length })}: ${title}`}
				onFocus={() => setPreviewIndex(selectedIndex)}
				onPointerMove={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					const index = Math.round((event.clientY - rect.top + event.currentTarget.scrollTop - 10) / 10);
					setPreviewIndex(Math.max(0, Math.min(entries.length - 1, index)));
				}}
				onClick={() => {
					onJump(selected);
					setPreviewIndex(null);
				}}
				onKeyDown={(event) => {
					let next = selectedIndex;
					switch (event.key) {
						case "ArrowUp":
						case "ArrowLeft":
							next -= 1;
							break;
						case "ArrowDown":
						case "ArrowRight":
							next += 1;
							break;
						case "Home":
							next = 0;
							break;
						case "End":
							next = entries.length - 1;
							break;
						case "Enter":
						case " ":
							onJump(selected);
							setPreviewIndex(null);
							break;
						case "Escape":
							setPreviewIndex(null);
							break;
						default:
							return;
					}
					event.preventDefault();
					if (!["Enter", " ", "Escape"].includes(event.key)) selectWithKeyboard(next);
				}}
			>
				<div
					className="conversation-navigation-ticks"
					aria-hidden="true"
					style={{ height: `${entries.length * 10 + 10}px` }}
				>
					{Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
						const index = start + offset;
						const distance = Math.abs(index - selectedIndex);
						const width = previewOpen ? Math.max(6, 26 - distance * 6) : index === activeIndex ? 12 : 6;
						return (
							<span
								key={entries[index]!.itemId}
								data-navigation-turn={entries[index]!.itemId}
								className={(previewOpen ? index === selectedIndex : index === activeIndex) ? "is-current" : undefined}
								style={{ top: `${index * 10 + 10}px`, width: `${width}px` }}
							/>
						);
					})}
				</div>
			</div>
			<span className="sr-only" id={hintId}>
				{t("Use arrow keys to preview messages, Enter to jump.")}
			</span>
			{previewOpen && (
				<button
					type="button"
					className="conversation-navigation-preview"
					style={{ top: `${previewTop}px` }}
					onClick={() => {
						onJump(selected);
						setPreviewIndex(null);
					}}
					aria-label={t("Jump to message")}
				>
					<strong>{title}</strong>
					{selected.answer && (
						<span className="conversation-navigation-excerpt">
							{selected.answer.replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\n{2,}/g, "\n")}
						</span>
					)}
					{selected.attachments.length > 0 && (
						<span className="conversation-navigation-files">{selected.attachments.join(" · ")}</span>
					)}
				</button>
			)}
		</nav>
	);
}
