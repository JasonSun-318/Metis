import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopChangelog, DesktopUpdateState } from "../../shared/desktop-api.ts";
import { ArrowsClockwise, CaretDown, GearSix } from "../icons.tsx";
import { useProfileIdentity } from "../profile-identity.ts";
import { ReleaseNotesPopover } from "./ReleaseNotesPopover.tsx";

const NO_UPDATE: DesktopUpdateState = { status: "unavailable" };

export const AccountMenu = memo(function AccountMenu({
	onSettings,
	onCheckUpdate,
	onUpdate,
	checkingUpdate = false,
	updateState = NO_UPDATE,
	loadChangelog,
}: {
	readonly onSettings: () => void;
	readonly onCheckUpdate?: () => void;
	readonly onUpdate?: () => void;
	readonly checkingUpdate?: boolean;
	readonly updateState?: DesktopUpdateState;
	readonly loadChangelog?: () => Promise<DesktopChangelog>;
}) {
	const { t } = useTranslation();
	const identity = useProfileIdentity();
	const [open, setOpen] = useState(false);
	const [notificationsUnread, setNotificationsUnread] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const initialFocus = useRef<"first" | "last">("first");
	const menuId = useId();
	const checking = updateState.status === "checking" || (checkingUpdate && updateState.status === "unavailable");
	const downloading = updateState.status === "downloading";
	const hasUpdate = updateState.status === "available" || updateState.status === "ready";
	const updateDetail = checking
		? t("Checking for updates")
		: updateState.status === "downloading"
			? t("Downloading update {{progress}}%", { progress: updateState.progress })
			: updateState.status === "available"
				? t("Version {{version}} available", { version: updateState.version })
				: updateState.status === "ready"
					? `${t("Open installer")} · ${updateState.version}`
					: null;
	const updateAction = (hasUpdate ? onUpdate : undefined) ?? onCheckUpdate;
	const description = [notificationsUnread ? t("Unread notifications") : null, updateDetail]
		.filter(Boolean)
		.join(" · ");

	const closeMenu = useCallback((restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	}, []);
	const openNotifications = useCallback(() => closeMenu(), [closeMenu]);
	const menuItems = useCallback(
		() => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []),
		[],
	);
	const focusEdge = useCallback(
		(edge: "first" | "last") => {
			const items = menuItems();
			(edge === "last" ? items.at(-1) : items[0])?.focus();
		},
		[menuItems],
	);
	useLayoutEffect(() => {
		if (open) focusEdge(initialFocus.current);
	}, [focusEdge, open]);
	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) closeMenu();
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			closeMenu(true);
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [closeMenu, open]);

	return (
		<div
			className="account-menu"
			onBlurCapture={(event) => {
				if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu();
			}}
			ref={rootRef}
		>
			{/* Keep notification state and its body portal alive after this menu closes. */}
			<div
				aria-hidden={!open}
				aria-label={t("Metis menu")}
				className="account-menu-popover"
				hidden={!open}
				id={menuId}
				inert={!open}
				onKeyDown={(event) => {
					// Dialog portals remain React descendants while this menu is hidden.
					if (!open || !event.currentTarget.contains(event.target as Node)) return;
					if (event.key === "Tab") {
						closeMenu(true);
						return;
					}
					if (event.key === "Home" || event.key === "End") {
						event.preventDefault();
						focusEdge(event.key === "Home" ? "first" : "last");
						return;
					}
					const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
					if (!delta) return;
					event.preventDefault();
					const items = menuItems();
					const index = items.indexOf(document.activeElement as HTMLButtonElement);
					items[(index + delta + items.length) % items.length]?.focus();
				}}
				ref={menuRef}
				role="menu"
			>
				<button
					className="account-menu-item"
					onClick={() => {
						closeMenu(true);
						onSettings();
					}}
					role="menuitem"
					type="button"
				>
					<GearSix aria-hidden="true" size={15} />
					<span className="account-menu-item-label">{t("Settings")}</span>
				</button>
				{loadChangelog && (
					<ReleaseNotesPopover
						anchorRef={triggerRef}
						availableVersion={"version" in updateState ? updateState.version : null}
						loadChangelog={loadChangelog}
						onOpen={openNotifications}
						onUnreadChange={setNotificationsUnread}
						returnFocusRef={triggerRef}
						variant="menu"
					/>
				)}
				{updateAction && (
					<button
						aria-busy={checking || downloading}
						aria-description={updateDetail ?? undefined}
						aria-label={t("Get updates")}
						className="account-menu-item account-update-check"
						disabled={checking || downloading}
						onClick={() => {
							closeMenu(true);
							updateAction();
						}}
						role="menuitem"
						title={updateDetail ?? undefined}
						type="button"
					>
						<ArrowsClockwise
							aria-hidden="true"
							className={checking || downloading ? "is-spinning" : undefined}
							size={15}
						/>
						<span className="account-menu-item-label">{t("Get updates")}</span>
						{updateDetail && <span className="account-menu-item-detail">{updateDetail}</span>}
					</button>
				)}
			</div>
			<div className="account-menu-footer">
				<button
					aria-controls={menuId}
					aria-description={description || undefined}
					aria-expanded={open}
					aria-haspopup="menu"
					aria-label={identity.displayName}
					className="account-menu-trigger"
					onClick={() => {
						initialFocus.current = "first";
						setOpen((current) => !current);
					}}
					onKeyDown={(event) => {
						if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
						event.preventDefault();
						const edge = event.key === "ArrowUp" ? "last" : "first";
						initialFocus.current = edge;
						if (open) focusEdge(edge);
						else setOpen(true);
					}}
					ref={triggerRef}
					type="button"
				>
					<span aria-hidden="true" className="account-mark">
						{identity.avatarDataUrl ? (
							<img alt="" src={identity.avatarDataUrl} />
						) : (
							(identity.displayName.trim()[0]?.toUpperCase() ?? "M")
						)}
					</span>
					<span className="account-menu-name">{identity.displayName}</span>
					{(notificationsUnread || hasUpdate) && (
						<span
							aria-hidden="true"
							className="account-menu-status-dot"
							data-unread={notificationsUnread || undefined}
						/>
					)}
					<CaretDown aria-hidden="true" size={14} />
				</button>
			</div>
		</div>
	);
});
