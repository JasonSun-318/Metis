import { type Static, type TSchema, Type } from "typebox";
import {
	CapabilitySchema,
	CursorSchema,
	MAX_CAPABILITIES,
	MAX_HISTORY_ITEMS,
	NameSchema,
	OpaqueIdSchema,
	OptionalNameSchema,
	PathSchema,
	PROTOCOL_VERSION,
	PromptTextSchema,
	PublicTextSchema,
	SessionIdSchema,
	StrictObject,
	UuidSchema,
} from "./schema.ts";
import {
	ActualThinkingLevelSchema,
	AgentModeSchema,
	ConnectionEventsParamsSchema,
	DurableImageRefViewSchema,
	InteractionViewSchema,
	ItemViewSchema,
	SessionSnapshotSchema,
	SessionSummarySchema,
	ThinkingSelectionSchema,
} from "./views.ts";

export interface RpcMethodDefinition<Params extends TSchema = TSchema, Result extends TSchema = TSchema> {
	readonly params: Params;
	readonly result: Result;
}

function method<const Params extends TSchema, const Result extends TSchema>(
	params: Params,
	result: Result,
): RpcMethodDefinition<Params, Result> {
	return { params, result };
}

export const InitializeParamsSchema = StrictObject({
	// Unsupported integer versions are structurally valid so the dispatcher can
	// answer with PROTOCOL_MISMATCH instead of misclassifying them as bad params.
	protocolVersion: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
	client: StrictObject({
		name: NameSchema,
		version: Type.String({ minLength: 1, maxLength: 64 }),
	}),
	capabilities: Type.Array(CapabilitySchema, { maxItems: MAX_CAPABILITIES, uniqueItems: true }),
});

export const InitializeResultSchema = StrictObject({
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	server: StrictObject({
		name: Type.Literal("arcmind-app-server"),
		version: Type.String({ minLength: 1, maxLength: 64 }),
	}),
	serverEpoch: UuidSchema,
	capabilities: Type.Array(CapabilitySchema, { maxItems: MAX_CAPABILITIES, uniqueItems: true }),
});

export const SessionListParamsSchema = StrictObject({
	includeArchived: Type.Optional(Type.Boolean()),
	afterSessionId: Type.Optional(Type.Union([SessionIdSchema, Type.Null()])),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS })),
});

export const SessionListResultSchema = StrictObject({
	sessions: Type.Array(SessionSummarySchema, { maxItems: MAX_HISTORY_ITEMS }),
	nextAfterSessionId: Type.Union([SessionIdSchema, Type.Null()]),
});

export const SessionCreateParamsSchema = StrictObject({
	// Create IDs are globally scoped because the ID also becomes the session ID.
	requestId: UuidSchema,
	mode: Type.Optional(AgentModeSchema),
	cwd: Type.Optional(PathSchema),
	name: Type.Optional(OptionalNameSchema),
});
export const SessionCreateResultSchema = StrictObject({ session: SessionSummarySchema });

export const SessionRefParamsSchema = StrictObject({ sessionId: SessionIdSchema });
export const SessionOpenResultSchema = StrictObject({ session: SessionSummarySchema });

export const SessionReadItemsParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	beforeItemId: Type.Optional(Type.Union([OpaqueIdSchema, Type.Null()])),
	limit: Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS }),
});
export const SessionReadItemsResultSchema = StrictObject({
	items: Type.Array(ItemViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	nextBeforeItemId: Type.Union([OpaqueIdSchema, Type.Null()]),
});

export const SessionMutationParamsSchema = StrictObject({
	// Every other request ID is scoped to this session's durable journal.
	requestId: UuidSchema,
	sessionId: SessionIdSchema,
});
export const SessionCloseResultSchema = StrictObject({
	sessionId: SessionIdSchema,
	closed: Type.Literal(true),
});
export const SessionMutationResultSchema = StrictObject({ session: SessionSummarySchema });

export const SessionSubscribeResultSchema = StrictObject({ snapshot: SessionSnapshotSchema });
export const SessionUnsubscribeResultSchema = StrictObject({
	sessionId: SessionIdSchema,
	unsubscribed: Type.Literal(true),
});

export const SessionSetThinkingSelectionParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	selection: ThinkingSelectionSchema,
});
export const SessionThinkingSelectionResultSchema = StrictObject({
	thinkingSelection: ThinkingSelectionSchema,
	actualThinkingLevel: ActualThinkingLevelSchema,
	availableThinkingSelections: Type.Array(ThinkingSelectionSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
});

export const SubagentReadItemsParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	beforeItemId: Type.Optional(Type.Union([OpaqueIdSchema, Type.Null()])),
	limit: Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS }),
});

export const FileAttachmentInputSchema = StrictObject({
	path: PathSchema,
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});

export const TurnInputSchema = StrictObject({
	sessionId: SessionIdSchema,
	// Turn request IDs are scoped to sessionId.
	requestId: UuidSchema,
	text: PromptTextSchema,
	images: Type.Optional(Type.Array(DurableImageRefViewSchema, { maxItems: 32 })),
	attachments: Type.Optional(Type.Array(FileAttachmentInputSchema, { maxItems: 16 })),
});

export const TurnSteerParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	text: PromptTextSchema,
	images: Type.Optional(Type.Array(DurableImageRefViewSchema, { maxItems: 32 })),
	attachments: Type.Optional(Type.Array(FileAttachmentInputSchema, { maxItems: 16 })),
	delivery: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
});

export const AcceptedOperationSchema = StrictObject({
	operationId: OpaqueIdSchema,
	queueItemId: Type.Optional(OpaqueIdSchema),
	turnId: Type.Optional(OpaqueIdSchema),
	status: Type.Union([Type.Literal("accepted"), Type.Literal("existing")]),
});

export const ConnectionAckParamsSchema = StrictObject({
	serverEpoch: UuidSchema,
	cursor: CursorSchema,
});
export const ConnectionAckResultSchema = StrictObject({ acknowledgedCursor: CursorSchema });

export const ServerShutdownParamsSchema = StrictObject({
	requestId: UuidSchema,
	reason: Type.Optional(PublicTextSchema),
});
export const ServerShutdownResultSchema = StrictObject({ accepted: Type.Literal(true) });

export const InteractionRequestParamsSchema = StrictObject({
	serverEpoch: UuidSchema,
	interaction: InteractionViewSchema,
});
export const TrustInteractionResultSchema = StrictObject({
	interactionId: UuidSchema,
	kind: Type.Literal("project_trust"),
	choiceId: OpaqueIdSchema,
});
export const SelectInteractionResultSchema = StrictObject({
	interactionId: UuidSchema,
	kind: Type.Literal("select"),
	choiceId: OpaqueIdSchema,
});
export const ConfirmInteractionResultSchema = StrictObject({
	interactionId: UuidSchema,
	kind: Type.Literal("confirm"),
	confirmed: Type.Boolean(),
});
export const InputInteractionResultSchema = StrictObject({
	interactionId: UuidSchema,
	kind: Type.Literal("input"),
	value: PublicTextSchema,
});
export const InteractionResultSchema = Type.Union([
	TrustInteractionResultSchema,
	SelectInteractionResultSchema,
	ConfirmInteractionResultSchema,
	InputInteractionResultSchema,
]);

export const ClientRequestMethods = {
	initialize: method(InitializeParamsSchema, InitializeResultSchema),
	"session/list": method(SessionListParamsSchema, SessionListResultSchema),
	"session/create": method(SessionCreateParamsSchema, SessionCreateResultSchema),
	"session/open": method(SessionRefParamsSchema, SessionOpenResultSchema),
	"session/readItems": method(SessionReadItemsParamsSchema, SessionReadItemsResultSchema),
	"session/close": method(SessionMutationParamsSchema, SessionCloseResultSchema),
	"session/archive": method(SessionMutationParamsSchema, SessionMutationResultSchema),
	"session/unarchive": method(SessionMutationParamsSchema, SessionMutationResultSchema),
	"session/subscribe": method(SessionRefParamsSchema, SessionSubscribeResultSchema),
	"session/unsubscribe": method(SessionRefParamsSchema, SessionUnsubscribeResultSchema),
	"session/setThinkingSelection": method(
		SessionSetThinkingSelectionParamsSchema,
		SessionThinkingSelectionResultSchema,
	),
	"subagent/readItems": method(SubagentReadItemsParamsSchema, SessionReadItemsResultSchema),
	"turn/start": method(TurnInputSchema, AcceptedOperationSchema),
	"turn/steer": method(TurnSteerParamsSchema, AcceptedOperationSchema),
	"turn/interrupt": method(SessionMutationParamsSchema, AcceptedOperationSchema),
	"connection/ack": method(ConnectionAckParamsSchema, ConnectionAckResultSchema),
} as const;

export const HostRequestMethods = {
	"server/shutdown": method(ServerShutdownParamsSchema, ServerShutdownResultSchema),
} as const;

export const ServerRequestMethods = {
	"interaction/request": method(InteractionRequestParamsSchema, InteractionResultSchema),
} as const;

export const ServerNotificationMethods = {
	"connection/events": ConnectionEventsParamsSchema,
} as const;

export type ClientRequestMethod = keyof typeof ClientRequestMethods;
export type HostRequestMethod = keyof typeof HostRequestMethods;
export type ServerRequestMethod = keyof typeof ServerRequestMethods;
export type ServerNotificationMethod = keyof typeof ServerNotificationMethods;
export type AnyRequestMethod = ClientRequestMethod | HostRequestMethod | ServerRequestMethod;

type DefinitionParams<Definition> = Definition extends RpcMethodDefinition<infer Params, TSchema>
	? Static<Params>
	: never;
type DefinitionResult<Definition> = Definition extends RpcMethodDefinition<TSchema, infer Result>
	? Static<Result>
	: never;

export type ClientParams<Method extends ClientRequestMethod> = DefinitionParams<(typeof ClientRequestMethods)[Method]>;
export type ClientResult<Method extends ClientRequestMethod> = DefinitionResult<(typeof ClientRequestMethods)[Method]>;
export type HostParams<Method extends HostRequestMethod> = DefinitionParams<(typeof HostRequestMethods)[Method]>;
export type HostResult<Method extends HostRequestMethod> = DefinitionResult<(typeof HostRequestMethods)[Method]>;
export type ServerParams<Method extends ServerRequestMethod> = DefinitionParams<(typeof ServerRequestMethods)[Method]>;
export type ServerResult<Method extends ServerRequestMethod> = DefinitionResult<(typeof ServerRequestMethods)[Method]>;
export type InteractionResponseInput = Static<typeof InteractionResultSchema>;
