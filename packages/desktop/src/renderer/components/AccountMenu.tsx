import { CaretDown, CaretRight, Check, GearSix, Globe } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { APP_LOCALES, type AppLocale, setLocale } from "../i18n.ts";

export function AccountMenu({ onSettings }: { readonly onSettings: () => void }) {
	const { t, i18n } = useTranslation();
	const [open, setOpen] = useState(false);
	const [languageOpen, setLanguageOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const itemRef = useRef<HTMLButtonElement>(null);
	const languageRef = useRef<HTMLButtonElement>(null);
	const localeRefs = useRef(new Map<AppLocale, HTMLButtonElement>());
	const triggerRef = useRef<HTMLButtonElement>(null);
	const locale: AppLocale = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";

	useEffect(() => {
		if (!open) return;
		itemRef.current?.focus();
		const closeOutside = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) {
				setLanguageOpen(false);
				setOpen(false);
			}
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (languageOpen) {
				setLanguageOpen(false);
				languageRef.current?.focus();
				return;
			}
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [languageOpen, open]);

	useEffect(() => {
		if (languageOpen) localeRefs.current.get(locale)?.focus();
	}, [languageOpen, locale]);

	const chooseLocale = async (nextLocale: AppLocale) => {
		await setLocale(nextLocale);
		setLanguageOpen(false);
		setOpen(false);
	};

	return (
		<div className="account-menu" ref={rootRef}>
			{open && (
				<div aria-label={t("ArcMind menu")} className="account-menu-popover" role="menu">
					<button
						className="account-menu-item"
						onClick={() => {
							setOpen(false);
							onSettings();
						}}
						ref={itemRef}
						role="menuitem"
						type="button"
					>
						<GearSix aria-hidden="true" size={17} />
						<span className="account-menu-item-label">{t("Settings")}</span>
					</button>
					<button
						aria-expanded={languageOpen}
						aria-haspopup="menu"
						className="account-menu-item"
						onClick={() => setLanguageOpen((current) => !current)}
						onKeyDown={(event) => {
							if (event.key === "ArrowRight") setLanguageOpen(true);
						}}
						ref={languageRef}
						role="menuitem"
						type="button"
					>
						<Globe aria-hidden="true" size={17} />
						<span className="account-menu-item-label">{t("Language")}</span>
						<CaretRight aria-hidden="true" size={14} />
					</button>
				</div>
			)}
			{open && languageOpen && (
				<div aria-label={t("Language")} className="account-language-popover" role="menu">
					{APP_LOCALES.map((option) => (
						<button
							aria-checked={locale === option.value}
							className="account-language-option"
							key={option.value}
							onClick={() => void chooseLocale(option.value)}
							onKeyDown={(event) => {
								if (event.key !== "ArrowLeft") return;
								setLanguageOpen(false);
								languageRef.current?.focus();
							}}
							ref={(element) => {
								if (element) localeRefs.current.set(option.value, element);
								else localeRefs.current.delete(option.value);
							}}
							role="menuitemradio"
							type="button"
						>
							<span>{option.label}</span>
							{locale === option.value && <Check aria-hidden="true" size={16} />}
						</button>
					))}
				</div>
			)}
			<button
				aria-label="ArcMind"
				aria-expanded={open}
				aria-haspopup="menu"
				className="account-menu-trigger"
				onClick={() => {
					setLanguageOpen(false);
					setOpen((current) => !current);
				}}
				ref={triggerRef}
				type="button"
			>
				<span className="account-mark">A</span>
				<span>ArcMind</span>
				<CaretDown aria-hidden="true" size={14} />
			</button>
		</div>
	);
}
