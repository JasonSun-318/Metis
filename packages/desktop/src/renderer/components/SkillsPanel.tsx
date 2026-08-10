import type { AgentMode, SkillSourceView, SkillSummaryView } from "@metis/app-protocol";
import {
	CaretRight,
	ChatCircleDots,
	Code,
	Desktop,
	FolderSimple,
	Folders,
	PuzzlePiece,
	UserCircle,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import emptyStateImage from "../assets/skills-empty-state.svg";
import type { AppStoreSnapshot } from "../store/app-store.ts";
import type { ProjectPreferenceMap } from "../store/project-preferences.ts";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { buildSessionTree } from "./SessionSidebar.tsx";
import { TracedSvgIcon } from "./TracedSvgIcon.tsx";

type CatalogRoute =
	| { readonly kind: "root" }
	| { readonly kind: "source"; readonly source: "system" | "user" }
	| { readonly kind: "project-modes" }
	| { readonly kind: "projects"; readonly mode: AgentMode }
	| { readonly kind: "project-skills"; readonly mode: AgentMode; readonly cwd: string };

type RequestState =
	| { readonly status: "idle" | "loading" }
	| { readonly status: "success"; readonly skills: readonly SkillSummaryView[] }
	| { readonly status: "error"; readonly message: string };

interface SkillsPanelProps {
	readonly api: Pick<MetisDesktopApi, "listSkills">;
	readonly preferences: ProjectPreferenceMap;
	readonly serverReady: boolean;
	readonly state: AppStoreSnapshot;
}

function DirectoryRow({ description, icon, name, onClick, title }: {
	readonly description: string;
	readonly icon: ReactNode;
	readonly name: string;
	readonly onClick: () => void;
	readonly title?: string;
}) {
	return (
		<button aria-label={name} className="skills-directory-row" onClick={onClick} title={title} type="button">
			<span className="skills-row-icon">{icon}</span>
			<span className="skills-row-copy">
				<strong>{name}</strong>
				<small>{description}</small>
			</span>
			<CaretRight aria-hidden="true" className="skills-row-caret" size={16} />
		</button>
	);
}

function LoadingRows() {
	const { t } = useTranslation();
	return (
		<div aria-label={t("Loading skills")} className="skills-loading" role="status">
			{[0, 1, 2].map((row) => (
				<div className="skills-loading-row" key={row}>
					<span />
					<div><i /><i /></div>
				</div>
			))}
		</div>
	);
}

function EmptyState({ cwd, source }: { readonly cwd?: string; readonly source: SkillSourceView }) {
	const { t } = useTranslation();
	const title = source === "system" ? "No system skills" : source === "user" ? "No user skills" : "No project skills";
	const hint = source === "user"
		? "~/.metis/agent/skills/ or ~/.agents/skills/"
		: source === "project" && cwd
			? `${cwd}/.metis/skills/`
			: undefined;
	return (
		<div className="skills-empty-state">
			<TracedSvgIcon src={emptyStateImage} />
			<h2>{t(title)}</h2>
			<p>{hint ? <>{t("Add a Skill under")} <code>{hint}</code>.</> : t("No Skills are available in this category.")}</p>
		</div>
	);
}

function modeLabel(mode: AgentMode): string {
	return mode === "chat" ? "Chat" : "Code";
}

export function SkillsPanel({ api, preferences, serverReady, state }: SkillsPanelProps) {
	const { t } = useTranslation();
	const [route, setRoute] = useState<CatalogRoute>({ kind: "root" });
	const [requestState, setRequestState] = useState<RequestState>({ status: "idle" });
	const [retry, setRetry] = useState(0);
	const requestGeneration = useRef(0);
	const activeSession = state.activeSessionId ? state.sessionsById.get(state.activeSessionId) : undefined;
	const projectTree = useMemo(
		() => route.kind === "projects" || route.kind === "project-skills"
			? buildSessionTree(state, route.mode, preferences)
			: null,
		[preferences, route, state],
	);
	const projects = projectTree?.projects ?? [];
	const selectedProject = route.kind === "project-skills"
		? projects.find((project) => project.cwd === route.cwd)
		: undefined;
	const projectExists = selectedProject !== undefined;

	const requestTarget = useMemo(() => {
		if (route.kind === "source") {
			return { input: { cwd: null } as const, source: route.source as SkillSourceView };
		}
		if (route.kind !== "project-skills" || !projectExists) return null;
		const input = activeSession?.mode === route.mode && activeSession.cwd === route.cwd
			? { sessionId: activeSession.sessionId }
			: { cwd: route.cwd };
		return { input, source: "project" as const };
	}, [activeSession?.cwd, activeSession?.mode, activeSession?.sessionId, projectExists, route]);

	useEffect(() => {
		if (route.kind === "project-skills" && !selectedProject) {
			setRoute({ kind: "projects", mode: route.mode });
		}
	}, [route, selectedProject]);

	useEffect(() => {
		const generation = ++requestGeneration.current;
		if (!requestTarget) {
			setRequestState({ status: "idle" });
			return;
		}
		if (!serverReady) {
			setRequestState({ status: "loading" });
			return;
		}
		setRequestState({ status: "loading" });
		void api.listSkills(requestTarget.input)
			.then((result) => {
				if (generation !== requestGeneration.current) return;
				setRequestState({
					status: "success",
					skills: result.skills
						.filter((skill) => skill.source === requestTarget.source)
						.sort((left, right) => left.name.localeCompare(right.name)),
				});
			})
			.catch((cause) => {
				if (generation !== requestGeneration.current) return;
				setRequestState({
					status: "error",
					message: cause instanceof Error ? cause.message : "",
				});
			});
		return () => {
			if (generation === requestGeneration.current) requestGeneration.current += 1;
		};
	}, [api, requestTarget, retry, serverReady]);

	const breadcrumbs: Array<{ label: string; route?: CatalogRoute }> = [{ label: t("Skills"), route: { kind: "root" } }];
	if (route.kind === "source") breadcrumbs.push({ label: t(route.source === "system" ? "System" : "User") });
	if (route.kind === "project-modes") breadcrumbs.push({ label: t("Project") });
	if (route.kind === "projects") {
		breadcrumbs.push({ label: t("Project"), route: { kind: "project-modes" } }, { label: t(modeLabel(route.mode)) });
	}
	if (route.kind === "project-skills") {
		breadcrumbs.push(
			{ label: t("Project"), route: { kind: "project-modes" } },
			{ label: t(modeLabel(route.mode)), route: { kind: "projects", mode: route.mode } },
			{ label: selectedProject?.name ?? route.cwd },
		);
	}

	let content: ReactNode;
	if (route.kind === "root") {
		content = (
			<div className="skills-directory-list">
				<DirectoryRow description={t("Skills included with Metis")} icon={<Desktop aria-hidden="true" size={22} />} name={t("System")} onClick={() => setRoute({ kind: "source", source: "system" })} />
				<DirectoryRow description={t("Skills available across all projects")} icon={<UserCircle aria-hidden="true" size={22} />} name={t("User")} onClick={() => setRoute({ kind: "source", source: "user" })} />
				<DirectoryRow description={t("Skills provided by project folders")} icon={<Folders aria-hidden="true" size={22} />} name={t("Project")} onClick={() => setRoute({ kind: "project-modes" })} />
			</div>
		);
	} else if (route.kind === "project-modes") {
		content = (
			<>
				<p className="skills-shared-note">{t("Project Skills are shared between Chat and Code when they use the same folder.")}</p>
				<div className="skills-directory-list">
					<DirectoryRow description={t("Projects used by Chat tasks")} icon={<ChatCircleDots aria-hidden="true" size={22} />} name={t("Chat")} onClick={() => setRoute({ kind: "projects", mode: "chat" })} />
					<DirectoryRow description={t("Projects used by Code tasks")} icon={<Code aria-hidden="true" size={22} />} name={t("Code")} onClick={() => setRoute({ kind: "projects", mode: "code" })} />
				</div>
			</>
		);
	} else if (route.kind === "projects") {
		content = projects.length === 0
			? <p className="skills-inline-empty">{t("No {{mode}} projects yet.", { mode: t(modeLabel(route.mode)) })}</p>
			: (
				<div className="skills-directory-list">
					{projects.map((project) => (
						<DirectoryRow
							description={project.cwd}
							icon={<FolderSimple aria-hidden="true" size={22} />}
							key={project.cwd}
							name={project.name}
							onClick={() => setRoute({ kind: "project-skills", mode: route.mode, cwd: project.cwd })}
							title={project.cwd}
						/>
					))}
				</div>
			);
	} else if (requestState.status === "error") {
		content = (
			<div className="skills-error-state" role="alert" title={requestState.message || t("The Skill catalog could not be read.")}>
				<h2>{t("Couldn’t load Skills")}</h2>
				<p>{t("The catalog could not be read.")}</p>
				<button onClick={() => setRetry((value) => value + 1)} type="button">{t("Retry")}</button>
			</div>
		);
	} else if (requestState.status !== "success") {
		content = <LoadingRows />;
	} else if (requestState.skills.length === 0) {
		content = <EmptyState cwd={route.kind === "project-skills" ? route.cwd : undefined} source={requestTarget?.source ?? "project"} />;
	} else {
		content = (
			<div className="skills-list" role="list">
				{requestState.skills.map((skill) => (
					<div className="skills-skill-row" key={`${skill.source}:${skill.name}`} role="listitem">
						<span className="skills-row-icon"><PuzzlePiece aria-hidden="true" size={21} /></span>
						<span className="skills-row-copy"><strong>{skill.name}</strong><small>{skill.description}</small></span>
					</div>
				))}
			</div>
		);
	}

	return (
		<section aria-labelledby="skills-catalog-title" className="skills-panel">
			<header className="skills-panel-header"><h1 id="skills-catalog-title">{t("Skills")}</h1></header>
			<div className="skills-panel-scroll">
				<div className="skills-panel-content">
					{route.kind !== "root" && (
						<nav aria-label={t("Skill catalog path")} className="skills-breadcrumbs">
							{breadcrumbs.map((crumb, index) => (
								<span key={`${crumb.label}:${index}`}>
									{index > 0 && <CaretRight aria-hidden="true" size={12} />}
									{crumb.route
										? <button onClick={() => setRoute(crumb.route!)} type="button">{crumb.label}</button>
										: <span aria-current="page">{crumb.label}</span>}
								</span>
							))}
						</nav>
					)}
					{content}
				</div>
			</div>
		</section>
	);
}
