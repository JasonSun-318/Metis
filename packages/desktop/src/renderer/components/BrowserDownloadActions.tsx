import { useTranslation } from "react-i18next";
import type { DesktopDownloadControlType } from "../../shared/desktop-api.ts";
import { ArrowCounterClockwise, ArrowSquareOut, type Icon, Pause, Play, Trash, X } from "../icons.tsx";
import { DOWNLOAD_ACTION_LABELS } from "./browser-download-presentation.ts";

const ACTION_ICONS: Readonly<Record<Exclude<DesktopDownloadControlType, "reveal">, Icon>> = {
	cancel: X,
	open: ArrowSquareOut,
	pause: Pause,
	remove: Trash,
	resume: Play,
	retry: ArrowCounterClockwise,
};

export function BrowserDownloadActions({
	actions,
	className,
	downloadId,
	iconSize,
	menuItem = false,
	onAction,
	revealIcon: RevealIcon,
}: {
	readonly actions: readonly DesktopDownloadControlType[];
	readonly className: string;
	readonly downloadId: string;
	readonly iconSize: 12 | 14;
	readonly menuItem?: boolean;
	readonly onAction: (type: DesktopDownloadControlType, downloadId: string) => void;
	readonly revealIcon: Icon;
}) {
	const { t } = useTranslation();
	return (
		<div className={className}>
			{actions.map((type) => {
				const ActionIcon = type === "reveal" ? RevealIcon : ACTION_ICONS[type];
				return (
					<button
						aria-label={t(DOWNLOAD_ACTION_LABELS[type])}
						key={type}
						onClick={() => onAction(type, downloadId)}
						role={menuItem ? "menuitem" : undefined}
						type="button"
					>
						<ActionIcon aria-hidden="true" size={iconSize} />
					</button>
				);
			})}
		</div>
	);
}
