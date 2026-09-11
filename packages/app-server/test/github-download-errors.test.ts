import { expect, it, vi } from "vitest";
import { fetchBytes, MISSING_GITHUB_COMMIT_STATUS } from "../src/github-archive.ts";
import { inspectRepositorySource } from "../src/plugin-sources.ts";

it.each([
	[403, { "x-ratelimit-remaining": "0" }],
	[403, { "retry-after": "60" }],
	[429, {}],
])("reports GitHub throttling instead of Operation failed (%s)", async (status, headers) => {
	const fetchImpl = vi.fn(async () => new Response("private diagnostic", { status, headers }));
	await expect(inspectRepositorySource("https://github.com/openai/plugins.git", fetchImpl)).rejects.toMatchObject({
		code: "GITHUB_RATE_LIMITED",
	});
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("reports connection failure without exposing underlying details", async () => {
	const fetchImpl = vi.fn(async () => {
		throw new Error("private proxy detail");
	});
	await expect(inspectRepositorySource("openai/plugins", fetchImpl)).rejects.toMatchObject({
		code: "GITHUB_DOWNLOAD_FAILED",
	});
	expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 404])("distinguishes inaccessible repositories from rate limits (%s)", async (status) => {
	await expect(
		inspectRepositorySource("openai/plugins", async () => new Response("", { status })),
	).rejects.toMatchObject({ code: "GITHUB_ACCESS_DENIED" });
});

it("still treats absent optional manifests as missing", async () => {
	expect(
		await fetchBytes(
			async () => new Response("", { status: 404 }),
			"https://api.github.com/repos/o/r/contents/.claude-plugin/marketplace.json",
			1024,
			"application/json",
			MISSING_GITHUB_COMMIT_STATUS,
		),
	).toBeUndefined();
});
