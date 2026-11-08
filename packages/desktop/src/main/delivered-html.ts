import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Metis treats these non-hidden credential files as sensitive even inside a workspace.
const CREDENTIAL_FILE_NAMES = new Set(["auth.json", "credentials.json"]);
const WEB_EXTENSIONS = new Set([
	".html",
	".htm",
	".css",
	".js",
	".mjs",
	".json",
	".wasm",
	".svg",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".avif",
	".ico",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".mp3",
	".wav",
	".ogg",
	".mp4",
	".webm",
]);

export class DeliveredHtmlPage {
	readonly url: string;
	private readonly directory: string;

	constructor(path: string) {
		if (!isAbsolute(path) || !/\.html?$/iu.test(path)) throw new Error("Delivered file is not an HTML page");
		this.directory = dirname(path);
		this.url = pathToFileURL(path).href;
	}

	contains(url: URL): boolean {
		return this.resourcePath(url) !== undefined;
	}

	async canRead(url: URL): Promise<boolean> {
		const path = this.resourcePath(url);
		if (!path) return false;
		try {
			// Block links and other non-regular files before Chromium opens the native file URL.
			return (await realpath(path)) === path && (await lstat(path)).isFile();
		} catch {
			return false;
		}
	}

	private resourcePath(url: URL): string | undefined {
		if (url.protocol !== "file:") return undefined;
		let path: string;
		try {
			path = fileURLToPath(url);
		} catch {
			return undefined;
		}
		const fromDirectory = relative(this.directory, path);
		if (!fromDirectory || isAbsolute(fromDirectory)) return undefined;
		if (fromDirectory.split(sep).some((part) => part.startsWith(".") || /[\\/:\0]/u.test(part))) return undefined;
		const name = basename(path).toLowerCase();
		return WEB_EXTENSIONS.has(extname(name)) && !CREDENTIAL_FILE_NAMES.has(name) ? path : undefined;
	}
}
