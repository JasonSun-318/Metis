import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdater } from "../src/main/updater.ts";

const BASE_URL = "https://updates.example.test/metis";
const VERSION = "0.80.6";
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "metis-updater-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function manifest(version: string, dmg: Uint8Array, hash = sha256(dmg)) {
	return {
		schemaVersion: 1,
		version,
		publishedAt: "2026-08-10T00:00:00.000Z",
		dmg: {
			url: `${BASE_URL}/darwin/arm64/releases/${version}/Metis-${version}-darwin-arm64.dmg`,
			size: dmg.byteLength,
			sha256: hash,
		},
	};
}

async function harness(
	options: {
		readonly dmg?: Uint8Array;
		readonly manifest?: ReturnType<typeof manifest>;
		readonly isPackaged?: boolean;
		readonly platform?: NodeJS.Platform;
		readonly arch?: string;
		readonly baseUrl?: string;
	} = {},
) {
	const dmg = options.dmg ?? new TextEncoder().encode("verified Metis disk image");
	const release = options.manifest ?? manifest("0.81.0", dmg);
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify(release), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)
		.mockResolvedValueOnce(
			new Response(dmg.buffer as ArrayBuffer, {
				headers: { "content-length": String(dmg.byteLength) },
				status: 200,
			}),
		);
	const openPath = vi.fn(async (_path: string) => "");
	const onDiagnostic = vi.fn();
	const states: unknown[] = [];
	const downloadsDirectory = await temporaryDirectory();
	const updater = new DesktopUpdater({
		arch: options.arch ?? "arm64",
		baseUrl: options.baseUrl ?? BASE_URL,
		currentVersion: VERSION,
		downloadsDirectory,
		fetch,
		isPackaged: options.isPackaged ?? true,
		onDiagnostic,
		onState: (state) => states.push(state),
		openPath,
		platform: options.platform ?? "darwin",
	});
	return { dmg, downloadsDirectory, fetch, onDiagnostic, openPath, states, updater };
}

describe("DesktopUpdater", () => {
	it("stays unavailable outside packaged macOS on a supported architecture", async () => {
		for (const options of [{ isPackaged: false }, { platform: "win32" as const }, { arch: "ia32" }]) {
			const { fetch, updater } = await harness(options);
			expect(updater.start()).toBe(false);
			expect(updater.view()).toEqual({ status: "unavailable" });
			expect(fetch).not.toHaveBeenCalled();
		}
	});

	it("rejects update bases that are not credential-free HTTPS URLs", async () => {
		for (const baseUrl of [
			"http://updates.example.test/metis",
			"https://token@updates.example.test/metis",
			"not a URL",
		]) {
			const { updater } = await harness({ baseUrl });
			expect(updater.start()).toBe(false);
		}
	});

	it.each(["0.80.5", "0.80.6"])("hides releases that are not newer than %s", async (remoteVersion) => {
		const dmg = new TextEncoder().encode("old release");
		const { updater } = await harness({ manifest: manifest(remoteVersion, dmg), dmg });
		expect(updater.start()).toBe(true);
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "unavailable" }));
	});

	it("announces a newer release after validating the manifest", async () => {
		const { fetch, states, updater } = await harness();
		expect(updater.start()).toBe(true);
		expect(updater.view()).toEqual({ status: "checking" });
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "available", version: "0.81.0" }));
		expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/darwin/arm64/latest.json`, { cache: "no-store" });
		expect(states).toContainEqual({ status: "available", version: "0.81.0" });
	});

	it("hides malformed or cross-origin releases without interrupting the app", async () => {
		const dmg = new TextEncoder().encode("untrusted release");
		const release = manifest("0.81.0", dmg);
		release.dmg.url = "https://attacker.example/Metis.dmg";
		const { onDiagnostic, updater } = await harness({ dmg, manifest: release });
		updater.start();
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "unavailable" }));
		expect(onDiagnostic).toHaveBeenCalledWith("Update check failed");
	});

	it("downloads once, reports progress, verifies the DMG, and reopens the verified file", async () => {
		const { dmg, fetch, openPath, states, updater } = await harness();
		updater.start();
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "available", version: "0.81.0" }));

		await Promise.all([updater.downloadAndOpen(), updater.downloadAndOpen()]);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(openPath).toHaveBeenCalledTimes(1);
		const openedPath = openPath.mock.calls[0]?.[0];
		expect(openedPath).toMatch(/Metis-0\.81\.0-darwin-arm64\.dmg$/u);
		expect(await readFile(openedPath!)).toEqual(Buffer.from(dmg));
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
		expect(states).toContainEqual({ status: "downloading", version: "0.81.0", progress: 100 });

		await updater.downloadAndOpen();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(openPath).toHaveBeenCalledTimes(2);
	});

	it("re-verifies a ready DMG and downloads it again if the file was replaced", async () => {
		const { dmg, fetch, openPath, updater } = await harness();
		updater.start();
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "available", version: "0.81.0" }));
		await updater.downloadAndOpen();
		const openedPath = openPath.mock.calls[0]?.[0];
		await writeFile(openedPath!, "replaced after verification");
		fetch.mockResolvedValueOnce(
			new Response(dmg.buffer as ArrayBuffer, {
				headers: { "content-length": String(dmg.byteLength) },
				status: 200,
			}),
		);

		await updater.downloadAndOpen();

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(openPath).toHaveBeenCalledTimes(2);
		expect(await readFile(openedPath!)).toEqual(Buffer.from(dmg));
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
	});

	it("deletes a corrupt partial download and keeps the update retryable", async () => {
		const dmg = new TextEncoder().encode("corrupt release");
		const release = manifest("0.81.0", dmg, "0".repeat(64));
		const { downloadsDirectory, onDiagnostic, openPath, updater } = await harness({ dmg, manifest: release });
		updater.start();
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "available", version: "0.81.0" }));

		await expect(updater.downloadAndOpen()).rejects.toThrow("Downloaded update failed verification");
		expect(updater.view()).toEqual({ status: "available", version: "0.81.0" });
		expect(openPath).not.toHaveBeenCalled();
		expect(onDiagnostic).toHaveBeenCalledWith("Update download failed");
		const files = await readdir(downloadsDirectory);
		expect(files).toEqual([]);
	});
});
