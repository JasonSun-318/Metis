import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type ConfiguredPackage,
	DefaultPackageManager as Direct,
	type PackageManager as DirectPackageManager,
	type MissingSourceAction,
	type PackageUpdate,
	type PathMetadata,
	type ProgressCallback,
	type ProgressEvent,
	type ResolvedPaths,
	type ResolvedResource,
} from "../src/core/package-manager.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import {
	type PackageManager,
	DefaultPackageManager as Root,
	type PathMetadata as RootPathMetadata,
	type ProgressCallback as RootProgressCallback,
	type ProgressEvent as RootProgressEvent,
	type ResolvedPaths as RootResolvedPaths,
	type ResolvedResource as RootResolvedResource,
} from "../src/index.ts";

type LocalOptions = { local?: boolean };
type ExtensionSourceOptions = { local?: boolean; temporary?: boolean };

describe("package manager public contracts", () => {
	it("keeps the root class and old module path identical", () => {
		expect(Root).toBe(Direct);
		expectTypeOf<Root>().toEqualTypeOf<Direct>();
		expectTypeOf<PackageManager>().toEqualTypeOf<DirectPackageManager>();
	});

	it("keeps the root type exports aligned with the old module path", () => {
		expectTypeOf<PathMetadata>().toEqualTypeOf<RootPathMetadata>();
		expectTypeOf<ResolvedResource>().toEqualTypeOf<RootResolvedResource>();
		expectTypeOf<ResolvedPaths>().toEqualTypeOf<RootResolvedPaths>();
		expectTypeOf<ProgressEvent>().toEqualTypeOf<RootProgressEvent>();
		expectTypeOf<ProgressCallback>().toEqualTypeOf<RootProgressCallback>();
	});

	it("keeps every PackageManager method signature exact", () => {
		expectTypeOf<MissingSourceAction>().toEqualTypeOf<"install" | "skip" | "error">();
		expectTypeOf<PackageManager["resolve"]>().toEqualTypeOf<
			(onMissing?: (source: string) => Promise<MissingSourceAction>) => Promise<ResolvedPaths>
		>();
		expectTypeOf<PackageManager["install"]>().toEqualTypeOf<
			(source: string, options?: LocalOptions) => Promise<void>
		>();
		expectTypeOf<PackageManager["installAndPersist"]>().toEqualTypeOf<
			(source: string, options?: LocalOptions) => Promise<void>
		>();
		expectTypeOf<PackageManager["remove"]>().toEqualTypeOf<
			(source: string, options?: LocalOptions) => Promise<void>
		>();
		expectTypeOf<PackageManager["removeAndPersist"]>().toEqualTypeOf<
			(source: string, options?: LocalOptions) => Promise<boolean>
		>();
		expectTypeOf<PackageManager["update"]>().toEqualTypeOf<(source?: string) => Promise<void>>();
		expectTypeOf<PackageManager["listConfiguredPackages"]>().toEqualTypeOf<() => ConfiguredPackage[]>();
		expectTypeOf<PackageManager["resolveExtensionSources"]>().toEqualTypeOf<
			(sources: string[], options?: ExtensionSourceOptions) => Promise<ResolvedPaths>
		>();
		expectTypeOf<PackageManager["addSourceToSettings"]>().toEqualTypeOf<
			(source: string, options?: LocalOptions) => boolean
		>();
		expectTypeOf<PackageManager["removeSourceFromSettings"]>().toEqualTypeOf<
			(source: string, options?: LocalOptions) => boolean
		>();
		expectTypeOf<PackageManager["setProgressCallback"]>().toEqualTypeOf<
			(callback: ProgressCallback | undefined) => void
		>();
		expectTypeOf<PackageManager["getInstalledPath"]>().toEqualTypeOf<
			(source: string, scope: "user" | "project") => string | undefined
		>();
	});

	it("keeps the concrete class aligned and update-check specific to the class", () => {
		expectTypeOf<ConstructorParameters<typeof Direct>[0]>().toEqualTypeOf<{
			cwd: string;
			agentDir: string;
			settingsManager: SettingsManager;
		}>();
		expectTypeOf<Direct["checkForAvailableUpdates"]>().toEqualTypeOf<() => Promise<PackageUpdate[]>>();
		expectTypeOf<Pick<Direct, keyof PackageManager>>().toEqualTypeOf<PackageManager>();
		expectTypeOf<Direct["resolve"]>().toEqualTypeOf<PackageManager["resolve"]>();
		expectTypeOf<Direct["getInstalledPath"]>().toEqualTypeOf<PackageManager["getInstalledPath"]>();
	});

	it("compiles the real constructor and every public call site", () => {
		void compileOnlyManagerSurface;
	});
});

/**
 * Never invoked. These calls only make tsgo type-check the constructor options and
 * public parameter/return shapes against both the root class and the facade.
 */
function compileOnlyManagerSurface(): void {
	const settingsManager = {} as SettingsManager;
	const manager: PackageManager = new Root({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager,
	});
	const direct = new Direct({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager,
	});

	void manager.resolve(async (source) => {
		expectTypeOf(source).toEqualTypeOf<string>();
		return "install";
	});
	void manager.resolve(async () => "skip");
	void manager.resolve(async () => "error");
	void direct.resolve(async (source) => {
		const action: MissingSourceAction = "skip";
		void source;
		return action;
	});

	void manager.install("npm:demo", { local: true });
	void manager.installAndPersist("npm:demo", { local: true });
	void manager.remove("npm:demo", { local: true });
	void manager.removeAndPersist("npm:demo", { local: true }).then((removed) => {
		expectTypeOf(removed).toEqualTypeOf<boolean>();
	});
	void manager.update();
	void manager.update("npm:demo");
	for (const configured of manager.listConfiguredPackages()) {
		expectTypeOf(configured).toEqualTypeOf<ConfiguredPackage>();
	}
	void manager.resolveExtensionSources(["npm:demo"], { local: true, temporary: true });
	expectTypeOf(manager.addSourceToSettings("npm:demo", { local: true })).toEqualTypeOf<boolean>();
	expectTypeOf(manager.removeSourceFromSettings("npm:demo", { local: true })).toEqualTypeOf<boolean>();
	manager.setProgressCallback((event) => {
		expectTypeOf(event).toEqualTypeOf<ProgressEvent>();
	});
	manager.setProgressCallback(undefined);
	expectTypeOf(manager.getInstalledPath("npm:demo", "project")).toEqualTypeOf<string | undefined>();

	const updates: Promise<PackageUpdate[]> = direct.checkForAvailableUpdates();
	void updates;
	expectTypeOf(direct.getInstalledPath("npm:demo", "user")).toEqualTypeOf<string | undefined>();

	// @ts-expect-error getInstalledPath only accepts user/project, not the internal temporary scope.
	direct.getInstalledPath("npm:demo", "temporary");
	// @ts-expect-error checkForAvailableUpdates is not part of the PackageManager facade.
	manager.checkForAvailableUpdates();
}
