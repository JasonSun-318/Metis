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
	migrateLegacyMemory(agentDir);
	new MemoryVault({ agentDir }).ensureLayout();
}
