import { CaretDown, Check } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export interface MenuSelectOption<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly description?: string;
	readonly icon?: ReactNode;
	readonly disabled?: boolean;
}

export function MenuSelect<T extends string>({
	ariaLabel,
	className = "",
	disabled = false,
	id: triggerId,
	menuAlign = "start",
	menuMinWidth = 156,
	onChange,
	options,
	placeholder = "Select",
	popoverClassName = "",
	prefix,
	triggerIcon,
	value,
}: {
	readonly ariaLabel: string;
	readonly className?: string;
	readonly disabled?: boolean;
	readonly id?: string;
	readonly menuAlign?: "start" | "end";
	readonly menuMinWidth?: number;
	readonly onChange: (value: T) => void;
	readonly options: readonly MenuSelectOption<T>[];
	readonly placeholder?: string;
	readonly popoverClassName?: string;
	readonly prefix?: string;
	readonly triggerIcon?: ReactNode;
	readonly value: T;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<React.CSSProperties>({});
	const id = useId();
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const selected = options.find((option) => option.value === value);

	const updatePosition = useCallback(() => {
		const rect = trigger.current?.getBoundingClientRect();
		if (!rect) return;
		const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
		const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
		const dialogRect = root.current?.closest<HTMLElement>('dialog, [role="dialog"]')?.getBoundingClientRect();
		const boundaryLeft = Math.max(8, dialogRect ? dialogRect.left + 8 : 8);
		const boundaryRight = Math.min(viewportWidth - 8, dialogRect ? dialogRect.right - 8 : viewportWidth - 8);
		const boundaryTop = Math.max(8, dialogRect ? dialogRect.top + 8 : 8);
		const boundaryBottom = Math.min(viewportHeight - 8, dialogRect ? dialogRect.bottom - 8 : viewportHeight - 8);
		const width = Math.min(Math.max(rect.width, menuMinWidth), Math.max(0, boundaryRight - boundaryLeft));
		const preferredLeft = menuAlign === "end" ? rect.right - width : rect.left;
		const left = Math.max(boundaryLeft, Math.min(preferredLeft, boundaryRight - width));
		const below = boundaryBottom - rect.bottom;
		const above = rect.top - boundaryTop;
		const neededHeight = Math.min(280, options.length * 34 + 10);
		setPosition(
			below >= neededHeight || below >= above
				? { top: rect.bottom + 6, left, width, maxHeight: Math.max(0, Math.min(280, below - 6)) }
				: { bottom: viewportHeight - rect.top + 6, left, width, maxHeight: Math.max(0, Math.min(280, above - 6)) },
		);
	}, [menuAlign, menuMinWidth, options.length]);
	const close = useCallback((restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
	}, []);

	useEffect(() => {
		if (disabled) close();
	}, [close, disabled]);

	useLayoutEffect(() => {
		if (!open) return;
		// The native top layer escapes transformed dialogs and their scrolling/clipping containers.
		menu.current?.showPopover?.();
		updatePosition();
		queueMicrotask(() => {
			const selectedItem = menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)');
			const initialItem = selectedItem ?? menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
			initialItem?.focus({ preventScroll: true });
			initialItem?.scrollIntoView?.({ block: "nearest" });
		});
		const onPointerDown = (event: PointerEvent) => {
			const node = event.target as Node;
			if (!root.current?.contains(node) && !menu.current?.contains(node)) close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close(true);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [close, open, updatePosition]);

	const popover = open ? (
		<div
			aria-label={ariaLabel}
			className={`menu-select-popover ${popoverClassName}`.trim()}
			id={id}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					close(true);
					return;
				}
				if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
				if (items.length === 0) return;
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
			ref={menu}
			popover="manual"
			role="listbox"
			style={position}
		>
			{options.map((option) => {
				const active = option.value === value;
				return (
					<button
						aria-selected={active}
						aria-description={option.description}
						className={option.description ? "menu-select-option-with-description" : undefined}
						disabled={option.disabled}
						key={option.value}
						onClick={() => {
							close(true);
							if (!active) onChange(option.value);
						}}
						role="option"
						title={option.description}
						type="button"
					>
						<span className="menu-select-option-label">
							{option.icon}
							{option.description ? (
								<span className="menu-select-option-copy">
									<span>{option.label}</span>
									<small>{option.description}</small>
								</span>
							) : (
								<span>{option.label}</span>
							)}
						</span>
						{active && <Check aria-hidden="true" size={16} weight="bold" />}
					</button>
				);
			})}
		</div>
	) : null;
	const portalTarget = root.current?.closest<HTMLElement>('dialog, [role="dialog"]') ?? document.body;

	return (
		<div className={`menu-select ${className}`.trim()} ref={root}>
			<button
				aria-controls={open ? id : undefined}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={ariaLabel}
				className="menu-select-trigger"
				disabled={disabled}
				id={triggerId}
				onClick={() => setOpen((current) => !current)}
				onKeyDown={(event) => {
					if (!open || event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					close(true);
				}}
				ref={trigger}
				type="button"
			>
				{triggerIcon}
				<span className="menu-select-value">
					{prefix && <span className="menu-select-prefix">{prefix}</span>}
					{selected?.label ?? t(placeholder)}
				</span>
				<CaretDown aria-hidden="true" className="menu-select-caret" size={13} />
			</button>
			{popover && createPortal(popover, portalTarget)}
		</div>
	);
}
