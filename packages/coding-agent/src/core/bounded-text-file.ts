import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedUtf8FileSync(path: string, maxBytes: number): string {
	const descriptor = openSync(path, "r");
	try {
		const stats = fstatSync(descriptor);
		if (!stats.isFile() || stats.size > maxBytes) throw new Error(`Text file exceeds ${maxBytes} bytes`);
		const bytes = Buffer.allocUnsafe(maxBytes + 1);
		let used = 0;
		while (used < bytes.length) {
			const count = readSync(descriptor, bytes, used, bytes.length - used, null);
			if (count === 0) break;
			used += count;
		}
		if (used > maxBytes) throw new Error(`Text file exceeds ${maxBytes} bytes`);
		return bytes.subarray(0, used).toString("utf8");
	} finally {
		closeSync(descriptor);
	}
}
