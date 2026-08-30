export const GENERAL_PREFERENCES_STORAGE_KEY = "metis.general-preferences.v1";

export type MotionPreference = "system" | "reduced";
export type ProseFontPreference = "anthropic-serif" | "system-serif" | "system-sans";

export const CONTENT_FONT_SIZE_OPTIONS = [
	{ value: "13px", label: "13 px" },
	{ value: "14px", label: "14 px" },
	{ value: "15px", label: "15 px" },
	{ value: "16px", label: "16 px" },
	{ value: "17px", label: "17 px" },
	{ value: "18px", label: "18 px" },
	{ value: "19px", label: "19 px" },
	{ value: "20px", label: "20 px" },
] as const;

export type ContentFontSizePreference = (typeof CONTENT_FONT_SIZE_OPTIONS)[number]["value"];

export interface GeneralPreferences {
	readonly motion: MotionPreference;
	readonly chatFont: ProseFontPreference;
	readonly codeFont: ProseFontPreference;
	readonly contentFontSize: ContentFontSizePreference;
}

export const DEFAULT_GENERAL_PREFERENCES: GeneralPreferences = {
	motion: "system",
	chatFont: "system-sans",
	codeFont: "system-sans",
	contentFontSize: "15px",
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

function isContentFontSizePreference(value: unknown): value is ContentFontSizePreference {
	return CONTENT_FONT_SIZE_OPTIONS.some((option) => option.value === value);
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
			contentFontSize: isContentFontSizePreference(parsed?.contentFontSize)
				? parsed.contentFontSize
				: DEFAULT_GENERAL_PREFERENCES.contentFontSize,
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
	document.documentElement.style.setProperty("--content-font-size", preferences.contentFontSize);
}
