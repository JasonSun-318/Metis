import type { ModelOptionView, SessionSnapshot } from "@metis/app-protocol";
import { CaretDown, CaretLeft, CaretRight, Check } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { providerDisplayName } from "../provider-names.ts";

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
	const [activeProvider, setActiveProvider] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const lastCommandRequest = useRef(commandRequest?.id);
	const selected = available.find((model) => model.provider === value?.provider && model.modelId === value.modelId);

	const providers = useMemo(() => {
		const names = new Map<string, string>();
		for (const model of available) names.set(model.provider, providerDisplayName(model.provider));
		return [...names.entries()].sort((left, right) => {
			if (left[0] === value?.provider) return -1;
			if (right[0] === value?.provider) return 1;
			return left[1].localeCompare(right[1]);
		});
	}, [available, value?.provider]);

	const activeModels = useMemo(
		() => (activeProvider === null ? [] : available.filter((model) => model.provider === activeProvider)),
		[activeProvider, available],
	);

	const close = (restoreFocus = false) => {
		setOpen(false);
		setActiveProvider(null);
		if (restoreFocus) triggerRef.current?.focus();
	};
	const selectModel = useCallback(async (model: ModelOptionView) => {
		setOpen(false);
		setActiveProvider(null);
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
		setActiveProvider(null);
	}, [commandRequest, disabled]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				if (activeProvider !== null) {
					setActiveProvider(null);
					return;
				}
				close(true);
				return;
			}
			if (activeProvider === null) return;
			const model = /^[1-9]$/.test(event.key) ? activeModels[Number(event.key) - 1] : undefined;
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
	}, [activeModels, activeProvider, open, selectModel]);

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
				<div aria-label={t(activeProvider === null ? "Providers" : "Models")} className={activeProvider === null ? "model-selector-popover is-provider" : "model-selector-popover"} role="menu">
					{activeProvider === null ? (
						<>
							<p>{t("Providers")}</p>
							{providers.map(([provider, name]) => {
								const isSelected = provider === value?.provider;
								return (
									<button
										aria-checked={isSelected}
										className="model-selector-provider"
										key={provider}
										onClick={() => setActiveProvider(provider)}
										role="menuitemradio"
										type="button"
									>
										<span>{name}</span>
										{isSelected ? (
											<Check aria-hidden="true" size={16} weight="bold" />
										) : (
											<CaretRight aria-hidden="true" size={14} />
										)}
									</button>
								);
							})}
						</>
					) : (
						<>
							<button
								aria-label={t("Back to providers")}
								className="model-selector-back"
								onClick={() => setActiveProvider(null)}
								role="menuitem"
								type="button"
							>
								<CaretLeft aria-hidden="true" size={14} />
								<span>{providerDisplayName(activeProvider)}</span>
							</button>
							{activeModels.map((model, index) => {
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
						</>
					)}
				</div>
			)}
		</div>
	);
}
