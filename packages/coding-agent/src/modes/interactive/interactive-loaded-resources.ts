import { Spacer, Text } from "@metis/tui";
import type { ExtensionRunner } from "../../core/extensions/index.ts";
import type { PromptTemplate } from "../../core/prompt-templates.ts";
import type { ResourceDiagnostic, ResourceLoader } from "../../core/resource-loader.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { ResourceItem, ScopeGroup } from "./interactive-resource-display.ts";
import { type ThemeColor, theme } from "./theme/theme.ts";

export interface LoadedResourcesFormatters {
	formatDisplayPath(path: string): string;
	formatContextPath(path: string): string;
	formatExtensionDisplayPath(path: string): string;
	getShortPath(path: string, sourceInfo?: SourceInfo): string;
	getCompactPathLabel(path: string, sourceInfo?: SourceInfo): string;
	getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[];
	buildScopeGroups(items: ResourceItem[]): ScopeGroup[];
	formatScopeGroups(
		groups: ScopeGroup[],
		options: {
			formatPath: (item: ResourceItem) => string;
			formatPackagePath: (item: ResourceItem, source: string) => string;
		},
	): string;
	formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string;
}

export interface LoadedResourcesView {
	readonly container: { clear(): void; addChild(component: unknown): void };
	readonly options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	};
	readonly verbose: boolean;
	readonly quietStartup: boolean;
	readonly resourceLoader: ResourceLoader;
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;
	readonly extensionRunner: ExtensionRunner;
	readonly formatters: LoadedResourcesFormatters;
	getStartupExpansionState(): boolean;
	getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[];
	createExpandableSection(collapsed: () => string, expanded: () => string, startExpanded: boolean): unknown;
}

/** Builds the startup resource listing and diagnostics sections. */
export function renderLoadedResources(view: LoadedResourcesView): void {
	const options = view.options;
	// Resource rendering is idempotent; chat clears no longer clear this separate container.
	view.container.clear();

	const showListing = options?.force || view.verbose || !view.quietStartup;
	const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
	if (!showListing && !showDiagnostics) {
		return;
	}

	const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
	const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
		const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
		if (options?.sort !== false) {
			labels.sort((a, b) => a.localeCompare(b));
		}
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	const addLoadedSection = (
		name: string,
		collapsedBody: string,
		expandedBody = collapsedBody,
		color: ThemeColor = "mdHeading",
	): void => {
		view.container.addChild(
			view.createExpandableSection(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				view.getStartupExpansionState(),
			),
		);
		view.container.addChild(new Spacer(1));
	};

	const skillsResult = view.resourceLoader.getSkills();
	const promptsResult = view.resourceLoader.getPrompts();
	const themesResult = view.resourceLoader.getThemes();
	const extensions =
		options?.extensions ??
		view.resourceLoader.getExtensions().extensions.map((extension) => ({
			path: extension.path,
			sourceInfo: extension.sourceInfo,
		}));
	const sourceInfos = new Map<string, SourceInfo>();
	for (const extension of extensions) {
		if (extension.sourceInfo) {
			sourceInfos.set(extension.path, extension.sourceInfo);
		}
	}
	for (const skill of skillsResult.skills) {
		if (skill.sourceInfo) {
			sourceInfos.set(skill.filePath, skill.sourceInfo);
		}
	}
	for (const prompt of promptsResult.prompts) {
		if (prompt.sourceInfo) {
			sourceInfos.set(prompt.filePath, prompt.sourceInfo);
		}
	}
	for (const loadedTheme of themesResult.themes) {
		if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
			sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
		}
	}

	if (showListing) {
		const contextFiles = view.resourceLoader.getAgentsFiles().agentsFiles;
		if (contextFiles.length > 0) {
			view.container.addChild(new Spacer(1));
			const contextList = contextFiles
				.map((f) => theme.fg("dim", `  ${view.formatters.formatDisplayPath(f.path)}`))
				.join("\n");
			const contextCompactList = formatCompactList(
				contextFiles.map((contextFile) => view.formatters.formatContextPath(contextFile.path)),
				{ sort: false },
			);
			addLoadedSection("Context", contextCompactList, contextList);
		}

		const skills = skillsResult.skills;
		if (skills.length > 0) {
			const groups = view.formatters.buildScopeGroups(
				skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
			);
			const skillList = view.formatters.formatScopeGroups(groups, {
				formatPath: (item) => view.formatters.formatDisplayPath(item.path),
				formatPackagePath: (item) => view.formatters.getShortPath(item.path, item.sourceInfo),
			});
			const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
			addLoadedSection("Skills", skillCompactList, skillList);
		}

		const templates = view.promptTemplates;
		if (templates.length > 0) {
			const groups = view.formatters.buildScopeGroups(
				templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
			);
			const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
			const templateList = view.formatters.formatScopeGroups(groups, {
				formatPath: (item) => {
					const template = templateByPath.get(item.path);
					return template ? `/${template.name}` : view.formatters.formatDisplayPath(item.path);
				},
				formatPackagePath: (item) => {
					const template = templateByPath.get(item.path);
					return template ? `/${template.name}` : view.formatters.formatDisplayPath(item.path);
				},
			});
			const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
			addLoadedSection("Prompts", promptCompactList, templateList);
		}

		if (extensions.length > 0) {
			const groups = view.formatters.buildScopeGroups(extensions);
			const extList = view.formatters.formatScopeGroups(groups, {
				formatPath: (item) => view.formatters.formatExtensionDisplayPath(item.path),
				formatPackagePath: (item) =>
					view.formatters.formatExtensionDisplayPath(view.formatters.getShortPath(item.path, item.sourceInfo)),
			});
			const extensionCompactList = formatCompactList(view.formatters.getCompactExtensionLabels(extensions));
			addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
		}

		// Show loaded themes (excluding built-in)
		const loadedThemes = themesResult.themes;
		const customThemes = loadedThemes.filter((t) => t.sourcePath);
		if (customThemes.length > 0) {
			const groups = view.formatters.buildScopeGroups(
				customThemes.map((loadedTheme) => ({
					path: loadedTheme.sourcePath!,
					sourceInfo: loadedTheme.sourceInfo,
				})),
			);
			const themeList = view.formatters.formatScopeGroups(groups, {
				formatPath: (item) => view.formatters.formatDisplayPath(item.path),
				formatPackagePath: (item) => view.formatters.getShortPath(item.path, item.sourceInfo),
			});
			const themeCompactList = formatCompactList(
				customThemes.map(
					(loadedTheme) =>
						loadedTheme.name ??
						view.formatters.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
				),
			);
			addLoadedSection("Themes", themeCompactList, themeList);
		}
	}

	if (showDiagnostics) {
		const skillDiagnostics = skillsResult.diagnostics;
		if (skillDiagnostics.length > 0) {
			const warningLines = view.formatters.formatDiagnostics(skillDiagnostics, sourceInfos);
			view.container.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
			view.container.addChild(new Spacer(1));
		}

		const promptDiagnostics = promptsResult.diagnostics;
		if (promptDiagnostics.length > 0) {
			const warningLines = view.formatters.formatDiagnostics(promptDiagnostics, sourceInfos);
			view.container.addChild(new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0));
			view.container.addChild(new Spacer(1));
		}

		const extensionDiagnostics: ResourceDiagnostic[] = [];
		const extensionErrors = view.resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) {
			for (const error of extensionErrors) {
				extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
			}
		}

		const commandDiagnostics = view.extensionRunner.getCommandDiagnostics();
		extensionDiagnostics.push(...commandDiagnostics);
		extensionDiagnostics.push(...view.getBuiltInCommandConflictDiagnostics(view.extensionRunner));

		const shortcutDiagnostics = view.extensionRunner.getShortcutDiagnostics();
		extensionDiagnostics.push(...shortcutDiagnostics);

		if (extensionDiagnostics.length > 0) {
			const warningLines = view.formatters.formatDiagnostics(extensionDiagnostics, sourceInfos);
			view.container.addChild(new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0));
			view.container.addChild(new Spacer(1));
		}

		const themeDiagnostics = themesResult.diagnostics;
		if (themeDiagnostics.length > 0) {
			const warningLines = view.formatters.formatDiagnostics(themeDiagnostics, sourceInfos);
			view.container.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
			view.container.addChild(new Spacer(1));
		}
	}
}
