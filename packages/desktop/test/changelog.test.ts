import { describe, expect, it, vi } from "vitest";
import { loadDesktopChangelog } from "../src/main/changelog.ts";

const BASE_URL = "https://updates.example.test/metis";
const CHANGELOG = {
	schemaVersion: 1 as const,
	releases: [
		{ version: "0.82.0", notes: "## Added\n\n- History" },
		{ version: "0.81.0", notes: "## Fixed\n\n- Updates" },
	],
};

describe("loadDesktopChangelog", () => {
	it("loads and validates the macOS changelog", async () => {
		const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(CHANGELOG), { status: 200 }));
		await expect(loadDesktopChangelog({ baseUrl: BASE_URL, platform: "darwin", fetch })).resolves.toEqual(CHANGELOG);
		expect(fetch).toHaveBeenCalledWith(
			`${BASE_URL}/darwin/changelog.json`,
			expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
		);
	});

	it("loads the Windows changelog from its own platform path", async () => {
		const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(CHANGELOG), { status: 200 }));
		await expect(loadDesktopChangelog({ baseUrl: BASE_URL, platform: "win32", fetch })).resolves.toEqual(CHANGELOG);
		expect(fetch).toHaveBeenCalledWith(
			`${BASE_URL}/win32/changelog.json`,
			expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
		);
	});

	it.each(["http://updates.example.test/metis", "https://token@updates.example.test/metis", "not a URL"])(
		"rejects an unsafe release base: %s",
		async (baseUrl) => {
			const fetch = vi.fn();
			await expect(loadDesktopChangelog({ baseUrl, platform: "darwin", fetch })).rejects.toThrow(
				"Release notes are unavailable in this build",
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("rejects unsupported desktop platforms without making a request", async () => {
		const fetch = vi.fn();
		await expect(loadDesktopChangelog({ baseUrl: BASE_URL, platform: "linux", fetch })).rejects.toThrow(
			"Release notes are unavailable in this build",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("treats a missing published changelog as an empty history", async () => {
		await expect(
			loadDesktopChangelog({
				baseUrl: BASE_URL,
				platform: "darwin",
				fetch: vi.fn().mockResolvedValue(new Response("missing", { status: 404 })),
			}),
		).resolves.toEqual({ schemaVersion: 1, releases: [] });
	});

	it("reports other HTTP and schema failures", async () => {
		await expect(
			loadDesktopChangelog({
				baseUrl: BASE_URL,
				platform: "darwin",
				fetch: vi.fn().mockResolvedValue(new Response("unavailable", { status: 500 })),
			}),
		).rejects.toThrow("Changelog request failed with 500");
		await expect(
			loadDesktopChangelog({
				baseUrl: BASE_URL,
				platform: "darwin",
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ schemaVersion: 1, releases: [{ version: "0.1.0", notes: "  " }] }), {
						status: 200,
					}),
				),
			}),
		).rejects.toThrow("Invalid desktop changelog");
	});
});
