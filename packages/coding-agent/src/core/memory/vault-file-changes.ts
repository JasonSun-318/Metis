import { rmSync } from "node:fs";
import { replaceFileAtomicallySync } from "../durable-file.ts";

export interface VaultFileChange {
	path: string;
	/** Content before the operation; undefined means the file did not exist. */
	before: string | undefined;
	/** Content after the operation; undefined means the file is removed. */
	after: string | undefined;
}

function restore(path: string, text: string | undefined): void {
	if (text === undefined) rmSync(path, { force: true });
	else replaceFileAtomicallySync(path, text, { mode: 0o600 });
}

/**
 * Apply a pre-validated set of file changes in order. The caller holds the
 * vault lock and decides ordering. On failure, already-applied changes are
 * rolled back to their `before` content; a rollback failure is reported as an
 * AggregateError alongside the original cause.
 */
export function applyVaultFileChanges(changes: readonly VaultFileChange[]): void {
	const attempted: VaultFileChange[] = [];
	try {
		for (const change of changes) {
			if (change.before === change.after) continue;
			attempted.push(change);
			restore(change.path, change.after);
		}
	} catch (cause) {
		const errors: unknown[] = [cause];
		for (const change of attempted.reverse()) {
			try {
				restore(change.path, change.before);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 1) {
			throw new AggregateError(errors, "memory mutation failed; rollback also failed; snapshots retained");
		}
		throw cause;
	}
}
