import { ArrowsClockwise, CaretDown, GearSix } from "@phosphor-icons/react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProfileIdentity } from "../profile-identity.ts";

export const AccountMenu = memo(function AccountMenu({ onSettings, onCheckUpdate, checkingUpdate = false, updateDownloading = false }: {
 readonly onSettings: () => void;
 readonly onCheckUpdate?: () => void;
 readonly checkingUpdate?: boolean;
 readonly updateDownloading?: boolean;
}) {
	const { t } = useTranslation();
	const identity = useProfileIdentity();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const itemRef = useRef<HTMLButtonElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		itemRef.current?.focus();
		const closeOutside = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);

	return (
		<div className="account-menu" ref={rootRef}>
			{open ? (
				<div aria-label={t("Metis menu")} className="account-menu-popover" role="menu">
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
						<GearSix aria-hidden="true" size={15} />
						<span className="account-menu-item-label">{t("Settings")}</span>
					</button>
				</div>
			) : null}
			<div className="account-menu-footer">
			<button
				aria-label={identity.displayName}
				aria-expanded={open}
				aria-haspopup="menu"
				className="account-menu-trigger"
				onClick={() => setOpen((current) => !current)}
				ref={triggerRef}
				type="button"
			>
				<span aria-hidden="true" className="account-mark">
					{identity.avatarDataUrl
						? <img alt="" src={identity.avatarDataUrl} />
						: identity.displayName.trim()[0]?.toUpperCase() ?? "M"}
				</span>
				<span className="account-menu-name">{identity.displayName}</span>
				<CaretDown aria-hidden="true" size={14} />
			</button>
			{onCheckUpdate && <button
				aria-label={t(checkingUpdate ? "Checking for updates" : "Check for updates")}
				aria-busy={checkingUpdate}
				className="account-update-check"
				disabled={checkingUpdate || updateDownloading}
				onClick={() => { setOpen(false); onCheckUpdate(); }}
				title={t(updateDownloading ? "Update download in progress" : checkingUpdate ? "Checking for updates" : "Check for updates")}
				type="button"
			><ArrowsClockwise aria-hidden="true" className={checkingUpdate ? "is-spinning" : undefined} size={15} /></button>}
			</div>
		</div>
	);
});
