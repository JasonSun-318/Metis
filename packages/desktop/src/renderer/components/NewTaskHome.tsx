import type { AgentMode, SkillSummaryView } from "@metis/app-protocol";
import { CaretDown } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { Composer, type ComposerSubmission } from "./Composer.tsx";
import { SideRays } from "./SideRays.tsx";
import type { ComposerSlashCommand } from "./SlashCommandMenu.tsx";
import { AnimatedNavIcon } from "./AnimatedNavIcon.tsx";

interface NewTaskHomeProps {
	readonly busy: boolean;
	readonly commandRequest?: { readonly id: number; readonly open: boolean };
	readonly disabledSlashCommands?: ReadonlySet<ComposerSlashCommand>;
	readonly disabledSlashReasons?: Partial<Record<ComposerSlashCommand, string>>;
	readonly folder: string | null;
	readonly folderLocked: boolean;
	readonly mode: AgentMode;
	readonly modelControl?: ReactNode;
	readonly permissionControl?: ReactNode;
	readonly reducedMotion: boolean;
	readonly onChooseFolder: () => Promise<void>;
	readonly onManageMcp: () => void;
	readonly onManageSkills: () => void;
	readonly onPickFiles: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onResolveDroppedFiles?: (files: readonly File[]) => readonly DesktopAttachmentSelection[];
	readonly onSlashCommand?: (command: ComposerSlashCommand) => void | Promise<void>;
	readonly onSubmit: (input: ComposerSubmission) => Promise<void>;
	readonly skills: readonly SkillSummaryView[];
	readonly thinkingControl?: ReactNode;
}

function folderName(folder: string): string {
	return folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder;
}

export function NewTaskHome({
	busy,
	commandRequest,
	disabledSlashCommands,
	disabledSlashReasons,
	folder,
	folderLocked,
	mode,
	modelControl,
	permissionControl,
	reducedMotion,
	onChooseFolder,
	onManageMcp,
	onManageSkills,
	onPickFiles,
	onResolveDroppedFiles,
	onSlashCommand,
	onSubmit,
	skills,
	thinkingControl,
}: NewTaskHomeProps) {
	const { t } = useTranslation();
	return (
		<section className="new-task-home">
			<SideRays reducedMotion={reducedMotion} />
			<div className="new-task-home-content">
				<div className="new-task-home-heading">
					<h1>{t("What can I take off your plate?")}</h1>
					<p>{t("Ask a question, explore an idea, or get help with your work.")}</p>
				</div>
				<div className="new-task-home-composer">
					<Composer
						appearance="chat"
						commandRequest={commandRequest}
						disabled={busy}
						disabledSlashCommands={disabledSlashCommands}
						disabledSlashReasons={disabledSlashReasons}
						modelControl={modelControl}
						permissionControl={permissionControl}
						onInterrupt={async () => {}}
						onManageMcp={onManageMcp}
						onManageSkills={onManageSkills}
						onPickFiles={onPickFiles}
						onResolveDroppedFiles={onResolveDroppedFiles}
						onSlashCommand={onSlashCommand}
						onSubmit={onSubmit}
						placeholder={t("How can I help you today?")}
						running={false}
						skills={skills}
						submitDisabled={mode === "code" && folder === null}
						thinkingControl={thinkingControl}
					/>
					<button
						className="folder-picker"
						disabled={busy || folderLocked}
						onClick={() => void onChooseFolder()}
						title={folder ?? t(folderLocked ? "This task has no project folder" : "Choose a project or folder")}
						type="button"
					>
						<AnimatedNavIcon kind="folder" />
						<span>{folder ? folderName(folder) : t(folderLocked ? "No project folder" : "Work in a project or folder")}</span>
						<CaretDown aria-hidden="true" size={13} />
					</button>
				</div>
			</div>
		</section>
	);
}
