import type { AgentMode, SkillSummaryView } from "@metis/app-protocol";
import { type ReactNode, type Ref, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import {
	BracketsCurly,
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
	Lightbulb,
	ListChecks,
	MagnifyingGlass,
	Notebook,
	PencilSimple,
	PresentationChart,
	Scales,
	TestTube,
	Tool,
	TreeStructure,
} from "../icons.tsx";
import { getHomeStarters, type HomeStarter, type HomeStarterId, pickHomeGreeting } from "../new-task-home-content.ts";
import { useProfileIdentity } from "../profile-identity.ts";
import type { ProjectSessionGroup } from "../session-groups.ts";
import { iconSize } from "../ui/icon-size.ts";
import { AnimatedNavIcon } from "./AnimatedNavIcon.tsx";
import { Composer, type ComposerPrefillRequest, type ComposerSubmission } from "./Composer.tsx";
import type { KnowledgeLinkMenuProps } from "./KnowledgeLinkMenu.tsx";
import { NewTaskRippleBackground } from "./NewTaskRippleBackground.tsx";
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
	brainstorm: Lightbulb,
	feature: Tool,
	debug: Bug,
	explain: TreeStructure,
	review: GitDiff,
	test: TestTube,
	performance: Gauge,
	refactor: BracketsCurly,
	docs: Notebook,
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
	const contentRef = useRef<HTMLDivElement>(null);
	const moreTriggerRef = useRef<HTMLButtonElement>(null);
	const moreDrawerRef = useRef<HTMLDivElement>(null);
	const [moreTasksOpen, setMoreTasksOpen] = useState(false);
	const additionalTasksId = useId();
	const starters = getHomeStarters(mode);
	const scrollBehavior = reducedMotion ? "auto" : "smooth";
	useLayoutEffect(() => {
		const content = contentRef.current;
		const drawer = moreDrawerRef.current;
		if (!content || !drawer) return;
		const updateHeight = () => content.style.setProperty("--new-task-drawer-height", `${drawer.offsetHeight}px`);
		updateHeight();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updateHeight);
		observer.observe(drawer);
		return () => observer.disconnect();
	}, []);

	const handleStarterClick = (prompt: string) => {
		setMoreTasksOpen(false);
		scrollRef.current?.querySelector<HTMLElement>("#composer-input")?.focus({ preventScroll: true });
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
			{!reducedMotion && <NewTaskRippleBackground />}
			<div className="new-task-home-scroll" ref={scrollRef}>
				<div className="new-task-home-content" data-more-open={moreTasksOpen} ref={contentRef}>
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
											<CaretDown aria-hidden="true" size={iconSize.md} />
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
							moreTriggerRef.current?.focus();
						}}
					>
						<div className="new-task-starter-grid">
							{starters.slice(0, 4).map((starter) => renderStarter(starter))}
							<button
								aria-controls={additionalTasksId}
								aria-expanded={moreTasksOpen}
								aria-label={t(moreTasksOpen ? "Fewer tasks" : "More tasks")}
								className="new-task-more-trigger"
								disabled={busy}
								onClick={() => setMoreTasksOpen((open) => !open)}
								ref={moreTriggerRef}
								type="button"
							>
								<span aria-hidden="true" className="new-task-more-label">
									<DotsThree size={iconSize.xl} />
									{t("More")}
								</span>
								<CaretDown aria-hidden="true" className="new-task-more-arrow" size={iconSize.lg} />
							</button>
						</div>
						<div className="new-task-more-drawer" id={additionalTasksId} inert={!moreTasksOpen}>
							<div className="new-task-more-drawer-clip">
								<div className="new-task-more-drawer-body" ref={moreDrawerRef}>
									<div className="new-task-more-drawer-items">
										{starters.slice(4).map((starter) => renderStarter(starter, true))}
									</div>
								</div>
							</div>
						</div>
					</section>
					{recentProjects.length > 0 && onSelectRecentProject && (
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
										<FolderSimple aria-hidden="true" size={iconSize.xl} />
										<strong>{project.name}</strong>
										<span>{project.cwd}</span>
										<CaretRight aria-hidden="true" size={iconSize.md} />
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
