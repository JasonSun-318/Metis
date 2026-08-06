import { CaretDown, Check } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";

export interface MenuSelectOption<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly icon?: ReactNode;
	readonly disabled?: boolean;
}

export function MenuSelect<T extends string>({
	ariaLabel,
	className = "",
	disabled = false,
	menuAlign = "start",
	menuMinWidth = 156,
	onChange,
	options,
	placeholder = "Select",
	prefix,
	triggerIcon,
	value,
}: {
	readonly ariaLabel: string;
	readonly className?: string;
	readonly disabled?: boolean;
	readonly menuAlign?: "start" | "end";
	readonly menuMinWidth?: number;
	readonly onChange: (value: T) => void;
	readonly options: readonly MenuSelectOption<T>[];
	readonly placeholder?: string;
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
		const dialogRect = root.current?.closest("dialog")?.getBoundingClientRect();
		const boundaryLeft = dialogRect ? dialogRect.left + 8 : 8;
		const boundaryRight = dialogRect ? dialogRect.right - 8 : viewportWidth - 8;
		const boundaryTop = dialogRect ? dialogRect.top + 8 : 8;
		const boundaryBottom = dialogRect ? dialogRect.bottom - 8 : viewportHeight - 8;
		const width = Math.max(rect.width, menuMinWidth);
		const preferredLeft = menuAlign === "end" ? rect.right - width : rect.left;
		const left = Math.max(boundaryLeft, Math.min(preferredLeft, boundaryRight - width));
		const below = boundaryBottom - rect.bottom;
		const above = rect.top - boundaryTop;
		const neededHeight = Math.min(280, options.length * 34 + 10);
		setPosition(
			below >= neededHeight || below >= above
				? { top: rect.bottom + 6, left, width, maxHeight: Math.max(96, below - 6) }
				: { bottom: viewportHeight - rect.top + 6, left, width, maxHeight: Math.max(96, above - 6) },
		);
	}, [menuAlign, menuMinWidth, options.length]);
	const close = useCallback((restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
	}, []);

	useEffect(() => {
		if (disabled) close();
	}, [close, disabled]);

	useEffect(() => {
		if (!open) return;
		updatePosition();
		queueMicrotask(() => {
			const selectedItem = menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)');
			(selectedItem ?? menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
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
			className="menu-select-popover"
			id={id}
			onKeyDown={(event) => {
				if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
				if (items.length === 0) return;
				const current = items.indexOf(document.activeElement as HTMLButtonElement);
				const next = event.key === "Home"
					? items[0]
					: event.key === "End"
						? items.at(-1)
						: event.key === "ArrowDown"
							? items[(current + 1) % items.length]
							: items[(current <= 0 ? items.length : current) - 1];
				next?.focus();
			}}
			ref={menu}
			role="listbox"
			style={position}
		>
			{options.map((option) => {
				const active = option.value === value;
				return (
					<button
						aria-selected={active}
						disabled={option.disabled}
						key={option.value}
						onClick={() => {
							close(true);
							if (!active) onChange(option.value);
						}}
						role="option"
						type="button"
					>
						<span className="menu-select-option-label">
							{option.icon}
							<span>{option.label}</span>
						</span>
						{active && <Check aria-hidden="true" size={16} weight="bold" />}
					</button>
				);
			})}
		</div>
	) : null;
	const portalTarget = root.current?.closest("dialog") ?? document.body;

	return (
		<div className={`menu-select ${className}`.trim()} ref={root}>
			<button
				aria-controls={open ? id : undefined}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={ariaLabel}
				className="menu-select-trigger"
				disabled={disabled}
				onClick={() => setOpen((current) => !current)}
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
