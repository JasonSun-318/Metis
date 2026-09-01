/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledMetisAgentCore from "@metis/agent-core";
import * as _bundledMetisAiCompat from "@metis/ai/compat";
import * as _bundledMetisAiOauth from "@metis/ai/oauth";
import type { KeyId } from "@metis/tui";
import * as _bundledMetisTui from "@metis/tui";
import { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { getAgentDir, getProjectConfigDir, isBunBinary } from "../../config.ts";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @metis/coding-agent.
import * as _bundledMetisCodingAgent from "../../index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { time } from "../timings.ts";
import { assertToolPermissionDescriptor } from "../tool-permission-adapter.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

/** Modules available to extensions via virtualModules (for compiled Bun binary) */
const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@metis/agent-core": _bundledMetisAgentCore,
	"@metis/tui": _bundledMetisTui,
	// Extensions resolve the metis-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@metis/ai": _bundledMetisAiCompat,
	"@metis/ai/compat": _bundledMetisAiCompat,
	"@metis/ai/oauth": _bundledMetisAiOauth,
	"@metis/coding-agent": _bundledMetisCodingAgent,
};

const require = createRequire(import.meta.url);

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const metisCodingAgentEntry = packageIndex;
	const metisAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@metis/agent-core");
	const metisTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@metis/tui");
	// Extensions resolve the metis-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	const metisAiCompatEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@metis/ai/compat");
	const metisAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@metis/ai/oauth");

	_aliases = {
		"@metis/coding-agent": metisCodingAgentEntry,
		"@metis/agent-core": metisAgentCoreEntry,
		"@metis/tui": metisTuiEntry,
		"@metis/ai": metisAiCompatEntry,
		"@metis/ai/compat": metisAiCompatEntry,
		"@metis/ai/oauth": metisAiOauthEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

interface ExtensionCacheToken {
	cache: ExtensionModuleCache;
	cwd: string;
	generation: number;
}

export class ExtensionModuleCache {
	private cwd: string | undefined;
	private generation = 0;
	private factories = new Map<string, ExtensionFactory>();

	clear(): void {
		this.factories.clear();
		this.cwd = undefined;
		this.generation++;
	}

	begin(cwd: string): ExtensionCacheToken {
		const resolvedCwd = resolvePath(cwd);
		if (this.cwd !== undefined && this.cwd !== resolvedCwd) {
			this.clear();
		}
		this.cwd = resolvedCwd;
		return { cache: this, cwd: resolvedCwd, generation: this.generation };
	}

	get(token: ExtensionCacheToken, extensionPath: string): ExtensionFactory | undefined {
		return this.isCurrent(token) ? this.factories.get(extensionPath) : undefined;
	}

	set(token: ExtensionCacheToken, extensionPath: string, factory: ExtensionFactory): void {
		if (this.isCurrent(token)) {
			this.factories.set(extensionPath, factory);
		}
	}

	private isCurrent(token: ExtensionCacheToken): boolean {
		return token.cache === this && this.cwd === token.cwd && this.generation === token.generation;
	}
}

const sharedExtensionCache = new ExtensionModuleCache();

export function clearExtensionCache(): void {
	sharedExtensionCache.clear();
}

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured metis or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			assertToolPermissionDescriptor(tool);
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			runtime.assertActive();
			extension.entryRenderers ??= new Map();
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			runtime.assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			runtime.assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			runtime.assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			runtime.assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			runtime.assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			runtime.assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			runtime.assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			runtime.assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.assertActive();
			runtime.registerProvider(name, config, extension.path);
		},

		unregisterProvider(name: string) {
			runtime.assertActive();
			runtime.unregisterProvider(name, extension.path);
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
	if (cacheToken) {
		const cachedFactory = cacheToken.cache.get(cacheToken, extensionPath);
		if (cachedFactory) {
			return cachedFactory;
		}
	}

	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
		// Also disable tryNative so jiti handles ALL imports (not just the entry point)
		// In Node.js/dev: use aliases to resolve to node_modules paths
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	if (typeof factory !== "function") {
		return undefined;
	}
	if (cacheToken) {
		cacheToken.cache.set(cacheToken, extensionPath, factory);
	}
	return factory;
}

/**
 * Create an Extension object with empty collections.
 */
const LOCAL_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const MAX_EXTENSION_IMPLEMENTATION_FILES = 1_024;
const MAX_EXTENSION_IMPLEMENTATION_BYTES = 32 * 1024 * 1024;

function resolveExtensionEntry(input: string): string {
	const resolved = fs.realpathSync(input);
	if (fs.statSync(resolved).isFile()) return resolved;
	try {
		return fs.realpathSync(require.resolve(resolved));
	} catch {
		const packagePath = path.join(resolved, "package.json");
		if (fs.existsSync(packagePath)) {
			const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, unknown>;
			for (const field of ["source", "module", "main"] as const) {
				if (typeof packageJson[field] !== "string") continue;
				const candidate = resolveLocalModule(packageJson[field], packagePath);
				if (candidate) return candidate;
			}
		}
		for (const extension of LOCAL_MODULE_EXTENSIONS) {
			const candidate = path.join(resolved, `index${extension}`);
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
		}
		throw new TypeError(`Extension entry cannot be resolved: ${input}`);
	}
}

function resolveLocalModule(specifier: string, importer: string): string | undefined {
	const unresolved = specifier.startsWith("file:")
		? fileURLToPath(specifier)
		: path.resolve(path.dirname(importer), specifier);
	const candidates = [unresolved, ...LOCAL_MODULE_EXTENSIONS.map((extension) => `${unresolved}${extension}`)];
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		const stats = fs.statSync(candidate);
		if (stats.isFile()) return fs.realpathSync(candidate);
		if (stats.isDirectory()) return resolveExtensionEntry(candidate);
	}
	return undefined;
}

interface ModuleToken {
	readonly kind: "identifier" | "string" | "template" | "punctuation";
	readonly value: string;
	readonly escaped?: boolean;
}

function quotedLiteralEnd(source: string, start: number): number {
	const quote = source[start];
	for (let index = start + 1; index < source.length; index += 1) {
		if (source[index] === "\\") index += 1;
		else if (source[index] === quote) return index + 1;
	}
	throw new TypeError("Extension source contains an unterminated string literal");
}

function templateInterpolationEnd(source: string, start: number): number {
	let depth = 1;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (character === '"' || character === "'") {
			index = quotedLiteralEnd(source, index) - 1;
			continue;
		}
		if (character === "`") {
			index = templateLiteralParts(source, index).end - 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index + 2);
			if (newline < 0) throw new TypeError("Extension source contains an unterminated template interpolation");
			index = newline;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			if (end < 0) throw new TypeError("Extension source contains an unterminated comment");
			index = end + 1;
			continue;
		}
		if (character === "/") {
			let escaped = false;
			let characterClass = false;
			for (let end = index + 1; end < source.length && source[end] !== "\n"; end += 1) {
				if (escaped) escaped = false;
				else if (source[end] === "\\") escaped = true;
				else if (source[end] === "[") characterClass = true;
				else if (source[end] === "]") characterClass = false;
				else if (source[end] === "/" && !characterClass) {
					index = end;
					break;
				}
			}
			continue;
		}
		if (character === "{") depth += 1;
		if (character === "}" && --depth === 0) return index;
	}
	throw new TypeError("Extension source contains an unterminated template interpolation");
}

function templateLiteralParts(
	source: string,
	start: number,
): { readonly end: number; readonly expressions: readonly string[] } {
	const expressions: string[] = [];
	for (let index = start + 1; index < source.length; index += 1) {
		if (source[index] === "\\") {
			index += 1;
			continue;
		}
		if (source[index] === "`") return { end: index + 1, expressions };
		if (source[index] === "$" && source[index + 1] === "{") {
			const expressionStart = index + 2;
			const expressionEnd = templateInterpolationEnd(source, expressionStart);
			expressions.push(source.slice(expressionStart, expressionEnd));
			index = expressionEnd;
		}
	}
	throw new TypeError("Extension source contains an unterminated template literal");
}

function moduleTokens(source: string): ModuleToken[] {
	const tokens: ModuleToken[] = [];
	let index = 0;
	const regexPrefix = () => {
		const previous = tokens.at(-1);
		return (
			!previous ||
			(previous.kind === "punctuation" && /^(?:[([{=,:;!?&|+\-*%^~<>])$/u.test(previous.value)) ||
			(previous.kind === "identifier" &&
				/^(?:case|delete|do|else|in|instanceof|new|return|throw|typeof|void|yield)$/u.test(previous.value))
		);
	};
	while (index < source.length) {
		const character = source[index]!;
		if (/\s/u.test(character)) {
			index += 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			index = source.indexOf("\n", index + 2);
			if (index < 0) break;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			if (end < 0) throw new TypeError("Extension source contains an unterminated comment");
			index = end + 2;
			continue;
		}
		if (character === "/" && regexPrefix()) {
			index += 1;
			let escaped = false;
			let characterClass = false;
			for (; index < source.length; index += 1) {
				const current = source[index]!;
				if (current === "\n" || current === "\r") {
					throw new TypeError("Extension source contains an unterminated regular expression");
				}
				if (escaped) escaped = false;
				else if (current === "\\") escaped = true;
				else if (current === "[") characterClass = true;
				else if (current === "]") characterClass = false;
				else if (current === "/" && !characterClass) {
					index += 1;
					while (/[A-Za-z]/u.test(source[index] ?? "")) index += 1;
					break;
				}
			}
			continue;
		}
		if (character === '"' || character === "'") {
			const quote = character;
			let value = "";
			let escaped = false;
			index += 1;
			for (; index < source.length && source[index] !== quote; index += 1) {
				const current = source[index]!;
				if (current === "\n" || current === "\r") {
					throw new TypeError("Extension source contains an unterminated string literal");
				}
				if (current === "\\") {
					escaped = true;
					index += 1;
					if (index >= source.length) break;
					value += source[index]!;
				} else value += current;
			}
			if (source[index] !== quote) throw new TypeError("Extension source contains an unterminated string literal");
			index += 1;
			tokens.push({ kind: "string", value, escaped });
			continue;
		}
		if (character === "`") {
			const template = templateLiteralParts(source, index);
			index = template.end;
			tokens.push({ kind: "template", value: "" });
			for (const expression of template.expressions) tokens.push(...moduleTokens(expression));
			continue;
		}
		if (/[A-Za-z_$]/u.test(character)) {
			const start = index;
			while (/[A-Za-z0-9_$]/u.test(source[++index] ?? "")) {}
			tokens.push({ kind: "identifier", value: source.slice(start, index) });
			continue;
		}
		tokens.push({ kind: "punctuation", value: character });
		index += 1;
	}
	return tokens;
}

function localModuleSpecifiers(source: string): string[] {
	const tokens = moduleTokens(source);
	const specifiers = new Set<string>();
	const add = (token: ModuleToken | undefined) => {
		if (token?.kind !== "string") return;
		if (token.escaped) throw new TypeError("Extension module specifiers cannot contain escapes");
		if (token.value.startsWith(".") || token.value.startsWith("file:")) specifiers.add(token.value);
	};
	const callSpecifier = (index: number) => {
		const argument = tokens[index + 2];
		if (tokens[index + 1]?.value !== "(") return;
		if (argument?.kind !== "string" || tokens[index + 3]?.value !== ")") {
			throw new TypeError("Extension uses a dynamic module dependency that cannot be identity-bound");
		}
		add(argument);
	};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token?.kind !== "identifier") continue;
		if (token.value === "from") add(tokens[index + 1]);
		if (token.value === "import") {
			if (tokens[index + 1]?.kind === "string") add(tokens[index + 1]);
			else callSpecifier(index);
		}
		if (token.value === "require") {
			if (tokens[index + 1]?.value === "." && tokens[index + 2]?.value === "resolve") callSpecifier(index + 2);
			else callSpecifier(index);
		}
	}
	return [...specifiers].sort();
}

function extensionImplementationIdentity(resolvedPath: string): {
	readonly sourceIdentity: string;
	readonly implementationVersion: string;
} {
	const sourceIdentity = resolveExtensionEntry(resolvedPath);
	const files = new Map<string, Buffer>();
	let totalBytes = 0;
	const visit = (filePath: string): void => {
		const canonical = fs.realpathSync(filePath);
		if (files.has(canonical)) return;
		if (files.size >= MAX_EXTENSION_IMPLEMENTATION_FILES) {
			throw new TypeError("Extension implementation has too many local modules");
		}
		const bytes = fs.readFileSync(canonical);
		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_EXTENSION_IMPLEMENTATION_BYTES) {
			throw new TypeError("Extension implementation exceeds 32 MiB");
		}
		files.set(canonical, bytes);
		if (!/\.(?:[cm]?[jt]sx?)$/iu.test(canonical)) return;
		const source = bytes.toString("utf8");
		for (const specifier of localModuleSpecifiers(source)) {
			const dependency = resolveLocalModule(specifier, canonical);
			if (!dependency) throw new TypeError(`Extension local dependency cannot be resolved: ${specifier}`);
			visit(dependency);
		}
	};
	visit(sourceIdentity);
	const hash = createHash("sha256");
	for (const [filePath, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(filePath);
		hash.update("\0");
		hash.update(String(bytes.byteLength));
		hash.update("\0");
		hash.update(bytes);
		hash.update("\0");
	}
	return { sourceIdentity, implementationVersion: hash.digest("hex") };
}

function createExtension(
	extensionPath: string,
	resolvedPath: string,
	providedIdentity?: { readonly sourceIdentity: string; readonly implementationVersion: string },
): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const identity = providedIdentity ?? extensionImplementationIdentity(resolvedPath);
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(identity.sourceIdentity);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, {
			source,
			baseDir,
			sourceIdentity: identity.sourceIdentity,
			implementationVersion: identity.implementationVersion,
		}),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const identity = extensionImplementationIdentity(resolvedPath);
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		time(`${extensionPath} module import`, "extensions");
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath, identity);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		await factory(api);
		time(`${extensionPath} factory`, "extensions");

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath, {
		sourceIdentity: extensionPath,
		implementationVersion: createHash("sha256").update(Function.prototype.toString.call(factory)).digest("hex"),
	});
	const resolvedCwd = resolvePath(cwd);
	const api = createExtensionAPI(extension, runtime, resolvedCwd, eventBus);
	await factory(api);
	time(`${extensionPath} factory`, "extensions");
	return extension;
}

/**
 * Load extensions from paths.
 */
async function loadExtensionsInternal(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	useCache = false,
	extensionCache?: ExtensionModuleCache,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const cacheToken = useCache ? (extensionCache ?? sharedExtensionCache).begin(cwd) : undefined;
	const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(
			extPath,
			resolvedCwd,
			resolvedEventBus,
			resolvedRuntime,
			cacheToken,
		);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime: resolvedRuntime,
	};
}

export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime);
}

export async function loadExtensionsCached(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	extensionCache?: ExtensionModuleCache,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime, true, extensionCache);
}

interface MetisManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

function readMetisManifest(packageJsonPath: string): MetisManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as { metis?: unknown };
		if (pkg.metis && typeof pkg.metis === "object") return pkg.metis as MetisManifest;
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with a "metis.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with the Metis manifest field first.
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readMetisManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with a "metis" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/.metis/extensions/
	const localExtDir = path.join(getProjectConfigDir(resolvedCwd), "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with a Metis manifest, or index.ts.
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, resolvedCwd, eventBus);
}
