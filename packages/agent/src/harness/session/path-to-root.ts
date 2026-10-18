import { SessionError, type SessionTreeEntry } from "../types.ts";

export function getPathToRoot(byId: Map<string, SessionTreeEntry>, leafId: string | null): SessionTreeEntry[] {
	if (leafId === null) return [];
	const path: SessionTreeEntry[] = [];
	let current = byId.get(leafId);
	if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
	while (current) {
		path.unshift(current);
		if (!current.parentId) break;
		const parent = byId.get(current.parentId);
		if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
		current = parent;
	}
	return path;
}
