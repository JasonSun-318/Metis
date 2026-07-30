import type { AgentMode, SkillSummaryView } from "@arcmind/app-protocol";
import { CaretDown, FolderSimple } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { Composer, type ComposerSubmission } from "./Composer.tsx";

interface NewTaskHomeProps {
	readonly busy: boolean;
	readonly folder: string | null;
	readonly folderLocked: boolean;
	readonly mode: AgentMode;
	readonly modelControl?: ReactNode;
	readonly permissionControl?: ReactNode;
	readonly onChooseFolder: () => Promise<void>;
	readonly onManageSkills: () => void;
	readonly onPickFiles: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onSubmit: (input: ComposerSubmission) => Promise<void>;
	readonly skills: readonly SkillSummaryView[];
	readonly thinkingControl?: ReactNode;
}

function folderName(folder: string): string {
	return folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder;
}

export function NewTaskHome({
	busy,
	folder,
	folderLocked,
	mode,
	modelControl,
	permissionControl,
	onChooseFolder,
	onManageSkills,
	onPickFiles,
	onSubmit,
	skills,
	thinkingControl,
}: NewTaskHomeProps) {
	return (
		<section className="new-task-home">
			<div className="new-task-home-content">
				<div className="new-task-home-heading">
					<h1>What can I take off your plate?</h1>
					<p>Ask a question, explore an idea, or get help with your work.</p>
				</div>
				<div className="new-task-home-composer">
					<Composer
						appearance="chat"
						disabled={busy}
						modelControl={modelControl}
						permissionControl={permissionControl}
						onInterrupt={async () => {}}
						onManageSkills={onManageSkills}
						onPickFiles={onPickFiles}
						onSubmit={onSubmit}
						placeholder="How can I help you today?"
						running={false}
						skills={skills}
						submitDisabled={mode === "code" && folder === null}
						thinkingControl={thinkingControl}
					/>
					<button
						className="folder-picker"
						disabled={busy || folderLocked}
						onClick={() => void onChooseFolder()}
						title={folder ?? (folderLocked ? "This task has no project folder" : "Choose a project or folder")}
						type="button"
					>
						<FolderSimple aria-hidden="true" size={17} />
						<span>{folder ? folderName(folder) : folderLocked ? "No project folder" : "Work in a project or folder"}</span>
						<CaretDown aria-hidden="true" size={13} />
					</button>
				</div>
			</div>
		</section>
	);
}
