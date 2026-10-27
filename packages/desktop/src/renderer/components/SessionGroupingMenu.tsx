import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ListBullets } from "../icons.tsx";
import type { SessionGroupBy } from "../store/session-grouping.ts";

const OPTIONS = [
	{ value: "date", label: "Date" },
	{ value: "project", label: "Project" },
	{ value: "status", label: "Status" },
	{ value: "unread", label: "Unread" },
	{ value: "none", label: "None" },
] as const;

export function SessionGroupingMenu({
	onChange,
	value,
}: {
	readonly onChange: (value: SessionGroupBy) => void;
	readonly value: SessionGroupBy;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<React.CSSProperties>({});
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const currentLabel = t(OPTIONS.find((option) => option.value === value)?.label ?? "Date", {
		context: "session_grouping",
	});

	const updatePosition = useCallback(() => {
		const rect = trigger.current?.getBoundingClientRect();
		if (!rect) return;
		const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
		const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
		const width = Math.min(180, Math.max(0, viewportWidth - 16));
		const height = Math.min(menu.current?.getBoundingClientRect().height || 156, Math.max(0, viewportHeight - 16));
		const preferredTop = rect.bottom + 4 + height <= viewportHeight - 8 ? rect.bottom + 4 : rect.top - height - 4;
		setPosition({
			left: Math.max(8, Math.min(rect.right - width, viewportWidth - width - 8)),
			top: Math.max(8, Math.min(preferredTop, viewportHeight - height - 8)),
			width,
			maxHeight: Math.max(0, viewportHeight - 16),
			overflowY: "auto",
		});
	}, []);

	const close = useCallback((restoreFocus = false) => {
		const previousMenu = menu.current;
		setOpen(false);
		if (restoreFocus)
			queueMicrotask(() => {
				const active = document.activeElement;
				if (
					trigger.current?.isConnected &&
					(active === document.body || (active && previousMenu?.contains(active)))
				)
					trigger.current.focus({ preventScroll: true });
			});
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		updatePosition();
		menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
	}, [open, updatePosition]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const node = event.target as Node;
			if (!root.current?.contains(node) && !menu.current?.contains(node)) close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as Node;
			if (event.defaultPrevented || (!root.current?.contains(target) && !menu.current?.contains(target))) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close(true);
			} else if (event.key === "Tab") {
				close();
				// Restore the natural tab origin before the browser moves to its next control.
				trigger.current?.focus({ preventScroll: true });
			}
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

	return (
		<div className="session-grouping-control" ref={root}>
			<button
				aria-controls={open ? menuId : undefined}
				aria-description={t("Group by {{label}}", { label: currentLabel })}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={t("Group sessions")}
				className="session-grouping-trigger"
				onClick={() => setOpen((current) => !current)}
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					setOpen(true);
				}}
				ref={trigger}
				title={t("Group by {{label}}", { label: currentLabel })}
				type="button"
			>
				<ListBullets aria-hidden="true" size={16} />
			</button>
			{open &&
				createPortal(
					<div
						aria-label={t("Session grouping")}
						className="session-grouping-menu"
						id={menuId}
						onKeyDown={(event) => {
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
							event.preventDefault();
							const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
							const current = items.indexOf(document.activeElement as HTMLButtonElement);
							const index =
								event.key === "Home"
									? 0
									: event.key === "End"
										? items.length - 1
										: event.key === "ArrowDown"
											? (current + 1) % items.length
											: (current + items.length - 1) % items.length;
							items[index]?.focus({ preventScroll: true });
						}}
						ref={menu}
						role="menu"
						style={position}
					>
						{OPTIONS.map((option) => (
							<div
								className={option.value === "none" ? "session-grouping-menu-last" : undefined}
								key={option.value}
								role="none"
							>
								<button
									aria-checked={option.value === value}
									onClick={() => {
										close(true);
										if (option.value !== value) onChange(option.value);
									}}
									role="menuitemradio"
									tabIndex={option.value === value ? 0 : -1}
									type="button"
								>
									<span>{t(option.label, { context: "session_grouping" })}</span>
									{option.value === value && <Check aria-hidden="true" size={16} weight="bold" />}
								</button>
							</div>
						))}
					</div>,
					document.body,
				)}
		</div>
	);
}
