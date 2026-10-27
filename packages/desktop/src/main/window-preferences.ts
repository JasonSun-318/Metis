import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WindowPreferences {
	readonly width: number;
	readonly height: number;
	readonly maximized: boolean;
}

export const MAIN_WINDOW_MIN_WIDTH = 900;
export const MAIN_WINDOW_MIN_HEIGHT = 640;
const DEFAULT_PREFERENCES: WindowPreferences = { width: 1280, height: 840, maximized: false };

export function readStoredWindowPreferences(path: string): WindowPreferences {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_PREFERENCES;
		const { width, height, maximized } = value as Record<string, unknown>;
		if (
			typeof width === "number" &&
			Number.isFinite(width) &&
			width > 0 &&
			typeof height === "number" &&
			Number.isFinite(height) &&
			height > 0 &&
			(maximized === undefined || typeof maximized === "boolean")
		) {
			return { width: Math.round(width), height: Math.round(height), maximized: maximized === true };
		}
	} catch {
		// Missing or unreadable optional preferences use the normal startup size.
	}
	return DEFAULT_PREFERENCES;
}

export function constrainWindowSize(
	preferences: WindowPreferences,
	workArea: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
	return {
		width: Math.max(MAIN_WINDOW_MIN_WIDTH, Math.min(preferences.width, workArea.width)),
		height: Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.min(preferences.height, workArea.height)),
	};
}

export function storeWindowPreferences(path: string, preferences: WindowPreferences): void {
	let temporaryPath: string | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true });
		temporaryPath = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify(preferences), { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, path);
		temporaryPath = undefined;
	} catch {
		// Window preferences are best-effort and must not prevent closing the app.
	} finally {
		if (temporaryPath) {
			try {
				rmSync(temporaryPath, { force: true });
			} catch {
				// A failed cleanup must not turn an optional preference write into a startup failure.
			}
		}
	}
}
