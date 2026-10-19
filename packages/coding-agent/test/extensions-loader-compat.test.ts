import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The loader has two runtime modes:
 * - Node/dev: jiti aliases resolve workspace packages (agent/ai/tui use built dist).
 * - Bun bundled binary: static imports plus virtualModules resolve the exact
 *   namespaces bundled into the executable.
 *
 * Bun itself is not available in this environment. The virtual-module tests
 * therefore flip the loader's isBunBinary gate with a live module mock and
 * exercise the same virtualModules branch under Node/jiti. This validates the
 * map's names and values, not Bun's compiler/bundler behavior.
 */
let virtualModulesMode = false;

vi.mock("../src/config.ts", async () => {
	const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
	return {
		...actual,
		get isBunBinary() {
			return virtualModulesMode;
		},
	};
});

type ModuleNamespace = Record<string, unknown>;
type LoaderModule = typeof import("../src/core/extensions/loader.ts");

interface NamespaceSnapshot {
	names: string[];
	values: Record<string, unknown>;
}

interface AliasPairSnapshot {
	label: string;
	names: string[];
	missing: string[];
	extra: string[];
	mismatches: string[];
}

interface ProbeSnapshot {
	namespaces: Record<string, NamespaceSnapshot>;
	aliasPairs: AliasPairSnapshot[];
	apiKeys: string[];
}

interface SourceModules {
	root: ModuleNamespace;
	aiCompat: ModuleNamespace;
	aiOauth: ModuleNamespace;
	agentCore: ModuleNamespace;
	tui: ModuleNamespace;
	typebox: ModuleNamespace;
	typeboxCompile: ModuleNamespace;
	typeboxValue: ModuleNamespace;
}

interface AliasDistModules {
	aiCompat: ModuleNamespace;
	aiOauth: ModuleNamespace;
	agentCore: ModuleNamespace;
	tui: ModuleNamespace;
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const aliasDistPaths = [
	path.resolve(testDir, "../../ai/dist/compat.js"),
	path.resolve(testDir, "../../ai/dist/oauth.js"),
	path.resolve(testDir, "../../agent/dist/index.js"),
	path.resolve(testDir, "../../tui/dist/index.js"),
];
const aliasDistAvailable = aliasDistPaths.every((file) => fs.existsSync(file));
const compiledNodePaths = {
	loader: path.resolve(testDir, "../dist/core/extensions/loader.js"),
	root: path.resolve(testDir, "../dist/index.js"),
};
const compiledNodeLoaderAvailable =
	aliasDistAvailable && Object.values(compiledNodePaths).every((file) => fs.existsSync(file));

const probeKey = "__metisExtensionsLoaderCompatProbe";
const orderKey = "__metisExtensionsLoaderCompatOrder";
const cacheKey = "__metisExtensionsLoaderCompatCache";

const temporaryRoots: string[] = [];

function fixtureRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `metis-loader-compat-${label}-`));
	temporaryRoots.push(root);
	return root;
}

function resetGlobal(key: string): void {
	delete (globalThis as Record<string, unknown>)[key];
}

function readProbe(): ProbeSnapshot | undefined {
	return (globalThis as Record<string, unknown>)[probeKey] as ProbeSnapshot | undefined;
}

function readOrder(): { steps: string[]; commandValue?: string; commandBoxValue?: string } | undefined {
	return (globalThis as Record<string, unknown>)[orderKey] as
		| { steps: string[]; commandValue?: string; commandBoxValue?: string }
		| undefined;
}

interface CacheProbe {
	modules: number;
	factories: number;
	last: { instance: number; factoryRun: number } | null;
}

function readCache(): CacheProbe {
	const existing = (globalThis as Record<string, unknown>)[cacheKey] as CacheProbe | undefined;
	if (existing) return existing;
	const created: CacheProbe = { modules: 0, factories: 0, last: null };
	(globalThis as Record<string, unknown>)[cacheKey] = created;
	return created;
}

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

const namespaceProbeSource = `
import * as codingAgent from "@metis/coding-agent";
import * as ai from "@metis/ai";
import * as aiCompat from "@metis/ai/compat";
import * as aiOauth from "@metis/ai/oauth";
import * as agentCore from "@metis/agent-core";
import * as tui from "@metis/tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import * as sinclairTypebox from "@sinclair/typebox";
import * as sinclairTypeboxCompile from "@sinclair/typebox/compile";
import * as sinclairTypeboxValue from "@sinclair/typebox/value";

const probe = (globalThis.${probeKey} ??= {});
const record = (specifier, namespace) => {
  const names = Object.keys(namespace).sort();
  const values = {};
  for (const key of names) values[key] = namespace[key];
  probe.namespaces ??= {};
  probe.namespaces[specifier] = { names, values };
};

record("@metis/coding-agent", codingAgent);
record("@metis/ai", ai);
record("@metis/ai/compat", aiCompat);
record("@metis/ai/oauth", aiOauth);
record("@metis/agent-core", agentCore);
record("@metis/tui", tui);
record("typebox", typebox);
record("typebox/compile", typeboxCompile);
record("typebox/value", typeboxValue);
record("@sinclair/typebox", sinclairTypebox);
record("@sinclair/typebox/compile", sinclairTypeboxCompile);
record("@sinclair/typebox/value", sinclairTypeboxValue);

const compareAliases = (label, left, right) => {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  probe.aliasPairs ??= [];
  probe.aliasPairs.push({
    label,
    names: leftNames,
    missing: leftNames.filter((key) => !(key in right)),
    extra: rightNames.filter((key) => !(key in left)),
    mismatches: leftNames.filter((key) => !Object.is(left[key], right[key])),
  });
};

compareAliases("typebox", typebox, sinclairTypebox);
compareAliases("typebox/compile", typeboxCompile, sinclairTypeboxCompile);
compareAliases("typebox/value", typeboxValue, sinclairTypeboxValue);
compareAliases("@metis/ai", ai, aiCompat);

export default function (metis) {
  probe.apiKeys = Object.keys(metis).sort();
}
`;

function writeNamespaceProbe(root: string): string {
	const extensionPath = path.join(root, "namespace-probe.ts");
	fs.writeFileSync(extensionPath, namespaceProbeSource, "utf-8");
	return extensionPath;
}

let loader: LoaderModule;
let sourceModules: SourceModules;
let aliasDistModules: AliasDistModules | undefined;

beforeAll(async () => {
	loader = await import("../src/core/extensions/loader.ts");
	sourceModules = {
		root: (await import("../src/index.ts")) as unknown as ModuleNamespace,
		aiCompat: (await import("@metis/ai/compat")) as unknown as ModuleNamespace,
		aiOauth: (await import("@metis/ai/oauth")) as unknown as ModuleNamespace,
		agentCore: (await import("@metis/agent-core")) as unknown as ModuleNamespace,
		tui: (await import("@metis/tui")) as unknown as ModuleNamespace,
		typebox: (await import("typebox")) as unknown as ModuleNamespace,
		typeboxCompile: (await import("typebox/compile")) as unknown as ModuleNamespace,
		typeboxValue: (await import("typebox/value")) as unknown as ModuleNamespace,
	};
	if (aliasDistAvailable) {
		aliasDistModules = {
			// Built files are imported by explicit file URL: the source-import gate
			// rejects literal relative .js dynamic imports in TypeScript.
			aiCompat: (await import(pathToFileURL(aliasDistPaths[0]!).href)) as unknown as ModuleNamespace,
			aiOauth: (await import(pathToFileURL(aliasDistPaths[1]!).href)) as unknown as ModuleNamespace,
			agentCore: (await import(pathToFileURL(aliasDistPaths[2]!).href)) as unknown as ModuleNamespace,
			tui: (await import(pathToFileURL(aliasDistPaths[3]!).href)) as unknown as ModuleNamespace,
		};
	}
});

afterEach(() => {
	virtualModulesMode = false;
	loader.clearExtensionCache();
	resetGlobal(probeKey);
	resetGlobal(orderKey);
	resetGlobal(cacheKey);
});

afterAll(() => {
	for (const root of temporaryRoots.splice(0)) {
		if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
	}
});

async function loadNamespaceProbe(root: string): Promise<ProbeSnapshot> {
	const result = await loader.loadExtensions([writeNamespaceProbe(root)], root);
	expect(result.errors).toEqual([]);
	expect(result.extensions).toHaveLength(1);
	const snapshot = readProbe();
	expect(snapshot).toBeDefined();
	return snapshot!;
}

describe.skipIf(!aliasDistAvailable)("extension loader Node/jiti compatibility", () => {
	it("exposes the complete extension-visible module namespaces", async () => {
		const snapshot = await loadNamespaceProbe(fixtureRoot("node-names"));

		// Node aliases point agent/ai/tui at workspace dist, while the root alias
		// resolves to src/index.ts (jiti adds the .ts extension).
		const expectations: Array<[string, ModuleNamespace]> = [
			["@metis/coding-agent", sourceModules.root],
			["@metis/ai", aliasDistModules!.aiCompat],
			["@metis/ai/compat", aliasDistModules!.aiCompat],
			["@metis/ai/oauth", aliasDistModules!.aiOauth],
			["@metis/agent-core", aliasDistModules!.agentCore],
			["@metis/tui", aliasDistModules!.tui],
			["typebox", sourceModules.typebox],
			["typebox/compile", sourceModules.typeboxCompile],
			["typebox/value", sourceModules.typeboxValue],
			["@sinclair/typebox", sourceModules.typebox],
			["@sinclair/typebox/compile", sourceModules.typeboxCompile],
			["@sinclair/typebox/value", sourceModules.typeboxValue],
		];

		for (const [specifier, expected] of expectations) {
			const observed = snapshot.namespaces[specifier];
			expect(observed, specifier).toBeDefined();
			expect(observed!.names, specifier).toEqual(Object.keys(expected).sort());
		}

		// The exact namespace comparison above establishes the complete surface;
		// keep a few explicit names and the full ExtensionAPI key set as anchors.
		expect(snapshot.namespaces["@metis/coding-agent"]!.names).toEqual(
			expect.arrayContaining([
				"createAgentSession",
				"permissionClaim",
				"permissionDescriptor",
				"discoverAndLoadExtensions",
			]),
		);
		expect(snapshot.apiKeys).toEqual(extensionApiKeys);
	});

	it("keeps values identical across alias-equivalent specifiers", async () => {
		const snapshot = await loadNamespaceProbe(fixtureRoot("node-alias-values"));
		expect(snapshot.aliasPairs).toHaveLength(4);
		for (const pair of snapshot.aliasPairs) {
			expect(pair.names.length, pair.label).toBeGreaterThan(0);
			expect(pair.missing, `${pair.label} missing names`).toEqual([]);
			expect(pair.extra, `${pair.label} extra names`).toEqual([]);
			expect(pair.mismatches, `${pair.label} value identity`).toEqual([]);
		}
	});
});

describe("virtualModules (Bun-bundled path semantics)", () => {
	it("serves the exact static namespaces with value identity preserved", async () => {
		virtualModulesMode = true;
		const snapshot = await loadNamespaceProbe(fixtureRoot("virtual-names"));

		const expectations: Array<[string, ModuleNamespace]> = [
			["@metis/coding-agent", sourceModules.root],
			["@metis/ai", sourceModules.aiCompat],
			["@metis/ai/compat", sourceModules.aiCompat],
			["@metis/ai/oauth", sourceModules.aiOauth],
			["@metis/agent-core", sourceModules.agentCore],
			["@metis/tui", sourceModules.tui],
			["typebox", sourceModules.typebox],
			["typebox/compile", sourceModules.typeboxCompile],
			["typebox/value", sourceModules.typeboxValue],
			["@sinclair/typebox", sourceModules.typebox],
			["@sinclair/typebox/compile", sourceModules.typeboxCompile],
			["@sinclair/typebox/value", sourceModules.typeboxValue],
		];

		for (const [specifier, expected] of expectations) {
			const observed = snapshot.namespaces[specifier];
			expect(observed, specifier).toBeDefined();
			expect(observed!.names, specifier).toEqual(Object.keys(expected).sort());
			for (const name of observed!.names) {
				// Compare every value, not the namespace wrapper: jiti wraps each
				// import in its own interop Proxy, but the underlying bundled value
				// (and therefore extension-visible identity) must be unchanged.
				expect(observed!.values[name], `${specifier}#${name}`).toBe(expected[name]);
			}
		}
	});
});

describe("compiled Node loader (dist artifacts, not Bun)", () => {
	it.skipIf(!compiledNodeLoaderAvailable)(
		"loads through built dist/core/extensions/loader.js in a plain Node child with complete names and value identity",
		() => {
			const root = fixtureRoot("compiled-node");
			const extensionPath = writeNamespaceProbe(root);
			const scriptPath = path.join(root, "built-loader-probe.mjs");
			const builtUrls = {
				loader: pathToFileURL(compiledNodePaths.loader).href,
				root: pathToFileURL(compiledNodePaths.root).href,
				aiCompat: pathToFileURL(aliasDistPaths[0]!).href,
				aiOauth: pathToFileURL(aliasDistPaths[1]!).href,
				agentCore: pathToFileURL(aliasDistPaths[2]!).href,
				tui: pathToFileURL(aliasDistPaths[3]!).href,
			};
			fs.writeFileSync(
				scriptPath,
				`
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const loader = await import(${JSON.stringify(builtUrls.loader)});
const hostRoot = await import(${JSON.stringify(builtUrls.root)});
const hostAi = await import(${JSON.stringify(builtUrls.aiCompat)});
const hostOauth = await import(${JSON.stringify(builtUrls.aiOauth)});
const hostAgent = await import(${JSON.stringify(builtUrls.agentCore)});
const hostTui = await import(${JSON.stringify(builtUrls.tui)});
const require = createRequire(${JSON.stringify(builtUrls.loader)});
const loadTypebox = async (specifier) => import(pathToFileURL(require.resolve(specifier)).href);
const hostTypebox = await loadTypebox("typebox");
const hostTypeboxCompile = await loadTypebox("typebox/compile");
const hostTypeboxValue = await loadTypebox("typebox/value");

const result = await loader.loadExtensions([${JSON.stringify(extensionPath)}], ${JSON.stringify(root)});
const snapshot = globalThis[${JSON.stringify(probeKey)}];
const expectations = {
  "@metis/coding-agent": hostRoot,
  "@metis/ai": hostAi,
  "@metis/ai/compat": hostAi,
  "@metis/ai/oauth": hostOauth,
  "@metis/agent-core": hostAgent,
  "@metis/tui": hostTui,
  "typebox": hostTypebox,
  "typebox/compile": hostTypeboxCompile,
  "typebox/value": hostTypeboxValue,
  "@sinclair/typebox": hostTypebox,
  "@sinclair/typebox/compile": hostTypeboxCompile,
  "@sinclair/typebox/value": hostTypeboxValue,
};
const names = {};
const valueMismatches = {};
for (const [specifier, host] of Object.entries(expectations)) {
  const observed = snapshot?.namespaces?.[specifier];
  const expectedNames = Object.keys(host).sort();
  names[specifier] = Boolean(observed) && JSON.stringify(observed.names) === JSON.stringify(expectedNames);
  valueMismatches[specifier] = observed
    ? expectedNames.filter((name) => !Object.is(host[name], observed.values[name])).length
    : expectedNames.length;
}
console.log(JSON.stringify({
  snapshotPresent: Boolean(snapshot),
  errors: result.errors,
  extensionCount: result.extensions.length,
  names,
  valueMismatches,
  aliasPairs: snapshot?.aliasPairs ?? [],
  apiKeys: snapshot?.apiKeys ?? [],
}));
`,
				"utf-8",
			);

			const raw = execFileSync(process.execPath, ["--no-warnings", scriptPath], {
				cwd: root,
				encoding: "utf8",
				timeout: 120_000,
				maxBuffer: 4 * 1024 * 1024,
			});
			const output = JSON.parse(raw.trim().split("\n").at(-1)!) as {
				snapshotPresent: boolean;
				errors: Array<{ path: string; error: string }>;
				extensionCount: number;
				names: Record<string, boolean>;
				valueMismatches: Record<string, number>;
				aliasPairs: AliasPairSnapshot[];
				apiKeys: string[];
			};

			expect(output.snapshotPresent).toBe(true);
			expect(output.errors).toEqual([]);
			expect(output.extensionCount).toBe(1);
			expect(Object.keys(output.names)).toHaveLength(12);
			for (const [specifier, matches] of Object.entries(output.names)) {
				expect(matches, specifier).toBe(true);
			}
			expect(Object.keys(output.valueMismatches)).toHaveLength(12);
			for (const [specifier, mismatches] of Object.entries(output.valueMismatches)) {
				expect(mismatches, specifier).toBe(0);
			}
			expect(output.aliasPairs).toHaveLength(4);
			for (const pair of output.aliasPairs) {
				expect(pair.names.length, pair.label).toBeGreaterThan(0);
				expect(pair.missing, `${pair.label} missing names`).toEqual([]);
				expect(pair.extra, `${pair.label} extra names`).toEqual([]);
				expect(pair.mismatches, `${pair.label} value identity`).toEqual([]);
			}
			expect(output.apiKeys).toEqual(extensionApiKeys);
		},
	);
});

describe("extension loader file/package and cache compatibility", () => {
	it("loads package directory entries with observed initialization order, primitive snapshots and shared object state", async () => {
		const root = fixtureRoot("package");
		const packageDir = path.join(root, "live-package");
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "metis-loader-compat-live-package", type: "module" }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(packageDir, "state.ts"),
			[
				`const state = (globalThis.${orderKey} ??= { steps: [] });`,
				'state.steps.push("state:module");',
				'export let value = "initial";',
				'export const box = { value: "initial" };',
				'export function advance() { value = "advanced"; box.value = "advanced"; }',
				"",
			].join("\n"),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(packageDir, "late.ts"),
			`(globalThis.${orderKey} ??= { steps: [] }).steps.push("late:module");`,
			"utf-8",
		);
		fs.writeFileSync(
			path.join(packageDir, "index.ts"),
			[
				'import { advance, box, value } from "./state.ts";',
				'import "./late.ts";',
				`const state = (globalThis.${orderKey} ??= { steps: [] });`,
				'state.steps.push("entry:module:" + value + ":" + box.value);',
				"export default function (metis) {",
				'  state.steps.push("factory:before:" + value + ":" + box.value);',
				"  advance();",
				'  state.steps.push("factory:after:" + value + ":" + box.value);',
				'  metis.registerCommand("observed", { handler: async () => { state.commandValue = value; state.commandBoxValue = box.value; } });',
				"}",
				"",
			].join("\n"),
			"utf-8",
		);

		const result = await loader.loadExtensions([packageDir], root);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		const extension = result.extensions[0]!;
		expect(extension.sourceInfo.sourceIdentity).toBe(fs.realpathSync(path.join(packageDir, "index.ts")));
		expect(readOrder()?.steps).toEqual([
			"state:module",
			"late:module",
			"entry:module:initial:initial",
			"factory:before:initial:initial",
			"factory:after:initial:advanced",
		]);

		const command = extension.commands.get("observed");
		expect(command).toBeDefined();
		await command!.handler("", {} as never);
		// jiti transpiles local dependencies to CommonJS: mutable primitive exports
		// are snapshotted at import time, while exported object identity/state is
		// shared. Pin both halves so a loader/jiti change cannot silently alter it.
		expect(readOrder()?.commandValue).toBe("initial");
		expect(readOrder()?.commandBoxValue).toBe("advanced");

		const mainPackageDir = path.join(root, "main-package");
		fs.mkdirSync(mainPackageDir, { recursive: true });
		fs.writeFileSync(
			path.join(mainPackageDir, "package.json"),
			JSON.stringify({ name: "metis-loader-compat-main-package", type: "module", main: "./main.js" }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(mainPackageDir, "main.js"),
			'export default function (metis) { metis.registerCommand("main-entry", { handler: async () => {} }); }\n',
			"utf-8",
		);
		const mainResult = await loader.loadExtensions([mainPackageDir], root);
		expect(mainResult.errors).toEqual([]);
		expect(mainResult.extensions).toHaveLength(1);
		expect(mainResult.extensions[0]!.sourceInfo.sourceIdentity).toBe(
			fs.realpathSync(path.join(mainPackageDir, "main.js")),
		);
		expect(mainResult.extensions[0]!.commands.has("main-entry")).toBe(true);
	});

	it("reuses factories per cwd, reruns factories, and reinitializes across workspaces", async () => {
		const root = fixtureRoot("cache");
		const extensionPath = path.join(root, "instance.ts");
		fs.writeFileSync(
			extensionPath,
			[
				`const state = (globalThis.${cacheKey} ??= { modules: 0, factories: 0, last: null });`,
				"const instance = ++state.modules;",
				"export default function (metis) {",
				"  const factoryRun = ++state.factories;",
				'  metis.registerCommand("instance", {',
				"    handler: async () => { state.last = { instance, factoryRun }; },",
				"  });",
				"}",
				"",
			].join("\n"),
			"utf-8",
		);
		const firstCwd = path.join(root, "first-workspace");
		const secondCwd = path.join(root, "second-workspace");
		fs.mkdirSync(firstCwd, { recursive: true });
		fs.mkdirSync(secondCwd, { recursive: true });

		const loadAndRead = async (cwd: string) => {
			const result = await loader.loadExtensionsCached([extensionPath], cwd);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			const command = result.extensions[0]!.commands.get("instance");
			expect(command).toBeDefined();
			await command!.handler("", {} as never);
			return readCache().last!;
		};

		loader.clearExtensionCache();
		expect(await loadAndRead(firstCwd)).toEqual({ instance: 1, factoryRun: 1 });
		expect(await loadAndRead(firstCwd)).toEqual({ instance: 1, factoryRun: 2 });
		expect(await loadAndRead(secondCwd)).toEqual({ instance: 2, factoryRun: 3 });
		expect(await loadAndRead(firstCwd)).toEqual({ instance: 3, factoryRun: 4 });
	});

	it("invalidates cache tokens after clear and across cwd changes", () => {
		const root = fixtureRoot("generation");
		const firstCwd = path.join(root, "first");
		const secondCwd = path.join(root, "second");
		const cache = new loader.ExtensionModuleCache();
		const factory = (() => {}) as never;

		const firstToken = cache.begin(firstCwd);
		cache.set(firstToken, "extension", factory);
		expect(cache.get(firstToken, "extension")).toBe(factory);

		cache.clear();
		expect(cache.get(firstToken, "extension")).toBeUndefined();
		cache.set(firstToken, "extension", factory);
		expect(cache.get(firstToken, "extension")).toBeUndefined();

		const secondToken = cache.begin(firstCwd);
		expect(cache.get(secondToken, "extension")).toBeUndefined();
		cache.set(secondToken, "extension", factory);
		expect(cache.get(secondToken, "extension")).toBe(factory);

		const thirdToken = cache.begin(secondCwd);
		expect(cache.get(secondToken, "extension")).toBeUndefined();
		expect(cache.get(thirdToken, "extension")).toBeUndefined();
	});
});
