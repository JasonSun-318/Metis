import type { ModelOptionView, SessionSnapshot } from "@arcmind/app-protocol";
import { CaretDown, Check } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

interface ModelSelectorProps {
	readonly available: readonly ModelOptionView[];
	readonly disabled: boolean;
	readonly onChange: (model: ModelOptionView) => void;
	readonly value: SessionSnapshot["model"];
}

export function ModelSelector({ available, disabled, onChange, value }: ModelSelectorProps) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const selected = available.find((model) => model.provider === value?.provider && model.modelId === value.modelId);

	const close = (restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	};

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

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
			onChange(model);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [available, onChange, open]);

	return (
		<div className="composer-selector model-selector model-control" ref={rootRef}>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label="Select model"
				className="composer-selector-trigger"
				disabled={disabled || available.length === 0}
				onClick={() => setOpen((value) => !value)}
				ref={triggerRef}
				type="button"
			>
				<span>{selected?.name ?? value?.modelId ?? "Model"}</span>
				<CaretDown aria-hidden="true" size={12} />
			</button>
			{open && (
				<div aria-label="Models" className="model-selector-popover" role="menu">
					<p>Models</p>
					{available.map((model, index) => {
						const isSelected = model.provider === value?.provider && model.modelId === value.modelId;
						return (
							<button
								aria-checked={isSelected}
								key={`${model.provider}/${model.modelId}`}
								onClick={() => {
									close();
									if (!isSelected) onChange(model);
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
