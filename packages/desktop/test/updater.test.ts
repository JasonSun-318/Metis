import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdater } from "../src/main/updater.ts";

const BASE_URL = "https://updates.example.test/metis";
const VERSION = "0.80.6";
const temporaryDirectories: string[] = [];
const updaters: DesktopUpdater[] = [];

afterEach(async () => {
	for (const updater of updaters.splice(0)) updater.stop();
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
		readonly checkIntervalMs?: number;
		readonly fetch?: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
	} = {},
) {
	const dmg = options.dmg ?? new TextEncoder().encode("verified Metis disk image");
	const release = options.manifest ?? manifest("0.81.0", dmg);
	const fetch =
		options.fetch ??
		vi
			.fn<(input: string, init?: RequestInit) => Promise<Response>>()
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
		fetch: (input, init) => fetch(input, init),
		isPackaged: options.isPackaged ?? true,
		onDiagnostic,
		onState: (state) => states.push(state),
		openPath,
		platform: options.platform ?? "darwin",
		checkIntervalMs: options.checkIntervalMs ?? 0,
	});
	updaters.push(updater);
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
		expect(fetch).toHaveBeenCalledWith(
			`${BASE_URL}/darwin/arm64/latest.json`,
			expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
		);
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

	it("rechecks on an interval without requiring a restart", async () => {
		const dmg = new TextEncoder().encode("later release");
		let checks = 0;
		const fetch = vi.fn(async () => {
			checks += 1;
			return new Response(JSON.stringify(manifest(checks === 1 ? "0.80.6" : "0.81.0", dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		});
		const { updater } = await harness({ checkIntervalMs: 20, dmg, fetch });
		expect(updater.start()).toBe(true);
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "available", version: "0.81.0" }));
		updater.stop();
		expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("keeps an available update if a later check fails", async () => {
		const { fetch, updater } = await harness({ checkIntervalMs: 20 });
		updater.start();
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "available", version: "0.81.0" }));
		fetch.mockRejectedValue(new Error("offline"));
		await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2));
		updater.stop();
		expect(updater.view()).toEqual({ status: "available", version: "0.81.0" });
	});

	it("fetches a newer release on manual check after starting with no update", async () => {
		const dmg = new TextEncoder().encode("manual release");
		let check = 0;
		const fetch = vi.fn(async () => {
			check += 1;
			const version = check === 1 ? VERSION : "0.81.0";
			return new Response(JSON.stringify(manifest(version, dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		});
		const { updater } = await harness({ dmg, fetch });
		expect(updater.start()).toBe(true);
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "unavailable" }));
		expect(fetch).toHaveBeenCalledTimes(1);

		const result = await updater.checkForUpdate();
		expect(result).toEqual({ status: "available", version: "0.81.0" });
		expect(updater.view()).toEqual({ status: "available", version: "0.81.0" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("deduplicates concurrent checks into a single fetch and allows checking again after completion", async () => {
		let resolveFetch: ((res: Response) => void) | undefined;
		const fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const { updater } = await harness({ fetch });
		updater.start();
		const check1 = updater.checkForUpdate();
		const check2 = updater.checkForUpdate();
		expect(fetch).toHaveBeenCalledTimes(1);

		const dmg = new TextEncoder().encode("concurrent release");
		resolveFetch!(
			new Response(JSON.stringify(manifest("0.81.0", dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		const [res1, res2] = await Promise.all([check1, check2]);
		expect(res1).toEqual({ status: "available", version: "0.81.0" });
		expect(res2).toEqual({ status: "available", version: "0.81.0" });
		expect(fetch).toHaveBeenCalledTimes(1);

		fetch.mockResolvedValueOnce(
			new Response(JSON.stringify(manifest("0.81.0", dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		await updater.checkForUpdate();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("returns unavailable when up-to-date, but rejects on network/HTTP/manifest error", async () => {
		const dmg = new TextEncoder().encode("up-to-date");
		const fetchUpToDate = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(manifest(VERSION, dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		const { updater: upToDateUpdater } = await harness({ dmg, fetch: fetchUpToDate });
		await expect(upToDateUpdater.checkForUpdate()).resolves.toEqual({ status: "unavailable" });

		const fetchNetworkError = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
		const { updater: networkUpdater } = await harness({ fetch: fetchNetworkError });
		await expect(networkUpdater.checkForUpdate()).rejects.toThrow("Failed to fetch");

		const fetchHttpError = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
		const { updater: httpUpdater } = await harness({ fetch: fetchHttpError });
		await expect(httpUpdater.checkForUpdate()).rejects.toThrow("Update manifest request failed with 500");

		const fetchBadManifest = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ schemaVersion: 999 }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		const { updater: badManifestUpdater } = await harness({ fetch: fetchBadManifest });
		await expect(badManifestUpdater.checkForUpdate()).rejects.toThrow("Invalid update manifest");
	});

	it("preserves existing available and ready states on manual check failure and allows retry", async () => {
		const dmg = new TextEncoder().encode("state test");
		const fetch = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify(manifest("0.81.0", dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		const { updater } = await harness({ dmg, fetch });
		await updater.checkForUpdate();
		expect(updater.view()).toEqual({ status: "available", version: "0.81.0" });

		fetch.mockRejectedValueOnce(new Error("offline"));
		await expect(updater.checkForUpdate()).rejects.toThrow("offline");
		expect(updater.view()).toEqual({ status: "available", version: "0.81.0" });

		fetch.mockResolvedValueOnce(
			new Response(JSON.stringify(manifest("0.81.0", dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		await expect(updater.checkForUpdate()).resolves.toEqual({ status: "available", version: "0.81.0" });

		fetch.mockResolvedValueOnce(
			new Response(dmg.buffer as ArrayBuffer, {
				headers: { "content-length": String(dmg.byteLength) },
				status: 200,
			}),
		);
		await updater.downloadAndOpen();
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });

		fetch.mockRejectedValueOnce(new Error("offline"));
		await expect(updater.checkForUpdate()).rejects.toThrow("offline");
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
	});

	it("ignores checks during download without issuing a fetch or resetting progress", async () => {
		const dmg = new TextEncoder().encode("downloading progress test");
		let releaseChunk: (() => void) | undefined;
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(dmg.subarray(0, 5));
				releaseChunk = () => {
					controller.enqueue(dmg.subarray(5));
					controller.close();
				};
			},
		});
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(manifest("0.81.0", dmg)), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(stream, {
					headers: { "content-length": String(dmg.byteLength) },
					status: 200,
				}),
			);
		const { updater } = await harness({ dmg, fetch });
		await updater.checkForUpdate();
		const downloadPromise = updater.downloadAndOpen();
		await vi.waitFor(() => expect(updater.view().status).toBe("downloading"));
		const downloadingView = updater.view();

		const checkResult = await updater.checkForUpdate();
		expect(checkResult).toEqual(downloadingView);
		expect(fetch).toHaveBeenCalledTimes(2);

		releaseChunk!();
		await downloadPromise;
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
	});

	it("interleaves check then download: check returning older manifest during download does not overwrite state and allows opening ready installer", async () => {
		const dmg = new TextEncoder().encode("interleaved older release");
		let releaseChunk: (() => void) | undefined;
		let releaseCheck: (() => void) | undefined;
		let checks = 0;
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(dmg.subarray(0, 5));
				releaseChunk = () => {
					controller.enqueue(dmg.subarray(5));
					controller.close();
				};
			},
		});
		const fetch = vi.fn(async (url: string) => {
			if (url.endsWith("latest.json")) {
				checks += 1;
				if (checks === 1) {
					return new Response(JSON.stringify(manifest("0.81.0", dmg)), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}
				await new Promise<void>((resolve) => {
					releaseCheck = resolve;
				});
				// Remote returned older version (0.80.6) while download of 0.81.0 is in flight
				return new Response(JSON.stringify(manifest(VERSION, dmg)), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			}
			return new Response(stream, {
				headers: { "content-length": String(dmg.byteLength) },
				status: 200,
			});
		});
		const { openPath, updater } = await harness({ dmg, fetch });
		await updater.checkForUpdate();
		expect(updater.view()).toEqual({ status: "available", version: "0.81.0" });

		// 1. Start check first
		const checkPromise = updater.checkForUpdate();
		// 2. Start download second while check fetch is pending
		const downloadPromise = updater.downloadAndOpen();
		await vi.waitFor(() => expect(updater.view().status).toBe("downloading"));

		// 3. Resolve the pending check with the older manifest
		releaseCheck!();
		await checkPromise;
		// Downloading status and manifest should NOT be overwritten by the check
		expect(updater.view().status).toBe("downloading");

		// 4. Finish the download
		releaseChunk!();
		await downloadPromise;
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
		expect(openPath).toHaveBeenCalledTimes(1);

		// 5. Subsequent open must succeed without throwing "No desktop update is available"
		await updater.downloadAndOpen();
		expect(openPath).toHaveBeenCalledTimes(2);
	});

	it("interleaves check then download: check returning same manifest during download preserves download and installer", async () => {
		const dmg = new TextEncoder().encode("interleaved same release");
		let releaseChunk: (() => void) | undefined;
		let releaseCheck: (() => void) | undefined;
		let checks = 0;
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(dmg.subarray(0, 5));
				releaseChunk = () => {
					controller.enqueue(dmg.subarray(5));
					controller.close();
				};
			},
		});
		const fetch = vi.fn(async (url: string) => {
			if (url.endsWith("latest.json")) {
				checks += 1;
				if (checks === 1) {
					return new Response(JSON.stringify(manifest("0.81.0", dmg)), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}
				await new Promise<void>((resolve) => {
					releaseCheck = resolve;
				});
				return new Response(JSON.stringify(manifest("0.81.0", dmg)), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			}
			return new Response(stream, {
				headers: { "content-length": String(dmg.byteLength) },
				status: 200,
			});
		});
		const { openPath, updater } = await harness({ dmg, fetch });
		await updater.checkForUpdate();
		const checkPromise = updater.checkForUpdate();
		const downloadPromise = updater.downloadAndOpen();
		await vi.waitFor(() => expect(updater.view().status).toBe("downloading"));

		releaseCheck!();
		await checkPromise;
		expect(updater.view().status).toBe("downloading");

		releaseChunk!();
		await downloadPromise;
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
		expect(openPath).toHaveBeenCalledTimes(1);

		await updater.downloadAndOpen();
		expect(openPath).toHaveBeenCalledTimes(2);
	});

	it("interleaves check then download: check returning newer manifest during download does not disrupt active download", async () => {
		const dmg = new TextEncoder().encode("interleaved newer release");
		const dmgNew = new TextEncoder().encode("future newer release");
		let releaseChunk: (() => void) | undefined;
		let releaseCheck: (() => void) | undefined;
		let checks = 0;
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(dmg.subarray(0, 5));
				releaseChunk = () => {
					controller.enqueue(dmg.subarray(5));
					controller.close();
				};
			},
		});
		const fetch = vi.fn(async (url: string) => {
			if (url.endsWith("latest.json")) {
				checks += 1;
				if (checks === 1) {
					return new Response(JSON.stringify(manifest("0.81.0", dmg)), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}
				if (checks === 2) {
					await new Promise<void>((resolve) => {
						releaseCheck = resolve;
					});
					// While 0.81.0 is downloading, remote announced 0.82.0
					return new Response(JSON.stringify(manifest("0.82.0", dmgNew)), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}
				return new Response(JSON.stringify(manifest("0.82.0", dmgNew)), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			}
			return new Response(stream, {
				headers: { "content-length": String(dmg.byteLength) },
				status: 200,
			});
		});
		const { openPath, updater } = await harness({ dmg, fetch });
		await updater.checkForUpdate();
		const checkPromise = updater.checkForUpdate();
		const downloadPromise = updater.downloadAndOpen();
		await vi.waitFor(() => expect(updater.view().status).toBe("downloading"));

		releaseCheck!();
		await checkPromise;
		expect(updater.view().status).toBe("downloading");

		releaseChunk!();
		await downloadPromise;
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
		expect(openPath).toHaveBeenCalledTimes(1);

		// Verified opening the downloaded 0.81.0 installer succeeds
		await updater.downloadAndOpen();
		expect(openPath).toHaveBeenCalledTimes(2);

		// Now subsequent check detects the newer 0.82.0
		const nextCheck = await updater.checkForUpdate();
		expect(nextCheck).toEqual({ status: "available", version: "0.82.0" });
		expect(updater.view()).toEqual({ status: "available", version: "0.82.0" });
	});

	it("keeps verified DMG on same or lower remote version, and switches to available on higher remote version", async () => {
		const dmg = new TextEncoder().encode("ready version test");
		const dmgNew = new TextEncoder().encode("newer ready version test");
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(manifest("0.81.0", dmg)), {
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
		const { openPath, updater } = await harness({ dmg, fetch });
		await updater.checkForUpdate();
		await updater.downloadAndOpen();
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
		expect(openPath).toHaveBeenCalledTimes(1);

		// Remote serves same version 0.81.0 -> stays ready, can open again
		fetch.mockResolvedValueOnce(
			new Response(JSON.stringify(manifest("0.81.0", dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		await updater.checkForUpdate();
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
		await updater.downloadAndOpen();
		expect(openPath).toHaveBeenCalledTimes(2);

		// Remote rolls back to 0.80.7 (higher than current app 0.80.6, but lower than ready 0.81.0)
		fetch.mockResolvedValueOnce(
			new Response(JSON.stringify(manifest("0.80.7", dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		await updater.checkForUpdate();
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });
		await updater.downloadAndOpen();
		expect(openPath).toHaveBeenCalledTimes(3);

		// Remote rolls back to 0.80.6 (same as app version) -> stays ready
		fetch.mockResolvedValueOnce(
			new Response(JSON.stringify(manifest("0.80.6", dmg)), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		await updater.checkForUpdate();
		expect(updater.view()).toEqual({ status: "ready", version: "0.81.0" });

		// Remote serves higher version 0.82.0 -> transitions to available
		fetch
			.mockResolvedValueOnce(
				new Response(JSON.stringify(manifest("0.82.0", dmgNew)), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(dmgNew.buffer as ArrayBuffer, {
					headers: { "content-length": String(dmgNew.byteLength) },
					status: 200,
				}),
			);
		await updater.checkForUpdate();
		expect(updater.view()).toEqual({ status: "available", version: "0.82.0" });
		await updater.downloadAndOpen();
		expect(updater.view()).toEqual({ status: "ready", version: "0.82.0" });
		expect(openPath).toHaveBeenCalledTimes(4);
	});

	it("rejects manual check when unpackaged, on unsupported platform, or without valid base URL", async () => {
		for (const options of [
			{ isPackaged: false },
			{ platform: "win32" as const },
			{ arch: "ia32" },
			{ baseUrl: "http://insecure.example.test" },
		]) {
			const { fetch, updater } = await harness(options);
			await expect(updater.checkForUpdate()).rejects.toThrow("Update checks are unavailable in this build");
			expect(fetch).not.toHaveBeenCalled();
			expect(updater.view()).toEqual({ status: "unavailable" });
		}
	});

	it("records diagnostic without unhandled rejection when startup check fails", async () => {
		const fetch = vi.fn().mockRejectedValue(new Error("network down"));
		const { onDiagnostic, updater } = await harness({ fetch });
		expect(updater.start()).toBe(true);
		expect(updater.view()).toEqual({ status: "checking" });
		await vi.waitFor(() => expect(updater.view()).toEqual({ status: "unavailable" }));
		expect(onDiagnostic).toHaveBeenCalledWith("Update check failed");
	});

	it("aborts manifest request when timeout occurs", async () => {
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const signal = init?.signal;
			return new Promise<Response>((_, reject) => {
				if (signal?.aborted) {
					reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
					return;
				}
				signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
				});
			});
		});
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(() => {
				controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
			}, ms);
			return controller.signal;
		});
		try {
			const { updater } = await harness({ fetch });
			const checkPromise = updater.checkForUpdate();
			const assertion = expect(checkPromise).rejects.toThrow(/aborted/u);
			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;
		} finally {
			timeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});
