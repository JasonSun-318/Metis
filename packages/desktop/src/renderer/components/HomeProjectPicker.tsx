import type { AgentMode } from "@metis/app-protocol";
import { FolderSimple, Plus, X } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectSessionGroup } from "./SessionSidebar.tsx";
import { MenuSelect, type MenuSelectOption } from "./MenuSelect.tsx";

const NO_PROJECT_VALUE = "__metis_home_no_project__";

export interface HomeProjectPickerProps {
	readonly busy: boolean;
	readonly folder: string | null;
	readonly folderLocked: boolean;
	readonly mode: AgentMode;
	readonly onChooseFolder: () => Promise<void>;
	readonly onClearFolder?: () => void;
	readonly onCreateProject?: () => void;
	readonly onSelectProject: (cwd: string) => void;
	readonly projects: readonly ProjectSessionGroup[];
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
	onSelectProject,
	projects,
}: HomeProjectPickerProps) {
	const { t } = useTranslation();
	const options = useMemo<readonly MenuSelectOption<string>[]>(() => {
		const seen = new Set<string>();
		const next: MenuSelectOption<string>[] = [];
		const add = (cwd: string, label: string) => {
			if (!cwd || seen.has(cwd)) return;
			seen.add(cwd);
			next.push({ value: cwd, label });
		};
		for (const project of projects) add(project.cwd, project.name);
		if (folder) add(folder, projects.find((project) => project.cwd === folder)?.name ?? projectName(folder));
		return next;
	}, [folder, projects]);
	const value = folder ?? NO_PROJECT_VALUE;
	const pickerLabel = folder ? projectName(folder) : t(mode === "code" ? "Choose a project" : "Choose a project or folder");
	const pickerDisabled = busy || folderLocked || options.length === 0;

	return (
		<div
			className={`home-project-picker home-project-picker-${mode}`}
			data-folder-selected={folder ? "true" : undefined}
			data-folder-locked={folderLocked ? "true" : undefined}
		>
			<MenuSelect
				ariaLabel={t("Choose a project")}
				className="home-project-picker-select"
				disabled={pickerDisabled}
				menuMinWidth={240}
				onChange={onSelectProject}
				options={options}
				placeholder={pickerLabel}
				popoverClassName="home-project-picker-menu"
				value={value}
				triggerIcon={<FolderSimple aria-hidden="true" size={15} />}
			/>
			{mode === "chat" && !folder && (
				<span className="folder-picker-hint home-project-picker-hint">{t("Optional")}</span>
			)}
			<button
				aria-label={t("Choose folder")}
				className="folder-picker home-project-picker-browse"
				disabled={busy || folderLocked}
				onClick={() => void onChooseFolder()}
				title={t("Choose folder")}
				type="button"
			>
				<FolderSimple aria-hidden="true" size={16} />
				<span>{t("Choose folder")}</span>
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
