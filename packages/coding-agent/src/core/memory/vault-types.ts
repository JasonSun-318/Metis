export const MEMORY_SCOPES = ["global", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const NOTE_TYPES = ["user", "feedback", "project", "reference", "decision"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const PINNED_BLOCKS = {
	global: ["user", "feedback"],
	project: ["project", "active"],
} as const;
export type PinnedBlock = "user" | "feedback" | "project" | "active";

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface NoteFrontmatter {
	name: string;
	description: string;
	type: NoteType;
	aliases?: string[];
	/** YYYY-MM-DD */
	created: string;
	/** YYYY-MM-DD */
	updated: string;
	/** session:<id> | dream:<runId> | user | migrated */
	sources: string[];
	confidence: ConfidenceLevel;
	applies_to?: string[];
}

export interface Note {
	scope: MemoryScope;
	slug: string;
	frontmatter: NoteFrontmatter;
	body: string;
	path: string;
	/** [[slug]] link targets found in the body. */
	links: string[];
	/** Set when the stored frontmatter could not be fully parsed. */
	malformed?: boolean;
}

export type MemoryTarget = { slug: string } | { block: PinnedBlock };

export type MemoryActor =
	| { kind: "agent"; sessionId: string }
	| { kind: "dream"; runId: string }
	| { kind: "user" }
	| { kind: "migrate" };

export const MEMORY_LIMITS = {
	indexLines: 200,
	indexBytes: 25 * 1024,
	noteBodyBytes: 16 * 1024,
	pinnedBytes: { user: 4096, feedback: 4096, project: 4096, active: 2048 },
	pinnedTotalBytes: 12 * 1024,
	descriptionChars: 120,
	snapshotsPerTarget: 20,
	snapshotMaxAgeDays: 90,
} as const;

export const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,119}$/u;

export function isSafeSlug(value: string): boolean {
	return SAFE_SLUG.test(value) && !value.includes("..");
}

export const INDEX_ENTRY =
	/^- \[(user|feedback|project|reference|decision)\] \[([a-z0-9][a-z0-9._-]*)\]\(notes\/\2\.md\) — .{1,120}$/u;

export function isPinnedBlock(value: string): value is PinnedBlock {
	return value === "user" || value === "feedback" || value === "project" || value === "active";
}

/** Scope a pinned block belongs to. */
export function pinnedBlockScope(block: PinnedBlock): MemoryScope {
	return (PINNED_BLOCKS.global as readonly string[]).includes(block) ? "global" : "project";
}

/** Frontmatter `sources` entry for an actor. */
export function actorSource(actor: MemoryActor): string {
	switch (actor.kind) {
		case "agent":
			return `session:${actor.sessionId}`;
		case "dream":
			return `dream:${actor.runId}`;
		case "user":
			return "user";
		case "migrate":
			return "migrated";
	}
}

/** History directory key for a write target: the slug, or `_pinned-<block>`. */
export function targetKey(target: MemoryTarget): string {
	return "slug" in target ? target.slug : `_pinned-${target.block}`;
}

export function targetsEqual(left: MemoryTarget, right: MemoryTarget): boolean {
	if ("slug" in left && "slug" in right) return left.slug === right.slug;
	if ("block" in left && "block" in right) return left.block === right.block;
	return false;
}
