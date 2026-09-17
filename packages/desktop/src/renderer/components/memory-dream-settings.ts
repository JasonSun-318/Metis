import type { ClientParams, MemorySettingsView } from "@metis/app-protocol";

export interface DreamSettingsDraft {
	enabled: boolean;
	modelKey: string;
	minHours: string;
	minSessions: string;
	maxUnusedDays: string;
}

export type DreamDraftResult =
	| { ok: true; value: NonNullable<ClientParams<"memory/update">["dream"]> }
	| { ok: false; message: string };

export function toDreamDraft(view: MemorySettingsView["dream"]): DreamSettingsDraft {
	return {
		enabled: view.enabled,
		modelKey: view.model ? JSON.stringify([view.model.provider, view.model.modelId]) : "",
		minHours: String(view.minHours),
		minSessions: String(view.minSessions),
		maxUnusedDays: String(view.maxUnusedDays),
	};
}

export function parseDreamDraft(draft: DreamSettingsDraft): DreamDraftResult {
	const integer = (s: string, max: number): number | undefined => {
		if (!/^\d+$/.test(s.trim())) return undefined;
		const n = Number(s);
		return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : undefined;
	};
	const minHours = integer(draft.minHours, 8760);
	const minSessions = integer(draft.minSessions, 100000);
	const maxUnusedDays = integer(draft.maxUnusedDays, 3650);
	if (minHours === undefined) {
		return { ok: false, message: "Minimum interval must be an integer from 1 to 8760 hours." };
	}
	if (minSessions === undefined) {
		return { ok: false, message: "Minimum sessions must be an integer from 1 to 100000." };
	}
	if (maxUnusedDays === undefined) {
		return { ok: false, message: "Unused-note age must be an integer from 1 to 3650 days." };
	}
	let model: { provider: string; modelId: string } | null = null;
	if (draft.modelKey) {
		try {
			const parts: unknown = JSON.parse(draft.modelKey);
			if (
				!Array.isArray(parts) ||
				parts.length !== 2 ||
				parts.some((s) => typeof s !== "string" || s.length === 0)
			) {
				throw new Error("invalid model");
			}
			model = { provider: parts[0] as string, modelId: parts[1] as string };
		} catch {
			return { ok: false, message: "Choose a valid memory model." };
		}
	}
	return { ok: true, value: { enabled: draft.enabled, model, minHours, minSessions, maxUnusedDays } };
}
