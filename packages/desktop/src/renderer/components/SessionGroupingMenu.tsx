import { CaretRight, Check, Sliders } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SessionGroupBy } from "../store/session-grouping.ts";

const OPTIONS = [
	{ value: "date", label: "Date" },
	{ value: "project", label: "Project" },
	{ value: "unread", label: "Unread" },
	{ value: "none", label: "None" },
] as const;

const PRIMARY_WIDTH = 200;
const SECONDARY_WIDTH = 128;

export function SessionGroupingMenu({
	onChange,
	value,
}: {
	readonly onChange: (value: SessionGroupBy) => void;
	readonly value: SessionGroupBy;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [submenuOpen, setSubmenuOpen] = useState(false);
	const [primaryPosition, setPrimaryPosition] = useState<React.CSSProperties>({});
	const [secondaryPosition, setSecondaryPosition] = useState<React.CSSProperties>({});
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const primary = useRef<HTMLDivElement>(null);
	const primaryItem = useRef<HTMLButtonElement>(null);
	const secondary = useRef<HTMLDivElement>(null);
	const primaryId = useId();
	const secondaryId = useId();
	const currentLabel = t(OPTIONS.find((option) => option.value === value)?.label ?? "Date");

	const updatePosition = useCallback(() => {
		const rect = trigger.current?.getBoundingClientRect();
		if (!rect) return;
		const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
		const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
		const primaryLeft = Math.max(8, Math.min(rect.right - PRIMARY_WIDTH, viewportWidth - PRIMARY_WIDTH - 8));
		const primaryTop = Math.min(rect.bottom + 3, viewportHeight - 44);
		const preferredSecondaryLeft = primaryLeft + PRIMARY_WIDTH + 2;
		const secondaryLeft =
			preferredSecondaryLeft + SECONDARY_WIDTH <= viewportWidth - 8
				? preferredSecondaryLeft
				: Math.max(8, primaryLeft - SECONDARY_WIDTH - 2);
		setPrimaryPosition({ left: primaryLeft, top: primaryTop, width: PRIMARY_WIDTH });
		setSecondaryPosition({
			left: secondaryLeft,
			top: Math.min(primaryTop + 5, viewportHeight - 133),
			width: SECONDARY_WIDTH,
		});
	}, []);

	const close = useCallback((restoreFocus = false) => {
		setOpen(false);
		setSubmenuOpen(false);
		if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
	}, []);

	const showSubmenu = useCallback((focusSelected = false) => {
		setSubmenuOpen(true);
		if (focusSelected) {
			queueMicrotask(() => {
				secondary.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
			});
		}
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		updatePosition();
		queueMicrotask(() => primaryItem.current?.focus());
	}, [open, updatePosition]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const node = event.target as Node;
			if (!root.current?.contains(node) && !primary.current?.contains(node) && !secondary.current?.contains(node))
				close();
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

	const menus = open ? (
		<>
			<div
				aria-label={t("Session grouping")}
				className="session-grouping-menu-primary"
				id={primaryId}
				ref={primary}
				role="menu"
				style={primaryPosition}
			>
				<button
					aria-controls={submenuOpen ? secondaryId : undefined}
					aria-expanded={submenuOpen}
					aria-haspopup="menu"
					aria-label={t("Group by {{label}}", { label: currentLabel })}
					onClick={() => showSubmenu(true)}
					onKeyDown={(event) => {
						if (event.key !== "ArrowRight") return;
						event.preventDefault();
						showSubmenu(true);
					}}
					onPointerEnter={() => showSubmenu()}
					ref={primaryItem}
					role="menuitem"
					type="button"
				>
					<span>{t("Group by")}</span>
					<span className="session-grouping-current">
						{currentLabel}
						<CaretRight aria-hidden="true" size={15} />
					</span>
				</button>
			</div>
			{submenuOpen && (
				<div
					aria-label={t("Group sessions")}
					className="session-grouping-menu-secondary"
					id={secondaryId}
					onKeyDown={(event) => {
						if (event.key === "ArrowLeft") {
							event.preventDefault();
							setSubmenuOpen(false);
							queueMicrotask(() => primaryItem.current?.focus());
							return;
						}
						if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
						event.preventDefault();
						const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
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
					ref={secondary}
					role="menu"
					style={secondaryPosition}
				>
					{OPTIONS.map((option, index) => {
						const selected = option.value === value;
						return (
							<div
								className={index === 3 ? "session-grouping-menu-last" : undefined}
								key={option.value}
								role="none"
							>
								<button
									aria-checked={selected}
									onClick={() => {
										close(true);
										if (!selected) onChange(option.value);
									}}
									role="menuitemradio"
									type="button"
								>
									<span>{t(option.label)}</span>
									{selected && <Check aria-hidden="true" size={16} weight="bold" />}
								</button>
							</div>
						);
					})}
				</div>
			)}
		</>
	) : null;

	return (
		<div className="session-grouping-control" ref={root}>
			<button
				aria-controls={open ? primaryId : undefined}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={t("Group sessions")}
				className="session-grouping-trigger"
				onClick={() => {
					setOpen((current) => !current);
					setSubmenuOpen(false);
				}}
				ref={trigger}
				type="button"
			>
				<Sliders aria-hidden="true" size={16} />
			</button>
			{menus && createPortal(menus, document.body)}
		</div>
	);
}
