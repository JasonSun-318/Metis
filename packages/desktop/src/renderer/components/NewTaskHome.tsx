import type { AgentMode, SkillSummaryView } from "@metis/app-protocol";
import {
	CalendarBlank,
	CaretDown,
	ChartBar,
	FileText,
	Files,
	ListChecks,
	MagnifyingGlass,
	PencilSimple,
	PresentationChart,
	Scales,
} from "@phosphor-icons/react";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { DEFAULT_PROFILE_IDENTITY, useProfileIdentity } from "../profile-identity.ts";
import { HOME_STARTERS, pickHomeGreeting, type HomeStarterId } from "../new-task-home-content.ts";
import { Composer, type ComposerPrefillRequest, type ComposerSubmission } from "./Composer.tsx";
import { SideRays } from "./SideRays.tsx";
import type { ComposerSlashCommand } from "./SlashCommandMenu.tsx";
import { AnimatedNavIcon } from "./AnimatedNavIcon.tsx";

const starterIcons: Record<HomeStarterId, typeof FileText> = {
	report: FileText,
	slides: PresentationChart,
	spreadsheet: ChartBar,
	research: MagnifyingGlass,
	document: Files,
	plan: CalendarBlank,
	writing: PencilSimple,
	compare: Scales,
	meeting: ListChecks,
};

let previousGreetingId: string | undefined;

interface NewTaskHomeProps {
	readonly busy: boolean;
	readonly commandRequest?: { readonly id: number; readonly open: boolean };
	readonly composerFormRef?: Ref<HTMLFormElement>;
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
	composerFormRef,
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
	const { displayName } = useProfileIdentity();
	const [greeting] = useState(() => pickHomeGreeting(new Date(), previousGreetingId));
	useEffect(() => {
		previousGreetingId = greeting.id;
	}, [greeting.id]);
	const name = displayName.trim() === DEFAULT_PROFILE_IDENTITY.displayName ? "" : displayName.trim();
	const headingKey = name ? greeting.key : greeting.anonymousKey ?? greeting.key;
	const [prefillRequest, setPrefillRequest] = useState<ComposerPrefillRequest>();
	const prefillSequence = useRef(0);
	return (
		<section className="new-task-home">
			<SideRays reducedMotion={reducedMotion} />
			<div className="new-task-home-scroll">
				<div className="new-task-home-content">
					<div className="new-task-home-heading">
						<h1>{t(headingKey, { name })}</h1>
					</div>
					<div className="new-task-home-composer">
						<Composer
							appearance="chat"
							commandRequest={commandRequest}
							disabled={busy}
							disabledSlashCommands={disabledSlashCommands}
							disabledSlashReasons={disabledSlashReasons}
							formRef={composerFormRef}
							modelControl={modelControl}
							permissionControl={permissionControl}
							onInterrupt={async () => {}}
							onManageMcp={onManageMcp}
							onManageSkills={onManageSkills}
							onPickFiles={onPickFiles}
							onResolveDroppedFiles={onResolveDroppedFiles}
							onSlashCommand={onSlashCommand}
							onSubmit={onSubmit}
							placeholder={t("Describe your task, or drop in files…")}
							prefillRequest={prefillRequest}
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
							<span>{folder ? folderName(folder) : t(folderLocked ? "No project folder" : "Choose a workspace folder")}</span>
							{!folder && !folderLocked && <span className="folder-picker-hint">{t("Optional")}</span>}
							<CaretDown aria-hidden="true" size={13} />
						</button>
					</div>
					<section className="new-task-starters" aria-label={t("Start here")}>
						<div className="new-task-starters-label">{t("Start here")}</div>
						<div className="new-task-starter-grid">
							{HOME_STARTERS.map((starter) => {
								const Icon = starterIcons[starter.id];
								return (
									<button
										className="new-task-starter"
										data-starter-id={starter.id}
										key={starter.id}
										type="button"
										disabled={busy}
										onClick={() => setPrefillRequest({ id: ++prefillSequence.current, text: t(starter.prompt) })}
									>
										<Icon aria-hidden="true" size={22} />
										<span className="new-task-starter-copy">
											<strong>{t(starter.title)}</strong>
											<span>{t(starter.description)}</span>
										</span>
									</button>
								);
							})}
						</div>
					</section>
				</div>
			</div>
		</section>
	);
}
