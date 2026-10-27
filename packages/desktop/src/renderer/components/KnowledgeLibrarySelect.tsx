import type { KnowledgeLibrary } from "@metis/app-protocol";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Books, CaretDown, Check } from "../icons.tsx";

export function KnowledgeLibrarySelect({
	libraries,
	value,
	disabled,
	busy,
	onChange,
}: {
	readonly libraries: readonly KnowledgeLibrary[];
	readonly value: string;
	readonly disabled: boolean;
	readonly busy: boolean;
	readonly onChange: (id: string) => void;
}) {
	const { t } = useTranslation();
	const id = useId();
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<React.CSSProperties>({});
	const selected = libraries.find((library) => library.id === value);
	const close = useCallback((restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
	}, []);
	const updatePosition = useCallback(() => {
		const rect = trigger.current?.getBoundingClientRect();
		if (!rect) return;
		const width = document.documentElement.clientWidth || window.innerWidth;
		const height = document.documentElement.clientHeight || window.innerHeight;
		const dialog = root.current?.closest<HTMLElement>('dialog, [role="dialog"]')?.getBoundingClientRect();
		const left = Math.max(8, dialog ? dialog.left + 8 : 8);
		const right = Math.min(width - 8, dialog ? dialog.right - 8 : width - 8);
		const top = Math.max(8, dialog ? dialog.top + 8 : 8);
		const bottom = Math.min(height - 8, dialog ? dialog.bottom - 8 : height - 8);
		const menuWidth = Math.min(Math.max(rect.width, 320), Math.max(0, right - left));
		const menuLeft = Math.max(left, Math.min(rect.left, right - menuWidth));
		const below = bottom - rect.bottom;
		const above = rect.top - top;
		const neededHeight = Math.min(340, libraries.length * 50 + 54);
		setPosition(
			below >= neededHeight || below >= above
				? {
						left: menuLeft,
						top: rect.bottom + 6,
						width: menuWidth,
						maxHeight: Math.max(0, Math.min(340, below - 6)),
					}
				: {
						left: menuLeft,
						bottom: height - rect.top + 6,
						width: menuWidth,
						maxHeight: Math.max(0, Math.min(340, above - 6)),
					},
		);
	}, [libraries.length]);
	useEffect(() => {
		if (disabled || libraries.length === 0) close();
	}, [close, disabled, libraries.length]);
	useLayoutEffect(() => {
		if (!open) return;
		menu.current?.showPopover?.();
		updatePosition();
		queueMicrotask(() => {
			const item =
				menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)') ??
				menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
			(item ?? menu.current)?.focus({ preventScroll: true });
			item?.scrollIntoView?.({ block: "nearest" });
		});
		const outside = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!root.current?.contains(target) && !menu.current?.contains(target)) close();
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close(true);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", onEscape);
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", onEscape);
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [close, open, updatePosition]);
	const portalTarget = root.current?.closest<HTMLElement>('dialog, [role="dialog"]') ?? document.body;
	return (
		<div className="menu-select knowledge-library-select" ref={root}>
			<button
				aria-controls={open ? id : undefined}
				aria-describedby={`${id}-value`}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={t("Choose knowledge library")}
				className="menu-select-trigger"
				disabled={disabled || libraries.length === 0}
				onClick={() => setOpen((current) => !current)}
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					setOpen(true);
				}}
				ref={trigger}
				title={selected?.path}
				type="button"
			>
				<Books aria-hidden="true" size={17} />
				<span className="menu-select-value" id={`${id}-value`}>
					{selected?.name ?? t("Choose knowledge library")}
				</span>
				<CaretDown aria-hidden="true" className="menu-select-caret" size={13} />
			</button>
			{open &&
				createPortal(
					<div
						aria-label={t("Choose knowledge library")}
						className="menu-select-popover knowledge-library-options"
						id={id}
						onKeyDown={(event) => {
							if (event.key === "Tab") {
								trigger.current?.focus();
								close();
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								close(true);
								return;
							}
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
							event.preventDefault();
							const items = Array.from(
								event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
							);
							if (!items.length) return;
							const current = items.indexOf(document.activeElement as HTMLButtonElement);
							const next =
								event.key === "Home"
									? items[0]
									: event.key === "End"
										? items.at(-1)
										: event.key === "ArrowDown"
											? items[(current + 1) % items.length]
											: items[(current <= 0 ? items.length : current) - 1];
							next?.focus();
						}}
						popover="manual"
						ref={menu}
						role="menu"
						style={position}
						tabIndex={-1}
					>
						{libraries.map((library) => (
							<div className="knowledge-library-option" key={library.id} role="none">
								<button
									aria-checked={library.id === value}
									aria-description={library.path}
									aria-label={library.name}
									className="knowledge-library-choice"
									disabled={busy}
									onClick={() => {
										close(true);
										onChange(library.id);
									}}
									role="menuitemradio"
									tabIndex={-1}
									title={library.path}
									type="button"
								>
									<span className="menu-select-option-label">
										<Books aria-hidden="true" size={15} />
										<span className="menu-select-option-copy">
											<span>{library.name}</span>
											<small>{library.path}</small>
										</span>
									</span>
									{library.id === value && <Check aria-hidden="true" size={15} weight="bold" />}
								</button>
							</div>
						))}
					</div>,
					portalTarget,
				)}
		</div>
	);
}
