import type { SkillSummaryView } from "@arcmind/app-protocol";
import { CaretDown, FolderSimple, Sparkle } from "@phosphor-icons/react";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { Composer, type ComposerSubmission } from "./Composer.tsx";

interface ChatHomeProps {
	readonly busy: boolean;
	readonly folder: string | null;
	readonly folderLocked: boolean;
	readonly onChooseFolder: () => Promise<void>;
	readonly onManageSkills: () => void;
	readonly onPickFiles: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onSubmit: (input: ComposerSubmission) => Promise<void>;
	readonly skills: readonly SkillSummaryView[];
}

function folderName(folder: string): string {
	return folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder;
}

export function ChatHome({ busy, folder, folderLocked, onChooseFolder, onManageSkills, onPickFiles, onSubmit, skills }: ChatHomeProps) {
	return (
		<section className="chat-home">
			<div className="chat-home-content">
				<div className="chat-home-heading">
					<Sparkle aria-hidden="true" size={30} weight="fill" />
					<div>
						<h1>What can I take off your plate?</h1>
						<p>Ask a question, explore an idea, or get help with your work.</p>
					</div>
				</div>
				<div className="chat-home-composer">
					<Composer
						appearance="chat"
						disabled={busy}
						onInterrupt={async () => {}}
						onManageSkills={onManageSkills}
						onPickFiles={onPickFiles}
						onSubmit={onSubmit}
						placeholder="How can I help you today?"
						running={false}
						skills={skills}
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
