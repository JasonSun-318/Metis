import type { ModelOptionView, SessionSnapshot } from "@metis/app-protocol";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretDown, CaretRight, Check } from "../icons.tsx";
import { providerDisplayName } from "../provider-names.ts";

interface ModelSelectorProps {
	readonly available: readonly ModelOptionView[];
	readonly commandRequest?: { readonly id: number; readonly open: boolean };
	readonly disabled: boolean;
	readonly onChange: (model: ModelOptionView) => void | Promise<void>;
	readonly value: SessionSnapshot["model"];
}

function focusMenuItem(menu: HTMLDivElement | null) {
	const item =
		menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
		menu?.querySelector<HTMLButtonElement>("button");
	item?.focus();
}

export function ModelSelector({ available, commandRequest, disabled, onChange, value }: ModelSelectorProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [activeProvider, setActiveProvider] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const providerMenuRef = useRef<HTMLDivElement>(null);
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const providerItemsRef = useRef(new Map<string, HTMLButtonElement>());
	const focusedItemRef = useRef<HTMLButtonElement | null>(null);
	const returnProviderRef = useRef<string | null>(null);
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

	const close = useCallback((restoreFocus = false) => {
		setOpen(false);
		setActiveProvider(null);
		returnProviderRef.current = null;
		focusedItemRef.current = null;
		if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
	}, []);
	const selectModel = useCallback(
		async (model: ModelOptionView) => {
			close();
			setPending(true);
			try {
				await onChange(model);
			} finally {
				setPending(false);
			}
		},
		[close, onChange],
	);

	useEffect(() => {
		if (disabled) close();
	}, [close, disabled]);
	useEffect(() => {
		if (commandRequest === undefined || commandRequest.id === lastCommandRequest.current) return;
		lastCommandRequest.current = commandRequest.id;
		setOpen(commandRequest.open && !disabled && !pending && available.length > 0);
		setActiveProvider(null);
		returnProviderRef.current = null;
	}, [available.length, commandRequest, disabled, pending]);

	useLayoutEffect(() => {
		if (!open) return;
		if (activeProvider !== null) focusMenuItem(modelMenuRef.current);
		else {
			if (providerMenuRef.current?.contains(document.activeElement)) return;
			const returning =
				returnProviderRef.current === null ? undefined : providerItemsRef.current.get(returnProviderRef.current);
			if (returning) returning.focus();
			else focusMenuItem(providerMenuRef.current);
		}
	}, [open, activeProvider]);

	useLayoutEffect(() => {
		if (!open) return;
		if (available.length === 0) {
			close();
			return;
		}
		if (activeProvider !== null && activeModels.length === 0) {
			setActiveProvider(null);
			return;
		}
		// Recover only focus lost when this menu's own row was removed. Ordinary
		// discovery refreshes and focus intentionally moved elsewhere stay untouched.
		if (focusedItemRef.current?.isConnected === false && document.activeElement === document.body) {
			focusMenuItem(activeProvider === null ? providerMenuRef.current : modelMenuRef.current);
		}
	}, [activeModels.length, activeProvider, available, close, open]);

	useEffect(() => {
		if (!open) return;
		const dismissOutside = (event: Event) => {
			if (!rootRef.current?.contains(event.target as Node)) close();
		};
		document.addEventListener("pointerdown", dismissOutside);
		document.addEventListener("focusin", dismissOutside);
		return () => {
			document.removeEventListener("pointerdown", dismissOutside);
			document.removeEventListener("focusin", dismissOutside);
		};
	}, [close, open]);

	const enterProvider = (provider: string) => {
		returnProviderRef.current = provider;
		if (activeProvider === provider) focusMenuItem(modelMenuRef.current);
		else setActiveProvider(provider);
	};
	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey)
			return;
		if (event.key === "Tab") {
			close();
			return;
		}
		if (event.key === "Escape" || (event.key === "ArrowLeft" && event.currentTarget === modelMenuRef.current)) {
			event.preventDefault();
			event.stopPropagation();
			if (activeProvider !== null) setActiveProvider(null);
			else close(true);
			return;
		}
		const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
		const target = event.target instanceof HTMLElement ? event.target.closest("button") : null;
		if (event.key === "ArrowRight" && event.currentTarget === providerMenuRef.current) {
			const provider = target?.dataset.provider;
			if (provider) {
				event.preventDefault();
				enterProvider(provider);
			}
			return;
		}
		if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) && items.length > 0) {
			event.preventDefault();
			const current = items.indexOf(target as HTMLButtonElement);
			const next =
				event.key === "Home"
					? 0
					: event.key === "End"
						? items.length - 1
						: (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
			items[next]?.focus();
			return;
		}
		if (event.currentTarget !== modelMenuRef.current) return;
		const model = /^[1-9]$/.test(event.key) ? activeModels[Number(event.key) - 1] : undefined;
		if (!model) return;
		event.preventDefault();
		close(true);
		void selectModel(model).catch(() => undefined);
	};

	return (
		<div className="composer-selector model-selector model-control" ref={rootRef}>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={t("Select model")}
				className="composer-selector-trigger"
				disabled={disabled || pending || available.length === 0}
				onClick={() => {
					if (open) close();
					else {
						returnProviderRef.current = null;
						setOpen(true);
					}
				}}
				onKeyDown={(event) => {
					if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
						event.preventDefault();
						returnProviderRef.current = null;
						setOpen(true);
					}
				}}
				ref={triggerRef}
				type="button"
			>
				<span>{selected?.name ?? value?.modelId ?? t("Model")}</span>
				<CaretDown aria-hidden="true" size={12} />
			</button>
			{open && (
				<div
					aria-label={t("Providers")}
					className="model-selector-popover is-provider"
					onFocus={(event) => {
						if (event.target instanceof HTMLButtonElement) focusedItemRef.current = event.target;
					}}
					onKeyDown={onMenuKeyDown}
					ref={providerMenuRef}
					role="menu"
				>
					{providers.map(([provider, name]) => {
						const isSelected = provider === value?.provider;
						const expanded = provider === activeProvider;
						return (
							<button
								aria-checked={isSelected}
								aria-expanded={expanded}
								className="model-selector-provider"
								data-provider={provider}
								key={provider}
								onClick={() => {
									returnProviderRef.current = provider;
									setActiveProvider(expanded ? null : provider);
								}}
								ref={(button) => {
									if (button) providerItemsRef.current.set(provider, button);
									else providerItemsRef.current.delete(provider);
								}}
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
				</div>
			)}
			{open && activeProvider !== null && (
				<div
					aria-label={t("Models")}
					className="model-selector-submenu"
					onFocus={(event) => {
						if (event.target instanceof HTMLButtonElement) focusedItemRef.current = event.target;
					}}
					onKeyDown={onMenuKeyDown}
					ref={modelMenuRef}
					role="menu"
				>
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
				</div>
			)}
		</div>
	);
}
