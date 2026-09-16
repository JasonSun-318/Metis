import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { PluginFormat, PluginRecord } from "@metis/coding-agent/host";
import {
	archiveEntries,
	type FetchImplementation,
	fetchBytes,
	fetchJson,
	fetchOptionalJson,
	githubSource,
	MAX_GITHUB_ROUTE_PARTS,
	MAX_PLUGIN_ARCHIVE_ENTRIES,
	MAX_PLUGIN_DOWNLOAD_BYTES,
	MAX_PLUGIN_FILE_BYTES,
	MAX_PLUGIN_METADATA_BYTES,
	MAX_PLUGIN_UNCOMPRESSED_BYTES,
	MISSING_GITHUB_COMMIT_STATUS,
	validArchivePath,
} from "./github-archive.ts";
import { AppServerError } from "./session-runtime-host.ts";

export interface CatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly formatHint: PluginFormat;
	readonly sourceSupported: boolean;
	readonly source: unknown;
	readonly strict?: boolean;
	readonly skills?: readonly string[];
}

export interface InspectedSource {
	readonly canonicalRepository: string;
	readonly owner: string;
	readonly repo: string;
	readonly commit: string;
	readonly root: string;
	readonly trackingRef?: string;
	readonly pinnedCommit?: string;
	readonly catalog: readonly CatalogEntry[];
	readonly isMarketplace: boolean;
}

export interface ResolvedPluginFiles {
	readonly repository: string;
	readonly owner: string;
	readonly repo: string;
	readonly commit: string;
	readonly subdir: string;
	readonly trackingRef?: string;
	readonly pinnedCommit?: string;
	readonly files: Map<string, Buffer>;
	readonly fileModes: Map<string, number>;
}

function normalizeSubdir(p: string): string {
	const norm = posix.normalize(p.replace(/\\/g, "/"));
	const res = norm.replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
	return res === "." ? "" : res;
}

export function canonicalizeRepository(urlOrShorthand: string): {
	canonicalRepository: string;
	owner: string;
	repo: string;
	route?: { readonly kind: "tree" | "blob"; readonly parts: readonly string[] };
} {
	const source = githubSource(urlOrShorthand);
	const owner = source.owner.toLowerCase();
	const repo = source.repo.toLowerCase();
	return {
		canonicalRepository: `https://github.com/${owner}/${repo}`,
		owner: source.owner,
		repo: source.repo,
		route: source.route,
	};
}

export function computePluginId(canonicalRepository: string, canonicalSubdir: string): string {
	const normRepo = canonicalRepository.toLowerCase().replace(/\/$/, "");
	const normSubdir = normalizeSubdir(canonicalSubdir).toLowerCase();
	return createHash("sha256").update(`${normRepo}\0${normSubdir}`).digest("hex");
}

export function isSourceSupported(source: unknown): boolean {
	if (typeof source === "string") {
		// Relative path inside repo
		return !source.startsWith("http://") && !source.startsWith("https://") && !source.startsWith("git@");
	}
	if (typeof source !== "object" || source === null) return false;
	const obj = source as Record<string, unknown>;

	if (obj.source === "local" && typeof obj.path === "string") return true;

	if (obj.source === "github" && typeof obj.repo === "string") {
		const parts = obj.repo.split("/").filter(Boolean);
		return parts.length === 2;
	}

	if (obj.source === "url" && typeof obj.url === "string") {
		try {
			const u = new URL(obj.url);
			return u.protocol === "https:" && u.hostname === "github.com";
		} catch {
			return false;
		}
	}

	if (obj.source === "git-subdir" && typeof obj.url === "string" && typeof obj.path === "string") {
		try {
			const u = new URL(obj.url);
			return u.protocol === "https:" && u.hostname === "github.com";
		} catch {
			return false;
		}
	}

	return false;
}

async function fetchFileRaw(
	fetchImpl: FetchImplementation,
	owner: string,
	repo: string,
	path: string,
	commit: string,
): Promise<Buffer | undefined> {
	const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(commit)}`;
	return await fetchBytes(
		fetchImpl,
		url,
		MAX_PLUGIN_METADATA_BYTES,
		"application/vnd.github.raw+json",
		MISSING_GITHUB_COMMIT_STATUS,
	);
}

export async function resolveCommitSha(
	fetchImpl: FetchImplementation,
	owner: string,
	repo: string,
	refOrSha?: string,
): Promise<string> {
	if (refOrSha && /^[a-f0-9]{40}$/i.test(refOrSha)) {
		return refOrSha.toLowerCase();
	}
	const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	if (!refOrSha) {
		const repository = (await fetchJson(fetchImpl, api)) as { default_branch?: unknown };
		if (typeof repository.default_branch !== "string" || !repository.default_branch) {
			throw new AppServerError("OPERATION_FAILED");
		}
		refOrSha = repository.default_branch;
	}
	const result = (await fetchJson(fetchImpl, `${api}/commits/${encodeURIComponent(refOrSha)}`)) as {
		sha?: unknown;
	};
	if (typeof result.sha !== "string" || !/^[a-f0-9]{40}$/i.test(result.sha)) {
		throw new AppServerError("OPERATION_FAILED");
	}
	return result.sha.toLowerCase();
}

export async function resolveTrackedPluginCommit(
	record: PluginRecord,
	fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<string> {
	if (record.pinnedCommit) {
		return record.pinnedCommit;
	}
	const { owner, repo } = canonicalizeRepository(record.repository);
	let ref = record.trackingRef;
	if (!ref) {
		const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
		const repoInfo = (await fetchJson(fetchImpl, api)) as { default_branch?: unknown };
		if (typeof repoInfo.default_branch !== "string" || !repoInfo.default_branch) {
			throw new AppServerError("OPERATION_FAILED");
		}
		ref = repoInfo.default_branch;
	}
	const commitUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
	const result = (await fetchJson(fetchImpl, commitUrl)) as { sha?: unknown };
	if (typeof result.sha !== "string" || !/^[a-f0-9]{40}$/i.test(result.sha)) {
		throw new AppServerError("OPERATION_FAILED");
	}
	return result.sha.toLowerCase();
}

export async function inspectRepositorySource(
	urlOrShorthand: string,
	fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<InspectedSource> {
	const parsed = canonicalizeRepository(urlOrShorthand);
	const api = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
	let commit: string | undefined;
	let root = "";
	let trackingRef: string | undefined;
	let pinnedCommit: string | undefined;

	if (!parsed.route) {
		commit = await resolveCommitSha(fetchImpl, parsed.owner, parsed.repo);
	} else {
		if (parsed.route.parts.length > MAX_GITHUB_ROUTE_PARTS) {
			throw new AppServerError("INVALID_REQUEST");
		}
		for (let length = parsed.route.parts.length; length >= 1; length -= 1) {
			const candidateRef = parsed.route.parts.slice(0, length).join("/");
			const result = (await fetchOptionalJson(fetchImpl, `${api}/commits/${encodeURIComponent(candidateRef)}`)) as
				| { sha?: unknown }
				| undefined;
			if (!result) continue;
			if (typeof result.sha !== "string" || !/^[a-f0-9]{40}$/i.test(result.sha)) {
				throw new AppServerError("OPERATION_FAILED");
			}
			commit = result.sha.toLowerCase();
			if (/^[a-f0-9]{40}$/i.test(candidateRef)) {
				pinnedCommit = candidateRef.toLowerCase();
			} else {
				trackingRef = candidateRef;
			}
			root = parsed.route.parts.slice(length).join("/");
			if (parsed.route.kind === "blob" && posix.basename(root) === "SKILL.md") {
				root = posix.dirname(root);
			}
			if (root === ".") root = "";
			if (root && !validArchivePath(root)) {
				throw new AppServerError("INVALID_REQUEST");
			}
			break;
		}
	}

	if (!commit) {
		throw new AppServerError("OPERATION_FAILED");
	}

	// Probe for marketplace manifest
	const claudeMarketPath = root ? `${root}/.claude-plugin/marketplace.json` : ".claude-plugin/marketplace.json";
	const codexMarketPath = root ? `${root}/.agents/plugins/marketplace.json` : ".agents/plugins/marketplace.json";

	const claudeMarketBuf = await fetchFileRaw(fetchImpl, parsed.owner, parsed.repo, claudeMarketPath, commit);
	let codexMarketBuf: Buffer | undefined;
	if (!claudeMarketBuf) {
		codexMarketBuf = await fetchFileRaw(fetchImpl, parsed.owner, parsed.repo, codexMarketPath, commit);
	}

	const catalog: CatalogEntry[] = [];
	let isMarketplace = false;

	if (claudeMarketBuf) {
		isMarketplace = true;
		try {
			const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(claudeMarketBuf));
			if (typeof json === "object" && json !== null && Array.isArray(json.plugins)) {
				for (const item of json.plugins) {
					if (typeof item !== "object" || item === null) continue;
					const itemObj = item as Record<string, unknown>;
					const entryName = typeof itemObj.name === "string" ? itemObj.name : "unnamed-plugin";
					const entryDesc = typeof itemObj.description === "string" ? itemObj.description : "";
					const supported = isSourceSupported(itemObj.source);
					const strict = typeof itemObj.strict === "boolean" ? itemObj.strict : undefined;
					const skills = Array.isArray(itemObj.skills)
						? (itemObj.skills.filter((s) => typeof s === "string") as string[])
						: undefined;

					catalog.push({
						id: `entry-${entryName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
						name: entryName,
						description: entryDesc,
						formatHint: "claude",
						sourceSupported: supported,
						source: itemObj.source,
						strict,
						skills,
					});
				}
			}
		} catch {
			throw new AppServerError("OPERATION_FAILED");
		}
	} else if (codexMarketBuf) {
		isMarketplace = true;
		try {
			const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(codexMarketBuf));
			if (typeof json === "object" && json !== null && Array.isArray(json.plugins)) {
				for (const item of json.plugins) {
					if (typeof item !== "object" || item === null) continue;
					const itemObj = item as Record<string, unknown>;
					const entryName = typeof itemObj.name === "string" ? itemObj.name : "unnamed-plugin";
					const entryDesc = typeof itemObj.description === "string" ? itemObj.description : "";
					const supported = isSourceSupported(itemObj.source);

					catalog.push({
						id: `entry-${entryName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
						name: entryName,
						description: entryDesc,
						formatHint: "codex",
						sourceSupported: supported,
						source: itemObj.source,
					});
				}
			}
		} catch {
			throw new AppServerError("OPERATION_FAILED");
		}
	} else {
		// Not a marketplace. Check if it is a single Claude or Codex plugin
		const claudePluginPath = root ? `${root}/.claude-plugin/plugin.json` : ".claude-plugin/plugin.json";
		const codexPluginPath = root ? `${root}/.codex-plugin/plugin.json` : ".codex-plugin/plugin.json";

		const claudePluginBuf = await fetchFileRaw(fetchImpl, parsed.owner, parsed.repo, claudePluginPath, commit);
		const codexPluginBuf = !claudePluginBuf
			? await fetchFileRaw(fetchImpl, parsed.owner, parsed.repo, codexPluginPath, commit)
			: undefined;

		if (claudePluginBuf) {
			let name = parsed.repo;
			let description = "";
			try {
				const json = JSON.parse(new TextDecoder("utf-8").decode(claudePluginBuf));
				if (json.name) name = json.name;
				if (json.description) description = json.description;
			} catch {
				// ignore
			}
			catalog.push({
				id: `entry-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
				name,
				description,
				formatHint: "claude",
				sourceSupported: true,
				source: root || "./",
			});
		} else if (codexPluginBuf) {
			let name = parsed.repo;
			let description = "";
			try {
				const json = JSON.parse(new TextDecoder("utf-8").decode(codexPluginBuf));
				if (json.name) name = json.name;
				if (json.description) description = json.description;
			} catch {
				// ignore
			}
			catalog.push({
				id: `entry-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
				name,
				description,
				formatHint: "codex",
				sourceSupported: true,
				source: root || "./",
			});
		} else {
			// Download repo archive to discover skills
			const zipBytes = await fetchBytes(
				fetchImpl,
				`https://codeload.github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/zip/${commit}`,
				MAX_PLUGIN_DOWNLOAD_BYTES,
				"application/zip",
			);
			if (!zipBytes) throw new AppServerError("OPERATION_FAILED");

			const entries = await archiveEntries(zipBytes, {
				stripRoot: true,
				skipNonRegular: true,
				maxFileBytes: MAX_PLUGIN_FILE_BYTES,
				maxUncompressedBytes: MAX_PLUGIN_UNCOMPRESSED_BYTES,
				maxEntries: MAX_PLUGIN_ARCHIVE_ENTRIES,
			});

			const prefix = root ? `${normalizeSubdir(root)}/` : "";
			const relevant = entries.filter((e) => (prefix ? e.path.startsWith(prefix) : true));
			const skillEntries = relevant.filter((e) => posix.basename(e.path) === "SKILL.md");

			if (skillEntries.length > 0) {
				for (const se of skillEntries) {
					const skillDir = posix.dirname(se.path);
					const skillName = posix.basename(skillDir) || parsed.repo;
					catalog.push({
						id: `entry-${skillName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
						name: skillName,
						description: "",
						formatHint: "agent-skills",
						sourceSupported: true,
						source: skillDir,
					});
				}
			}
		}
	}

	return {
		canonicalRepository: parsed.canonicalRepository,
		owner: parsed.owner,
		repo: parsed.repo,
		commit,
		root,
		...(trackingRef ? { trackingRef } : {}),
		...(pinnedCommit ? { pinnedCommit } : {}),
		catalog,
		isMarketplace,
	};
}

export async function fetchPluginFilesAtCommit(
	input: { repository: string; subdir: string; commit: string },
	fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<ResolvedPluginFiles> {
	const { owner, repo } = canonicalizeRepository(input.repository);
	const targetSubdir = normalizeSubdir(input.subdir);
	const targetCommit = input.commit;

	// Download ZIP
	const zipUrl = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${encodeURIComponent(targetCommit)}`;
	const zipBytes = await fetchBytes(fetchImpl, zipUrl, MAX_PLUGIN_DOWNLOAD_BYTES, "application/zip");
	if (!zipBytes) throw new AppServerError("OPERATION_FAILED");

	const entries = await archiveEntries(zipBytes, {
		stripRoot: true,
		skipNonRegular: true,
		maxFileBytes: MAX_PLUGIN_FILE_BYTES,
		maxUncompressedBytes: MAX_PLUGIN_UNCOMPRESSED_BYTES,
		maxEntries: MAX_PLUGIN_ARCHIVE_ENTRIES,
	});

	const files = new Map<string, Buffer>();
	const fileModes = new Map<string, number>();
	const prefix = targetSubdir ? `${targetSubdir}/` : "";

	for (const e of entries) {
		const mode = (e.mode & 0o111) !== 0 ? 0o755 : 0o644;
		if (prefix) {
			if (e.path.startsWith(prefix)) {
				const relativePath = e.path.slice(prefix.length);
				if (relativePath) {
					files.set(relativePath, e.bytes);
					fileModes.set(relativePath, mode);
				}
			}
		} else {
			files.set(e.path, e.bytes);
			fileModes.set(e.path, mode);
		}
	}

	return {
		repository: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`,
		owner,
		repo,
		commit: targetCommit,
		subdir: targetSubdir,
		files,
		fileModes,
	};
}

export async function fetchPluginFiles(
	origin: {
		canonicalRepository: string;
		owner: string;
		repo: string;
		commit: string;
		root: string;
		trackingRef?: string;
		pinnedCommit?: string;
	},
	entry: CatalogEntry,
	fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<ResolvedPluginFiles> {
	if (!entry.sourceSupported) {
		throw new AppServerError("INVALID_REQUEST");
	}

	let targetOwner = origin.owner;
	let targetRepo = origin.repo;
	let targetCommit = origin.commit;
	let targetSubdir = origin.root;
	let trackingRef = origin.trackingRef;
	let pinnedCommit = origin.pinnedCommit;

	const src = entry.source;

	if (typeof src === "string") {
		// Relative path in origin repository
		const rel = normalizeSubdir(src);
		targetSubdir = origin.root ? normalizeSubdir(posix.join(origin.root, rel)) : rel;
	} else if (typeof src === "object" && src !== null) {
		const obj = src as Record<string, unknown>;
		if (obj.source === "local" && typeof obj.path === "string") {
			const rel = normalizeSubdir(obj.path);
			targetSubdir = origin.root ? normalizeSubdir(posix.join(origin.root, rel)) : rel;
		} else if (obj.source === "github" && typeof obj.repo === "string") {
			const parts = obj.repo.split("/").filter(Boolean);
			targetOwner = parts[0];
			targetRepo = parts[1].replace(/\.git$/, "");
			targetSubdir = "";
		} else if (obj.source === "url" && typeof obj.url === "string") {
			const parsed = canonicalizeRepository(obj.url);
			targetOwner = parsed.owner;
			targetRepo = parsed.repo;
			targetSubdir = "";
		} else if (obj.source === "git-subdir" && typeof obj.url === "string" && typeof obj.path === "string") {
			const parsed = canonicalizeRepository(obj.url);
			targetOwner = parsed.owner;
			targetRepo = parsed.repo;
			targetSubdir = normalizeSubdir(obj.path);
		} else {
			throw new AppServerError("INVALID_REQUEST");
		}
		if (obj.source !== "local") {
			const ref = typeof obj.sha === "string" ? obj.sha : typeof obj.ref === "string" ? obj.ref : undefined;
			pinnedCommit = ref && /^[a-f0-9]{40}$/i.test(ref) ? ref.toLowerCase() : undefined;
			trackingRef = pinnedCommit ? undefined : ref;
			if (!pinnedCommit && !trackingRef) {
				const repository = (await fetchJson(
					fetchImpl,
					`https://api.github.com/repos/${encodeURIComponent(targetOwner)}/${encodeURIComponent(targetRepo)}`,
				)) as { default_branch?: unknown };
				if (typeof repository.default_branch !== "string" || !repository.default_branch)
					throw new AppServerError("OPERATION_FAILED");
				trackingRef = repository.default_branch;
			}
			targetCommit = await resolveCommitSha(fetchImpl, targetOwner, targetRepo, pinnedCommit ?? trackingRef);
		}
	} else {
		throw new AppServerError("INVALID_REQUEST");
	}

	const resolved = await fetchPluginFilesAtCommit(
		{
			repository: `https://github.com/${targetOwner}/${targetRepo}`,
			subdir: targetSubdir,
			commit: targetCommit,
		},
		fetchImpl,
	);
	return { ...resolved, trackingRef, pinnedCommit };
}
