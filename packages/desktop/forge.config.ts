import path from "node:path";
import { spawn } from "node:child_process";
import { access, chmod, cp, mkdir, rm } from "node:fs/promises";
import { type FuseConfig, FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";
import { MakerDMG, type MakerDMGConfig } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { namedHookWithTaskFn, PluginBase } from "@electron-forge/plugin-base";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";
import type { ForgeConfig, ForgeMultiHookMap } from "@electron-forge/shared-types";
import { isSignedBundledNativeTool, signBundledNativeTools } from "./scripts/native-tool-signing.ts";

/** Forge 7's published fuse plugin still peers on fuses v1; Electron 43 needs v2's ninth fuse. */
class CompleteFusesPlugin extends PluginBase<FuseConfig> {
	name = "complete-fuses";

	getHooks(): ForgeMultiHookMap {
		return {
			packageAfterCopy: namedHookWithTaskFn<"packageAfterCopy">(
				async (_task, resolvedForgeConfig, resourcesPath, _electronVersion, platform, arch) => {
					const apple = platform === "darwin" || platform === "mas";
					const basePath = path.resolve(resourcesPath, "../..");
					const executable = apple
						? path.join(basePath, "MacOS", "Electron")
						: path.join(basePath, platform === "win32" ? "electron.exe" : "electron");
					const signing = resolvedForgeConfig.packagerConfig.osxSign;
					const signed =
						(typeof signing === "object" && signing !== null && Object.keys(signing).length > 0) || Boolean(signing);
					await flipFuses(executable, {
						resetAdHocDarwinSignature: !signed && apple && arch === "arm64",
						...this.config,
					});
				},
				"Flipping complete Electron fuses",
			),
		};
	}
}

const desktopRoot = import.meta.dirname;
const repoRoot = path.resolve(desktopRoot, "../..");
const appServerRuntime = path.join(repoRoot, "node_modules", ".cache", "metis-desktop", "app-server");

function completeCredentialGroup(names: readonly string[]): Record<string, string> | undefined {
	const values = names.map((name) => process.env[name]);
	if (values.every((value) => !value)) return undefined;
	if (values.some((value) => !value)) throw new Error(`Incomplete release credential group: ${names.join(", ")}`);
	return Object.fromEntries(names.map((name, index) => [name, values[index]!])) as Record<string, string>;
}

const macosRelease = completeCredentialGroup([
	"MACOS_SIGN_IDENTITY",
	"APPLE_ID",
	"APPLE_APP_SPECIFIC_PASSWORD",
	"APPLE_TEAM_ID",
]);
const macosSign = macosRelease
	? {
			identity: macosRelease.MACOS_SIGN_IDENTITY,
			ignore: isSignedBundledNativeTool,
			optionsForFile: () => ({ hardenedRuntime: true }),
		}
	: process.platform === "darwin"
		? {
				identity: "-",
				ignore: isSignedBundledNativeTool,
				identityValidation: false,
				preAutoEntitlements: false,
				preEmbedProvisioningProfile: false,
				optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
			}
		: undefined;
const windowsCertificate = completeCredentialGroup(["WINDOWS_CERTIFICATE_FILE", "WINDOWS_CERTIFICATE_PASSWORD"]);
const windowsSign = windowsCertificate
	? {
			certificateFile: windowsCertificate.WINDOWS_CERTIFICATE_FILE,
			certificatePassword: windowsCertificate.WINDOWS_CERTIFICATE_PASSWORD,
			description: "Metis",
		}
	: undefined;
// appdmg's runtime schema supports `filesystem`, but its published TypeScript
// declaration omits the property.
const apfsDmgConfig = {
	background: path.join(desktopRoot, "assets", "dmg-background.png"),
	iconSize: 88,
	contents: (options: { appPath: string }) => [
		{ x: 178, y: 278, type: "file", path: options.appPath },
		{ x: 480, y: 278, type: "link", path: "/Applications" },
	],
	additionalDMGOptions: { filesystem: "APFS" },
} as unknown as MakerDMGConfig;

async function prepareAppServerRuntime(_forgeConfig: ForgeConfig, platform: string, arch: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(desktopRoot, "scripts", "prepare-app-server-runtime.mjs")], {
			cwd: repoRoot,
			env: { ...process.env, METIS_NATIVE_TOOLS_TARGET: `${platform}-${arch}` },
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`App-server runtime staging failed with exit code ${code}`));
		});
	});
}

async function stageNodePtyRuntime(buildPath: string, platform: string, arch: string): Promise<void> {
	const source = path.join(repoRoot, "node_modules", "node-pty");
	const target = path.join(buildPath, ".webpack", arch, "main", "node_modules", "node-pty");
	const platformTag = platform === "mas" ? "darwin" : platform;
	const prebuild = path.join(source, "prebuilds", `${platformTag}-${arch}`);
	const compiled = path.join(source, "build", "Release");
	const nativeSource = await access(prebuild).then(() => prebuild).catch(async () => {
		await access(compiled);
		return compiled;
	});
	const nativeTarget = nativeSource === prebuild
		? path.join(target, "prebuilds", `${platformTag}-${arch}`)
		: path.join(target, "build", "Release");
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	await Promise.all([
		cp(path.join(source, "lib"), path.join(target, "lib"), { recursive: true }),
		cp(path.join(source, "package.json"), path.join(target, "package.json")),
		cp(path.join(source, "LICENSE"), path.join(target, "LICENSE")),
		cp(nativeSource, nativeTarget, { recursive: true, filter: (entry) => !entry.endsWith(".pdb") }),
	]);
	// spawn-helper is only built for macOS (binding.gyp OS=="mac"); Linux ships pty.node alone.
	if (platformTag === "darwin") await chmod(path.join(nativeTarget, "spawn-helper"), 0o755);
}

async function stageRipgrepRuntime(buildPath: string, platform: string, arch: string): Promise<void> {
	const platformTag = platform === "mas" ? "darwin" : platform;
	if (platformTag !== "darwin" && platformTag !== "win32") return;
	const name = platformTag === "win32" ? "rg.exe" : "rg";
	const source = path.join(
		appServerRuntime,
		"node_modules",
		"@metis",
		"coding-agent",
		"dist",
		"vendor",
		"tools",
		`${platformTag}-${arch}`,
		name,
	);
	const target = path.join(buildPath, ".webpack", arch, "main", "native-tools", name);
	await mkdir(path.dirname(target), { recursive: true });
	await cp(source, target);
	if (platformTag !== "win32") await chmod(target, 0o755);
}

async function signNativeToolRuntime(buildPath: string, platform: string, arch: string): Promise<void> {
	if (platform !== "darwin" && platform !== "mas") return;
	const directory = path.join(
		buildPath, ".webpack", arch, "app-server", "node_modules", "@metis", "coding-agent",
		"dist", "vendor", "tools", `darwin-${arch}`,
	);
	await signBundledNativeTools(directory, async (binary) => {
		const entitlementFile = platform === "mas"
			? "default.mas.child.plist"
			: path.basename(binary) === "officecli" ? "default.darwin.plist" : undefined;
		const args = [
			"--force", "--sign", macosRelease?.MACOS_SIGN_IDENTITY ?? "-",
			"--identifier", `ai.metis.tool.${path.basename(binary)}`,
			// OfficeCLI needs JIT; rg/fd do not need the Electron runtime entitlements.
			...(macosRelease ? ["--options", "runtime", "--timestamp",
				...(entitlementFile ? ["--entitlements", path.join(repoRoot, "node_modules", "@electron", "osx-sign", "entitlements", entitlementFile)] : [])]
				: ["--timestamp=none"]), binary,
		];
		await new Promise<void>((resolve, reject) => {
			const child = spawn("/usr/bin/codesign", args, { stdio: "inherit" });
			child.once("error", reject);
			child.once("exit", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`Native-tool signing failed: ${path.basename(binary)}`));
			});
		});
	});
	console.log("Signed bundled native tools and sealed their manifest before ASAR creation");
}

const config: ForgeConfig = {
	packagerConfig: {
		asar: { unpackDir: "{.webpack/main/node_modules/node-pty,.webpack/main/native-tools,.webpack/app-server/node_modules/@metis/coding-agent/dist/vendor}" },
		// Electron Packager otherwise shares one global temp root. Concurrent
		// packaging jobs can delete each other's staging trees mid-ASAR creation.
		tmpdir: process.env.METIS_ELECTRON_PACKAGER_TMPDIR,
		appBundleId: "ai.metis.desktop",
		appCategoryType: "public.app-category.developer-tools",
		// macOS uses extraResource + CFBundleIconFile below instead of this option.
		icon: process.platform === "win32" ? path.join(desktopRoot, "assets", "metis.ico") : undefined,
		extraResource: process.platform === "darwin" ? [path.join(desktopRoot, "assets", "metis.icns")] : [],
		name: "Metis",
		executableName: "Metis",
		extendInfo: {
			CFBundleIconFile: "metis.icns",
			NSDesktopFolderUsageDescription: "Metis needs access to Desktop files you choose for a task.",
			NSDocumentsFolderUsageDescription: "Metis needs access to Documents files you choose for a task.",
			NSDownloadsFolderUsageDescription: "Metis needs access to Downloads files you choose for a task.",
		},
		// Even local builds need an app-owned identity so macOS TCC attributes
		// protected-folder consent to Metis instead of the stock Electron bundle.
		osxSign: macosSign,
		osxNotarize: macosRelease
			? {
					appleId: macosRelease.APPLE_ID,
					appleIdPassword: macosRelease.APPLE_APP_SPECIFIC_PASSWORD,
					teamId: macosRelease.APPLE_TEAM_ID,
				}
			: undefined,
		windowsSign,
	},
	hooks: {
		generateAssets: prepareAppServerRuntime,
		packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
			const target = path.join(buildPath, ".webpack", arch, "app-server");
			await rm(target, { recursive: true, force: true });
			await Promise.all([
				cp(appServerRuntime, target, { recursive: true, verbatimSymlinks: true }),
				stageNodePtyRuntime(buildPath, platform, arch),
				stageRipgrepRuntime(buildPath, platform, arch),
			]);
			await signNativeToolRuntime(buildPath, platform, arch);
		},
	},
	makers: [
		// An explicit unscoped name is required: electron-winstaller builds the
		// nuspec path from `name`, and a scoped name (@metis/desktop) turns the
		// slash into a directory separator on Windows, failing with ENOENT.
		// `authors` is required because nuget refuses to pack a nuspec without it.
		new MakerSquirrel({
			windowsSign,
			name: "Metis",
			authors: "Metis",
			setupIcon: path.join(desktopRoot, "assets", "metis.ico"),
		}),
		new MakerZIP({}),
		// APFS avoids appdmg's legacy `bless --openfolder` path, which fails when
		// an x64 Node process runs under Rosetta on Apple Silicon.
		new MakerDMG(apfsDmgConfig),
	],
	plugins: [
		new AutoUnpackNativesPlugin({}),
		new WebpackPlugin({
			mainConfig: "./webpack.main.config.ts",
			renderer: {
				config: "./webpack.renderer.config.ts",
				nodeIntegration: false,
				entryPoints: [
					{
						name: "main_window",
						html: "./src/renderer/index.html",
						js: "./src/renderer/index.tsx",
						preload: { js: "./src/preload.ts" },
					},
				],
			},
			devContentSecurityPolicy:
				"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob: ws://127.0.0.1:* ws://localhost:*",
		}),
		new CompleteFusesPlugin({
			version: FuseVersion.V1,
			strictlyRequireAllFuses: true,
			[FuseV1Options.RunAsNode]: false,
			[FuseV1Options.EnableCookieEncryption]: true,
			[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
			[FuseV1Options.EnableNodeCliInspectArguments]: false,
			[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
			[FuseV1Options.OnlyLoadAppFromAsar]: true,
			// Electron's stock bundle has the shared snapshot, not browser_v8_context_snapshot.bin.
			[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
			[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
			[FuseV1Options.WasmTrapHandlers]: true,
		}),
	],
};

export default config;
