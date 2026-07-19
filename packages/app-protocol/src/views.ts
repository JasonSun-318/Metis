import { type Static, Type } from "typebox";
import {
	CursorSchema,
	DeltaTextSchema,
	MAX_HISTORY_ITEMS,
	MAX_INTERACTION_CHOICES,
	NameSchema,
	OpaqueIdSchema,
	OptionalNameSchema,
	PathSchema,
	PromptTextSchema,
	PublicTextSchema,
	SessionIdSchema,
	Sha256Schema,
	StrictObject,
	TimestampSchema,
	UuidSchema,
} from "./schema.ts";

export const SessionStateSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("running"),
	Type.Literal("interrupted"),
	Type.Literal("corrupt"),
	Type.Literal("in_use"),
]);

export const PublicErrorDataSchema = StrictObject({
	name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z][A-Z0-9_]*$" }),
	retryable: Type.Boolean(),
	requestId: Type.Optional(UuidSchema),
	sessionId: Type.Optional(SessionIdSchema),
	operationId: Type.Optional(OpaqueIdSchema),
	interactionId: Type.Optional(UuidSchema),
});

export const SessionSummarySchema = StrictObject({
	sessionId: SessionIdSchema,
	name: Type.Optional(OptionalNameSchema),
	// Legacy journals may not contain a working directory. App-server projects
	// their empty-string sentinel to null instead of exposing it on the wire.
	cwd: Type.Union([PathSchema, Type.Null()]),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	state: SessionStateSchema,
	archived: Type.Boolean(),
	recoveryNotice: Type.Optional(PublicTextSchema),
});

export const DurableImageRefViewSchema = StrictObject({
	hash: Sha256Schema,
	mediaType: Type.Union([
		Type.Literal("image/jpeg"),
		Type.Literal("image/png"),
		Type.Literal("image/gif"),
		Type.Literal("image/webp"),
	]),
	byteLength: Type.Integer({ minimum: 1, maximum: 32 * 1024 * 1024 }),
});

export const TextBlockViewSchema = StrictObject({
	type: Type.Literal("text"),
	text: PromptTextSchema,
});

export const ImageBlockViewSchema = StrictObject({
	type: Type.Literal("image"),
	image: DurableImageRefViewSchema,
});

export const ToolCallBlockViewSchema = StrictObject({
	type: Type.Literal("tool_call"),
	toolCallId: OpaqueIdSchema,
	name: NameSchema,
	state: Type.Union([
		Type.Literal("pending"),
		Type.Literal("running"),
		Type.Literal("completed"),
		Type.Literal("interrupted"),
	]),
	inputPreview: Type.Optional(PublicTextSchema),
});

export const ToolResultBlockViewSchema = StrictObject({
	type: Type.Literal("tool_result"),
	toolCallId: OpaqueIdSchema,
	name: NameSchema,
	isError: Type.Boolean(),
	output: PublicTextSchema,
});

export const NoticeBlockViewSchema = StrictObject({
	type: Type.Literal("notice"),
	level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
	text: PublicTextSchema,
});

export const ItemContentBlockViewSchema = Type.Union([
	TextBlockViewSchema,
	ImageBlockViewSchema,
	ToolCallBlockViewSchema,
	ToolResultBlockViewSchema,
	NoticeBlockViewSchema,
]);

export const ItemViewSchema = StrictObject({
	itemId: OpaqueIdSchema,
	sessionId: SessionIdSchema,
	turnId: Type.Optional(OpaqueIdSchema),
	role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("system")]),
	state: Type.Union([Type.Literal("streaming"), Type.Literal("completed"), Type.Literal("interrupted")]),
	content: Type.Array(ItemContentBlockViewSchema, { maxItems: 256 }),
	createdAt: TimestampSchema,
	completedAt: Type.Optional(TimestampSchema),
});

export const TurnViewSchema = StrictObject({
	turnId: OpaqueIdSchema,
	sessionId: SessionIdSchema,
	operationIds: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 256, uniqueItems: true }),
	state: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("interrupted")]),
	startedAt: TimestampSchema,
	completedAt: Type.Optional(TimestampSchema),
	error: Type.Optional(PublicErrorDataSchema),
});

export const InteractionChoiceSchema = StrictObject({
	id: OpaqueIdSchema,
	label: NameSchema,
	description: Type.Optional(PublicTextSchema),
});

const InteractionBase = {
	interactionId: UuidSchema,
	sessionId: SessionIdSchema,
	title: NameSchema,
	message: PublicTextSchema,
	createdAt: TimestampSchema,
	expiresAt: Type.Optional(TimestampSchema),
} as const;

export const TrustInteractionViewSchema = StrictObject({
	...InteractionBase,
	kind: Type.Literal("project_trust"),
	projectPath: PathSchema,
	choices: Type.Array(InteractionChoiceSchema, { minItems: 1, maxItems: MAX_INTERACTION_CHOICES }),
});

export const SelectInteractionViewSchema = StrictObject({
	...InteractionBase,
	kind: Type.Literal("select"),
	choices: Type.Array(InteractionChoiceSchema, { minItems: 1, maxItems: MAX_INTERACTION_CHOICES }),
});

export const ConfirmInteractionViewSchema = StrictObject({
	...InteractionBase,
	kind: Type.Literal("confirm"),
	confirmLabel: Type.Optional(NameSchema),
	cancelLabel: Type.Optional(NameSchema),
});

export const InputInteractionViewSchema = StrictObject({
	...InteractionBase,
	kind: Type.Literal("input"),
	placeholder: Type.Optional(PublicTextSchema),
	secret: Type.Boolean(),
});

export const InteractionViewSchema = Type.Union([
	TrustInteractionViewSchema,
	SelectInteractionViewSchema,
	ConfirmInteractionViewSchema,
	InputInteractionViewSchema,
]);

export const ActualThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export const ThinkingSelectionSchema = Type.Union([ActualThinkingLevelSchema, Type.Literal("ultra")]);
export const SubagentStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
	Type.Literal("close_failed"),
	Type.Literal("closed"),
]);
export const SubagentModelRefSchema = StrictObject({ provider: NameSchema, modelId: NameSchema });
export const SubagentUsageSchema = StrictObject({
	model: SubagentModelRefSchema,
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
	elapsedMs: Type.Number({ minimum: 0 }),
	cost: Type.Optional(Type.Number({ minimum: 0 })),
});
export const SubagentSummarySchema = StrictObject({
	agentId: SessionIdSchema,
	name: NameSchema,
	status: SubagentStatusSchema,
	taskSummary: PublicTextSchema,
	configuration: Type.Optional(
		StrictObject({
			mode: Type.Union([Type.Literal("chat"), Type.Literal("code")]),
			tools: Type.Array(NameSchema, { maxItems: 128, uniqueItems: true }),
			permissionMode: Type.Union([Type.Literal("ask"), Type.Literal("auto"), Type.Literal("full")]),
			model: SubagentModelRefSchema,
			thinkingLevel: ActualThinkingLevelSchema,
			cwd: PathSchema,
			forkTurns: Type.Union([Type.Integer({ minimum: 0, maximum: 1_000 }), Type.Literal("all")]),
			timeoutSeconds: Type.Integer({ minimum: 1, maximum: 1_800 }),
		}),
	),
	finalSummary: Type.Optional(PublicTextSchema),
	error: Type.Optional(PublicTextSchema),
	residualPath: Type.Optional(PathSchema),
	usage: Type.Optional(SubagentUsageSchema),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
});

export const SessionSnapshotSchema = StrictObject({
	session: SessionSummarySchema,
	turns: Type.Array(TurnViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	recentItems: Type.Array(ItemViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	nextBeforeItemId: Type.Union([OpaqueIdSchema, Type.Null()]),
	activeTurnId: Type.Union([OpaqueIdSchema, Type.Null()]),
	pendingInteractions: Type.Array(InteractionViewSchema, { maxItems: MAX_INTERACTION_CHOICES }),
	thinkingSelection: ThinkingSelectionSchema,
	actualThinkingLevel: ActualThinkingLevelSchema,
	availableThinkingSelections: Type.Array(ThinkingSelectionSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
	subagents: Type.Array(SubagentSummarySchema, { maxItems: 10 }),
	serverEpoch: UuidSchema,
	cursor: CursorSchema,
});

export const ThinkingSelectionChangedEventSchema = StrictObject({
	type: Type.Literal("session/thinkingSelectionChanged"),
	sessionId: SessionIdSchema,
	thinkingSelection: ThinkingSelectionSchema,
	actualThinkingLevel: ActualThinkingLevelSchema,
	availableThinkingSelections: Type.Array(ThinkingSelectionSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
});

export const SubagentUpdatedEventSchema = StrictObject({
	type: Type.Literal("subagent/updated"),
	sessionId: SessionIdSchema,
	subagent: SubagentSummarySchema,
});

export const SessionUpdatedEventSchema = StrictObject({
	type: Type.Literal("session/updated"),
	session: SessionSummarySchema,
});

export const TurnStartedEventSchema = StrictObject({
	type: Type.Literal("turn/started"),
	turn: TurnViewSchema,
});

export const TurnCompletedEventSchema = StrictObject({
	type: Type.Literal("turn/completed"),
	turn: TurnViewSchema,
});

export const TurnInterruptedEventSchema = StrictObject({
	type: Type.Literal("turn/interrupted"),
	turn: TurnViewSchema,
});

export const ItemStartedEventSchema = StrictObject({
	type: Type.Literal("item/started"),
	item: ItemViewSchema,
});

export const ItemDeltaEventSchema = StrictObject({
	type: Type.Literal("item/delta"),
	sessionId: SessionIdSchema,
	itemId: OpaqueIdSchema,
	delta: StrictObject({
		type: Type.Literal("text"),
		text: DeltaTextSchema,
	}),
});

export const ItemCompletedEventSchema = StrictObject({
	type: Type.Literal("item/completed"),
	item: ItemViewSchema,
});

export const InteractionNotifyEventSchema = StrictObject({
	type: Type.Literal("interaction/notify"),
	notificationId: UuidSchema,
	sessionId: Type.Optional(SessionIdSchema),
	level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
	title: Type.Optional(NameSchema),
	message: PublicTextSchema,
	createdAt: TimestampSchema,
});

export const ServerStateEventSchema = StrictObject({
	type: Type.Literal("server/state"),
	state: Type.Union([
		Type.Literal("starting"),
		Type.Literal("ready"),
		Type.Literal("restarting"),
		Type.Literal("failed"),
		Type.Literal("shutting_down"),
	]),
	attempt: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
	message: Type.Optional(PublicTextSchema),
});

export const DomainEventSchema = Type.Union([
	SessionUpdatedEventSchema,
	TurnStartedEventSchema,
	TurnCompletedEventSchema,
	TurnInterruptedEventSchema,
	ItemStartedEventSchema,
	ItemDeltaEventSchema,
	ItemCompletedEventSchema,
	InteractionNotifyEventSchema,
	ServerStateEventSchema,
	ThinkingSelectionChangedEventSchema,
	SubagentUpdatedEventSchema,
]);

export const ConnectionEventsParamsSchema = Type.Refine(
	StrictObject({
		serverEpoch: UuidSchema,
		fromCursor: CursorSchema,
		toCursor: CursorSchema,
		events: Type.Array(DomainEventSchema, { minItems: 1, maxItems: 256 }),
	}),
	(value) => value.fromCursor <= value.toCursor && value.toCursor - value.fromCursor + 1 === value.events.length,
	"cursor range must contain exactly one cursor per event",
);

export type PublicErrorData = Static<typeof PublicErrorDataSchema>;
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type DurableImageRefView = Static<typeof DurableImageRefViewSchema>;
export type ItemContentBlockView = Static<typeof ItemContentBlockViewSchema>;
export type ItemView = Static<typeof ItemViewSchema>;
export type TurnView = Static<typeof TurnViewSchema>;
export type InteractionChoice = Static<typeof InteractionChoiceSchema>;
export type InteractionView = Static<typeof InteractionViewSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type ThinkingSelectionView = Static<typeof ThinkingSelectionSchema>;
export type SubagentSummaryView = Static<typeof SubagentSummarySchema>;
export type DomainEvent = Static<typeof DomainEventSchema>;
export type ConnectionEventsParams = Static<typeof ConnectionEventsParamsSchema>;
