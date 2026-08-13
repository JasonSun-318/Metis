import { useSyncExternalStore } from "react";

export const PROFILE_IDENTITY_STORAGE_KEY = "metis.profile.identity.v1";
export const DEFAULT_PROFILE_IDENTITY: ProfileIdentity = {
	displayName: "Metis User",
	avatarDataUrl: null,
};

export interface ProfileIdentity {
	readonly displayName: string;
	readonly avatarDataUrl: string | null;
}

const listeners = new Set<() => void>();
let current: ProfileIdentity | undefined;

function normalizedIdentity(value: Partial<ProfileIdentity> | null): ProfileIdentity {
	const displayName = typeof value?.displayName === "string" ? value.displayName.trim().slice(0, 80) : "";
	return {
		displayName: displayName || DEFAULT_PROFILE_IDENTITY.displayName,
		avatarDataUrl:
			typeof value?.avatarDataUrl === "string" && /^data:image\/(?:jpeg|png|webp);base64,/u.test(value.avatarDataUrl)
				? value.avatarDataUrl
				: null,
	};
}

function readProfileIdentity(): ProfileIdentity {
	try {
		return normalizedIdentity(
			JSON.parse(localStorage.getItem(PROFILE_IDENTITY_STORAGE_KEY) ?? "null") as Partial<ProfileIdentity> | null,
		);
	} catch {
		return DEFAULT_PROFILE_IDENTITY;
	}
}

function getProfileIdentity(): ProfileIdentity {
	if (!current) current = readProfileIdentity();
	return current;
}

function subscribeProfileIdentity(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function saveProfileIdentity(value: ProfileIdentity): void {
	const next = normalizedIdentity(value);
	localStorage.setItem(PROFILE_IDENTITY_STORAGE_KEY, JSON.stringify(next));
	const previous = current;
	current = next;
	if (previous?.displayName === next.displayName && previous.avatarDataUrl === next.avatarDataUrl) return;
	for (const listener of listeners) listener();
}

export function useProfileIdentity(): ProfileIdentity {
	return useSyncExternalStore(subscribeProfileIdentity, getProfileIdentity, getProfileIdentity);
}
