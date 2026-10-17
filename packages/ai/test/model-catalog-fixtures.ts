import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Model } from "../src/types.ts";
import { modelCatalogSourceFixture } from "./fixtures/model-catalog-source.ts";

let catalog: Record<string, Record<string, Model<Api>>> | undefined;

function fixtureCatalog(): Record<string, Record<string, Model<Api>>> {
	if (catalog) return catalog;
	const fixtureRoot = mkdtempSync(join(tmpdir(), "metis-model-catalog-fixture-"));
	try {
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		const isolatedPackage = join(fixtureRoot, "package");
		mkdirSync(isolatedPackage);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackage, entry), { recursive: true });
		}
		const preload = join(fixtureRoot, "catalog-fetch.mjs");
		writeFileSync(
			preload,
			`
const sources = ${JSON.stringify(modelCatalogSourceFixture)};
globalThis.fetch = async (input) => {
	const url = String(input);
	if (!Object.hasOwn(sources, url)) throw new Error("Unexpected catalog request: " + url);
	return new Response(JSON.stringify(sources[url]), { status: 200 });
};
`,
		);
		const output = join(fixtureRoot, "catalog");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preload).href,
				"scripts/generate-models.ts",
				"--strict",
				"--json-only",
				"--json-output",
				output,
			],
			{ cwd: isolatedPackage, encoding: "utf8", timeout: 10_000 },
		);
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`Fixture model generation failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
		}
		const generated: Record<string, Record<string, Model<Api>>> = JSON.parse(
			readFileSync(join(output, "models.json"), "utf8"),
		);
		catalog = generated;
		return generated;
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
}

export function getFixtureProviders(): string[] {
	return Object.keys(fixtureCatalog());
}

export function getFixtureModels(provider: string): Model<Api>[] {
	const models = fixtureCatalog()[provider];
	if (!models) throw new Error(`Missing fixture provider: ${provider}`);
	return structuredClone(Object.values(models));
}

export function getFixtureModel<TApi extends Api>(provider: string, id: string, api: TApi): Model<TApi> {
	const model = fixtureCatalog()[provider]?.[id];
	if (!model) throw new Error(`Missing fixture model: ${provider}/${id}`);
	if (model.api !== api) throw new Error(`Fixture ${provider}/${id} uses ${model.api}, expected ${api}`);
	return structuredClone(model) as Model<TApi>;
}
