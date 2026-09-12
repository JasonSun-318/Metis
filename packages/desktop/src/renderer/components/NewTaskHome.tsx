import type { AgentMode, SkillSummaryView } from "@metis/app-protocol";
import {
	CalendarBlank,
	CaretDown,
	CaretDoubleUp,
	ChartBar,
	Bug,
	FileText,
	Files,
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
import { DEFAULT_PROFILE_IDENTITY, useProfileIdentity } from "../profile-identity.ts";
import { getHomeStarters, pickHomeGreeting, type HomeStarterId } from "../new-task-home-content.ts";
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
	feature: Wrench,
	debug: Bug,
	explain: TreeStructure,
	review: GitDiff,
	test: TestTube,
	performance: Gauge,
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
	readonly projectControl?: ReactNode;
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
	projectControl,
	skills,
	thinkingControl,
}: NewTaskHomeProps) {
	const { t } = useTranslation();
	const { displayName } = useProfileIdentity();
	const [greeting] = useState(() => pickHomeGreeting(new Date(), previousGreetingId, undefined, mode));
	useEffect(() => {
		previousGreetingId = greeting.id;
	}, [greeting.id]);
	const name = displayName.trim() === DEFAULT_PROFILE_IDENTITY.displayName ? "" : displayName.trim();
	const headingKey = name ? greeting.key : greeting.anonymousKey ?? greeting.key;
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

	return (
			<section className="new-task-home" data-mode={mode}>
			<SideRays reducedMotion={reducedMotion} />
				<div className="new-task-home-scroll" ref={scrollRef}>
					<div className="new-task-home-content" ref={contentRef}>
						<div className="new-task-home-hero">
							<div className="new-task-home-hero-main" ref={heroRef}>
							<div className="new-task-home-heading">
								<h1 title={t(headingKey, { name })}>{t(headingKey, { name })}</h1>
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
											{!folder && !folderLocked && <span className="folder-picker-hint">{t("Optional")}</span>}
											<CaretDown aria-hidden="true" size={13} />
										</button>
									)}
								</div>
							</div>
						</div>
						<button className="new-task-home-discovery" onClick={handleDiscoverClick} ref={discoveryRef} type="button">
							<Lightbulb aria-hidden="true" size={17} />
							<span className="new-task-home-discovery-label">{t("Explore tasks")}</span>
							<span>{t("Scroll to explore")}</span>
							<CaretDoubleUp aria-hidden="true" size={14} />
						</button>
					</div>
					<section className="new-task-starters" aria-label={t("Start here")} ref={starterRef}>
						<div className="new-task-starters-label">{t("Start here")}</div>
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
