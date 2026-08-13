import type { ModelOptionView, SessionSnapshot } from "@metis/app-protocol";
import { CaretDown, Check } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface ModelSelectorProps {
	readonly available: readonly ModelOptionView[];
	readonly commandRequest?: { readonly id: number; readonly open: boolean };
	readonly disabled: boolean;
	readonly onChange: (model: ModelOptionView) => void | Promise<void>;
	readonly value: SessionSnapshot["model"];
}

export function ModelSelector({ available, commandRequest, disabled, onChange, value }: ModelSelectorProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const lastCommandRequest = useRef(commandRequest?.id);
	const selected = available.find((model) => model.provider === value?.provider && model.modelId === value.modelId);

	const close = (restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	};
	const selectModel = useCallback(async (model: ModelOptionView) => {
		setOpen(false);
		setPending(true);
		try {
			await onChange(model);
		} finally {
			setPending(false);
		}
	}, [onChange]);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	useEffect(() => {
		if (commandRequest === undefined || commandRequest.id === lastCommandRequest.current) return;
		lastCommandRequest.current = commandRequest.id;
		setOpen(commandRequest.open && !disabled);
	}, [commandRequest, disabled]);

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
			const model = /^[1-9]$/.test(event.key) ? available[Number(event.key) - 1] : undefined;
			if (!model) return;
			event.preventDefault();
			close(true);
			void selectModel(model).catch(() => undefined);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [available, open, selectModel]);

	return (
		<div className="composer-selector model-selector model-control" ref={rootRef}>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={t("Select model")}
				className="composer-selector-trigger"
				disabled={disabled || pending || available.length === 0}
				onClick={() => setOpen((value) => !value)}
				ref={triggerRef}
				type="button"
			>
				<span>{selected?.name ?? value?.modelId ?? t("Model")}</span>
				<CaretDown aria-hidden="true" size={12} />
			</button>
			{open && (
				<div aria-label={t("Models")} className="model-selector-popover" role="menu">
					<p>{t("Models")}</p>
					{available.map((model, index) => {
						const isSelected = model.provider === value?.provider && model.modelId === value.modelId;
						return (
							<button
								aria-checked={isSelected}
								key={`${model.provider}/${model.modelId}`}
								onClick={() => {
									if (!isSelected) void selectModel(model).catch(() => undefined);
								}}
								role="menuitemradio"
								type="button"
							>
								<span>{model.name}</span>
								{isSelected ? (
									<Check aria-hidden="true" size={16} weight="bold" />
								) : index < 9 ? (
									<kbd>{index + 1}</kbd>
								) : null}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
