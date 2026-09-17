/**
 * Long-term memory layout helpers. Markdown files under the vault root are the
 * source of truth; see `core/memory/vault-*.ts` for the implementation.
 */

import { migrateLegacyMemory } from "./memory/migrate-legacy.ts";
import { MemoryVault } from "./memory/vault.ts";
import { getVaultRoot } from "./memory/vault-paths.ts";

/** Vault root for long-term memory (`<agentDir>/memory`). */
export function getAutoMemoryRoot(agentDir: string): string {
	return getVaultRoot(agentDir);
}

/** Migrate any legacy memory data, then create the base vault layout. */
export function ensureVaultLayout(agentDir: string): void {
	const migration = migrateLegacyMemory(agentDir);
	if (migration.error) {
		// Surface the failure once per startup; the vault still opens and the
		// journal keeps the migration resumable on the next attempt.
		console.error(
			`Memory migration incomplete (legacy data preserved under ${migration.legacyDir ?? ".history"}): ${migration.error}`,
		);
	}
	new MemoryVault({ agentDir }).ensureLayout();
}
