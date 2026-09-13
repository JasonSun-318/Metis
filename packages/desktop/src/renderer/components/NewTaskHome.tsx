import type { AgentMode, SkillSummaryView } from "@metis/app-protocol";
import {
	CalendarBlank,
	CaretDown,
	CaretDoubleUp,
	CaretRight,
	ChartBar,
	Bug,
	FileText,
	Files,
	FolderSimple,
	Gauge,
	GitDiff,
	ListChecks,
	Lightbulb,
	MagnifyingGlass,
	PencilSimple,
	PresentationChart,
	Scales,
	TestTube,
	TreeStructure,
	Wrench,
} from "@phosphor-icons/react";
import { type ReactNode, type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { useProfileIdentity } from "../profile-identity.ts";
import { getHomeStarters, pickHomeGreeting, type HomeStarterId } from "../new-task-home-content.ts";
import { Composer, type ComposerPrefillRequest, type ComposerSubmission } from "./Composer.tsx";
import type { ProjectSessionGroup } from "./SessionSidebar.tsx";
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
	feature: Wrench,
	debug: Bug,
	explain: TreeStructure,
	review: GitDiff,
	test: TestTube,
	performance: Gauge,
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

export function recentProjectsFromGroups(
	projects: readonly ProjectSessionGroup[],
): readonly NewTaskRecentProject[] {
	const candidates = projects
		.map((project) => ({
			cwd: project.cwd,
			name: project.name,
			updatedAt: project.sessions.reduce(
				(latest, session) => session.updatedAt > latest ? session.updatedAt : latest,
				"",
			),
		}))
		.sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt)
			|| left.name.localeCompare(right.name)
			|| left.cwd.localeCompare(right.cwd));
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
	onSelectRecentProject,
	onSlashCommand,
	onSubmit,
	projectControl,
	recentProjects = [],
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
	const heroRef = useRef<HTMLDivElement>(null);
	const discoveryRef = useRef<HTMLButtonElement>(null);
	const starterRef = useRef<HTMLElement>(null);
	const starters = getHomeStarters(mode);
	const scrollBehavior = reducedMotion ? "auto" : "smooth";

	useLayoutEffect(() => {
		const scroll = scrollRef.current;
		const content = contentRef.current;
		const hero = heroRef.current;
		const discovery = discoveryRef.current;
		const starters = starterRef.current;
		if (!scroll || !content || !hero || !discovery || !starters) return;
		let coverOffset = Number.POSITIVE_INFINITY;
		let revealOffset = Number.POSITIVE_INFINITY;
		const updateBackdrop = () => {
			const covered = String(scroll.scrollTop > coverOffset);
			if (hero.dataset.covered !== covered) hero.dataset.covered = covered;
			const hidden = scroll.scrollTop > revealOffset;
			if (discovery.inert !== hidden) {
				discovery.inert = hidden;
				discovery.dataset.hidden = String(hidden);
			}
		};
		const measure = () => {
			const height = Math.ceil(hero.getBoundingClientRect().height);
			const startersHeight = Math.ceil(starters.getBoundingClientRect().height);
			if (height > 0) content.style.setProperty("--home-hero-height", `${height}px`);
			if (startersHeight > 0) content.style.setProperty("--home-starters-height", `${startersHeight}px`);
			const stickyTop = Number.parseFloat(getComputedStyle(hero).top);
			revealOffset = Math.max(0, Number.parseFloat(getComputedStyle(content).paddingTop) - stickyTop);
			coverOffset = starters.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - stickyTop - height - 16;
			updateBackdrop();
		};
		// Measure wrapping, editor growth and window resizing; CSS owns the scroll motion.
		const observer = new ResizeObserver(measure);
		observer.observe(hero);
		observer.observe(starters);
		observer.observe(scroll);
		scroll.addEventListener("scroll", updateBackdrop, { passive: true });
		measure();
		return () => {
			observer.disconnect();
			scroll.removeEventListener("scroll", updateBackdrop);
		};
	}, []);

	const handleStarterClick = (prompt: string) => {
		setPrefillRequest({ id: ++prefillSequence.current, text: t(prompt) });
		scrollRef.current?.scrollTo({ behavior: scrollBehavior, top: 0 });
	};

	const handleDiscoverClick = () => {
		starterRef.current?.scrollIntoView({ behavior: scrollBehavior, block: "start" });
	};

	const handleRecentProjectClick = (cwd: string) => {
		onSelectRecentProject?.(cwd);
		scrollRef.current?.querySelector<HTMLElement>("#composer-input")?.focus();
	};

	return (
		<section className="new-task-home" data-mode={mode}>
			<SideRays reducedMotion={reducedMotion} />
			<div className="new-task-home-scroll" ref={scrollRef}>
				<div className="new-task-home-content" ref={contentRef}>
					<div className="new-task-home-hero">
						<div className="new-task-home-hero-main" ref={heroRef}>
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
									skills={skills}
									submitDisabled={mode === "code" && folder === null}
									thinkingControl={thinkingControl}
								/>
								<div className="new-task-home-project-control">
									{projectControl ?? (
										<button
											className="folder-picker"
											disabled={busy || folderLocked}
											onClick={() => void onChooseFolder()}
											title={folder ?? t(folderLocked ? "This task has no project folder" : "Choose a project or folder")}
											type="button"
										>
											<AnimatedNavIcon kind="folder" />
											<span>{folder ? folderName(folder) : t(folderLocked ? "No project folder" : "Choose a workspace folder")}</span>
											<CaretDown aria-hidden="true" size={13} />
										</button>
									)}
								</div>
							</div>
						</div>
					</div>
					<button className="new-task-home-discovery" onClick={handleDiscoverClick} ref={discoveryRef} type="button">
						<Lightbulb aria-hidden="true" size={17} />
						<span className="new-task-home-discovery-label">{t("Explore tasks")}</span>
						<span>{t("Scroll to explore")}</span>
						<CaretDoubleUp aria-hidden="true" size={14} />
					</button>
					<section className="new-task-starters" aria-label={t("Explore tasks")} ref={starterRef}>
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
						<div className="new-task-starter-grid">
							{starters.map((starter) => {
								const Icon = starterIcons[starter.id];
								return (
									<button
										className="new-task-starter"
										data-starter-id={starter.id}
										key={starter.id}
										type="button"
										disabled={busy}
										onClick={() => handleStarterClick(starter.prompt)}
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
