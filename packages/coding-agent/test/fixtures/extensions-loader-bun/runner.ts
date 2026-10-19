/**
 * Acceptance runner for the compiled Bun extension-loader path.
 *
 * This file is bundled with `bun build --compile` by
 * extensions-loader-bun.test.ts and then executed as a native binary. It imports
 * ONLY the loader before the fixture extension runs: the public package barrel is
 * imported afterwards, so a pre-imported host entrypoint cannot mask cold-start
 * initialization order. Other host namespaces are imported by the loader itself.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as agentCore from "@metis/agent-core";
import * as aiCompat from "@metis/ai/compat";
import * as aiOauth from "@metis/ai/oauth";
import * as tui from "@metis/tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import { isBunBinary } from "../../../src/config.ts";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";

type ModuleNamespace = Record<string, unknown>;

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

const namespaceKey = "__metisBunNamespaceProbe";
const orderKey = "__metisBunOrderProbe";
const cacheKey = "__metisBunCacheProbe";

const extensionSource = `
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

const compare = (label, left, right) => {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return {
    label,
    names: leftNames,
    missing: leftNames.filter((name) => !(name in right)),
    extra: rightNames.filter((name) => !(name in left)),
    valueMismatches: leftNames.filter((name) => !Object.is(left[name], right[name])),
  };
};

const themeSignature = (theme) =>
  [theme.heading, theme.link, theme.linkUrl, theme.code, theme.codeBlock, theme.quote, theme.hr]
    .map((render) => render("probe"))
    .join("|");

codingAgent.initTheme("dark");
const dark = themeSignature(codingAgent.getMarkdownTheme());
codingAgent.initTheme("light");
const light = themeSignature(codingAgent.getMarkdownTheme());

globalThis.${namespaceKey} = {
  namespaces: {
    "@metis/coding-agent": codingAgent,
    "@metis/ai": ai,
    "@metis/ai/compat": aiCompat,
    "@metis/ai/oauth": aiOauth,
    "@metis/agent-core": agentCore,
    "@metis/tui": tui,
    "typebox": typebox,
    "typebox/compile": typeboxCompile,
    "typebox/value": typeboxValue,
    "@sinclair/typebox": sinclairTypebox,
    "@sinclair/typebox/compile": sinclairTypeboxCompile,
    "@sinclair/typebox/value": sinclairTypeboxValue,
  },
  aliases: [
    compare("typebox", typebox, sinclairTypebox),
    compare("typebox/compile", typeboxCompile, sinclairTypeboxCompile),
    compare("typebox/value", typeboxValue, sinclairTypeboxValue),
    compare("@metis/ai", ai, aiCompat),
  ],
  apiKeys: [],
  theme: {
    changed: dark !== light,
    dark,
    light,
    themeClass: codingAgent.Theme,
  },
};

export default function (metis) {
  const probe = globalThis.${namespaceKey};
  probe.apiKeys = Object.keys(metis).sort();
}
`;

const packageStateSource = `
const state = (globalThis.${orderKey} ??= { steps: [] });
state.steps.push("state:module");
export let value = "initial";
export const box = { value: "initial" };
export function advance() { value = "advanced"; box.value = "advanced"; }
`;

const packageLateSource = `(globalThis.${orderKey} ??= { steps: [] }).steps.push("late:module");\n`;

const packageEntrySource = `
import { advance, box, value } from "./state.ts";
import "./late.ts";
const state = (globalThis.${orderKey} ??= { steps: [] });
state.steps.push("entry:module:" + value + ":" + box.value);
export default function (metis) {
  state.steps.push("factory:before:" + value + ":" + box.value);
  advance();
  state.steps.push("factory:after:" + value + ":" + box.value);
  metis.registerCommand("observed", { handler: async () => { state.commandValue = value; state.commandBoxValue = box.value; } });
}
`;

const failingExtensionSource = `
export default function () { throw new Error("intentional bun fixture factory failure"); }
`;

const recoveryExtensionSource = `
export default function (metis) { metis.registerCommand("recovered", { handler: async () => {} }); }
`;

const cacheExtensionSource = `
const state = (globalThis.${cacheKey} ??= { modules: 0, factories: 0, last: null });
const instance = ++state.modules;
export default function (metis) {
  const factoryRun = ++state.factories;
  metis.registerCommand("instance", { handler: async () => { state.last = { instance, factoryRun }; } });
}
`;

function compareNamespaces(label: string, observed: ModuleNamespace, expected: ModuleNamespace): NamespaceCheck {
	const observedNames = Object.keys(observed).sort();
	const expectedNames = Object.keys(expected).sort();
	return {
		specifier: label,
		names: observedNames,
		missing: expectedNames.filter((name) => !(name in observed)),
		extra: observedNames.filter((name) => !(name in expected)),
		valueMismatches: expectedNames.filter((name) => !Object.is(expected[name], observed[name])),
	};
}

function themeSignature(theme: {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	quote: (text: string) => string;
	hr: (text: string) => string;
}): string {
	return [theme.heading, theme.link, theme.linkUrl, theme.code, theme.codeBlock, theme.quote, theme.hr]
		.map((render) => render("probe"))
		.join("|");
}

async function main(): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "metis-bun-loader-"));
	try {
		const namespaceExtension = path.join(root, "namespace-probe.ts");
		fs.writeFileSync(namespaceExtension, extensionSource, "utf-8");
		const namespaceResult = await loadExtensions([namespaceExtension], root);
		if (namespaceResult.errors.length > 0) {
			throw new Error(`namespace extension failed: ${JSON.stringify(namespaceResult.errors)}`);
		}

		// Import the public barrel from the runner only after the extension load,
		// so the runner cannot initialize it ahead of the loader being tested.
		const hostRoot = (await import("../../../src/index.ts")) as unknown as ModuleNamespace;
		const expectedNamespaces: Record<string, ModuleNamespace> = {
			"@metis/coding-agent": hostRoot,
			"@metis/ai": aiCompat as unknown as ModuleNamespace,
			"@metis/ai/compat": aiCompat as unknown as ModuleNamespace,
			"@metis/ai/oauth": aiOauth as unknown as ModuleNamespace,
			"@metis/agent-core": agentCore as unknown as ModuleNamespace,
			"@metis/tui": tui as unknown as ModuleNamespace,
			typebox: typebox as unknown as ModuleNamespace,
			"typebox/compile": typeboxCompile as unknown as ModuleNamespace,
			"typebox/value": typeboxValue as unknown as ModuleNamespace,
			"@sinclair/typebox": typebox as unknown as ModuleNamespace,
			"@sinclair/typebox/compile": typeboxCompile as unknown as ModuleNamespace,
			"@sinclair/typebox/value": typeboxValue as unknown as ModuleNamespace,
		};
		const namespaceProbe = (globalThis as Record<string, unknown>)[namespaceKey] as {
			namespaces: Record<string, ModuleNamespace>;
			aliases: AliasCheck[];
			apiKeys: string[];
			theme: { changed: boolean; dark: string; light: string; themeClass: unknown };
		};
		const namespaces = Object.entries(namespaceProbe.namespaces).map(([specifier, namespace]) =>
			compareNamespaces(specifier, namespace, expectedNamespaces[specifier]!),
		);

		const packageDir = path.join(root, "live-package");
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "metis-bun-loader-live-package", type: "module" }),
			"utf-8",
		);
		fs.writeFileSync(path.join(packageDir, "state.ts"), packageStateSource, "utf-8");
		fs.writeFileSync(path.join(packageDir, "late.ts"), packageLateSource, "utf-8");
		fs.writeFileSync(path.join(packageDir, "index.ts"), packageEntrySource, "utf-8");
		const packageResult = await loadExtensions([packageDir], root);
		const order = (globalThis as Record<string, unknown>)[orderKey] as BunReport["order"];
		const observedCommand = packageResult.extensions[0]?.commands.get("observed");
		await observedCommand?.handler("", {} as never);

		const cacheExtension = path.join(root, "cache-instance.ts");
		fs.writeFileSync(cacheExtension, cacheExtensionSource, "utf-8");
		const firstCwd = path.join(root, "first-workspace");
		const secondCwd = path.join(root, "second-workspace");
		fs.mkdirSync(firstCwd, { recursive: true });
		fs.mkdirSync(secondCwd, { recursive: true });
		const loadAndRead = async (cwd: string) => {
			const result = await loadExtensionsCached([cacheExtension], cwd);
			await result.extensions[0]?.commands.get("instance")?.handler("", {} as never);
			const state = (globalThis as Record<string, unknown>)[cacheKey] as
				| { modules: number; factories: number; last: { instance: number; factoryRun: number } | null }
				| undefined;
			return state?.last;
		};
		clearExtensionCache();
		const cache = [
			await loadAndRead(firstCwd),
			await loadAndRead(firstCwd),
			await loadAndRead(secondCwd),
			await loadAndRead(firstCwd),
		].filter((entry): entry is { instance: number; factoryRun: number } => entry !== null && entry !== undefined);
		clearExtensionCache();
		const cacheAfterClear = (await loadAndRead(firstCwd)) ?? undefined;

		const failingPath = path.join(root, "failing.ts");
		fs.writeFileSync(failingPath, failingExtensionSource, "utf-8");
		const failingResult = await loadExtensions([failingPath], root);
		const recoveryPath = path.join(root, "recovery.ts");
		fs.writeFileSync(recoveryPath, recoveryExtensionSource, "utf-8");
		const recoveryResult = await loadExtensions([recoveryPath], root);

		const report: BunReport = {
			bunVersion: process.versions.bun ?? "unknown",
			isBunBinary,
			errors: [...namespaceResult.errors, ...packageResult.errors],
			extensionCount: namespaceResult.extensions.length + packageResult.extensions.length,
			namespaces,
			aliases: namespaceProbe.aliases,
			apiKeys: namespaceProbe.apiKeys,
			theme: {
				changed: namespaceProbe.theme.changed,
				dark: namespaceProbe.theme.dark,
				light: namespaceProbe.theme.light,
				sameClassAsHost: Object.is(namespaceProbe.theme.themeClass, (hostRoot as { Theme: unknown }).Theme),
				hostStateAfterExtensionInit: themeSignature(
					(hostRoot as { getMarkdownTheme: () => Parameters<typeof themeSignature>[0] }).getMarkdownTheme(),
				),
			},
			order: order
				? {
						steps: order.steps,
						commandValue: order.commandValue,
						commandBoxValue: order.commandBoxValue,
					}
				: undefined,
			cache,
			failure: {
				errors: failingResult.errors.map((error) => error.error),
				extensionCount: failingResult.extensions.length,
				recoveryErrors: recoveryResult.errors,
				recoveryExtensionCount: recoveryResult.extensions.length,
			},
			cacheAfterClear,
		};
		process.stdout.write(`${JSON.stringify(report)}\n`);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

await main();
