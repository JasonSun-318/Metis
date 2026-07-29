import { type Static, Type } from "typebox";
import {
	CursorSchema,
	DeltaTextSchema,
	MAX_HISTORY_ITEMS,
	MAX_INTERACTION_CHOICES,
	MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES,
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
	Utf8String,
	UuidSchema,
} from "./schema.ts";

export const SessionStateSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("running"),
	Type.Literal("interrupted"),
	Type.Literal("corrupt"),
	Type.Literal("in_use"),
]);

export const AgentModeSchema = Type.Union([Type.Literal("chat"), Type.Literal("code")]);
export const CwdOriginSchema = Type.Union([Type.Literal("managed"), Type.Literal("user-selected")]);

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
	mode: AgentModeSchema,
	cwdOrigin: CwdOriginSchema,
	// Legacy journals may not contain a working directory. App-server projects
	// their empty-string sentinel to null instead of exposing it on the wire.
	cwd: Type.Union([PathSchema, Type.Null()]),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	state: SessionStateSchema,
	archived: Type.Boolean(),
	recoveryNotice: Type.Optional(PublicTextSchema),
	scheduled: Type.Optional(StrictObject({ taskId: SessionIdSchema, runId: SessionIdSchema })),
});

export const SkillSummaryViewSchema = StrictObject({
	name: NameSchema,
	description: PublicTextSchema,
	source: Type.Optional(Type.Union([Type.Literal("system"), Type.Literal("user"), Type.Literal("project")])),
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

export const ThinkingBlockViewSchema = StrictObject({
	type: Type.Literal("thinking"),
	text: PublicTextSchema,
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
	ThinkingBlockViewSchema,
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
export const ModelOptionViewSchema = StrictObject({
	provider: NameSchema,
	modelId: NameSchema,
	name: NameSchema,
});
export const SubagentUsageSchema = StrictObject({
	model: SubagentModelRefSchema,
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
	elapsedMs: Type.Number({ minimum: 0 }),
	cost: Type.Optional(Type.Number({ minimum: 0 })),
});
const SubagentIdentityFields = {
	agentId: SessionIdSchema,
	name: NameSchema,
	taskSummary: PublicTextSchema,
	finalSummary: Type.Optional(PublicTextSchema),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
};
const ActiveSubagentStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
	Type.Literal("close_failed"),
]);
const SubagentConfigurationSchema = StrictObject({
	mode: Type.Union([Type.Literal("chat"), Type.Literal("code")]),
	tools: Type.Array(NameSchema, { maxItems: 128, uniqueItems: true }),
	permissionMode: Type.Union([Type.Literal("ask"), Type.Literal("full")]),
	model: SubagentModelRefSchema,
	thinkingLevel: ActualThinkingLevelSchema,
	cwd: PathSchema,
	forkTurns: Type.Union([Type.Integer({ minimum: 0, maximum: 1_000 }), Type.Literal("all")]),
	timeoutSeconds: Type.Integer({ minimum: 1, maximum: 1_800 }),
});
export const SubagentSummarySchema = Type.Union([
	StrictObject({
		...SubagentIdentityFields,
		runId: Type.Optional(SessionIdSchema),
		status: ActiveSubagentStatusSchema,
		background: Type.Optional(Type.Boolean()),
		configuration: SubagentConfigurationSchema,
		error: Type.Optional(PublicTextSchema),
		residualPath: Type.Optional(PathSchema),
		usage: Type.Optional(SubagentUsageSchema),
	}),
	StrictObject({
		...SubagentIdentityFields,
		status: Type.Literal("closed"),
	}),
]);

export const SessionSnapshotSchema = StrictObject({
	session: SessionSummarySchema,
	model: Type.Optional(SubagentModelRefSchema),
	availableModels: Type.Optional(Type.Array(ModelOptionViewSchema, { maxItems: 512 })),
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

export const ModelChangedEventSchema = StrictObject({
	type: Type.Literal("session/modelChanged"),
	sessionId: SessionIdSchema,
	model: SubagentModelRefSchema,
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
	delta: Type.Union([
		StrictObject({ type: Type.Literal("text"), text: DeltaTextSchema }),
		StrictObject({ type: Type.Literal("thinking"), text: DeltaTextSchema }),
	]),
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

const ScheduleTimeSchema = Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" });
const ScheduleDateSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

export const ScheduleInputSpecSchema = Type.Union([
	StrictObject({ kind: Type.Literal("once"), date: ScheduleDateSchema, time: ScheduleTimeSchema }),
	StrictObject({ kind: Type.Literal("daily"), time: ScheduleTimeSchema }),
	StrictObject({
		kind: Type.Literal("weekly"),
		weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true }),
		time: ScheduleTimeSchema,
	}),
	StrictObject({
		kind: Type.Literal("monthly"),
		day: Type.Integer({ minimum: 1, maximum: 31 }),
		time: ScheduleTimeSchema,
	}),
	StrictObject({
		kind: Type.Literal("interval"),
		every: Type.Integer({ minimum: 1, maximum: 10_000 }),
		unit: Type.Union([Type.Literal("minute"), Type.Literal("hour")]),
		startDate: ScheduleDateSchema,
		startTime: ScheduleTimeSchema,
	}),
]);

export const ScheduleSpecSchema = Type.Union([
	ScheduleInputSpecSchema.anyOf[0],
	ScheduleInputSpecSchema.anyOf[1],
	ScheduleInputSpecSchema.anyOf[2],
	ScheduleInputSpecSchema.anyOf[3],
	StrictObject({
		kind: Type.Literal("interval"),
		every: Type.Integer({ minimum: 1, maximum: 10_000 }),
		unit: Type.Union([Type.Literal("minute"), Type.Literal("hour")]),
		startAt: TimestampSchema,
	}),
]);

export const ScheduleTargetViewSchema = Type.Union([
	StrictObject({ kind: Type.Literal("general"), workspace: Type.Literal("fixed"), cwd: PathSchema }),
	StrictObject({ kind: Type.Literal("general"), workspace: Type.Literal("task") }),
]);

export const ScheduleErrorViewSchema = StrictObject({
	code: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z][A-Z0-9_]*$" }),
	message: PublicTextSchema,
});

const ScheduleRunStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("succeeded"),
	Type.Literal("failed"),
	Type.Literal("missed"),
	Type.Literal("skipped"),
	Type.Literal("cancelled"),
]);

const ScheduleRunReasonSchema = Type.Union([
	Type.Literal("overlap"),
	Type.Literal("offline"),
	Type.Literal("interrupted"),
	Type.Literal("deleted"),
]);

export const ScheduleTaskSnapshotViewSchema = StrictObject({
	instruction: Utf8String(MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES, { minLength: 1 }),
	schedule: ScheduleSpecSchema,
	timezone: Type.String({ minLength: 1, maxLength: 255 }),
	target: ScheduleTargetViewSchema,
});

const ScheduleRunSummaryFields = {
	id: SessionIdSchema,
	taskId: SessionIdSchema,
	status: ScheduleRunStatusSchema,
	scheduledFor: TimestampSchema,
	createdAt: TimestampSchema,
	startedAt: Type.Optional(TimestampSchema),
	completedAt: Type.Optional(TimestampSchema),
	sessionId: Type.Optional(SessionIdSchema),
	resultPreview: Type.Optional(PublicTextSchema),
	error: Type.Optional(ScheduleErrorViewSchema),
	reason: Type.Optional(ScheduleRunReasonSchema),
	skippedCount: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	unread: Type.Boolean(),
} as const;

export const ScheduleRunViewSchema = StrictObject({
	...ScheduleRunSummaryFields,
	trigger: Type.Union([Type.Literal("scheduled"), Type.Literal("manual")]),
	snapshot: ScheduleTaskSnapshotViewSchema,
});

export const ScheduleRunSummaryViewSchema = StrictObject(ScheduleRunSummaryFields);

export const ScheduleTaskViewSchema = StrictObject({
	id: SessionIdSchema,
	title: NameSchema,
	instruction: Utf8String(MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES, { minLength: 1 }),
	schedule: ScheduleSpecSchema,
	timezone: Type.String({ minLength: 1, maxLength: 255 }),
	target: ScheduleTargetViewSchema,
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("paused"),
		Type.Literal("completed"),
		Type.Literal("deleting"),
	]),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	nextRunAt: Type.Union([TimestampSchema, Type.Null()]),
	unreadCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	lastRun: Type.Optional(ScheduleRunSummaryViewSchema),
	pauseReason: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("workspace_missing")])),
});

export const ScheduleSnapshotViewSchema = StrictObject({
	tasks: Type.Array(ScheduleTaskViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	unreadCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	cursor: CursorSchema,
});

export const ScheduleUpdatedEventSchema = StrictObject({
	type: Type.Literal("schedule/updated"),
	task: ScheduleTaskViewSchema,
});
export const ScheduleDeletedEventSchema = StrictObject({
	type: Type.Literal("schedule/deleted"),
	taskId: SessionIdSchema,
});

const ScheduleRunEventFields = {
	taskId: SessionIdSchema,
	runId: SessionIdSchema,
	unread: Type.Boolean(),
	createdAt: TimestampSchema,
	sessionId: Type.Optional(SessionIdSchema),
} as const;

export const ScheduleRunCompletedEventSchema = StrictObject({
	type: Type.Literal("schedule/runCompleted"),
	...ScheduleRunEventFields,
	resultPreview: Type.Optional(PublicTextSchema),
});
export const ScheduleRunFailedEventSchema = StrictObject({
	type: Type.Literal("schedule/runFailed"),
	...ScheduleRunEventFields,
	error: ScheduleErrorViewSchema,
});
export const ScheduleRunMissedEventSchema = StrictObject({
	type: Type.Literal("schedule/runMissed"),
	...ScheduleRunEventFields,
	reason: Type.Literal("offline"),
	skippedCount: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
export const ScheduleRunSkippedEventSchema = StrictObject({
	type: Type.Literal("schedule/runSkipped"),
	...ScheduleRunEventFields,
	reason: Type.Literal("overlap"),
});
export const ScheduleRefreshedEventSchema = StrictObject({ type: Type.Literal("schedule/refreshed") });

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
	ModelChangedEventSchema,
	SubagentUpdatedEventSchema,
	ScheduleUpdatedEventSchema,
	ScheduleDeletedEventSchema,
	ScheduleRunCompletedEventSchema,
	ScheduleRunFailedEventSchema,
	ScheduleRunMissedEventSchema,
	ScheduleRunSkippedEventSchema,
	ScheduleRefreshedEventSchema,
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
export type AgentMode = Static<typeof AgentModeSchema>;
export type CwdOrigin = Static<typeof CwdOriginSchema>;
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type SkillSummaryView = Static<typeof SkillSummaryViewSchema>;
export type SkillSourceView = NonNullable<SkillSummaryView["source"]>;
export type DurableImageRefView = Static<typeof DurableImageRefViewSchema>;
export type ItemContentBlockView = Static<typeof ItemContentBlockViewSchema>;
export type ItemView = Static<typeof ItemViewSchema>;
export type TurnView = Static<typeof TurnViewSchema>;
export type InteractionChoice = Static<typeof InteractionChoiceSchema>;
export type InteractionView = Static<typeof InteractionViewSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type ThinkingSelectionView = Static<typeof ThinkingSelectionSchema>;
export type ModelOptionView = Static<typeof ModelOptionViewSchema>;
export type SubagentSummaryView = Static<typeof SubagentSummarySchema>;
export type ScheduleInputSpecView = Static<typeof ScheduleInputSpecSchema>;
export type ScheduleTaskView = Static<typeof ScheduleTaskViewSchema>;
export type ScheduleRunView = Static<typeof ScheduleRunViewSchema>;
export type ScheduleSnapshotView = Static<typeof ScheduleSnapshotViewSchema>;
export type ScheduleTaskSnapshotView = Static<typeof ScheduleTaskSnapshotViewSchema>;
export type DomainEvent = Static<typeof DomainEventSchema>;
export type ConnectionEventsParams = Static<typeof ConnectionEventsParamsSchema>;
