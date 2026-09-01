import type { PermissionPresetView, SessionSnapshot } from "@metis/app-protocol";
import { CaretDown, Check, Shield } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface PermissionSelectorProps {
	readonly activeReview?: SessionSnapshot["activeReview"];
	readonly constrainedByParent?: boolean;
	readonly disabled: boolean;
	readonly onChange: (mode: PermissionPresetView) => void | Promise<void>;
	readonly sandboxHealth?: SessionSnapshot["sandboxHealth"];
	readonly value: PermissionPresetView;
}

const OPTIONS: ReadonlyArray<{
	readonly value: PermissionPresetView;
	readonly label: string;
	readonly description: string;
	readonly requiresSandbox: boolean;
}> = [
	{
		value: "ask",
		label: "Ask",
		description: "Runs in the workspace sandbox and asks you when approval is needed.",
		requiresSandbox: true,
	},
	{
		value: "auto",
		label: "Auto",
		description: "Runs in the workspace sandbox. The current model reviews risky actions when needed.",
		requiresSandbox: true,
	},
	{
		value: "full",
		label: "Full",
		description: "May run on the host. Critical actions still ask you.",
		requiresSandbox: false,
	},
];

export function PermissionSelector({
	activeReview,
	constrainedByParent = false,
	disabled,
	onChange,
	sandboxHealth = "healthy",
	value,
}: PermissionSelectorProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const sandboxReady = sandboxHealth === "healthy";
	const label = t(value === "ask" ? "Ask" : value === "auto" ? "Auto" : "Full");
	const reviewing = activeReview?.reviewer === "model";
	const status = reviewing
		? t("Checking security…")
		: !sandboxReady
			? t("Workspace sandbox is unavailable. Ask and Auto stay disabled instead of running on the host.")
			: constrainedByParent
				? t("A parent session limits the effective permissions for this task.")
				: undefined;

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
			if (event.key === "Escape") {
				event.preventDefault();
				close(true);
				return;
			}
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			event.preventDefault();
			const enabled = optionRefs.current.filter((node): node is HTMLButtonElement => node !== null && !node.disabled);
			if (enabled.length === 0) return;
			const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
			const delta = event.key === "ArrowDown" ? 1 : -1;
			const next = enabled[(current + delta + enabled.length) % enabled.length];
			next?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [close, open]);

	useEffect(() => {
		if (!open) return;
		const first = optionRefs.current.find((node) => node !== null && !node.disabled);
		queueMicrotask(() => first?.focus());
	}, [open]);

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
			{status && (
				<p
					className={`permission-selector-status${!sandboxReady || constrainedByParent ? " is-warning" : ""}`}
					role="status"
				>
					{status}
				</p>
			)}
			{open && (
				<div aria-label={t("Permissions")} className="permission-selector-popover" role="menu">
					{OPTIONS.map((option, index) => {
						const selected = option.value === value;
						const optionDisabled = option.requiresSandbox && !sandboxReady;
						return (
							<button
								aria-checked={selected}
								aria-disabled={optionDisabled}
								className={option.value === "full" ? "permission-full-option" : undefined}
								disabled={optionDisabled}
								key={option.value}
								onClick={() => {
									if (optionDisabled) return;
									void select(option.value).catch(() => undefined);
								}}
								ref={(node) => {
									optionRefs.current[index] = node;
								}}
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
					{constrainedByParent && (
						<p className="permission-selector-note">{t("A parent session limits the effective permissions for this task.")}</p>
					)}
					{!sandboxReady && (
						<p className="permission-selector-note" role="alert">
							{t("Workspace sandbox is unavailable. Ask and Auto stay disabled instead of running on the host.")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
