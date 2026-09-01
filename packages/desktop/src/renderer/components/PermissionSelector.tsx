import type { PermissionPresetView } from "@metis/app-protocol";
import { CaretDown, Check, Shield } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface PermissionSelectorProps {
	readonly disabled: boolean;
	readonly onChange: (mode: PermissionPresetView) => void | Promise<void>;
	readonly value: PermissionPresetView;
}

const OPTIONS: ReadonlyArray<{
	readonly value: PermissionPresetView;
	readonly label: string;
	readonly description: string;
}> = [
	{
		value: "ask",
		label: "Ask before every change",
		description: "Ask before model changes; approved Bash stays sandboxed unless host access is shown.",
	},
	{
		value: "auto",
		label: "Auto",
		description: "Work automatically in this project; ask for dangerous or boundary-crossing actions.",
	},
	{
		value: "full",
		label: "Full access",
		description: "Run model tools directly as your OS user without Metis approval.",
	},
];

export function PermissionSelector({ disabled, onChange, value }: PermissionSelectorProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const label = t(value === "ask" ? "Ask" : value === "auto" ? "Auto" : "Full");

	const close = useCallback((restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	}, []);
	const select = useCallback(
		async (mode: PermissionPresetView) => {
			setOpen(false);
			if (mode === value) return;
			setPending(true);
			try {
				await onChange(mode);
			} finally {
				setPending(false);
			}
		},
		[onChange, value],
	);

	useEffect(() => {
		if (disabled) close();
	}, [close, disabled]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close(true);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [close, open]);

	return (
		<div className={`composer-selector permission-selector permission-${value}`} ref={rootRef}>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={t("Select permissions, current {{label}}", { label })}
				className="composer-selector-trigger"
				disabled={disabled || pending}
				onClick={() => setOpen((current) => !current)}
				ref={triggerRef}
				type="button"
			>
				<Shield aria-hidden="true" size={14} weight={value === "full" ? "fill" : "regular"} />
				<span>{label}</span>
				<CaretDown aria-hidden="true" size={12} />
			</button>
			{open && (
				<div aria-label={t("Permissions")} className="permission-selector-popover" role="menu">
					{OPTIONS.map((option) => {
						const selected = option.value === value;
						return (
							<button
								aria-checked={selected}
								className={option.value === "full" ? "permission-full-option" : undefined}
								key={option.value}
								onClick={() => void select(option.value).catch(() => undefined)}
								role="menuitemradio"
								type="button"
							>
								<span>
									<strong>{t(option.label)}</strong>
									<small>{t(option.description)}</small>
								</span>
								{selected && <Check aria-hidden="true" size={16} weight="bold" />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
