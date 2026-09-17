import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WriteResult } from "../src/core/memory/vault.ts";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { MemorySearchIndex } from "../src/core/memory/vault-search.ts";
import {
	createMemoryToolDefinitions,
	type MemoryReadDetails,
	type MemorySearchDetails,
} from "../src/core/memory/vault-tools.ts";
import type { MemoryActor } from "../src/core/memory/vault-types.ts";

const AGENT: MemoryActor = { kind: "agent", sessionId: "sess-1" };

describe("memory tools", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-vault-tools-"));
		tempDirs.push(dir);
		return dir;
	};

	function makeCtx() {
		const vault = new MemoryVault({ agentDir: join(makeTemp(), "agent") });
		vault.ensureLayout();
		const search = new MemorySearchIndex(vault);
		const tools = createMemoryToolDefinitions({
			vault,
			search,
			actor: () => AGENT,
			recordUsage: false,
		});
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		return { vault, search, tools, byName };
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("exposes memory_search, memory_read, and memory_write", () => {
		const { tools } = makeCtx();
		expect(tools.map((tool) => tool.name)).toEqual(["memory_search", "memory_read", "memory_write"]);
		const write = tools[2]!;
		expect(write.executionMode).toBe("sequential");
		expect(tools[0]!.executionMode).toBe("parallel");
	});

	it("write create → search → read happy path", async () => {
		const { byName } = makeCtx();
		const write = byName.get("memory_write")!;
		const writeResult = await write.execute(
			"call-1",
			{
				op: "create",
				scope: "global",
				target: { slug: "pnpm-only" },
				frontmatter: { type: "project", description: "only pnpm allowed" },
				content: "**Why:** lockfile\n**How to apply:** use pnpm",
			},
			undefined,
			undefined,
			{} as never,
		);
		const writeDetails = writeResult.details as WriteResult;
		expect(writeDetails.ok).toBe(true);
		expect(writeResult.content[0]).toMatchObject({ type: "text" });

		const search = byName.get("memory_search")!;
		const searchResult = await search.execute("call-2", { query: "pnpm" }, undefined, undefined, {} as never);
		const searchDetails = searchResult.details as MemorySearchDetails;
		expect(searchDetails.ok).toBe(true);
		expect(searchDetails.hits.map((hit) => hit.slug)).toContain("pnpm-only");

		const read = byName.get("memory_read")!;
		const readResult = await read.execute(
			"call-3",
			{ slug: "pnpm-only", scope: "global" },
			undefined,
			undefined,
			{} as never,
		);
		const readDetails = readResult.details as MemoryReadDetails;
		expect(readDetails.ok).toBe(true);
		expect(readDetails.frontmatter?.type).toBe("project");
		expect(readDetails.body).toContain("lockfile");
		expect(readDetails.links).toEqual([]);
		expect(readDetails.backlinks).toEqual([]);
	});

	it("rejects invalid arguments", async () => {
		const { byName } = makeCtx();
		const write = byName.get("memory_write")!;
		const bad = await write.execute(
			"call-1",
			{ op: "create", scope: "global", target: { slug: "x" }, bogus: true },
			undefined,
			undefined,
			{} as never,
		);
		expect((bad.details as WriteResult).ok).toBe(false);

		const search = byName.get("memory_search")!;
		const badSearch = await search.execute("call-2", { query: "" }, undefined, undefined, {} as never);
		expect((badSearch.details as MemorySearchDetails).ok).toBe(false);
	});

	it("surfaces vault write rejections", async () => {
		const { byName } = makeCtx();
		const write = byName.get("memory_write")!;
		const noProject = await write.execute(
			"call-1",
			{
				op: "create",
				scope: "project",
				target: { slug: "x" },
				frontmatter: { type: "project" },
				content: "body",
			},
			undefined,
			undefined,
			{} as never,
		);
		const details = noProject.details as WriteResult;
		expect(details.ok).toBe(false);
		expect(details.ok === false && details.error).toContain("unavailable");

		const secret = await write.execute(
			"call-2",
			{
				op: "create",
				scope: "global",
				target: { slug: "k" },
				frontmatter: { type: "reference" },
				content: "api_key=sk-live-secret",
			},
			undefined,
			undefined,
			{} as never,
		);
		expect((secret.details as WriteResult).ok).toBe(false);
	});

	it("memory_read throws on a missing note (error result)", async () => {
		const { byName } = makeCtx();
		const read = byName.get("memory_read")!;
		await expect(read.execute("call-1", { slug: "nope" }, undefined, undefined, {} as never)).rejects.toThrow(
			/not found/,
		);
	});

	it("declares write permission on the vault root and none for read/search", () => {
		const { byName, vault } = makeCtx();
		const write = byName.get("memory_write")!;
		const claim = write.permission.describe({} as never, {
			actionId: "a",
			cwd: "/tmp",
			workspaceRoots: [],
		});
		expect(claim.writePaths).toEqual([vault.root]);
		const search = byName.get("memory_search")!;
		const searchClaim = search.permission.describe({} as never, {
			actionId: "a",
			cwd: "/tmp",
			workspaceRoots: [],
		});
		expect(searchClaim.writePaths).toEqual([]);
		expect(searchClaim.readPaths).toEqual([]);
	});
});
