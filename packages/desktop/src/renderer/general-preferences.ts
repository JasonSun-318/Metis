export const GENERAL_PREFERENCES_STORAGE_KEY = "metis.general-preferences.v1";

export type MotionPreference = "system" | "reduced";
export type ProseFontPreference = "anthropic-serif" | "system-serif" | "system-sans";

export interface GeneralPreferences {
	readonly motion: MotionPreference;
	readonly chatFont: ProseFontPreference;
	readonly codeFont: ProseFontPreference;
}

export const DEFAULT_GENERAL_PREFERENCES: GeneralPreferences = {
	motion: "system",
	chatFont: "system-sans",
	codeFont: "system-sans",
};

export const PROSE_FONT_OPTIONS = [
	{ value: "anthropic-serif", label: "Anthropic Serif" },
	{ value: "system-serif", label: "System serif" },
	{ value: "system-sans", label: "System sans serif" },
] as const;

const FONT_STACKS: Record<ProseFontPreference, string> = {
	"anthropic-serif": '"Metis Anthropic Serif", ui-serif, "Songti SC", STSong, Georgia, serif',
	"system-serif": 'ui-serif, "Songti SC", STSong, Georgia, serif',
	"system-sans": 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
};

function isMotionPreference(value: unknown): value is MotionPreference {
	return value === "system" || value === "reduced";
}

function isProseFontPreference(value: unknown): value is ProseFontPreference {
	return value === "anthropic-serif" || value === "system-serif" || value === "system-sans";
}

export function loadGeneralPreferences(storage: Pick<Storage, "getItem">): GeneralPreferences {
	try {
		const parsed = JSON.parse(storage.getItem(GENERAL_PREFERENCES_STORAGE_KEY) ?? "null") as Record<
			string,
			unknown
		> | null;
		return {
			motion: isMotionPreference(parsed?.motion) ? parsed.motion : DEFAULT_GENERAL_PREFERENCES.motion,
			chatFont: isProseFontPreference(parsed?.chatFont) ? parsed.chatFont : DEFAULT_GENERAL_PREFERENCES.chatFont,
			codeFont: isProseFontPreference(parsed?.codeFont) ? parsed.codeFont : DEFAULT_GENERAL_PREFERENCES.codeFont,
		};
	} catch {
		return DEFAULT_GENERAL_PREFERENCES;
	}
}

export function saveGeneralPreferences(storage: Pick<Storage, "setItem">, preferences: GeneralPreferences): void {
	try {
		storage.setItem(GENERAL_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
	} catch {
		// The preferences remain active when persistence is unavailable.
	}
}

export function resolveReducedMotion(preference: MotionPreference, media: Pick<MediaQueryList, "matches">): boolean {
	return preference === "reduced" || media.matches;
}

export function applyGeneralPreferencesToDocument(
	preferences: GeneralPreferences,
	media: Pick<MediaQueryList, "matches">,
): void {
	document.documentElement.dataset.motion = resolveReducedMotion(preferences.motion, media) ? "reduced" : "full";
	document.documentElement.style.setProperty("--chat-prose-font", FONT_STACKS[preferences.chatFont]);
	document.documentElement.style.setProperty("--code-prose-font", FONT_STACKS[preferences.codeFont]);
}
