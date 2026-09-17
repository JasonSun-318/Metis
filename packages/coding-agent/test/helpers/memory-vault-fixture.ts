import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryVault, type WriteResult } from "../../src/core/memory/vault.ts";
import { resolveVaultProject, type VaultProjectIdentity } from "../../src/core/memory/vault-project.ts";
import type { MemoryActor, MemoryScope } from "../../src/core/memory/vault-types.ts";

export interface MemoryFixture {
	root: string;
	agentDir: string;
	project(name: string): VaultProjectIdentity;
	vault(projectName?: string): MemoryVault;
}
export async function withMemoryFixture<T>(fn: (f: MemoryFixture) => Promise<T> | T): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "metis-memory-fix-"));
	const agentDir = join(root, "agent");
	const project = (name: string) => {
		const cwd = join(root, "work", name);
		mkdirSync(cwd, { recursive: true });
		return resolveVaultProject(cwd, "user-selected")!;
	};
	const vault = (name?: string) => {
		const v = new MemoryVault({ agentDir, ...(name ? { project: project(name) } : {}) });
		v.ensureLayout();
		return v;
	};
	try {
		return await fn({ root, agentDir, project, vault });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
export function mustWrite(result: WriteResult): Extract<WriteResult, { ok: true }> {
	if (!result.ok) throw new Error(result.error);
	return result;
}
export async function putNote(
	vault: MemoryVault,
	scope: MemoryScope,
	slug: string,
	content: string,
	actor: MemoryActor = { kind: "user" },
): Promise<Extract<WriteResult, { ok: true }>> {
	return mustWrite(
		await vault.write(
			{
				op: "create",
				scope,
				target: { slug },
				frontmatter: { name: "fixture", type: "reference", description: "fixture" },
				content,
			},
			actor,
		),
	);
}
