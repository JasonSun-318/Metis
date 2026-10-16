import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const QUARANTINE_DIR_NAME = ".metis-native-quarantine";

function getQuarantineRoot(packageDir: string, directoryName = QUARANTINE_DIR_NAME): string | undefined {
	let current = resolve(packageDir);
	while (true) {
		if (basename(current).toLowerCase() === "node_modules") {
			return join(current, directoryName);
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

export function cleanupWindowsSelfUpdateQuarantine(packageDir: string): void {
	const quarantineRoot = getQuarantineRoot(packageDir);
	if (!quarantineRoot) return;
	try {
		rmSync(quarantineRoot, { recursive: true, force: true });
	} catch {
		// A previous Metis process may still be exiting and holding a native addon.
	}
}
