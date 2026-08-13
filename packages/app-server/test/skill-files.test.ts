import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientParams } from "@metis/app-protocol";
import { loadSkills, type Skill } from "@metis/coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	importSkills,
	inspectSkillImport,
	isImmutableAsarSkill,
	readSkillDetail,
	trashSkill,
	writeSkill,
} from "../src/skill-files.ts";

const REQUEST_A = "30000000-0000-4000-8000-000000000001";

function content(name: string, description = "Write implementation plans", body = "# Instructions\nWrite the plan.") {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function saveSkill(root: string, name: string, body = content(name)): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	const filePath = join(directory, "SKILL.md");
	writeFileSync(filePath, body);
	return filePath;
}

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, string | { readonly content: string; readonly mode: number }>): Buffer {
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

describe("Skill files", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-skill-files-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function skills(): Skill[] {
		return loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills;
	}

	it("recognizes packaged ASAR entries without matching ordinary files", () => {
		const packaged = join(root, "Metis.app", "Contents", "Resources", "app.asar", "skills", "pdf", "SKILL.md");
		expect(isImmutableAsarSkill(packaged, "system")).toBe(true);
		expect(isImmutableAsarSkill(packaged, "user")).toBe(false);
		expect(isImmutableAsarSkill(join(root, "skills", "pdf", "SKILL.md"), "system")).toBe(false);
	});

	it("reads bounded user Skill detail and nested file names", async () => {
		const userRoot = join(agentDir, "skills");
		saveSkill(userRoot, "writing-plans");
		mkdirSync(join(userRoot, "writing-plans", "templates"));
		writeFileSync(join(userRoot, "writing-plans", "templates", "plan.md"), "template");

		const detail = await readSkillDetail(skills(), {
			cwd: null,
			source: "user",
			name: "writing-plans",
		});

		expect(detail).toMatchObject({
			name: "writing-plans",
			source: "user",
			entryFile: "SKILL.md",
			editable: true,
			instructions: "# Instructions\nWrite the plan.",
		});
		expect(detail.files).toEqual(["SKILL.md", "templates/plan.md"]);
		expect(detail.revision).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects hard-linked Skill entry files", async () => {
		const entry = saveSkill(join(agentDir, "skills"), "linked-entry");
		linkSync(entry, join(root, "entry-alias.md"));

		await expect(
			readSkillDetail(skills(), { cwd: null, source: "user", name: "linked-entry" }),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
	});

	it("creates atomically and rejects stale or malformed writes", async () => {
		const userRoot = join(agentDir, "skills");
		saveSkill(userRoot, "writing-plans");
		const existing = await readSkillDetail(skills(), { cwd: null, source: "user", name: "writing-plans" });
		const context = { agentDir, cwd: null, skills: skills() };

		await expect(
			writeSkill(context, {
				requestId: REQUEST_A,
				cwd: null,
				source: "user",
				name: "writing-plans",
				expectedRevision: "0".repeat(64),
				content: existing.content,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			writeSkill(context, {
				requestId: REQUEST_A,
				cwd: null,
				source: "user",
				name: "new-skill",
				expectedRevision: null,
				content: "# missing frontmatter",
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			writeSkill(context, {
				requestId: REQUEST_A,
				cwd: null,
				source: "user",
				name: "new-skill",
				expectedRevision: null,
				content: content("other-skill"),
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			writeSkill(context, {
				requestId: REQUEST_A,
				cwd: null,
				source: "user",
				name: "new-skill",
				expectedRevision: null,
				content: content("new-skill", "你".repeat(90_000)),
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });

		await writeSkill(context, {
			requestId: REQUEST_A,
			cwd: null,
			source: "user",
			name: "new-skill",
			expectedRevision: null,
			content: content("new-skill"),
		});
		expect(existsSync(join(userRoot, "new-skill", "SKILL.md"))).toBe(true);
		expect(readdirSync(join(userRoot, "new-skill")).some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("rejects system writes and symlink targets", async () => {
		const systemFile = saveSkill(join(root, "system"), "pdf", content("pdf", "Read PDF files"));
		const systemSkill: Skill = {
			name: "pdf",
			description: "Read PDF files",
			filePath: systemFile,
			baseDir: join(root, "system", "pdf"),
			sourceInfo: { path: systemFile, source: "system", scope: "temporary", origin: "top-level" },
			disableModelInvocation: false,
		};
		await expect(
			writeSkill({ agentDir, cwd: null, skills: [systemSkill] }, {
				requestId: REQUEST_A,
				cwd: null,
				source: "system",
				name: "pdf",
				expectedRevision: null,
				content: content("pdf", "Read PDF files"),
			} as unknown as ClientParams<"skill/upsert">),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });

		const outside = join(root, "outside");
		saveSkill(outside, "linked-skill");
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		symlinkSync(join(outside, "linked-skill"), join(agentDir, "skills", "linked-skill"), "dir");
		const linked: Skill = {
			name: "linked-skill",
			description: "Write implementation plans",
			filePath: join(agentDir, "skills", "linked-skill", "SKILL.md"),
			baseDir: join(agentDir, "skills", "linked-skill"),
			sourceInfo: {
				path: join(agentDir, "skills", "linked-skill", "SKILL.md"),
				source: "user",
				scope: "user",
				origin: "top-level",
			},
			disableModelInvocation: false,
		};
		await expect(
			writeSkill(
				{ agentDir, cwd: null, skills: [linked] },
				{
					requestId: REQUEST_A,
					cwd: null,
					source: "user",
					name: "linked-skill",
					expectedRevision: "0".repeat(64),
					content: content("linked-skill"),
				},
			),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
	});

	it("moves directory and legacy-file deletion into source-root trash", async () => {
		const userRoot = join(agentDir, "skills");
		saveSkill(userRoot, "writing-plans");
		const first = await readSkillDetail(skills(), { cwd: null, source: "user", name: "writing-plans" });
		await trashSkill(
			{ agentDir, cwd: null, skills: skills() },
			{
				requestId: REQUEST_A,
				cwd: null,
				source: "user",
				name: "writing-plans",
				expectedRevision: first.revision,
			},
		);
		expect(existsSync(join(userRoot, "writing-plans"))).toBe(false);
		expect(readdirSync(join(userRoot, ".trash")).some((name) => name.includes("writing-plans"))).toBe(true);

		writeFileSync(join(userRoot, "legacy.md"), content("legacy"));
		const legacy = await readSkillDetail(skills(), { cwd: null, source: "user", name: "legacy" });
		await trashSkill(
			{ agentDir, cwd: null, skills: skills() },
			{
				requestId: "30000000-0000-4000-8000-000000000002",
				cwd: null,
				source: "user",
				name: "legacy",
				expectedRevision: legacy.revision,
			},
		);
		expect(existsSync(join(userRoot, "legacy.md"))).toBe(false);
		expect(existsSync(userRoot)).toBe(true);
	});

	it("bounds file enumeration and skips symbolic links", async () => {
		const skillRoot = join(agentDir, "skills", "large-skill");
		saveSkill(join(agentDir, "skills"), "large-skill", content("large-skill"));
		mkdirSync(join(skillRoot, "files"));
		for (let index = 0; index < 300; index += 1) {
			writeFileSync(join(skillRoot, "files", `${String(index).padStart(3, "0")}.md`), String(index));
		}
		symlinkSync(join(skillRoot, "SKILL.md"), join(skillRoot, "linked.md"));

		const detail = await readSkillDetail(skills(), { cwd: null, source: "user", name: "large-skill" });
		expect(detail.files).toHaveLength(256);
		expect(detail.files).toContain("SKILL.md");
		expect(detail.files).not.toContain("linked.md");
	});

	it("inspects and imports selected archive Skills with their resources", async () => {
		const archive = join(root, "skills.skill");
		writeFileSync(
			archive,
			zip({
				"bundle/alpha/SKILL.md": content("alpha", "Alpha Skill"),
				"bundle/alpha/references/example.md": "example",
				"bundle/alpha/scripts/run.sh": { content: "#!/bin/sh\nexit 0\n", mode: 0o100700 },
				"bundle/beta/SKILL.md": content("beta", "Beta Skill"),
			}),
		);
		const context = { agentDir, cwd, skills: skills() };
		const inspected = await inspectSkillImport(context, {
			cwd,
			source: "project",
			input: { kind: "archive", path: archive },
		});
		expect(inspected.candidates).toEqual([
			{ id: "bundle/alpha", name: "alpha", description: "Alpha Skill", fileCount: 3 },
			{ id: "bundle/beta", name: "beta", description: "Beta Skill", fileCount: 1 },
		]);

		await importSkills(context, {
			requestId: REQUEST_A,
			cwd,
			source: "project",
			input: { kind: "archive", path: archive },
			sourceRevision: inspected.revision,
			candidateIds: ["bundle/alpha"],
		});
		expect(readFileSync(join(cwd, ".metis", "skills", "alpha", "references", "example.md"), "utf8")).toBe("example");
		expect(statSync(join(cwd, ".metis", "skills", "alpha", "scripts", "run.sh")).mode & 0o111).toBe(0o100);
		expect(existsSync(join(cwd, ".metis", "skills", "beta"))).toBe(false);
	});

	it("rejects archive traversal, changed sources, and target conflicts", async () => {
		const archive = join(root, "skills.zip");
		writeFileSync(archive, zip({ "alpha/SKILL.md": content("alpha") }));
		const context = { agentDir, cwd, skills: skills() };
		const inspected = await inspectSkillImport(context, {
			cwd,
			source: "project",
			input: { kind: "archive", path: archive },
		});
		writeFileSync(archive, zip({ "beta/SKILL.md": content("beta") }));
		await expect(
			importSkills(context, {
				requestId: REQUEST_A,
				cwd,
				source: "project",
				input: { kind: "archive", path: archive },
				sourceRevision: inspected.revision,
				candidateIds: ["alpha"],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		writeFileSync(archive, zip({ "../escape/SKILL.md": content("escape") }));
		await expect(
			inspectSkillImport(context, {
				cwd,
				source: "project",
				input: { kind: "archive", path: archive },
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });

		saveSkill(join(cwd, ".metis", "skills"), "alpha");
		writeFileSync(archive, zip({ "alpha/SKILL.md": content("alpha") }));
		const conflictContext = { agentDir, cwd, skills: skills() };
		const conflict = await inspectSkillImport(conflictContext, {
			cwd,
			source: "project",
			input: { kind: "archive", path: archive },
		});
		await expect(
			importSkills(conflictContext, {
				requestId: REQUEST_A,
				cwd,
				source: "project",
				input: { kind: "archive", path: archive },
				sourceRevision: conflict.revision,
				candidateIds: ["alpha"],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("rejects unsafe, malformed, and oversized Skill archives", async () => {
		const archive = join(root, "unsafe.skill");
		const context = { agentDir, cwd: null, skills: skills() };
		const inspect = () =>
			inspectSkillImport(context, {
				cwd: null,
				source: "user",
				input: { kind: "archive" as const, path: archive },
			});

		const invalidEntries: Array<Record<string, string | { readonly content: string; readonly mode: number }>> = [
			{ "alpha\\SKILL.md": content("alpha") },
			{ "alpha/link": { content: "target", mode: 0o120777 }, "alpha/SKILL.md": content("alpha") },
			{ "alpha/SKILL.md": "---\nname: [\n---\nBroken" },
			{ "alpha/SKILL.md": "x".repeat(16 * 1024 * 1024 + 1) },
		];
		for (const entries of invalidEntries) {
			writeFileSync(archive, zip(entries));
			await expect(inspect()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		}

		writeFileSync(
			archive,
			zip(Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [`files/${index}`, ""]))),
		);
		await expect(inspect()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		writeFileSync(archive, Buffer.alloc(32 * 1024 * 1024 + 1));
		await expect(inspect()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});

	it("inspects and imports a selected Skill from an immutable public GitHub snapshot", async () => {
		const commit = "a".repeat(40);
		const archive = zip({
			[`skills-${commit}/AGENTS.md`]: { content: "CLAUDE.md", mode: 0o120777 },
			[`skills-${commit}/bundle/alpha/SKILL.md`]: content("alpha", "Alpha Skill"),
			[`skills-${commit}/bundle/alpha/references/example.md`]: "example",
			[`skills-${commit}/other/SKILL.md`]: content("other", "Other Skill"),
		});
		const fetchImpl = vi.fn(async (value: string | URL | Request) => {
			const url = String(value);
			if (url.endsWith("/commits/main")) return new Response(JSON.stringify({ sha: commit }));
			if (url.includes("codeload.github.com")) return new Response(archive);
			return new Response(null, { status: 404 });
		}) as typeof fetch;
		const context = { agentDir, cwd: null, skills: skills() };
		const inspected = await inspectSkillImport(
			context,
			{
				cwd: null,
				source: "user",
				input: { kind: "github", url: "https://github.com/acme/skills/tree/main/bundle" },
			},
			fetchImpl,
		);
		expect(inspected.candidates).toEqual([
			{ id: "bundle/alpha", name: "alpha", description: "Alpha Skill", fileCount: 2 },
		]);

		await importSkills(
			context,
			{
				requestId: REQUEST_A,
				cwd: null,
				source: "user",
				input: { kind: "github", url: "https://github.com/acme/skills/tree/main/bundle" },
				sourceRevision: inspected.revision,
				candidateIds: ["bundle/alpha"],
			},
			fetchImpl,
		);
		expect(readFileSync(join(agentDir, "skills", "alpha", "references", "example.md"), "utf8")).toBe("example");
		expect(existsSync(join(agentDir, "skills", "other"))).toBe(false);
	});

	it("retries one transient GitHub response while inspecting", async () => {
		const commit = "b".repeat(40);
		const archive = zip({ [`skills-${commit}/alpha/SKILL.md`]: content("alpha", "Alpha Skill") });
		let archiveAttempts = 0;
		const fetchImpl = vi.fn(async (value: string | URL | Request) => {
			const url = String(value);
			if (url.endsWith("/repos/acme/skills")) return new Response(JSON.stringify({ default_branch: "main" }));
			if (url.endsWith("/commits/main")) return new Response(JSON.stringify({ sha: commit }));
			if (url.includes("codeload.github.com")) {
				archiveAttempts += 1;
				return archiveAttempts === 1 ? new Response(null, { status: 503 }) : new Response(archive);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		await expect(
			inspectSkillImport(
				{ agentDir, cwd: null, skills: skills() },
				{ cwd: null, source: "user", input: { kind: "github", url: "https://github.com/acme/skills.git" } },
				fetchImpl,
			),
		).resolves.toMatchObject({ candidates: [{ name: "alpha" }] });
		expect(archiveAttempts).toBe(2);
	});

	it("resolves GitHub refs containing slashes before applying the repository path", async () => {
		const commit = "c".repeat(40);
		const archive = zip({
			[`skills-${commit}/bundle/alpha/SKILL.md`]: content("alpha", "Alpha Skill"),
		});
		const fetchImpl = vi.fn(async (value: string | URL | Request) => {
			const url = String(value);
			if (url.endsWith("/commits/feature")) return new Response(null, { status: 404 });
			if (url.endsWith("/commits/feature%2Fskill-import")) {
				return new Response(JSON.stringify({ sha: commit }));
			}
			if (url.includes("codeload.github.com")) return new Response(archive);
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		await expect(
			inspectSkillImport(
				{ agentDir, cwd: null, skills: skills() },
				{
					cwd: null,
					source: "user",
					input: {
						kind: "github",
						url: "https://github.com/acme/skills/tree/feature/skill-import/bundle",
					},
				},
				fetchImpl,
			),
		).resolves.toMatchObject({ candidates: [{ id: "bundle/alpha", name: "alpha" }] });
	});

	it("rejects excessively deep GitHub routes before making network requests", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		await expect(
			inspectSkillImport(
				{ agentDir, cwd: null, skills: skills() },
				{
					cwd: null,
					source: "user",
					input: { kind: "github", url: `https://github.com/acme/skills/tree/${"part/".repeat(16)}skill` },
				},
				fetchImpl,
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
