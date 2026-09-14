import type { AgentMode } from "@metis/app-protocol";
import { FolderSimple, Plus, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

export interface HomeProjectPickerProps {
	readonly busy: boolean;
	readonly folder: string | null;
	readonly folderLocked: boolean;
	readonly mode: AgentMode;
	readonly onChooseFolder: () => Promise<void>;
	readonly onClearFolder?: () => void;
	readonly onCreateProject?: () => void;
}

function projectName(folder: string): string {
	return folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder;
}

export function HomeProjectPicker({
	busy,
	folder,
	folderLocked,
	mode,
	onChooseFolder,
	onClearFolder,
	onCreateProject,
}: HomeProjectPickerProps) {
	const { t } = useTranslation();
	const folderLabel = folder ? projectName(folder) : t("Choose folder");

	return (
		<div
			className={`home-project-picker home-project-picker-${mode}`}
			data-folder-selected={folder ? "true" : undefined}
			data-folder-locked={folderLocked ? "true" : undefined}
		>
			<button
				aria-label={t("Choose folder")}
				className="folder-picker home-project-picker-browse"
				disabled={busy || folderLocked}
				onClick={() => void onChooseFolder()}
				title={folder ?? t("Choose folder")}
				type="button"
			>
				<FolderSimple aria-hidden="true" size={16} />
				<span>{folderLabel}</span>
			</button>
			{mode === "code" && onCreateProject && (
				<button
					aria-label={t("Create a new project")}
					className="home-project-picker-create"
					disabled={busy || folderLocked}
					onClick={onCreateProject}
					title={t("Create a new project")}
					type="button"
				>
					<Plus aria-hidden="true" size={16} />
					<span>{t("Create a new project")}</span>
				</button>
			)}
			{mode === "chat" && folder && onClearFolder && (
				<button
					aria-label={t("No project context")}
					className="home-project-picker-clear"
					disabled={busy || folderLocked}
					onClick={onClearFolder}
					title={t("No project context")}
					type="button"
				>
					<X aria-hidden="true" size={15} />
				</button>
			)}
		</div>
	);
}
