import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { getIndexPath, getNotePath, getScopeDir } from "../src/core/memory/vault-paths.ts";
import { resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { INDEX_ENTRY, MEMORY_LIMITS, type MemoryActor } from "../src/core/memory/vault-types.ts";

const AGENT: MemoryActor = { kind: "agent", sessionId: "sess-1" };

function makeProject(cwd: string) {
	return resolveVaultProject(cwd, "user-selected");
}

describe("MemoryVault", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-vault-"));
		tempDirs.push(dir);
		return dir;
	};
	const makeVault = (opts?: { project?: ReturnType<typeof makeProject>; active?: boolean }) => {
		const agentDir = join(makeTemp(), "agent");
		const vault = new MemoryVault({
			agentDir,
			project: opts?.project,
			activeContextEnabled: opts?.active ? () => true : undefined,
		});
		vault.ensureLayout();
		return vault;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips frontmatter and body on create", async () => {
		const vault = makeVault();
		const result = await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "pnpm-only" },
				frontmatter: {
					name: "pnpm-only",
					description: "该项目只用 pnpm",
					type: "project",
					aliases: ["pnpm", "包管理"],
					confidence: "high",
				},
				content: "# 只用 pnpm\n**Why:** lockfile\n**How to apply:** never npm install",
			},
			AGENT,
		);
		expect(result.ok).toBe(true);
		const note = vault.readNote("global", "pnpm-only");
		expect(note).toBeDefined();
		expect(note!.frontmatter.name).toBe("pnpm-only");
		expect(note!.frontmatter.description).toBe("该项目只用 pnpm");
		expect(note!.frontmatter.type).toBe("project");
		expect(note!.frontmatter.aliases).toEqual(["pnpm", "包管理"]);
		expect(note!.frontmatter.confidence).toBe("high");
		expect(note!.frontmatter.sources).toEqual(["session:sess-1"]);
		expect(note!.frontmatter.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(note!.frontmatter.updated).toBe(note!.frontmatter.created);
		expect(note!.body).toContain("**Why:**");
		expect(note!.malformed).toBeFalsy();
	});

	it("rejects create without a type", async () => {
		const vault = makeVault();
		const result = await vault.write({ op: "create", scope: "global", target: { slug: "x" }, content: "hi" }, AGENT);
		expect(result).toEqual({ ok: false, error: expect.stringContaining("type") });
	});

	it("supports append, str_replace, replace and delete on notes", async () => {
		const vault = makeVault();
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "note-a" },
				frontmatter: { type: "reference", description: "first" },
				content: "alpha",
			},
			AGENT,
		);
		const appended = await vault.write(
			{ op: "append", scope: "global", target: { slug: "note-a" }, content: "beta" },
			{ kind: "user" },
		);
		expect(appended.ok).toBe(true);
		const note = vault.readNote("global", "note-a")!;
		expect(note.body).toBe("alpha\n\nbeta");
		expect(note.frontmatter.sources).toEqual(["session:sess-1", "user"]);

		const replaced = await vault.write(
			{
				op: "str_replace",
				scope: "global",
				target: { slug: "note-a" },
				oldText: "beta",
				newText: "gamma",
			},
			AGENT,
		);
		expect(replaced.ok).toBe(true);
		expect(vault.readNote("global", "note-a")!.body).toContain("gamma");

		const missing = await vault.write(
			{
				op: "str_replace",
				scope: "global",
				target: { slug: "note-a" },
				oldText: "nope",
				newText: "x",
			},
			AGENT,
		);
		expect(missing.ok).toBe(false);

		// Ambiguous oldText is rejected instead of replacing the first match.
		const ambiguous = await vault.write(
			{
				op: "str_replace",
				scope: "global",
				target: { slug: "note-a" },
				oldText: "a",
				newText: "z",
			},
			AGENT,
		);
		expect(ambiguous.ok).toBe(false);
		expect(ambiguous.ok === false && ambiguous.error).toContain("occurs");
		expect(ambiguous.ok === false && ambiguous.error).toContain("more context");
		expect(vault.readNote("global", "note-a")!.body).toBe("alpha\n\ngamma");

		const full = await vault.write(
			{ op: "replace", scope: "global", target: { slug: "note-a" }, content: "fresh body" },
			AGENT,
		);
		expect(full.ok).toBe(true);
		expect(vault.readNote("global", "note-a")!.body).toBe("fresh body");

		const deleted = await vault.write({ op: "delete", scope: "global", target: { slug: "note-a" } }, AGENT);
		expect(deleted.ok).toBe(true);
		expect(vault.readNote("global", "note-a")).toBeUndefined();
	});

	it("rejects str_replace when oldText occurs multiple times in a pinned block", async () => {
		const vault = makeVault();
		await vault.write({ op: "replace", scope: "global", target: { block: "user" }, content: "x and x" }, AGENT);
		const ambiguous = await vault.write(
			{ op: "str_replace", scope: "global", target: { block: "user" }, oldText: "x", newText: "y" },
			AGENT,
		);
		expect(ambiguous.ok).toBe(false);
		expect(ambiguous.ok === false && ambiguous.error).toContain("occurs 2 times");
		expect(vault.readPinned("global", "user")).toBe("x and x\n");

		// Unique oldText still works.
		const unique = await vault.write(
			{
				op: "str_replace",
				scope: "global",
				target: { block: "user" },
				oldText: "x and x",
				newText: "y",
			},
			AGENT,
		);
		expect(unique.ok).toBe(true);
		expect(vault.readPinned("global", "user")).toBe("y\n");
	});

	it("rejects oversized note bodies, descriptions, and pinned blocks", async () => {
		const vault = makeVault();
		const big = "x".repeat(MEMORY_LIMITS.noteBodyBytes + 1);
		const tooBig = await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "big" },
				frontmatter: { type: "reference" },
				content: big,
			},
			AGENT,
		);
		expect(tooBig.ok).toBe(false);

		const longDescription = await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "long" },
				frontmatter: { type: "reference", description: "d".repeat(121) },
				content: "ok",
			},
			AGENT,
		);
		expect(longDescription.ok).toBe(false);

		const pinnedTooBig = await vault.write(
			{
				op: "replace",
				scope: "global",
				target: { block: "user" },
				content: "y".repeat(MEMORY_LIMITS.pinnedBytes.user + 1),
			},
			AGENT,
		);
		expect(pinnedTooBig.ok).toBe(false);
	});

	it("rejects secret-looking content", async () => {
		const vault = makeVault();
		const result = await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "secret" },
				frontmatter: { type: "reference" },
				content: "the key is sk-abc123def456",
			},
			AGENT,
		);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toMatch(/secret/i);
	});

	it("maintains index lines in updated-desc order matching INDEX_ENTRY", async () => {
		const vault = makeVault();
		for (const [slug, updated] of [
			["older", "2026-01-01"],
			["newer", "2026-09-01"],
		] as const) {
			await vault.write(
				{
					op: "create",
					scope: "global",
					target: { slug },
					frontmatter: { type: "reference", description: `desc ${slug}` },
					content: "body",
				},
				AGENT,
			);
			const notePath = getNotePath(getScopeDir(vault.root, "global"), slug);
			const raw = readFileSync(notePath, "utf8").replace(/updated: .*/u, `updated: ${updated}`);
			writeFileSync(notePath, raw);
		}
		vault.rebuildIndex("global");
		const index = vault.readIndex("global").trim().split("\n");
		expect(index).toHaveLength(2);
		expect(index[0]).toContain("[newer]");
		expect(index[1]).toContain("[older]");
		for (const line of index) expect(line).toMatch(INDEX_ENTRY);
	});

	it("rebuilds the index after user hand-edits it", async () => {
		const vault = makeVault();
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "kept" },
				frontmatter: { type: "reference", description: "kept note" },
				content: "body",
			},
			AGENT,
		);
		writeFileSync(getIndexPath(getScopeDir(vault.root, "global")), "garbage line\n- not valid\n");
		const result = await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "added" },
				frontmatter: { type: "reference", description: "added note" },
				content: "body",
			},
			AGENT,
		);
		expect(result.ok).toBe(true);
		const lines = vault.readIndex("global").trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line).toMatch(INDEX_ENTRY);
	});

	it("warns when the index is full", async () => {
		const vault = makeVault();
		let last: Awaited<ReturnType<MemoryVault["write"]>> | undefined;
		for (let index = 0; index < MEMORY_LIMITS.indexLines + 1; index++) {
			const slug = `note-${String(index).padStart(4, "0")}`;
			last = await vault.write(
				{
					op: "create",
					scope: "global",
					target: { slug },
					frontmatter: { type: "reference", description: slug },
					content: "body",
				},
				AGENT,
			);
		}
		expect(last!.ok).toBe(true);
		expect(last!.ok && last!.warning).toBe("index full");
		expect(vault.readIndex("global").trim().split("\n")).toHaveLength(MEMORY_LIMITS.indexLines);
	}, 60_000);

	it("tolerates malformed notes", async () => {
		const vault = makeVault();
		const dir = getScopeDir(vault.root, "global");
		writeFileSync(getNotePath(dir, "broken"), "no frontmatter at all\njust text\n");
		writeFileSync(getNotePath(dir, "badtype"), "---\ntype: bogus\nname: x\ndescription: d\n---\nbody\n");
		const broken = vault.readNote("global", "broken")!;
		expect(broken.malformed).toBe(true);
		expect(broken.frontmatter.type).toBe("reference");
		expect(broken.frontmatter.description).toBe("no frontmatter at all");
		const badtype = vault.readNote("global", "badtype")!;
		expect(badtype.malformed).toBe(true);
		expect(badtype.frontmatter.type).toBe("reference");
		expect(vault.listNotes("global")).toHaveLength(2);
	});

	it("rejects project scope when there is no project identity", async () => {
		const vault = makeVault();
		const result = await vault.write(
			{
				op: "create",
				scope: "project",
				target: { slug: "x" },
				frontmatter: { type: "project" },
				content: "body",
			},
			AGENT,
		);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("project memory is unavailable for this workspace");
		expect(vault.hasScope("project")).toBe(false);
		expect(vault.hasScope("global")).toBe(true);
	});

	it("gates the active pinned block on activeContextEnabled", async () => {
		const cwd = makeTemp();
		const project = makeProject(cwd);
		const off = makeVault({ project });
		const rejected = await off.write(
			{ op: "replace", scope: "project", target: { block: "active" }, content: "ctx" },
			AGENT,
		);
		expect(rejected.ok).toBe(false);

		const on = makeVault({ project, active: true });
		const accepted = await on.write(
			{ op: "replace", scope: "project", target: { block: "active" }, content: "ctx" },
			AGENT,
		);
		expect(accepted.ok).toBe(true);
		expect(on.readPinned("project", "active")).toContain("ctx");
	});

	it("enforces block/scope pairing", async () => {
		const vault = makeVault();
		const wrong = await vault.write(
			{ op: "replace", scope: "global", target: { block: "project" }, content: "x" },
			AGENT,
		);
		expect(wrong.ok).toBe(false);
		const ok = await vault.write(
			{ op: "replace", scope: "global", target: { block: "user" }, content: "likes pnpm" },
			AGENT,
		);
		expect(ok.ok).toBe(true);
		expect(vault.readPinned("global", "user")).toContain("likes pnpm");
	});

	it("renames rewrite [[links]] in other notes and records two changelog legs", async () => {
		const cwd = makeTemp();
		const vault = makeVault({ project: makeProject(cwd) });
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "target-note" },
				frontmatter: { type: "reference", description: "dest" },
				content: "body",
			},
			AGENT,
		);
		await vault.write(
			{
				op: "create",
				scope: "project",
				target: { slug: "linker" },
				frontmatter: { type: "reference", description: "links" },
				content: "see [[target-note]] here",
			},
			AGENT,
		);
		const result = await vault.write(
			{
				op: "rename",
				scope: "global",
				target: { slug: "target-note" },
				newSlug: "renamed-note",
			},
			AGENT,
		);
		expect(result.ok).toBe(true);
		expect(vault.readNote("global", "target-note")).toBeUndefined();
		expect(vault.readNote("global", "renamed-note")).toBeDefined();
		expect(vault.readNote("project", "linker")!.body).toContain("[[renamed-note]]");
		const entries = vault.history(10);
		expect(entries.some((entry) => entry.op === "rename")).toBe(true);
		expect(
			entries.some(
				(entry) => entry.op === "create" && "slug" in entry.target && entry.target.slug === "renamed-note",
			),
		).toBe(true);
	});

	it("project rename leaves references to the same global slug unchanged", async () => {
		const vault = makeVault({ project: makeProject(makeTemp()) });
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "shared" },
				frontmatter: { type: "reference", description: "global note" },
				content: "global",
			},
			AGENT,
		);
		await vault.write(
			{
				op: "create",
				scope: "project",
				target: { slug: "shared" },
				frontmatter: { type: "project", description: "project note" },
				content: "project",
			},
			AGENT,
		);
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "global-ref" },
				frontmatter: { type: "reference", description: "links global" },
				content: "see [[shared]]",
			},
			AGENT,
		);
		await vault.write(
			{
				op: "create",
				scope: "project",
				target: { slug: "proj-ref" },
				frontmatter: { type: "project", description: "links project" },
				content: "use [[shared]]",
			},
			AGENT,
		);
		const renamed = await vault.write(
			{ op: "rename", scope: "project", target: { slug: "shared" }, newSlug: "renamed" },
			AGENT,
		);
		expect(renamed.ok).toBe(true);
		// The global note's [[shared]] resolves to global/shared and must not move.
		expect(vault.readNote("global", "global-ref")!.body).toBe("see [[shared]]");
		// The project note's [[shared]] resolved to the renamed project note.
		expect(vault.readNote("project", "proj-ref")!.body).toBe("use [[renamed]]");
		expect(vault.readNote("project", "renamed")).toBeDefined();
	});

	it("applies frontmatter overrides on rename", async () => {
		const vault = makeVault();
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "old-slug" },
				frontmatter: { type: "reference", name: "Old Name", description: "old desc" },
				content: "body",
			},
			AGENT,
		);
		const renamed = await vault.write(
			{
				op: "rename",
				scope: "global",
				target: { slug: "old-slug" },
				newSlug: "new-slug",
				frontmatter: { description: "new desc", aliases: ["alias-1"], confidence: "high" },
			},
			AGENT,
		);
		expect(renamed.ok).toBe(true);
		const note = vault.readNote("global", "new-slug")!;
		expect(note.frontmatter.description).toBe("new desc");
		expect(note.frontmatter.aliases).toEqual(["alias-1"]);
		expect(note.frontmatter.confidence).toBe("high");
		// Untouched fields are preserved.
		expect(note.frontmatter.name).toBe("Old Name");
		expect(note.frontmatter.type).toBe("reference");

		// Overlong descriptions are still rejected.
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "other" },
				frontmatter: { type: "reference", description: "ok" },
				content: "body",
			},
			AGENT,
		);
		const tooLong = await vault.write(
			{
				op: "rename",
				scope: "global",
				target: { slug: "other" },
				newSlug: "other-2",
				frontmatter: { description: "d".repeat(MEMORY_LIMITS.descriptionChars + 1) },
			},
			AGENT,
		);
		expect(tooLong.ok).toBe(false);
		expect(vault.readNote("global", "other")).toBeDefined();
	});

	it("emits changed events for each changelog entry", async () => {
		const vault = makeVault();
		const seen: string[] = [];
		vault.events.on("changed", (event) => seen.push(event.entry.op));
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "ev" },
				frontmatter: { type: "reference" },
				content: "body",
			},
			AGENT,
		);
		expect(seen).toEqual(["create"]);
	});
});
