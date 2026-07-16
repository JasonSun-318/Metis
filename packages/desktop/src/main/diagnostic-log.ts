import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 2;

export interface DiagnosticLogOptions {
	readonly path: string;
	readonly maxBytes?: number;
	readonly backups?: number;
}

function redact(value: string): string {
	return value
		.replace(/(\bauthorization\s*:\s*bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
		.replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
		.replace(/(\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*)(["']?)[^\s"',;]+/gi, "$1$2[REDACTED]");
}

function boundedRecord(source: string, chunk: string | Uint8Array, maxBytes: number): Buffer {
	const prefix = `[${new Date().toISOString()}] [${source}] `;
	const suffix = "\n";
	const text = redact(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")).replace(/\n+$/u, "");
	let record = Buffer.from(`${prefix}${text}${suffix}`);
	if (record.byteLength <= maxBytes) return record;

	const marker = "[truncated] ";
	const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(marker) + Buffer.byteLength(suffix);
	const remaining = Math.max(0, maxBytes - fixedBytes);
	const tail = Buffer.from(text).subarray(-remaining).toString("utf8");
	record = Buffer.from(`${prefix}${marker}${tail}${suffix}`);
	return record.byteLength <= maxBytes ? record : record.subarray(0, maxBytes);
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

async function renameIfPresent(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** A serialized, bounded local diagnostic sink. Callers retain backpressure by awaiting append. */
export class DiagnosticLog {
	private readonly path: string;
	private readonly maxBytes: number;
	private readonly backups: number;
	private tail = Promise.resolve();

	constructor(options: DiagnosticLogOptions) {
		if (
			!Number.isSafeInteger(options.maxBytes ?? DEFAULT_MAX_BYTES) ||
			(options.maxBytes ?? DEFAULT_MAX_BYTES) < 64
		) {
			throw new TypeError("Diagnostic log maxBytes must be an integer of at least 64");
		}
		if (!Number.isSafeInteger(options.backups ?? DEFAULT_BACKUPS) || (options.backups ?? DEFAULT_BACKUPS) < 0) {
			throw new TypeError("Diagnostic log backups must be a non-negative integer");
		}
		this.path = options.path;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.backups = options.backups ?? DEFAULT_BACKUPS;
	}

	append(source: "stdout" | "stderr" | "supervisor", chunk: string | Uint8Array): Promise<void> {
		const record = boundedRecord(source, chunk, this.maxBytes);
		const write = this.tail.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			if ((await fileSize(this.path)) + record.byteLength > this.maxBytes) await this.rotate();
			await writeFile(this.path, record, { flag: "a", mode: 0o600 });
		});
		this.tail = write.catch(() => undefined);
		return write;
	}

	async flush(): Promise<void> {
		await this.tail;
	}

	private async rotate(): Promise<void> {
		if (this.backups === 0) {
			await rm(this.path, { force: true });
			return;
		}
		await rm(`${this.path}.${this.backups}`, { force: true });
		for (let index = this.backups - 1; index >= 1; index -= 1) {
			await renameIfPresent(`${this.path}.${index}`, `${this.path}.${index + 1}`);
		}
		await renameIfPresent(this.path, `${this.path}.1`);
	}
}
