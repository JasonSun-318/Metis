import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language, Node, Tree, Parser as TreeSitterParser } from "@vscode/tree-sitter-wasm";
import { isBunBinary } from "../../config.ts";

type TreeSitterModule = typeof import("@vscode/tree-sitter-wasm");
type ShellAnalysisLanguage = "bash" | "python" | "javascript";
type InlineScriptLanguage = Exclude<ShellAnalysisLanguage, "bash">;

const MAX_SOURCE_BYTES = 32 * 1024;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;
const PARSE_BUDGET_MS = 100;
const MANIFEST_NAME = "manifest.json";
const ASSET_PACKAGE = "@vscode/tree-sitter-wasm";
const ASSET_VERSION = "0.3.1";
const REQUIRED_ASSETS = [
	"tree-sitter.js",
	"tree-sitter.wasm",
	"tree-sitter-bash.wasm",
	"tree-sitter-python.wasm",
	"tree-sitter-javascript.wasm",
] as const;

export interface ShellParserStatus {
	readonly ready: boolean;
	readonly reason?: string;
}

export interface ParsedShellSyntax {
	readonly root: Node | null;
	readonly complete: boolean;
	readonly reason?: string;
	dispose(): void;
}

interface ShellAnalysisManifest {
	readonly schemaVersion?: unknown;
	readonly package?: unknown;
	readonly version?: unknown;
	readonly files?: unknown;
}

interface LoadedShellAnalysis {
	readonly runtime: TreeSitterModule;
	readonly languages: Readonly<Record<ShellAnalysisLanguage, Language>>;
}

let initialization: Promise<void> | undefined;
let loaded: LoadedShellAnalysis | undefined;
let status: ShellParserStatus = { ready: false, reason: "trusted shell analysis is not initialized" };

/**
 * The only asset locations the application trusts. Production never accepts an
 * asset directory argument, project-relative fallback, or network download.
 */
function shellAnalysisAssetDir(): string {
	if (isBunBinary) return join(dirname(process.execPath), "vendor", "shell-analysis");
	// Resolve from this installed module, never the environment-aware package
	// helper. A self-consistent manifest does not make an external runtime trusted.
	const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..").replace(
		/\.asar([\\/])/u,
		".asar.unpacked$1",
	);
	return join(packageDir, "dist", "vendor", "shell-analysis");
}

function incomplete(reason: string): ParsedShellSyntax {
	return { root: null, complete: false, reason, dispose() {} };
}

function readVerifiedAsset(directory: string, name: string): Buffer {
	const path = join(directory, name);
	if (!lstatSync(path).isFile()) {
		throw new Error(`trusted shell analysis asset is not a regular file: ${name}`);
	}
	return readFileSync(path);
}

function readVerifiedAssets(directory: string): ReadonlyMap<string, Buffer> {
	const manifest = JSON.parse(readVerifiedAsset(directory, MANIFEST_NAME).toString("utf8")) as ShellAnalysisManifest;
	if (
		manifest.schemaVersion !== 1 ||
		manifest.package !== ASSET_PACKAGE ||
		manifest.version !== ASSET_VERSION ||
		!Array.isArray(manifest.files)
	) {
		throw new Error("trusted shell analysis manifest is invalid");
	}
	const entries = new Map<string, { sha256?: unknown; bytes?: unknown }>();
	for (const value of manifest.files) {
		if (value && typeof value === "object" && "name" in value && typeof value.name === "string") {
			entries.set(value.name, value as { sha256?: unknown; bytes?: unknown });
		}
	}
	const assets = new Map<string, Buffer>();
	for (const name of REQUIRED_ASSETS) {
		const entry = entries.get(name);
		if (!entry || typeof entry.sha256 !== "string") {
			throw new Error(`trusted shell analysis manifest is missing ${name}`);
		}
		const bytes = readVerifiedAsset(directory, name);
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== entry.sha256 || bytes.byteLength !== entry.bytes) {
			throw new Error(`trusted shell analysis asset failed its integrity check: ${name}`);
		}
		assets.set(name, bytes);
	}
	if (entries.size !== REQUIRED_ASSETS.length) {
		throw new Error("trusted shell analysis manifest contains unexpected assets");
	}
	return assets;
}

function initializationReason(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/missing|ENOENT/iu.test(message)) return "trusted shell analysis assets are missing";
	if (/manifest|version|integrity|symlink|regular file/iu.test(message)) {
		return "trusted shell analysis assets failed validation";
	}
	return "trusted shell analysis runtime is unavailable";
}

async function loadShellAnalysis(): Promise<void> {
	try {
		const assetDir = shellAnalysisAssetDir();
		const assets = readVerifiedAssets(assetDir);
		const requireRuntime = createRequire(join(assetDir, "tree-sitter.js"));
		const runtime = requireRuntime(join(assetDir, "tree-sitter.js")) as TreeSitterModule;
		if (typeof runtime?.Parser?.init !== "function" || typeof runtime.Language?.load !== "function") {
			throw new Error("trusted shell analysis runtime does not export Parser and Language");
		}
		await runtime.Parser.init({ locateFile: () => join(assetDir, "tree-sitter.wasm") });
		const loadLanguage = async (name: string): Promise<Language> => {
			const bytes = assets.get(name);
			if (!bytes) throw new Error(`trusted shell analysis asset is missing: ${name}`);
			return runtime.Language.load(bytes);
		};
		const languages: Record<ShellAnalysisLanguage, Language> = {
			bash: await loadLanguage("tree-sitter-bash.wasm"),
			python: await loadLanguage("tree-sitter-python.wasm"),
			javascript: await loadLanguage("tree-sitter-javascript.wasm"),
		};
		// Exercise fixed, trusted syntax before an untrusted command starts its 100ms
		// budget. The first WASM invocation can otherwise turn a cold-start cost into
		// an incomplete claim that changes between authorization snapshots.
		for (const language of Object.values(languages)) {
			const parser = new runtime.Parser();
			let tree: Tree | null = null;
			try {
				parser.setLanguage(language);
				tree = parser.parse("true");
				if (!tree || tree.rootNode.hasError) throw new Error("trusted grammar initialization failed");
			} finally {
				tree?.delete();
				parser.delete();
			}
		}
		loaded = { runtime, languages };
		status = { ready: true };
	} catch (error) {
		loaded = undefined;
		status = { ready: false, reason: initializationReason(error) };
	}
}

/**
 * Initialize the trusted parser runtime once per process. Known asset failures
 * are recorded as unavailable instead of rejecting session construction.
 */
export function initializeShellAnalysis(): Promise<void> {
	initialization ??= loadShellAnalysis().catch(() => {
		loaded = undefined;
		status = { ready: false, reason: "trusted shell analysis runtime is unavailable" };
	});
	return initialization;
}

export function getShellParserStatus(): ShellParserStatus {
	return { ...status };
}

function inspectTree(root: Node, deadlineAt: number): string | undefined {
	const pending: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
	let nodes = 0;
	while (pending.length > 0) {
		if (Date.now() > deadlineAt) return "shell analysis exceeded the time budget";
		const current = pending.pop();
		if (!current) break;
		nodes += 1;
		if (nodes > MAX_NODES) return "shell syntax tree exceeds the node budget";
		if (current.depth > MAX_DEPTH) return "shell syntax exceeds the nesting budget";
		if (current.node.isError || current.node.isMissing) return "shell syntax is incomplete or invalid";
		for (let index = current.node.childCount - 1; index >= 0; index -= 1) {
			const child = current.node.child(index);
			if (child) {
				// Bash represents a flat &&/|| chain as left-associated list nodes.
				// Count actual nesting while the independent node budget bounds length.
				const associativeList = child.type === "list" && current.node.type === "list";
				pending.push({ node: child, depth: current.depth + (associativeList ? 0 : 1) });
			}
		}
	}
	return undefined;
}

function parseSyntax(source: string, language: ShellAnalysisLanguage, deadline?: number): ParsedShellSyntax {
	if (typeof source !== "string") return incomplete("shell analysis requires command text");
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
		return incomplete("command exceeds the 32 KiB shell analysis limit");
	}
	if (!loaded) return incomplete(status.reason ?? "trusted shell analysis is not initialized");

	const startedAt = Date.now();
	// An explicit deadline may only tighten the standalone parse budget, never extend it,
	// so nested parses share one absolute budget with the caller's traversal.
	const deadlineAt = Math.min(deadline ?? Number.POSITIVE_INFINITY, startedAt + PARSE_BUDGET_MS);
	const parser: TreeSitterParser = new loaded.runtime.Parser();
	let tree: Tree | null = null;
	let timedOut = false;
	try {
		parser.setLanguage(loaded.languages[language]);
		tree = parser.parse(source, undefined, {
			progressCallback: () => {
				if (Date.now() <= deadlineAt) return false;
				timedOut = true;
				return true;
			},
		});
	} catch {
		return incomplete("shell syntax could not be parsed");
	} finally {
		if (!tree) parser.reset();
		parser.delete();
	}
	if (!tree) {
		return incomplete(timedOut ? "shell analysis exceeded the time budget" : "shell syntax could not be parsed");
	}

	const reason = inspectTree(tree.rootNode, deadlineAt);
	if (reason) {
		tree.delete();
		return incomplete(reason);
	}
	let disposed = false;
	return {
		root: tree.rootNode,
		complete: true,
		dispose() {
			if (disposed) return;
			disposed = true;
			tree.delete();
		},
	};
}

function isBashShell(shellPath: string): boolean {
	const name = basename(shellPath.replaceAll("\\", "/")).toLowerCase();
	return name === "bash" || name === "bash.exe";
}

/**
 * Parse a complete Bash program without evaluating it. A null root always means
 * the caller must treat the command as incomplete and require review.
 */
export function parseShellSyntax(source: string, shellPath: string, deadline?: number): ParsedShellSyntax {
	if (!isBashShell(shellPath)) return incomplete(`unsupported shell for trusted analysis: ${basename(shellPath)}`);
	return parseSyntax(source, "bash", deadline);
}

/**
 * Reuse the same trusted runtime and budgets for literal Python/JavaScript
 * embedded in a shell command. Semantic analysis lives in script-analysis.ts.
 */
export function parseInlineScriptSyntax(
	source: string,
	language: InlineScriptLanguage,
	deadline?: number,
): ParsedShellSyntax {
	return parseSyntax(source, language, deadline);
}
