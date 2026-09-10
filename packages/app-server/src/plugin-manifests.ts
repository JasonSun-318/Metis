import { posix } from "node:path";
import type {
	CapabilityKind,
	DeclarativeHook,
	HookEventName,
	McpServerSettings,
	PluginFormat,
	PluginIssue,
} from "@metis/coding-agent";
import { HOOK_EVENT_NAMES, parseFrontmatter } from "@metis/coding-agent";

export interface ParsedSkillComponent {
	readonly kind: "skill";
	readonly id: string;
	readonly name: string;
	readonly originalName: string;
	readonly description: string;
	readonly relativeEntryPath: string; // e.g. "skills/helper/SKILL.md"
	readonly relativeBaseDir: string; // e.g. "skills/helper"
	readonly disableModelInvocation?: boolean;
}

export interface ParsedMcpComponent {
	readonly kind: "mcp";
	readonly id: string;
	readonly name: string;
	readonly originalName: string;
	readonly definition: McpServerSettings;
}

export interface ParsedHookComponent {
	readonly kind: "hook";
	readonly id: string;
	readonly name: string;
	readonly event: HookEventName;
	readonly definition: DeclarativeHook;
}

export interface ParsedUnsupportedComponent {
	readonly kind: "unsupported";
	readonly id: string;
	readonly name: string;
	readonly reason: string;
}

export type ParsedPluginComponent =
	| ParsedSkillComponent
	| ParsedMcpComponent
	| ParsedHookComponent
	| ParsedUnsupportedComponent;

export interface MarketplacePluginEntry {
	readonly name?: string;
	readonly description?: string;
	readonly strict?: boolean;
	readonly skills?: readonly string[];
	readonly [key: string]: unknown;
}

export interface ParsePluginManifestOptions {
	readonly format?: PluginFormat;
	readonly manifest?: unknown;
	readonly files: ReadonlyMap<string, Buffer> | Record<string, Buffer>;
	readonly root?: string; // e.g. "" or "plugins/foo"
	readonly marketEntry?: MarketplacePluginEntry;
}

export interface ParsedPluginManifest {
	readonly format: PluginFormat;
	readonly name: string;
	readonly displayName: string;
	readonly description: string;
	readonly version?: string;
	readonly components: readonly ParsedPluginComponent[];
	readonly issues: readonly PluginIssue[];
}

const KIND_ORDER: Record<CapabilityKind, number> = {
	skill: 0,
	mcp: 1,
	hook: 2,
	unsupported: 3,
};

function normalizePath(p: string): string {
	const normalized = posix.normalize(p.replace(/\\/g, "/"));
	return normalized.replace(/^\.\//, "").replace(/^\//, "");
}

export function canonicalComponentPath(input: string): string {
	const raw = input.replace(/\\/g, "/");
	if (posix.isAbsolute(raw)) throw new Error("Absolute component path is not allowed");
	const normalized = posix.normalize(raw);
	if (normalized === ".." || normalized.startsWith("../")) throw new Error("Component path escapes plugin");
	return normalized === "." ? "" : normalized.replace(/^\.\//, "").replace(/\/+$/, "");
}

export function skillEntriesAt(input: string, paths: readonly string[]): string[] {
	const path = canonicalComponentPath(input);
	if (path.endsWith("SKILL.md")) return paths.includes(path) ? [path] : [];
	const prefix = path ? `${path}/` : "";
	return paths.filter((p) => p.startsWith(prefix) && posix.basename(p) === "SKILL.md");
}

function unsupportedHandlerReason(handler: Record<string, unknown>): string | undefined {
	if (handler.type !== undefined && handler.type !== "command") return "Unsupported hook handler type";
	if (handler.async === true) return "Async hooks are not supported";
	if (handler.if !== undefined || handler.condition !== undefined) return "Conditional hooks are not supported";
	return undefined;
}

function parseJsonWithDiagnostics(
	buffer: Buffer,
	filePath: string,
	componentId: string,
	issues: PluginIssue[],
	isManifest = false,
): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
	} catch (err) {
		issues.push({
			code: isManifest ? "CORRUPT_MANIFEST" : "INVALID_JSON",
			componentId,
			message: `Failed to parse JSON file at ${filePath}: ${(err as Error).message}`,
			status: "unsupported",
		});
		return undefined;
	}
}

function getFileContent(
	files: ReadonlyMap<string, Buffer> | Record<string, Buffer>,
	path: string,
	root = "",
): Buffer | undefined {
	const normalizedRoot = root ? normalizePath(root) : "";
	const target = normalizedRoot ? normalizePath(posix.join(normalizedRoot, path)) : normalizePath(path);

	if (files instanceof Map) {
		if (files.has(target)) return files.get(target);
		// Try without/with leading slash
		for (const [key, value] of files.entries()) {
			if (normalizePath(key) === target) return value;
		}
	} else {
		const record = files as Record<string, Buffer>;
		if (Object.hasOwn(record, target)) return record[target];
		for (const key of Object.keys(record)) {
			if (normalizePath(key) === target) return record[key];
		}
	}
	return undefined;
}

function listFilePaths(files: ReadonlyMap<string, Buffer> | Record<string, Buffer>, root = ""): string[] {
	const normalizedRoot = root ? normalizePath(root) : "";
	const keys = files instanceof Map ? Array.from(files.keys()) : Object.keys(files as Record<string, Buffer>);
	return keys
		.map((k) => normalizePath(k))
		.filter((k) => (normalizedRoot ? k === normalizedRoot || k.startsWith(`${normalizedRoot}/`) : true))
		.map((k) => (normalizedRoot && k.startsWith(`${normalizedRoot}/`) ? k.slice(normalizedRoot.length + 1) : k));
}

function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "item"
	);
}

const SUPPORTED_ROOT_VARIABLES = new Set(["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR"]);

function checkVariables(value: string | undefined, componentId: string, issues: PluginIssue[]): void {
	if (!value) return;
	const regex = /\$\{([^}]+)\}/g;
	let match = regex.exec(value);
	while (match !== null) {
		const varName = match[1];
		if (!SUPPORTED_ROOT_VARIABLES.has(varName)) {
			issues.push({
				code: "UNKNOWN_VARIABLE",
				componentId,
				message: `Unknown variable \${${varName}} requires configuration`,
				status: "needs-configuration",
			});
		}
		match = regex.exec(value);
	}
}

function discoverSkillPaths(
	files: ReadonlyMap<string, Buffer> | Record<string, Buffer>,
	root: string,
	declaredSkills: unknown,
	isStrictFalseBundle: boolean,
	issues: PluginIssue[],
): string[] {
	const allPaths = listFilePaths(files, root);
	const candidateSkillPaths = new Set<string>();

	if (isStrictFalseBundle) {
		const list = Array.isArray(declaredSkills) ? declaredSkills : [];
		for (const s of list) {
			if (typeof s !== "string") continue;
			try {
				const entries = skillEntriesAt(s, allPaths);
				if (entries.length === 0) {
					issues.push({
						code: "MISSING_COMPONENT",
						componentId: `skill-${slugify(s)}`,
						message: `Declared skill path does not exist: ${s}`,
						status: "warning",
					});
				} else {
					for (const e of entries) candidateSkillPaths.add(e);
				}
			} catch (err) {
				issues.push({
					code: "INVALID_COMPONENT_PATH",
					componentId: `skill-${slugify(s)}`,
					message: (err as Error).message,
					status: "warning",
				});
			}
		}
		return Array.from(candidateSkillPaths);
	}

	if (declaredSkills !== undefined && declaredSkills !== null) {
		const list =
			typeof declaredSkills === "string" ? [declaredSkills] : Array.isArray(declaredSkills) ? declaredSkills : [];
		for (const s of list) {
			if (typeof s !== "string") continue;
			try {
				const entries = skillEntriesAt(s, allPaths);
				if (entries.length === 0) {
					issues.push({
						code: "MISSING_COMPONENT",
						componentId: `skill-${slugify(s)}`,
						message: `Declared skill path does not exist: ${s}`,
						status: "warning",
					});
				} else {
					for (const e of entries) candidateSkillPaths.add(e);
				}
			} catch (err) {
				issues.push({
					code: "INVALID_COMPONENT_PATH",
					componentId: `skill-${slugify(s)}`,
					message: (err as Error).message,
					status: "warning",
				});
			}
		}
	}

	for (const e of skillEntriesAt("skills", allPaths)) {
		candidateSkillPaths.add(e);
	}
	if (allPaths.includes("SKILL.md")) {
		candidateSkillPaths.add("SKILL.md");
	}

	return Array.from(candidateSkillPaths);
}

function parseSkillComponents(
	files: ReadonlyMap<string, Buffer> | Record<string, Buffer>,
	root: string,
	skillPaths: readonly string[],
): ParsedSkillComponent[] {
	const components: ParsedSkillComponent[] = [];
	for (const skillPath of skillPaths) {
		const buf = getFileContent(files, skillPath, root);
		if (!buf) continue;
		const text = new TextDecoder("utf-8").decode(buf);
		let frontmatter: Record<string, unknown> = {};
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(text);
			frontmatter = parsed.frontmatter;
		} catch {
			// empty or malformed frontmatter
		}
		const originalName =
			typeof frontmatter.name === "string" && frontmatter.name.trim()
				? frontmatter.name.trim()
				: posix.basename(posix.dirname(skillPath)) || "skill";
		const skillDescription = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		const disableModelInvocation = Boolean(frontmatter["disable-model-invocation"]);

		components.push({
			kind: "skill",
			id: slugify(originalName),
			name: originalName,
			originalName,
			description: skillDescription,
			relativeEntryPath: skillPath,
			relativeBaseDir: posix.dirname(skillPath) === "." ? "" : posix.dirname(skillPath),
			disableModelInvocation,
		});
	}
	return components;
}

function parseHooks(
	files: ReadonlyMap<string, Buffer> | Record<string, Buffer>,
	root: string,
	declaredHooks: unknown,
	pluginName: string,
	components: ParsedPluginComponent[],
	issues: PluginIssue[],
): void {
	const configsToParse: Array<{ source: string; content: unknown }> = [];

	const defaultHookPath = "hooks/hooks.json";
	const defaultBuf = getFileContent(files, defaultHookPath, root);
	if (defaultBuf) {
		const parsed = parseJsonWithDiagnostics(defaultBuf, defaultHookPath, "hooks", issues);
		if (parsed) {
			configsToParse.push({ source: defaultHookPath, content: parsed });
		}
	}

	const customPaths: string[] = [];
	if (typeof declaredHooks === "string") {
		customPaths.push(declaredHooks);
	} else if (Array.isArray(declaredHooks)) {
		for (const h of declaredHooks) {
			if (typeof h === "string") customPaths.push(h);
		}
	}

	const seenCustomPaths = new Set<string>();
	for (const rawCustom of customPaths) {
		let canonical: string;
		try {
			canonical = canonicalComponentPath(rawCustom);
		} catch (err) {
			issues.push({
				code: "INVALID_COMPONENT_PATH",
				componentId: `hook-${slugify(rawCustom)}`,
				message: (err as Error).message,
				status: "warning",
			});
			continue;
		}

		if (canonical === defaultHookPath || seenCustomPaths.has(canonical)) {
			continue;
		}
		seenCustomPaths.add(canonical);

		const buf = getFileContent(files, canonical, root);
		if (!buf) {
			issues.push({
				code: "MISSING_COMPONENT",
				componentId: `hook-${slugify(canonical)}`,
				message: `Declared hooks file does not exist: ${canonical}`,
				status: "warning",
			});
			continue;
		}

		const parsed = parseJsonWithDiagnostics(buf, canonical, "hooks", issues);
		if (parsed) {
			configsToParse.push({ source: canonical, content: parsed });
		}
	}

	if (typeof declaredHooks === "object" && declaredHooks !== null && !Array.isArray(declaredHooks)) {
		configsToParse.push({ source: "inline", content: declaredHooks });
	}

	let hookIndex = 0;
	for (const { source: _source, content } of configsToParse) {
		if (typeof content !== "object" || content === null) continue;
		const hooksRoot =
			"hooks" in content &&
			typeof (content as Record<string, unknown>).hooks === "object" &&
			(content as Record<string, unknown>).hooks !== null
				? ((content as Record<string, unknown>).hooks as Record<string, unknown>)
				: (content as Record<string, unknown>);

		for (const [eventName, groupOrHandlers] of Object.entries(hooksRoot)) {
			const isSupportedEvent = HOOK_EVENT_NAMES.includes(eventName as HookEventName);
			if (!isSupportedEvent) {
				issues.push({
					code: "UNSUPPORTED_HOOK_EVENT",
					componentId: `hook-${eventName}`,
					message: `Unsupported hook event: ${eventName}`,
					status: "unsupported",
				});
				components.push({
					kind: "unsupported",
					id: `hook-${eventName}`,
					name: `Hook: ${eventName}`,
					reason: `Unsupported hook event: ${eventName}`,
				});
				continue;
			}

			if (!Array.isArray(groupOrHandlers)) continue;

			for (const item of groupOrHandlers) {
				if (typeof item !== "object" || item === null) continue;
				const itemObj = item as Record<string, unknown>;
				const matcher = typeof itemObj.matcher === "string" ? itemObj.matcher : undefined;
				const handlers: Array<Record<string, unknown>> = Array.isArray(itemObj.hooks)
					? (itemObj.hooks as Array<Record<string, unknown>>)
					: [itemObj];

				for (const handler of handlers) {
					hookIndex += 1;
					const reason = unsupportedHandlerReason(handler);
					const stableId = `hook-${eventName}-${matcher ? slugify(matcher) : "all"}-${hookIndex}`;

					if (reason) {
						issues.push({
							code: "UNSUPPORTED_HOOK_HANDLER",
							componentId: stableId,
							message: reason,
							status: "unsupported",
						});
						components.push({
							kind: "unsupported",
							id: stableId,
							name: `${pluginName || "plugin"} ${eventName} hook`,
							reason,
						});
						continue;
					}

					const command = typeof handler.command === "string" ? handler.command : "";
					if (!command) continue;

					const timeoutSeconds =
						typeof handler.timeout === "number"
							? handler.timeout
							: typeof handler.timeoutSeconds === "number"
								? handler.timeoutSeconds
								: undefined;
					const statusMessage = typeof handler.statusMessage === "string" ? handler.statusMessage : undefined;

					components.push({
						kind: "hook",
						id: stableId,
						name: `${pluginName || "plugin"} ${eventName} hook`,
						event: eventName as HookEventName,
						definition: {
							id: stableId,
							name: `${pluginName || "plugin"} ${eventName} hook`,
							enabled: true,
							event: eventName as HookEventName,
							matcher,
							runMode: "shell",
							protocol: "command-v1",
							command,
							...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
							...(statusMessage !== undefined ? { statusMessage } : {}),
						},
					});
				}
			}
		}
	}
}

export function parsePluginManifest(options: ParsePluginManifestOptions): ParsedPluginManifest {
	const root = options.root ? normalizePath(options.root) : "";
	const files = options.files;
	const issues: PluginIssue[] = [];
	const components: ParsedPluginComponent[] = [];

	const claudeManifestBuf = getFileContent(files, ".claude-plugin/plugin.json", root);
	const codexManifestBuf = getFileContent(files, ".codex-plugin/plugin.json", root);

	let format = options.format;
	if (!format) {
		if (claudeManifestBuf && codexManifestBuf) {
			format = "claude";
			issues.push({
				code: "DUAL_MANIFEST_CONFLICT",
				componentId: "manifest",
				message: "Both Claude and Codex plugin manifests found in same root. Defaulting to Claude.",
				status: "warning",
			});
		} else if (claudeManifestBuf) {
			format = "claude";
		} else if (codexManifestBuf) {
			format = "codex";
		} else if (options.marketEntry?.strict === false && Array.isArray(options.marketEntry?.skills)) {
			format = "claude";
		} else {
			const allPaths = listFilePaths(files, root);
			const hasSkills = allPaths.some((p) => posix.basename(p) === "SKILL.md");
			if (hasSkills) {
				format = "agent-skills";
			} else {
				format = "claude";
			}
		}
	}

	let name = options.marketEntry?.name || "";
	let displayName = options.marketEntry?.name || "";
	let description = options.marketEntry?.description || "";
	let version: string | undefined;

	if (format === "claude") {
		let manifestObj: Record<string, unknown> = {};
		if (options.manifest && typeof options.manifest === "object") {
			manifestObj = options.manifest as Record<string, unknown>;
		} else if (claudeManifestBuf) {
			const parsed = parseJsonWithDiagnostics(
				claudeManifestBuf,
				".claude-plugin/plugin.json",
				"manifest",
				issues,
				true,
			);
			if (typeof parsed === "object" && parsed !== null) {
				manifestObj = parsed as Record<string, unknown>;
			}
		}

		if (manifestObj.name && typeof manifestObj.name === "string") name = manifestObj.name;
		if (manifestObj.displayName && typeof manifestObj.displayName === "string") displayName = manifestObj.displayName;
		else if (name) displayName = name;
		if (manifestObj.description && typeof manifestObj.description === "string") description = manifestObj.description;
		if (manifestObj.version && typeof manifestObj.version === "string") version = manifestObj.version;

		// Skill discovery
		const isStrictFalseBundle = Boolean(
			options.marketEntry?.strict === false && Array.isArray(options.marketEntry?.skills),
		);
		const declaredSkills = isStrictFalseBundle ? options.marketEntry?.skills : manifestObj.skills;
		const candidateSkillPaths = discoverSkillPaths(files, root, declaredSkills, isStrictFalseBundle, issues);
		const skillComponents = parseSkillComponents(files, root, candidateSkillPaths);
		components.push(...skillComponents);

		// MCP discovery
		const mcpServerConfigs = new Map<string, unknown>();
		let customMcpFile: string | undefined;
		if (typeof manifestObj.mcpServers === "string") {
			customMcpFile = manifestObj.mcpServers;
		} else if (typeof manifestObj.mcpServers === "object" && manifestObj.mcpServers !== null) {
			for (const [serverName, srv] of Object.entries(manifestObj.mcpServers as Record<string, unknown>)) {
				mcpServerConfigs.set(serverName, srv);
			}
		}

		if (customMcpFile) {
			let canonical: string;
			try {
				canonical = canonicalComponentPath(customMcpFile);
			} catch (err) {
				issues.push({
					code: "INVALID_COMPONENT_PATH",
					componentId: `mcp-${slugify(customMcpFile)}`,
					message: (err as Error).message,
					status: "warning",
				});
				canonical = "";
			}
			if (canonical) {
				const buf = getFileContent(files, canonical, root);
				if (!buf) {
					issues.push({
						code: "MISSING_COMPONENT",
						componentId: `mcp-${slugify(canonical)}`,
						message: `Declared MCP file does not exist: ${canonical}`,
						status: "warning",
					});
				} else {
					const parsed = parseJsonWithDiagnostics(buf, canonical, "mcp", issues);
					if (typeof parsed === "object" && parsed !== null) {
						const srvMap =
							"mcpServers" in parsed && typeof (parsed as Record<string, unknown>).mcpServers === "object"
								? ((parsed as Record<string, unknown>).mcpServers as Record<string, unknown>)
								: (parsed as Record<string, unknown>);
						for (const [serverName, srv] of Object.entries(srvMap)) {
							if (!mcpServerConfigs.has(serverName)) {
								mcpServerConfigs.set(serverName, srv);
							}
						}
					}
				}
			}
		}

		const defaultMcpBuf = getFileContent(files, ".mcp.json", root);
		if (defaultMcpBuf) {
			const parsed = parseJsonWithDiagnostics(defaultMcpBuf, ".mcp.json", "mcp", issues);
			if (typeof parsed === "object" && parsed !== null) {
				const srvMap =
					"mcpServers" in parsed && typeof (parsed as Record<string, unknown>).mcpServers === "object"
						? ((parsed as Record<string, unknown>).mcpServers as Record<string, unknown>)
						: (parsed as Record<string, unknown>);
				for (const [serverName, srv] of Object.entries(srvMap)) {
					if (!mcpServerConfigs.has(serverName)) {
						mcpServerConfigs.set(serverName, srv);
					}
				}
			}
		}

		for (const [serverName, srvRaw] of mcpServerConfigs) {
			if (typeof srvRaw !== "object" || srvRaw === null) continue;
			const srv = srvRaw as Record<string, unknown>;

			if (srv.type === "sse" || srv.transport === "sse") {
				components.push({
					kind: "unsupported",
					id: `mcp-${serverName}`,
					name: serverName,
					reason: "SSE transport is not supported",
				});
				issues.push({
					code: "UNSUPPORTED_TRANSPORT",
					componentId: `mcp-${serverName}`,
					message: `MCP server ${serverName} uses unsupported SSE transport`,
					status: "unsupported",
				});
				continue;
			}

			if (typeof srv.command === "string") {
				const cmd = srv.command;
				const args = Array.isArray(srv.args)
					? (srv.args.filter((a) => typeof a === "string") as string[])
					: undefined;
				const env =
					typeof srv.env === "object" && srv.env !== null ? (srv.env as Record<string, string>) : undefined;
				const cwd = typeof srv.cwd === "string" ? srv.cwd : `$${"{CLAUDE_PLUGIN_ROOT}"}`;

				checkVariables(cmd, serverName, issues);
				if (args) {
					for (const arg of args) checkVariables(arg, serverName, issues);
				}
				if (env) {
					for (const val of Object.values(env)) checkVariables(val, serverName, issues);
				}
				checkVariables(cwd, serverName, issues);

				components.push({
					kind: "mcp",
					id: serverName,
					name: serverName,
					originalName: serverName,
					definition: {
						command: cmd,
						args,
						env,
						cwd,
						enabled: true,
					},
				});
			} else if (typeof srv.url === "string") {
				const url = srv.url;
				checkVariables(url, serverName, issues);
				components.push({
					kind: "mcp",
					id: serverName,
					name: serverName,
					originalName: serverName,
					definition: {
						url,
						httpHeaders:
							typeof srv.headers === "object" && srv.headers !== null
								? (srv.headers as Record<string, string>)
								: undefined,
						enabled: true,
					},
				});
			}
		}

		// Hooks discovery
		parseHooks(files, root, manifestObj.hooks, name, components, issues);
	} else if (format === "codex") {
		let manifestObj: Record<string, unknown> = {};
		if (options.manifest && typeof options.manifest === "object") {
			manifestObj = options.manifest as Record<string, unknown>;
		} else if (codexManifestBuf) {
			const parsed = parseJsonWithDiagnostics(
				codexManifestBuf,
				".codex-plugin/plugin.json",
				"manifest",
				issues,
				true,
			);
			if (typeof parsed === "object" && parsed !== null) {
				manifestObj = parsed as Record<string, unknown>;
			}
		}

		if (manifestObj.name && typeof manifestObj.name === "string") name = manifestObj.name;
		const interfaceObj =
			typeof manifestObj.interface === "object" && manifestObj.interface !== null
				? (manifestObj.interface as Record<string, unknown>)
				: undefined;

		if (interfaceObj?.displayName && typeof interfaceObj.displayName === "string")
			displayName = interfaceObj.displayName;
		else if (manifestObj.displayName && typeof manifestObj.displayName === "string")
			displayName = manifestObj.displayName;
		else if (name) displayName = name;

		if (interfaceObj?.description && typeof interfaceObj.description === "string")
			description = interfaceObj.description;
		else if (manifestObj.description && typeof manifestObj.description === "string")
			description = manifestObj.description;

		if (manifestObj.version && typeof manifestObj.version === "string") version = manifestObj.version;

		// Skills discovery
		const isStrictFalseBundle = Boolean(
			options.marketEntry?.strict === false && Array.isArray(options.marketEntry?.skills),
		);
		const declaredSkills = isStrictFalseBundle ? options.marketEntry?.skills : manifestObj.skills;
		const candidateSkillPaths = discoverSkillPaths(files, root, declaredSkills, isStrictFalseBundle, issues);
		const skillComponents = parseSkillComponents(files, root, candidateSkillPaths);
		components.push(...skillComponents);

		// MCP discovery
		const mcpServerConfigs = new Map<string, unknown>();
		let customMcpFile: string | undefined;
		if (typeof manifestObj.mcpServers === "string") {
			customMcpFile = manifestObj.mcpServers;
		} else if (typeof manifestObj.mcpServers === "object" && manifestObj.mcpServers !== null) {
			for (const [serverName, srv] of Object.entries(manifestObj.mcpServers as Record<string, unknown>)) {
				mcpServerConfigs.set(serverName, srv);
			}
		}

		if (customMcpFile) {
			let canonical: string;
			try {
				canonical = canonicalComponentPath(customMcpFile);
			} catch (err) {
				issues.push({
					code: "INVALID_COMPONENT_PATH",
					componentId: `mcp-${slugify(customMcpFile)}`,
					message: (err as Error).message,
					status: "warning",
				});
				canonical = "";
			}
			if (canonical) {
				const buf = getFileContent(files, canonical, root);
				if (!buf) {
					issues.push({
						code: "MISSING_COMPONENT",
						componentId: `mcp-${slugify(canonical)}`,
						message: `Declared MCP file does not exist: ${canonical}`,
						status: "warning",
					});
				} else {
					const parsed = parseJsonWithDiagnostics(buf, canonical, "mcp", issues);
					if (typeof parsed === "object" && parsed !== null) {
						const srvMap =
							"mcpServers" in parsed && typeof (parsed as Record<string, unknown>).mcpServers === "object"
								? ((parsed as Record<string, unknown>).mcpServers as Record<string, unknown>)
								: (parsed as Record<string, unknown>);
						for (const [serverName, srv] of Object.entries(srvMap)) {
							if (!mcpServerConfigs.has(serverName)) {
								mcpServerConfigs.set(serverName, srv);
							}
						}
					}
				}
			}
		}

		const defaultMcpBuf = getFileContent(files, ".mcp.json", root);
		if (defaultMcpBuf) {
			const parsed = parseJsonWithDiagnostics(defaultMcpBuf, ".mcp.json", "mcp", issues);
			if (typeof parsed === "object" && parsed !== null) {
				const srvMap =
					"mcpServers" in parsed && typeof (parsed as Record<string, unknown>).mcpServers === "object"
						? ((parsed as Record<string, unknown>).mcpServers as Record<string, unknown>)
						: (parsed as Record<string, unknown>);
				for (const [serverName, srv] of Object.entries(srvMap)) {
					if (!mcpServerConfigs.has(serverName)) {
						mcpServerConfigs.set(serverName, srv);
					}
				}
			}
		}

		for (const [serverName, srvRaw] of mcpServerConfigs) {
			if (typeof srvRaw !== "object" || srvRaw === null) continue;
			const srv = srvRaw as Record<string, unknown>;

			if (typeof srv.command === "string") {
				const cmd = srv.command;
				const args = Array.isArray(srv.args)
					? (srv.args.filter((a) => typeof a === "string") as string[])
					: undefined;
				const env =
					typeof srv.env === "object" && srv.env !== null ? (srv.env as Record<string, string>) : undefined;
				const cwd = typeof srv.cwd === "string" ? srv.cwd : undefined;

				components.push({
					kind: "mcp",
					id: serverName,
					name: serverName,
					originalName: serverName,
					definition: {
						command: cmd,
						args,
						env,
						cwd,
						enabled: true,
					},
				});
			} else if (typeof srv.url === "string") {
				components.push({
					kind: "mcp",
					id: serverName,
					name: serverName,
					originalName: serverName,
					definition: {
						url: srv.url,
						httpHeaders:
							typeof srv.headers === "object" && srv.headers !== null
								? (srv.headers as Record<string, string>)
								: undefined,
						enabled: true,
					},
				});
			}
		}

		// Hooks discovery
		parseHooks(files, root, manifestObj.hooks, name, components, issues);

		// Apps discovery (Codex app connectors)
		if (Array.isArray(manifestObj.apps)) {
			for (const app of manifestObj.apps) {
				if (typeof app === "object" && app !== null) {
					const appObj = app as Record<string, unknown>;
					const appId = typeof appObj.id === "string" ? appObj.id : "codex-app";
					const appName = typeof appObj.name === "string" ? appObj.name : appId;
					components.push({
						kind: "unsupported",
						id: appId,
						name: appName,
						reason: "Codex app connectors are not supported",
					});
					issues.push({
						code: "UNSUPPORTED_APP_CONNECTOR",
						componentId: appId,
						message: `Codex app connector ${appName} is not supported`,
						status: "unsupported",
					});
				}
			}
		}
	} else {
		// format === "agent-skills"
		const allPaths = listFilePaths(files, root);
		const skillPaths = allPaths.filter((p) => posix.basename(p) === "SKILL.md");
		const skillComponents = parseSkillComponents(files, root, skillPaths);
		components.push(...skillComponents);

		if (!name && components.length > 0) {
			name = components[0].name;
			displayName = name;
		}
	}

	// Sort components stably: skill -> mcp -> hook -> unsupported, then by id/name
	components.sort((a, b) => {
		const orderA = KIND_ORDER[a.kind];
		const orderB = KIND_ORDER[b.kind];
		if (orderA !== orderB) return orderA - orderB;
		return a.id.localeCompare(b.id);
	});

	return {
		format,
		name: name || "plugin",
		displayName: displayName || name || "Plugin",
		description: description || "",
		version,
		components,
		issues,
	};
}
