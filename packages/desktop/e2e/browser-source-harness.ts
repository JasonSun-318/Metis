import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication } from "@playwright/test";
import { build } from "esbuild";
import type { SourceBrowserApi } from "./browser-source-control.fixture.ts";

export async function launchSourceBrowser() {
	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-browser-source-"));
	let app: ElectronApplication | undefined;
	const close = async () => {
		try {
			if (app) {
				await app.evaluate(async () => (await globalThis.metisBrowserSourceReady).close()).catch(() => undefined);
				await app.close();
			}
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	};
	try {
		await Promise.all([mkdir(path.join(tempRoot, "profile")), mkdir(path.join(tempRoot, "agent"))]);
		await symlink(
			path.resolve(__dirname, "../../../node_modules"),
			path.join(tempRoot, "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const entry = path.join(tempRoot, "browser-source.mjs");
		const fixture = path.join(__dirname, "browser-source-control.fixture.ts");
		await build({
			entryPoints: [fixture],
			bundle: true,
			platform: "node",
			format: "esm",
			packages: "external",
			outfile: entry,
			target: "node24",
			tsconfigRaw: { compilerOptions: {} },
			plugins: [
				{
					name: "source-browser-contracts",
					setup(builder) {
						builder.onResolve({ filter: /^@metis\/ai$/ }, (args) =>
							args.importer === fixture
								? { path: path.resolve(__dirname, "../../ai/src/utils/validation.ts") }
								: { path: args.path, external: true },
						);
						builder.onResolve({ filter: /^@metis\/app-protocol$/ }, () => ({
							path: path.resolve(__dirname, "../../app-protocol/src/index.ts"),
						}));
					},
				},
			],
		});
		app = await _electron.launch({
			args: [entry, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
			env: {
				...process.env,
				METIS_BROWSER_SOURCE_PROFILE: path.join(tempRoot, "profile"),
				METIS_CODING_AGENT_DIR: path.join(tempRoot, "agent"),
			},
		});
		return { app, close };
	} catch (error) {
		await close();
		throw error;
	}
}

export function callSourceBrowser(app: ElectronApplication, name: string, args: Record<string, unknown>, actorId?: string) {
	return app.evaluate(
		async (_electron, input) => {
			const api: SourceBrowserApi = await globalThis.metisBrowserSourceReady;
			return api.call(input.name, input.args, input.actorId);
		},
		{ name, args, actorId },
	);
}
