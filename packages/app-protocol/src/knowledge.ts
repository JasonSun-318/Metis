import { type Static, Type } from "typebox";
import { PathSchema, PublicTextSchema, SessionIdSchema, StrictObject, Utf8String, UuidSchema } from "./schema.ts";

export const KnowledgeLibrarySchema = StrictObject({ id: UuidSchema, name: PublicTextSchema, path: PathSchema });
export type KnowledgeLibrary = Static<typeof KnowledgeLibrarySchema>;
export const KnowledgeLibrariesSchema = StrictObject({ libraries: Type.Array(KnowledgeLibrarySchema) });
export const KnowledgeNoteSchema = StrictObject({
	path: PathSchema,
	title: PublicTextSchema,
	links: Type.Array(
		StrictObject({
			target: PublicTextSchema,
			kind: Type.Union([Type.Literal("wiki"), Type.Literal("markdown")]),
			path: Type.Union([PathSchema, Type.Null()]),
		}),
	),
});
export type KnowledgeNote = Static<typeof KnowledgeNoteSchema>;
export const KnowledgeScanSchema = StrictObject({
	notes: Type.Array(KnowledgeNoteSchema),
	edges: Type.Array(StrictObject({ source: PathSchema, target: PathSchema })),
	warnings: Type.Array(PublicTextSchema),
});
export const KnowledgeReadSchema = StrictObject({ path: PathSchema, content: Utf8String(4 * 1024 * 1024) });
export const KnowledgeRegisterParamsSchema = StrictObject({ requestId: UuidSchema, path: PathSchema });
export const KnowledgeScanParamsSchema = StrictObject({ libraryId: UuidSchema });
export const KnowledgeReadParamsSchema = StrictObject({ libraryId: UuidSchema, path: PathSchema });
export const KnowledgeSessionParamsSchema = StrictObject({ sessionId: SessionIdSchema });
export const KnowledgeSetParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	libraryIds: Type.Array(UuidSchema, { uniqueItems: true }),
});
