import type { AgentMode, SkillSummaryView } from "@metis/app-protocol";
import {
	Bug,
	CalendarBlank,
	CaretDown,
	CaretRight,
	ChartBar,
	DotsThree,
	Files,
	FileText,
	FolderSimple,
	Gauge,
	GitDiff,
	ListChecks,
	MagnifyingGlass,
	PencilSimple,
	PresentationChart,
	Scales,
	TestTube,
	TreeStructure,
	Wrench,
} from "@phosphor-icons/react";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { getHomeStarters, type HomeStarter, type HomeStarterId, pickHomeGreeting } from "../new-task-home-content.ts";
import { useProfileIdentity } from "../profile-identity.ts";
import { AnimatedNavIcon } from "./AnimatedNavIcon.tsx";
import { Composer, type ComposerPrefillRequest, type ComposerSubmission } from "./Composer.tsx";
import type { KnowledgeLinkMenuProps } from "./KnowledgeLinkMenu.tsx";
import type { ProjectSessionGroup } from "./SessionSidebar.tsx";
import type { ComposerSlashCommand } from "./SlashCommandMenu.tsx";

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
	feature: Wrench,
	debug: Bug,
	explain: TreeStructure,
	review: GitDiff,
	test: TestTube,
	performance: Gauge,
};

const shortcutLabels: Partial<Record<HomeStarterId, string>> = {
	report: "Report",
	slides: "Slides",
	spreadsheet: "Analyze",
	research: "Research",
	feature: "Build",
	debug: "Debug",
	explain: "Explore",
	review: "Review",
};

let previousGreetingId: string | undefined;

export interface NewTaskRecentProject {
	readonly cwd: string;
	readonly name: string;
	readonly updatedAt: string;
}

function normalizedProjectKey(cwd: string): string {
	const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized || "/";
}

export function recentProjectsFromGroups(projects: readonly ProjectSessionGroup[]): readonly NewTaskRecentProject[] {
	const candidates = projects
		.map((project) => ({
			cwd: project.cwd,
			name: project.name,
			updatedAt: project.sessions.reduce(
				(latest, session) => (session.updatedAt > latest ? session.updatedAt : latest),
				"",
			),
		}))
		.sort(
			(left, right) =>
				right.updatedAt.localeCompare(left.updatedAt) ||
				left.name.localeCompare(right.name) ||
				left.cwd.localeCompare(right.cwd),
		);
	const seen = new Set<string>();
	const recent: NewTaskRecentProject[] = [];
	for (const project of candidates) {
		const key = normalizedProjectKey(project.cwd);
		if (seen.has(key)) continue;
		seen.add(key);
		recent.push(project);
		if (recent.length === 3) break;
	}
	return recent;
}

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
	readonly knowledge?: KnowledgeLinkMenuProps;
	readonly permissionControl?: ReactNode;
	readonly reducedMotion: boolean;
	readonly onChooseFolder: () => Promise<void>;
	readonly onManageMcp: () => void;
	readonly onManageSkills: () => void;
	readonly onPickFiles: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onResolveDroppedFiles?: (files: readonly File[]) => readonly DesktopAttachmentSelection[];
	readonly onSelectRecentProject?: (cwd: string) => void;
	readonly onSlashCommand?: (command: ComposerSlashCommand) => void | Promise<void>;
	readonly onSubmit: (input: ComposerSubmission) => Promise<void>;
	readonly projectControl?: ReactNode;
	readonly recentProjects?: readonly NewTaskRecentProject[];
	readonly selectionSessionId?: string | null;
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
	knowledge,
	permissionControl,
	reducedMotion,
	onChooseFolder,
	onManageMcp,
	onManageSkills,
	onPickFiles,
	onResolveDroppedFiles,
	onSelectRecentProject,
	onSlashCommand,
	onSubmit,
	projectControl,
	recentProjects = [],
	selectionSessionId,
	skills,
	thinkingControl,
}: NewTaskHomeProps) {
	const { t } = useTranslation();
	const { displayName } = useProfileIdentity();
	const [greeting] = useState(() => pickHomeGreeting(new Date(), previousGreetingId, undefined, mode));
	useEffect(() => {
		previousGreetingId = greeting.id;
	}, [greeting.id]);
	const name = displayName.trim();
	const [prefillRequest, setPrefillRequest] = useState<ComposerPrefillRequest>();
	const prefillSequence = useRef(0);
	const scrollRef = useRef<HTMLDivElement>(null);
	const moreRef = useRef<HTMLButtonElement>(null);
	const [moreTasksOpen, setMoreTasksOpen] = useState(false);
	const additionalTasksId = useId();
	const starters = getHomeStarters(mode);
	const scrollBehavior = reducedMotion ? "auto" : "smooth";

	const handleStarterClick = (prompt: string) => {
		setMoreTasksOpen(false);
		setPrefillRequest({ id: ++prefillSequence.current, text: t(prompt) });
		scrollRef.current?.scrollTo({ behavior: scrollBehavior, top: 0 });
	};

	const handleRecentProjectClick = (cwd: string) => {
		onSelectRecentProject?.(cwd);
		scrollRef.current?.querySelector<HTMLElement>("#composer-input")?.focus();
	};

	const renderStarter = (starter: HomeStarter, additional = false) => {
		const Icon = starterIcons[starter.id];
		const title = t(starter.title);
		const label = additional ? title : t(shortcutLabels[starter.id] ?? starter.title);
		return (
			<button
				aria-label={label === title ? title : `${label}: ${title}`}
				className={`new-task-starter${additional ? " new-task-starter-extra" : ""}`}
				data-starter-id={starter.id}
				disabled={busy}
				key={starter.id}
				onClick={() => handleStarterClick(starter.prompt)}
				title={t(starter.description)}
				type="button"
			>
				<Icon aria-hidden="true" size={additional ? 18 : 15} />
				<span className="new-task-starter-copy">
					<strong>{label}</strong>
					{additional && <span>{t(starter.description)}</span>}
				</span>
			</button>
		);
	};

	return (
		<section className="new-task-home" data-mode={mode}>
			<div className="new-task-home-scroll" ref={scrollRef}>
				<div className="new-task-home-content">
					<div className="new-task-home-hero">
						<div className="new-task-home-hero-main">
							<div className="new-task-home-heading">
								<h1 title={t(greeting.key, { name })}>{t(greeting.key, { name })}</h1>
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
									selectionSessionId={selectionSessionId}
									skills={skills}
									knowledge={knowledge}
									submitDisabled={mode === "code" && folder === null}
									thinkingControl={thinkingControl}
								/>
								<fieldset aria-label={t("Workspace")} className="control-group new-task-home-project-control">
									{projectControl ?? (
										<button
											className="folder-picker"
											disabled={busy || folderLocked}
											onClick={() => void onChooseFolder()}
											title={
												folder ??
												t(folderLocked ? "This task has no project folder" : "Choose a project or folder")
											}
											type="button"
										>
											<AnimatedNavIcon kind="folder" />
											<span>
												{folder
													? folderName(folder)
													: t(folderLocked ? "No project folder" : "Choose a workspace folder")}
											</span>
											<CaretDown aria-hidden="true" size={13} />
										</button>
									)}
								</fieldset>
							</div>
						</div>
					</div>
					<section
						aria-label={t("Explore tasks")}
						className="new-task-starters"
						onKeyDown={(event) => {
							if (event.key !== "Escape" || !moreTasksOpen) return;
							event.preventDefault();
							setMoreTasksOpen(false);
							moreRef.current?.focus();
						}}
					>
						<div className="new-task-starter-grid">
							{starters.slice(0, 4).map((starter) => renderStarter(starter))}
							<button
								aria-controls={moreTasksOpen ? additionalTasksId : undefined}
								aria-expanded={moreTasksOpen}
								aria-label={t(moreTasksOpen ? "Fewer tasks" : "More tasks")}
								className="new-task-more-trigger"
								disabled={busy}
								onClick={() => setMoreTasksOpen((open) => !open)}
								ref={moreRef}
								type="button"
							>
								<DotsThree aria-hidden="true" size={17} />
								<span>{t(moreTasksOpen ? "Less" : "More")}</span>
							</button>
						</div>
						{moreTasksOpen && (
							<div className="new-task-additional-grid" id={additionalTasksId}>
								{starters.slice(4).map((starter) => renderStarter(starter, true))}
							</div>
						)}
					</section>
					{mode === "code" && recentProjects.length > 0 && onSelectRecentProject && (
						<section className="new-task-recent-projects" aria-labelledby="new-task-recent-projects-title">
							<h2 id="new-task-recent-projects-title">{t("Recent projects")}</h2>
							<div className="new-task-recent-project-list">
								{recentProjects.map((project) => (
									<button
										aria-pressed={folder === project.cwd}
										className="new-task-recent-project"
										data-selected={folder === project.cwd ? "true" : undefined}
										disabled={busy || folderLocked}
										key={project.cwd}
										onClick={() => handleRecentProjectClick(project.cwd)}
										title={project.cwd}
										type="button"
									>
										<FolderSimple aria-hidden="true" size={17} />
										<strong>{project.name}</strong>
										<span>{project.cwd}</span>
										<CaretRight aria-hidden="true" size={14} />
									</button>
								))}
							</div>
						</section>
					)}
				</div>
			</div>
		</section>
	);
}
