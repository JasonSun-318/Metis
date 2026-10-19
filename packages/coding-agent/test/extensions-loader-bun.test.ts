import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Real Bun acceptance for the extension loader.
 *
 * This test compiles the fixture runner into a native executable with
 * `bun build --compile` and executes it. It is skipped unless a Bun binary is
 * available through BUN_BINARY or PATH; a mocked Bun mode is not acceptance.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const runnerPath = path.join(testDir, "fixtures/extensions-loader-bun/runner.ts");
const themePackageDir = path.join(packageRoot, "src/modes/interactive");

function resolveBunBinary(): string | undefined {
	const explicit = process.env.BUN_BINARY;
	if (explicit) {
		return fs.existsSync(explicit) ? explicit : undefined;
	}
	try {
		const command = process.platform === "win32" ? "where" : "which";
		const found = execFileSync(command, ["bun"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
		return found && fs.existsSync(found) ? found : undefined;
	} catch {
		return undefined;
	}
}

const bunBinary = resolveBunBinary();
const bunVersion = bunBinary
	? execFileSync(bunBinary, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim()
	: undefined;

const extensionApiKeys = [
	"on",
	"registerTool",
	"registerCommand",
	"registerShortcut",
	"registerFlag",
	"registerMessageRenderer",
	"registerEntryRenderer",
	"getFlag",
	"sendMessage",
	"sendUserMessage",
	"appendEntry",
	"setSessionName",
	"getSessionName",
	"setLabel",
	"exec",
	"getActiveTools",
	"getAllTools",
	"setActiveTools",
	"getCommands",
	"setModel",
	"getThinkingLevel",
	"setThinkingLevel",
	"registerProvider",
	"unregisterProvider",
	"events",
].sort();

interface NamespaceCheck {
	specifier: string;
	names: string[];
	missing: string[];
	extra: string[];
	valueMismatches: string[];
}

interface AliasCheck {
	label: string;
	names: string[];
	missing: string[];
	extra: string[];
	valueMismatches: string[];
}

interface BunReport {
	bunVersion: string;
	isBunBinary: boolean;
	errors: Array<{ path: string; error: string }>;
	extensionCount: number;
	namespaces: NamespaceCheck[];
	aliases: AliasCheck[];
	apiKeys: string[];
	theme: {
		changed: boolean;
		dark: string;
		light: string;
		sameClassAsHost: boolean;
		hostStateAfterExtensionInit: string;
	};
	order: { steps: string[]; commandValue?: string; commandBoxValue?: string } | undefined;
	cache: Array<{ instance: number; factoryRun: number }>;
	failure: {
		errors: string[];
		extensionCount: number;
		recoveryErrors: Array<{ path: string; error: string }>;
		recoveryExtensionCount: number;
	};
	cacheAfterClear: { instance: number; factoryRun: number } | undefined;
}

describe.skipIf(!bunBinary)(`extension loader compiled Bun binary (${bunVersion ?? "Bun not available"})`, () => {
	it("loads file and package extensions with complete namespaces, value identity, theme state and cache semantics", () => {
		// The runner must not statically pre-import the public barrel; it imports
		// it only after the extension load so cold-start ordering is observable.
		expect(fs.readFileSync(runnerPath, "utf8")).not.toMatch(/^import\s+.*from\s+["'][^"']*src\/index\.ts["'];/m);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "metis-bun-loader-test-"));
		try {
			const outfile = path.join(root, "bun-loader-runner");
			execFileSync(bunBinary!, ["build", "--compile", runnerPath, "--outfile", outfile], {
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 300_000,
				maxBuffer: 16 * 1024 * 1024,
			});
			expect(fs.existsSync(outfile)).toBe(true);

			const raw = execFileSync(outfile, [], {
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 120_000,
				maxBuffer: 16 * 1024 * 1024,
				env: {
					...process.env,
					METIS_PACKAGE_DIR: themePackageDir,
				},
			});
			const report = JSON.parse(raw.trim().split("\n").at(-1)!) as BunReport;

			expect(report.bunVersion).toBe(bunVersion);
			expect(report.isBunBinary).toBe(true);
			expect(report.errors).toEqual([]);
			expect(report.extensionCount).toBe(2);

			expect(report.namespaces).toHaveLength(12);
			for (const namespace of report.namespaces) {
				expect(namespace.missing, namespace.specifier).toEqual([]);
				expect(namespace.extra, namespace.specifier).toEqual([]);
				expect(namespace.valueMismatches, namespace.specifier).toEqual([]);
			}
			expect(report.namespaces.find((namespace) => namespace.specifier === "@metis/coding-agent")!.names).toEqual(
				expect.arrayContaining([
					"createAgentSession",
					"permissionClaim",
					"permissionDescriptor",
					"discoverAndLoadExtensions",
				]),
			);

			expect(report.aliases).toHaveLength(4);
			for (const alias of report.aliases) {
				expect(alias.missing, alias.label).toEqual([]);
				expect(alias.extra, alias.label).toEqual([]);
				expect(alias.valueMismatches, alias.label).toEqual([]);
			}
			expect(report.apiKeys).toEqual(extensionApiKeys);

			// getMarkdownTheme() returns a plain MarkdownTheme object, not a Theme
			// instance; identity is checked on the exported Theme constructor. The
			// earlier CLI probe read `.text` (absent) and asserted instanceof Theme,
			// which produced meaningless false values rather than product evidence.
			expect(report.theme.changed).toBe(true);
			expect(report.theme.dark).not.toBe(report.theme.light);
			expect(report.theme.sameClassAsHost).toBe(true);
			expect(report.theme.hostStateAfterExtensionInit).toBe(report.theme.light);

			expect(report.order?.steps).toEqual([
				"state:module",
				"late:module",
				"entry:module:initial:initial",
				"factory:before:initial:initial",
				"factory:after:initial:advanced",
			]);
			// jiti transpiles local dependencies to CommonJS: mutable primitive
			// exports snapshot at import time, while object identity is shared.
			expect(report.order?.commandValue).toBe("initial");
			expect(report.order?.commandBoxValue).toBe("advanced");

			expect(report.cache).toEqual([
				{ instance: 1, factoryRun: 1 },
				{ instance: 1, factoryRun: 2 },
				{ instance: 2, factoryRun: 3 },
				{ instance: 3, factoryRun: 4 },
			]);
			expect(report.cacheAfterClear).toEqual({ instance: 4, factoryRun: 5 });

			expect(report.failure.errors).toHaveLength(1);
			expect(report.failure.errors[0]).toContain("intentional bun fixture factory failure");
			expect(report.failure.extensionCount).toBe(0);
			expect(report.failure.recoveryErrors).toEqual([]);
			expect(report.failure.recoveryExtensionCount).toBe(1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 300_000);
});
