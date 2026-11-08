import { dirname, join, resolve } from "path";
import type { PathMetadata } from "../package-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { collectFilesFromPaths } from "./resource-collection.ts";
import {
	collectAncestorAgentsSkillDirs,
	collectAutoExtensionEntries,
	collectAutoPromptEntries,
	collectAutoSkillEntries,
	collectAutoThemeEntries,
	type ResourceType,
} from "./resource-discovery.ts";
import { applyPatterns, isEnabledByOverrides, splitPatterns } from "./resource-patterns.ts";
import { addResource, getTargetMap, type ResourceAccumulator } from "./resource-results.ts";

/** Explicit contract for local-entry and auto-discovery resolution. */
export interface AutoDiscoveryContract {
	/** Settings snapshots are read by the caller once per resolve pass. */
	readonly globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>;
	readonly projectSettings: ReturnType<SettingsManager["getProjectSettings"]>;
	/** Project trust is decided by the caller; discovery never re-reads it. */
	readonly projectTrusted: boolean;
	/** Home and cwd are captured by the caller at the same time as base dirs. */
	readonly cwd: string;
	readonly homeDir: string;
	readonly globalBaseDir: string;
	readonly projectBaseDir: string;
	readonly accumulator: ResourceAccumulator;
}

export function resolveLocalEntries(input: {
	readonly entries: string[];
	readonly resourceType: ResourceType;
	readonly target: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	readonly metadata: PathMetadata;
	readonly baseDir: string;
	resolvePathFromBase(input: string, baseDir: string): string;
}): void {
	const { entries, resourceType, target, metadata, baseDir } = input;
	if (entries.length === 0) return;

	// Collect all files from plain entries (non-pattern entries)
	const { plain, patterns } = splitPatterns(entries);
	const resolvedPlain = plain.map((p) => input.resolvePathFromBase(p, baseDir));
	const allFiles = collectFilesFromPaths(resolvedPlain, resourceType);

	// Determine which files are enabled based on patterns
	const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

	// Add all files with their enabled state
	for (const f of allFiles) {
		addResource(target, f, metadata, enabledPaths.has(f));
	}
}

export function addAutoDiscoveredResources(input: {
	readonly accumulator: ResourceAccumulator;
	readonly globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>;
	readonly projectSettings: ReturnType<SettingsManager["getProjectSettings"]>;
	readonly globalBaseDir: string;
	readonly projectBaseDir: string;
	readonly cwd: string;
	readonly homeDir: string;
	readonly projectTrusted: boolean;
}): void {
	const { accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir } = input;
	const userMetadata: PathMetadata = {
		source: "auto",
		scope: "user",
		origin: "top-level",
		baseDir: globalBaseDir,
	};
	const projectMetadata: PathMetadata = {
		source: "auto",
		scope: "project",
		origin: "top-level",
		baseDir: projectBaseDir,
	};

	const userOverrides = {
		extensions: (globalSettings.extensions ?? []) as string[],
		skills: (globalSettings.skills ?? []) as string[],
		prompts: (globalSettings.prompts ?? []) as string[],
		themes: (globalSettings.themes ?? []) as string[],
	};
	const projectOverrides = {
		extensions: (projectSettings.extensions ?? []) as string[],
		skills: (projectSettings.skills ?? []) as string[],
		prompts: (projectSettings.prompts ?? []) as string[],
		themes: (projectSettings.themes ?? []) as string[],
	};

	const userDirs = {
		extensions: join(globalBaseDir, "extensions"),
		skills: join(globalBaseDir, "skills"),
		prompts: join(globalBaseDir, "prompts"),
		themes: join(globalBaseDir, "themes"),
	};
	const projectDirs = {
		extensions: join(projectBaseDir, "extensions"),
		skills: join(projectBaseDir, "skills"),
		prompts: join(projectBaseDir, "prompts"),
		themes: join(projectBaseDir, "themes"),
	};
	const userAgentsSkillsDir = join(input.homeDir, ".agents", "skills");
	const projectTrusted = input.projectTrusted;
	const projectAgentsSkillDirs = projectTrusted
		? collectAncestorAgentsSkillDirs(input.cwd).filter((dir) => resolve(dir) !== resolve(userAgentsSkillsDir))
		: [];

	const addResources = (
		resourceType: ResourceType,
		paths: string[],
		metadata: PathMetadata,
		overrides: string[],
		baseDir: string,
	) => {
		const target = getTargetMap(accumulator, resourceType);
		for (const path of paths) {
			const enabled = isEnabledByOverrides(path, overrides, baseDir);
			addResource(target, path, metadata, enabled);
		}
	};

	if (projectTrusted) {
		// Project extensions from .metis/
		addResources(
			"extensions",
			collectAutoExtensionEntries(projectDirs.extensions),
			projectMetadata,
			projectOverrides.extensions,
			projectBaseDir,
		);

		// Project skills from .metis/
		addResources(
			"skills",
			collectAutoSkillEntries(projectDirs.skills, "metis"),
			projectMetadata,
			projectOverrides.skills,
			projectBaseDir,
		);
	}

	// Project skills from .agents/ (each with its own baseDir)
	for (const agentsSkillsDir of projectAgentsSkillDirs) {
		const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
		const agentsMetadata: PathMetadata = {
			...projectMetadata,
			baseDir: agentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(agentsSkillsDir, "agents"),
			agentsMetadata,
			projectOverrides.skills,
			agentsBaseDir,
		);
	}

	if (projectTrusted) {
		addResources(
			"prompts",
			collectAutoPromptEntries(projectDirs.prompts),
			projectMetadata,
			projectOverrides.prompts,
			projectBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(projectDirs.themes),
			projectMetadata,
			projectOverrides.themes,
			projectBaseDir,
		);
	}

	// User extensions from ~/.metis/agent/
	addResources(
		"extensions",
		collectAutoExtensionEntries(userDirs.extensions),
		userMetadata,
		userOverrides.extensions,
		globalBaseDir,
	);

	// User skills from ~/.metis/agent/
	addResources(
		"skills",
		collectAutoSkillEntries(userDirs.skills, "metis"),
		userMetadata,
		userOverrides.skills,
		globalBaseDir,
	);

	// User skills from ~/.agents/ (with its own baseDir)
	const userAgentsBaseDir = dirname(userAgentsSkillsDir);
	const userAgentsMetadata: PathMetadata = {
		...userMetadata,
		baseDir: userAgentsBaseDir,
	};
	addResources(
		"skills",
		collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
		userAgentsMetadata,
		userOverrides.skills,
		userAgentsBaseDir,
	);

	addResources(
		"prompts",
		collectAutoPromptEntries(userDirs.prompts),
		userMetadata,
		userOverrides.prompts,
		globalBaseDir,
	);
	addResources("themes", collectAutoThemeEntries(userDirs.themes), userMetadata, userOverrides.themes, globalBaseDir);
}
