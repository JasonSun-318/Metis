import { type Static, type TSchema, Type } from "typebox";
import {
	CapabilitySchema,
	CursorSchema,
	MAX_ASK_USER_CUSTOM_ANSWER_UTF8_BYTES,
	MAX_ASK_USER_OPTIONS,
	MAX_ASK_USER_QUESTIONS,
	MAX_CAPABILITIES,
	MAX_HISTORY_ITEMS,
	MAX_READ_IMAGE_DATA_UTF8_BYTES,
	MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES,
	NameSchema,
	OpaqueIdSchema,
	OptionalNameSchema,
	PathSchema,
	PROTOCOL_VERSION,
	PromptTextSchema,
	PublicTextSchema,
	SessionIdSchema,
	Sha256Schema,
	StrictObject,
	Utf8String,
	UuidSchema,
} from "./schema.ts";
import {
	ActualThinkingLevelSchema,
	AgentModeSchema,
	ConnectionEventsParamsSchema,
	DeclarativeHookViewSchema,
	DurableImageRefViewSchema,
	HooksListViewSchema,
	InteractionViewSchema,
	ItemViewSchema,
	McpCatalogItemDetailViewSchema,
	McpCatalogItemKindViewSchema,
	McpEnvironmentMapSchema,
	McpEnvironmentNameSchema,
	McpHttpUrlSchema,
	McpImportInspectionViewSchema,
	McpScopeViewSchema,
	McpServerDetailViewSchema,
	McpServerSummaryViewSchema,
	ModelOptionViewSchema,
	ModelSettingsViewSchema,
	PermissionModeSchema,
	ProfileUsageSummaryViewSchema,
	ProjectPermissionRuleViewSchema,
	QueuedTurnViewSchema,
	ScheduleDescriptionInputSchema,
	ScheduleInputSpecSchema,
	ScheduleNameSchema,
	ScheduleRunViewSchema,
	ScheduleSnapshotViewSchema,
	ScheduleTaskViewSchema,
	SessionGoalViewSchema,
	SessionSnapshotSchema,
	SessionStatusViewSchema,
	SessionSummarySchema,
	SkillContentSchema,
	SkillDetailViewSchema,
	SkillImportCandidateViewSchema,
	SkillImportInputViewSchema,
	SkillNameSchema,
	SkillSourceViewSchema,
	SkillSummaryViewSchema,
	SubagentModelRefSchema,
	SubagentSummarySchema,
	ThinkingSelectionSchema,
	UsageRangeDaysSchema,
	UsageSummaryViewSchema,
	WebSearchProviderSchema,
	WebSearchSettingsViewSchema,
	WritableSkillSourceViewSchema,
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
		name: Type.Literal("metis-app-server"),
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

export const PersonalizationGetParamsSchema = StrictObject({});
export const PersonalizationViewSchema = StrictObject({
	instructions: PublicTextSchema,
});
export const PersonalizationUpdateParamsSchema = StrictObject({
	instructions: PublicTextSchema,
});

export const SkillListParamsSchema = Type.Union([
	StrictObject({ sessionId: SessionIdSchema }),
	StrictObject({ cwd: Type.Union([PathSchema, Type.Null()]) }),
]);

export const SkillListResultSchema = StrictObject({
	skills: Type.Array(SkillSummaryViewSchema, { maxItems: 256 }),
});

const SkillIdentityFields = { source: SkillSourceViewSchema, name: SkillNameSchema } as const;
const WritableSkillIdentityFields = { source: WritableSkillSourceViewSchema, name: SkillNameSchema } as const;

function skillDraftTarget<const Fields extends Record<string, TSchema>>(fields: Fields) {
	return Type.Refine(
		StrictObject({ cwd: Type.Union([PathSchema, Type.Null()]), ...fields }),
		(value) => {
			const target = value as { cwd: string | null; source: string };
			return target.source !== "project" || target.cwd !== null;
		},
		"project Skills require a project cwd",
	);
}

export const SkillGetParamsSchema = skillDraftTarget(SkillIdentityFields);
export const SkillGetResultSchema = SkillDetailViewSchema;
export const SkillUpsertParamsSchema = skillDraftTarget({
	requestId: UuidSchema,
	...WritableSkillIdentityFields,
	expectedRevision: Type.Union([Sha256Schema, Type.Null()]),
	content: SkillContentSchema,
});
export const SkillUpsertResultSchema = SkillDetailViewSchema;
export const SkillRemoveParamsSchema = skillDraftTarget({
	requestId: UuidSchema,
	...WritableSkillIdentityFields,
	expectedRevision: Sha256Schema,
});
export const SkillRemoveResultSchema = SkillListResultSchema;
export const SkillImportInspectParamsSchema = skillDraftTarget({
	source: WritableSkillSourceViewSchema,
	input: SkillImportInputViewSchema,
});
export const SkillImportInspectResultSchema = StrictObject({
	revision: Sha256Schema,
	candidates: Type.Array(SkillImportCandidateViewSchema, { minItems: 1, maxItems: 64 }),
});
export const SkillImportParamsSchema = skillDraftTarget({
	requestId: UuidSchema,
	source: WritableSkillSourceViewSchema,
	input: SkillImportInputViewSchema,
	sourceRevision: Sha256Schema,
	candidateIds: Type.Array(Utf8String(4096, { minLength: 1, maxLength: 4096 }), {
		minItems: 1,
		maxItems: 64,
		uniqueItems: true,
	}),
});
export const SkillImportResultSchema = SkillListResultSchema;

function mcpSessionTarget<const Fields extends Record<string, TSchema>>(fields: Fields) {
	return StrictObject({ sessionId: SessionIdSchema, ...fields });
}

function mcpDraftTarget<const Fields extends Record<string, TSchema>>(fields: Fields) {
	return StrictObject({ cwd: Type.Union([PathSchema, Type.Null()]), ...fields });
}

const NonEmptyPublicTextSchema = Type.Refine(PublicTextSchema, (value) => value.length > 0, "value must not be empty");
const CommandSchema = Type.Refine(PublicTextSchema, (value) => Boolean(value.trim()), "command must not be empty");

const McpCommonServerInputFields = {
	description: Type.Optional(Utf8String(4096, { minLength: 1, maxLength: 4096 })),
	enabled: Type.Optional(Type.Boolean()),
	required: Type.Optional(Type.Boolean()),
	startupTimeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3_600 })),
	toolTimeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 86_400 })),
	enabledTools: Type.Optional(Type.Array(NameSchema, { maxItems: 512, uniqueItems: true })),
	disabledTools: Type.Optional(Type.Array(NameSchema, { maxItems: 512, uniqueItems: true })),
} as const;

export const McpServerInputSchema = Type.Union([
	StrictObject({
		...McpCommonServerInputFields,
		transport: Type.Literal("stdio"),
		command: CommandSchema,
		args: Type.Optional(Type.Array(PublicTextSchema, { maxItems: 128 })),
		envVars: Type.Optional(Type.Array(McpEnvironmentNameSchema, { maxItems: 128, uniqueItems: true })),
		cwd: Type.Optional(PathSchema),
	}),
	StrictObject({
		...McpCommonServerInputFields,
		transport: Type.Literal("http"),
		url: McpHttpUrlSchema,
		bearerTokenEnvVar: Type.Optional(McpEnvironmentNameSchema),
		envHttpHeaders: Type.Optional(McpEnvironmentMapSchema),
	}),
]);

const McpSecretMapSchema = Type.Refine(
	Type.Record(McpEnvironmentNameSchema, NonEmptyPublicTextSchema),
	(value) => Object.keys(value).length <= 128,
	"MCP credential has too many environment values",
);
export const McpCredentialInputSchema = Type.Refine(
	StrictObject({
		bearerToken: Type.Optional(NonEmptyPublicTextSchema),
		environment: Type.Optional(McpSecretMapSchema),
	}),
	(value) => Boolean(value.bearerToken || Object.keys(value.environment ?? {}).length),
	"MCP credential must contain a bearer token or environment value",
);

export const McpListParamsSchema = Type.Union([mcpSessionTarget({}), mcpDraftTarget({})]);
export const McpListResultSchema = StrictObject({
	servers: Type.Array(McpServerSummaryViewSchema, { maxItems: 512 }),
});

const McpDefinitionFields = { scope: McpScopeViewSchema, name: NameSchema } as const;
const McpMutationBaseFields = {
	requestId: UuidSchema,
	...McpDefinitionFields,
} as const;
const McpUpsertMutationFields = {
	...McpMutationBaseFields,
	expectedRevision: Type.Union([Sha256Schema, Type.Null()]),
} as const;
const McpExistingMutationFields = { ...McpMutationBaseFields, expectedRevision: Sha256Schema } as const;

function mcpScopedDraftTarget<const Fields extends Record<string, TSchema>>(fields: Fields) {
	return Type.Refine(
		mcpDraftTarget(fields),
		(value) => {
			const target = value as { cwd: string | null; scope: string };
			return target.cwd !== null || target.scope === "user";
		},
		"project-scoped MCP servers require a project cwd",
	);
}

export const McpGetParamsSchema = Type.Union([
	mcpSessionTarget(McpDefinitionFields),
	mcpScopedDraftTarget(McpDefinitionFields),
]);
export const McpGetResultSchema = McpServerDetailViewSchema;
export const McpCatalogGetParamsSchema = mcpSessionTarget({
	server: NameSchema,
	kind: McpCatalogItemKindViewSchema,
	id: PublicTextSchema,
});
export const McpCatalogGetResultSchema = McpCatalogItemDetailViewSchema;
export const McpUpsertParamsSchema = Type.Union([
	mcpSessionTarget({
		...McpUpsertMutationFields,
		server: McpServerInputSchema,
		credential: Type.Optional(McpCredentialInputSchema),
	}),
	mcpScopedDraftTarget({
		...McpUpsertMutationFields,
		server: McpServerInputSchema,
		credential: Type.Optional(McpCredentialInputSchema),
	}),
]);
export const McpMutationResultSchema = McpListResultSchema;
export const McpRemoveParamsSchema = Type.Union([
	mcpSessionTarget(McpExistingMutationFields),
	mcpScopedDraftTarget(McpExistingMutationFields),
]);
export const McpRestartParamsSchema = mcpSessionTarget(McpExistingMutationFields);
export const McpRestartResultSchema = McpGetResultSchema;
export const McpCredentialSetParamsSchema = mcpSessionTarget({
	...McpExistingMutationFields,
	credential: McpCredentialInputSchema,
});
export const McpCredentialSetResultSchema = McpGetResultSchema;
export const McpCredentialClearParamsSchema = mcpSessionTarget(McpExistingMutationFields);
export const McpCredentialClearResultSchema = McpGetResultSchema;

const McpImportFields = {
	scope: McpScopeViewSchema,
	text: Utf8String(1024 * 1024, { minLength: 1, maxLength: 1024 * 1024 }),
} as const;
const McpImportSelectionSchema = StrictObject({
	id: NameSchema,
	expectedRevision: Type.Union([Sha256Schema, Type.Null()]),
});
const McpImportSelectionsSchema = Type.Refine(
	Type.Array(McpImportSelectionSchema, { minItems: 1, maxItems: 128 }),
	(value) => new Set(value.map((candidate) => candidate.id)).size === value.length,
	"MCP import candidates must be unique",
);
export const McpImportInspectParamsSchema = Type.Union([
	mcpSessionTarget(McpImportFields),
	mcpScopedDraftTarget(McpImportFields),
]);
export const McpImportParamsSchema = Type.Union([
	mcpSessionTarget({
		requestId: UuidSchema,
		...McpImportFields,
		sourceRevision: Sha256Schema,
		candidates: McpImportSelectionsSchema,
	}),
	mcpScopedDraftTarget({
		requestId: UuidSchema,
		...McpImportFields,
		sourceRevision: Sha256Schema,
		candidates: McpImportSelectionsSchema,
	}),
]);

export const ProfileGetParamsSchema = StrictObject({});
export const ProfileGetResultSchema = ProfileUsageSummaryViewSchema;

export const ProjectRevisionSchema = Sha256Schema;
export const ProjectDeletePreviewParamsSchema = StrictObject({
	mode: AgentModeSchema,
	cwd: PathSchema,
});
export const ProjectDeletePreviewResultSchema = StrictObject({
	mode: AgentModeSchema,
	cwd: PathSchema,
	sessionCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
	blockingScheduleCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
	revision: ProjectRevisionSchema,
});
export const ProjectDeleteParamsSchema = StrictObject({
	requestId: UuidSchema,
	mode: AgentModeSchema,
	cwd: PathSchema,
	expectedRevision: ProjectRevisionSchema,
});
export const ProjectDeleteResultSchema = StrictObject({
	mode: AgentModeSchema,
	cwd: PathSchema,
	deletedSessionCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
});

export const SessionCreateParamsSchema = StrictObject({
	// Create IDs are globally scoped because the ID also becomes the session ID.
	requestId: UuidSchema,
	mode: Type.Optional(AgentModeSchema),
	cwd: Type.Optional(PathSchema),
	name: Type.Optional(OptionalNameSchema),
	permissionMode: Type.Optional(PermissionModeSchema),
});
export const SessionCreateResultSchema = StrictObject({ session: SessionSummarySchema });

export const SessionRefParamsSchema = StrictObject({ sessionId: SessionIdSchema });
export const SessionOpenResultSchema = StrictObject({ session: SessionSummarySchema });
export const SessionMarkReadParamsSchema = StrictObject({ sessionId: SessionIdSchema });

export const SessionReadItemsParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	beforeItemId: Type.Optional(Type.Union([OpaqueIdSchema, Type.Null()])),
	limit: Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS }),
});
export const SessionReadItemsResultSchema = StrictObject({
	items: Type.Array(ItemViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	nextBeforeItemId: Type.Union([OpaqueIdSchema, Type.Null()]),
});

export const SessionReadImageParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	image: DurableImageRefViewSchema,
});
export const SessionReadImageResultSchema = StrictObject({
	data: Type.String({ minLength: 1, maxLength: MAX_READ_IMAGE_DATA_UTF8_BYTES }),
	mediaType: Type.Union([
		Type.Literal("image/jpeg"),
		Type.Literal("image/png"),
		Type.Literal("image/gif"),
		Type.Literal("image/webp"),
	]),
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
export const SessionRenameParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	name: NameSchema,
});
export const SessionForkParamsSchema = StrictObject({
	requestId: UuidSchema,
	sessionId: SessionIdSchema,
	// Branch point: the assistant item to fork at (itemId === journal entryId).
	entryId: OpaqueIdSchema,
});
export const SessionForkResultSchema = StrictObject({
	session: SessionSummarySchema,
	entryId: OpaqueIdSchema,
});
export const SessionDeleteResultSchema = StrictObject({
	sessionId: SessionIdSchema,
	deleted: Type.Literal(true),
	method: Type.Union([Type.Literal("trash"), Type.Literal("unlink")]),
	warning: Type.Optional(PublicTextSchema),
});

export const SessionCompactResultSchema = StrictObject({
	sessionId: SessionIdSchema,
	tokensBefore: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	estimatedTokensAfter: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
	// Present only when compaction was requested but there was nothing to do
	// (e.g. the session is already compacted or too small). This is a success
	// response carrying an informational notice, not a failure.
	message: Type.Optional(PublicTextSchema),
});

export const SessionGoalGetParamsSchema = SessionRefParamsSchema;
export const SessionGoalGetResultSchema = StrictObject({
	sessionId: SessionIdSchema,
	goal: Type.Union([SessionGoalViewSchema, Type.Null()]),
});
export const SessionGoalSetParamsSchema = Type.Refine(
	StrictObject({
		requestId: UuidSchema,
		sessionId: SessionIdSchema,
		objective: Type.Optional(Utf8String(4000, { minLength: 1, maxLength: 4000 })),
		status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused")])),
	}),
	(value) => value.objective !== undefined || value.status !== undefined,
	"session/goal/set requires objective and/or status",
);
export const SessionGoalSetResultSchema = StrictObject({
	sessionId: SessionIdSchema,
	goal: SessionGoalViewSchema,
});
export const SessionGoalClearParamsSchema = SessionMutationParamsSchema;
export const SessionGoalClearResultSchema = StrictObject({
	sessionId: SessionIdSchema,
	cleared: Type.Boolean(),
});

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

export const SessionSetPermissionModeParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	permissionMode: PermissionModeSchema,
});
export const SessionPermissionModeResultSchema = StrictObject({ permissionMode: PermissionModeSchema });

export const PermissionRulesListParamsSchema = StrictObject({ sessionId: SessionIdSchema });
export const PermissionRulesDeleteParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	ruleId: OpaqueIdSchema,
	requestId: UuidSchema,
});
export const PermissionRulesClearParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
});
export const PermissionRulesResultSchema = StrictObject({
	projectPath: PathSchema,
	rules: Type.Array(ProjectPermissionRuleViewSchema, { maxItems: 256 }),
});

export const SessionSetModelParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	provider: NameSchema,
	modelId: NameSchema,
});
export const SessionModelResultSchema = StrictObject({
	model: SubagentModelRefSchema,
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
export const SubagentInterruptParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	requestId: UuidSchema,
});
export const SubagentResultSchema = StrictObject({ subagent: SubagentSummarySchema });

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

const QueueItemMutationFields = {
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	queueItemId: OpaqueIdSchema,
	expectedRevision: OpaqueIdSchema,
} as const;

export const TurnQueueUpdateParamsSchema = StrictObject({
	...QueueItemMutationFields,
	text: PromptTextSchema,
});
export const TurnQueueDeleteParamsSchema = StrictObject(QueueItemMutationFields);
export const TurnQueueSendParamsSchema = StrictObject({
	...QueueItemMutationFields,
	delivery: Type.Union([Type.Literal("steer"), Type.Literal("start")]),
});
export const QueuedTurnResultSchema = StrictObject({ queuedTurn: QueuedTurnViewSchema });
export const QueuedTurnDeleteResultSchema = StrictObject({
	queueItemId: OpaqueIdSchema,
	deleted: Type.Literal(true),
});

export const ConnectionAckParamsSchema = StrictObject({
	serverEpoch: UuidSchema,
	cursor: CursorSchema,
});
export const ConnectionAckResultSchema = StrictObject({ acknowledgedCursor: CursorSchema });

const ScheduleInstructionSchema = Utf8String(MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES, { minLength: 1 });

export const ModelListParamsSchema = StrictObject({});
export const ModelListResultSchema = StrictObject({
	models: Type.Array(ModelOptionViewSchema, { maxItems: 512 }),
});
const EditableModelInputSchema = StrictObject({
	modelId: NameSchema,
	name: NameSchema,
	contextWindow: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
	maxOutputTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
	reasoning: Type.Boolean(),
	imageInput: Type.Boolean(),
});
export const CredentialMutationSchema = Type.Union([
	StrictObject({ action: Type.Literal("keep") }),
	StrictObject({ action: Type.Literal("remove") }),
	StrictObject({ action: Type.Literal("set"), value: Type.String({ minLength: 1, maxLength: 32_768 }) }),
]);
export const ModelSettingsMutationSchema = Type.Union([
	StrictObject({
		type: Type.Literal("save_provider"),
		provider: NameSchema,
		name: NameSchema,
		baseUrl: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
		api: Type.Union([
			Type.Literal("openai-responses"),
			Type.Literal("openai-completions"),
			Type.Literal("anthropic-messages"),
			Type.Null(),
		]),
		models: Type.Array(EditableModelInputSchema, { maxItems: 512 }),
		credential: CredentialMutationSchema,
	}),
	StrictObject({ type: Type.Literal("remove_provider"), provider: NameSchema }),
	StrictObject({
		type: Type.Literal("set_defaults"),
		model: Type.Union([SubagentModelRefSchema, Type.Null()]),
		thinkingSelection: ThinkingSelectionSchema,
	}),
	StrictObject({
		type: Type.Literal("set_vision"),
		settings: Type.Union([
			StrictObject({
				name: Type.String({ minLength: 1, maxLength: 120 }),
				baseUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
				api: Type.Union([
					Type.Literal("openai-responses"),
					Type.Literal("openai-completions"),
					Type.Literal("anthropic-messages"),
				]),
				modelId: Type.String({ minLength: 1, maxLength: 300 }),
			}),
			Type.Null(),
		]),
		credential: CredentialMutationSchema,
	}),
]);
export const ModelSettingsGetParamsSchema = StrictObject({});
export const ModelSettingsUpdateParamsSchema = StrictObject({
	requestId: UuidSchema,
	mutation: ModelSettingsMutationSchema,
});
export const ModelTestConnectionParamsSchema = StrictObject({
	requestId: UuidSchema,
	provider: NameSchema,
	modelId: NameSchema,
});
export const ModelTestConnectionResultSchema = StrictObject({
	ok: Type.Boolean(),
	message: PublicTextSchema,
	latencyMs: Type.Integer({ minimum: 0, maximum: 300_000 }),
});
export const UsageGetParamsSchema = StrictObject({ rangeDays: UsageRangeDaysSchema });

export const WebSearchGetParamsSchema = StrictObject({});
export const WebSearchCredentialRevealParamsSchema = StrictObject({ provider: WebSearchProviderSchema });
export const WebSearchCredentialRevealResultSchema = StrictObject({
	credential: Type.Union([Type.String({ minLength: 1, maxLength: 32_768 }), Type.Null()]),
});
export const WebSearchUpdateParamsSchema = StrictObject({
	enabled: Type.Boolean(),
	provider: WebSearchProviderSchema,
	credential: CredentialMutationSchema,
});

export const HooksListParamsSchema = StrictObject({});
export const HooksUpsertParamsSchema = StrictObject({ hook: DeclarativeHookViewSchema });
export const HooksDeleteParamsSchema = StrictObject({
	id: Type.String({ minLength: 1, maxLength: 128 }),
});

export const ScheduleCreateParamsSchema = Type.Refine(
	StrictObject({
		requestId: UuidSchema,
		sourceSessionId: Type.Optional(SessionIdSchema),
		additionalWorkspaceCwd: Type.Optional(PathSchema),
		name: ScheduleNameSchema,
		description: Type.Optional(ScheduleDescriptionInputSchema),
		instruction: ScheduleInstructionSchema,
		model: SubagentModelRefSchema,
		schedule: ScheduleInputSpecSchema,
	}),
	(value) => value.sourceSessionId === undefined || value.additionalWorkspaceCwd === undefined,
	"fixed scheduled tasks cannot include an additional workspace",
);
export const ScheduleTaskResultSchema = StrictObject({ task: ScheduleTaskViewSchema });
export const ScheduleListParamsSchema = StrictObject({
	afterTaskId: Type.Optional(Type.Union([SessionIdSchema, Type.Null()])),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS })),
	unreadOnly: Type.Optional(Type.Boolean()),
	query: Type.Optional(OptionalNameSchema),
	sort: Type.Optional(Type.Union([Type.Literal("next_run"), Type.Literal("updated"), Type.Literal("name")])),
});
export const ScheduleListResultSchema = StrictObject({
	tasks: Type.Array(ScheduleTaskViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	nextAfterTaskId: Type.Union([SessionIdSchema, Type.Null()]),
	unreadCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const ScheduleTaskRefParamsSchema = StrictObject({ taskId: SessionIdSchema });
export const ScheduleUpdateParamsSchema = Type.Refine(
	StrictObject({
		requestId: UuidSchema,
		taskId: SessionIdSchema,
		name: Type.Optional(ScheduleNameSchema),
		description: Type.Optional(Type.Union([ScheduleDescriptionInputSchema, Type.Null()])),
		instruction: Type.Optional(ScheduleInstructionSchema),
		model: Type.Optional(SubagentModelRefSchema),
		schedule: Type.Optional(ScheduleInputSpecSchema),
		sourceSessionId: Type.Optional(Type.Union([SessionIdSchema, Type.Null()])),
		additionalWorkspaceCwd: Type.Optional(Type.Union([PathSchema, Type.Null()])),
	}),
	(value) =>
		(value.name !== undefined ||
			value.description !== undefined ||
			value.instruction !== undefined ||
			value.model !== undefined ||
			value.schedule !== undefined ||
			value.sourceSessionId !== undefined ||
			value.additionalWorkspaceCwd !== undefined) &&
		!(typeof value.sourceSessionId === "string" && typeof value.additionalWorkspaceCwd === "string"),
	"schedule update must include at least one editable field",
);
export const ScheduleMutationParamsSchema = StrictObject({ requestId: UuidSchema, taskId: SessionIdSchema });
export const ScheduleDeleteParamsSchema = StrictObject({
	requestId: UuidSchema,
	taskId: SessionIdSchema,
	deleteSessions: Type.Boolean(),
});
export const ScheduleDeleteResultSchema = StrictObject({
	taskId: SessionIdSchema,
	deleted: Type.Literal(true),
	deletedSessionCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	retainedSessionCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const ScheduleRunResultSchema = StrictObject({ run: ScheduleRunViewSchema });
export const ScheduleRunListParamsSchema = StrictObject({
	taskId: SessionIdSchema,
	beforeRunId: Type.Optional(Type.Union([SessionIdSchema, Type.Null()])),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS })),
});
export const ScheduleRunListResultSchema = StrictObject({
	runs: Type.Array(ScheduleRunViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	nextBeforeRunId: Type.Union([SessionIdSchema, Type.Null()]),
});
export const ScheduleRunRefParamsSchema = StrictObject({ taskId: SessionIdSchema, runId: SessionIdSchema });
export const ScheduleRunMarkReadParamsSchema = StrictObject({
	requestId: UuidSchema,
	taskId: SessionIdSchema,
	runId: SessionIdSchema,
});
export const ScheduleRunMarkReadResultSchema = StrictObject({
	run: ScheduleRunViewSchema,
	unreadCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const ScheduleSubscribeParamsSchema = StrictObject({});
export const ScheduleSubscribeResultSchema = StrictObject({ snapshot: ScheduleSnapshotViewSchema });
export const ScheduleUnsubscribeResultSchema = StrictObject({ unsubscribed: Type.Literal(true) });

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
export const AskUserAnswerResultSchema = StrictObject({
	questionId: OpaqueIdSchema,
	choiceIds: Type.Array(OpaqueIdSchema, { maxItems: MAX_ASK_USER_OPTIONS, uniqueItems: true }),
	customAnswer: Type.Optional(Utf8String(MAX_ASK_USER_CUSTOM_ANSWER_UTF8_BYTES, { minLength: 1, maxLength: 4096 })),
});
export const AskUserInteractionResultSchema = Type.Refine(
	StrictObject({
		interactionId: UuidSchema,
		kind: Type.Literal("ask_user"),
		cancelled: Type.Boolean(),
		answers: Type.Array(AskUserAnswerResultSchema, { maxItems: MAX_ASK_USER_QUESTIONS }),
	}),
	(value) => {
		if (value.cancelled) return value.answers.length === 0;
		return (
			value.answers.length > 0 &&
			new Set(value.answers.map((answer) => answer.questionId)).size === value.answers.length &&
			value.answers.every((answer) => answer.choiceIds.length > 0 || answer.customAnswer !== undefined)
		);
	},
	"ask_user cancellation and answers are inconsistent",
);
export const InteractionResultSchema = Type.Union([
	TrustInteractionResultSchema,
	SelectInteractionResultSchema,
	ConfirmInteractionResultSchema,
	InputInteractionResultSchema,
	AskUserInteractionResultSchema,
]);

export const ClientRequestMethods = {
	initialize: method(InitializeParamsSchema, InitializeResultSchema),
	"session/list": method(SessionListParamsSchema, SessionListResultSchema),
	"skill/list": method(SkillListParamsSchema, SkillListResultSchema),
	"skill/get": method(SkillGetParamsSchema, SkillGetResultSchema),
	"skill/upsert": method(SkillUpsertParamsSchema, SkillUpsertResultSchema),
	"skill/remove": method(SkillRemoveParamsSchema, SkillRemoveResultSchema),
	"skill/import/inspect": method(SkillImportInspectParamsSchema, SkillImportInspectResultSchema),
	"skill/import": method(SkillImportParamsSchema, SkillImportResultSchema),
	"mcp/list": method(McpListParamsSchema, McpListResultSchema),
	"mcp/get": method(McpGetParamsSchema, McpGetResultSchema),
	"mcp/catalog/get": method(McpCatalogGetParamsSchema, McpCatalogGetResultSchema),
	"mcp/upsert": method(McpUpsertParamsSchema, McpMutationResultSchema),
	"mcp/remove": method(McpRemoveParamsSchema, McpMutationResultSchema),
	"mcp/restart": method(McpRestartParamsSchema, McpRestartResultSchema),
	"mcp/credential/set": method(McpCredentialSetParamsSchema, McpCredentialSetResultSchema),
	"mcp/credential/clear": method(McpCredentialClearParamsSchema, McpCredentialClearResultSchema),
	"mcp/import/inspect": method(McpImportInspectParamsSchema, McpImportInspectionViewSchema),
	"mcp/import": method(McpImportParamsSchema, McpMutationResultSchema),
	"profile/get": method(ProfileGetParamsSchema, ProfileGetResultSchema),
	"personalization/get": method(PersonalizationGetParamsSchema, PersonalizationViewSchema),
	"personalization/update": method(PersonalizationUpdateParamsSchema, PersonalizationViewSchema),
	"project/deletePreview": method(ProjectDeletePreviewParamsSchema, ProjectDeletePreviewResultSchema),
	"project/delete": method(ProjectDeleteParamsSchema, ProjectDeleteResultSchema),
	"session/create": method(SessionCreateParamsSchema, SessionCreateResultSchema),
	"session/open": method(SessionRefParamsSchema, SessionOpenResultSchema),
	"session/markRead": method(SessionMarkReadParamsSchema, SessionMutationResultSchema),
	"session/readItems": method(SessionReadItemsParamsSchema, SessionReadItemsResultSchema),
	"session/readImage": method(SessionReadImageParamsSchema, SessionReadImageResultSchema),
	"session/status": method(SessionRefParamsSchema, SessionStatusViewSchema),
	"session/compact": method(SessionMutationParamsSchema, SessionCompactResultSchema),
	"session/goal/get": method(SessionGoalGetParamsSchema, SessionGoalGetResultSchema),
	"session/goal/set": method(SessionGoalSetParamsSchema, SessionGoalSetResultSchema),
	"session/goal/clear": method(SessionGoalClearParamsSchema, SessionGoalClearResultSchema),
	"session/close": method(SessionMutationParamsSchema, SessionCloseResultSchema),
	"session/rename": method(SessionRenameParamsSchema, SessionMutationResultSchema),
	"session/fork": method(SessionForkParamsSchema, SessionForkResultSchema),
	"session/delete": method(SessionMutationParamsSchema, SessionDeleteResultSchema),
	"session/archive": method(SessionMutationParamsSchema, SessionMutationResultSchema),
	"session/unarchive": method(SessionMutationParamsSchema, SessionMutationResultSchema),
	"session/subscribe": method(SessionRefParamsSchema, SessionSubscribeResultSchema),
	"session/unsubscribe": method(SessionRefParamsSchema, SessionUnsubscribeResultSchema),
	"session/setThinkingSelection": method(
		SessionSetThinkingSelectionParamsSchema,
		SessionThinkingSelectionResultSchema,
	),
	"session/setPermissionMode": method(SessionSetPermissionModeParamsSchema, SessionPermissionModeResultSchema),
	"permission/rules/list": method(PermissionRulesListParamsSchema, PermissionRulesResultSchema),
	"permission/rules/delete": method(PermissionRulesDeleteParamsSchema, PermissionRulesResultSchema),
	"permission/rules/clear": method(PermissionRulesClearParamsSchema, PermissionRulesResultSchema),
	"session/setModel": method(SessionSetModelParamsSchema, SessionModelResultSchema),
	"model/list": method(ModelListParamsSchema, ModelListResultSchema),
	"model/settings/get": method(ModelSettingsGetParamsSchema, ModelSettingsViewSchema),
	"model/settings/update": method(ModelSettingsUpdateParamsSchema, ModelSettingsViewSchema),
	"model/testConnection": method(ModelTestConnectionParamsSchema, ModelTestConnectionResultSchema),
	"usage/get": method(UsageGetParamsSchema, UsageSummaryViewSchema),
	"webSearch/get": method(WebSearchGetParamsSchema, WebSearchSettingsViewSchema),
	"webSearch/credential/reveal": method(WebSearchCredentialRevealParamsSchema, WebSearchCredentialRevealResultSchema),
	"webSearch/update": method(WebSearchUpdateParamsSchema, WebSearchSettingsViewSchema),
	"hooks/list": method(HooksListParamsSchema, HooksListViewSchema),
	"hooks/upsert": method(HooksUpsertParamsSchema, HooksListViewSchema),
	"hooks/delete": method(HooksDeleteParamsSchema, HooksListViewSchema),
	"subagent/readItems": method(SubagentReadItemsParamsSchema, SessionReadItemsResultSchema),
	"subagent/interrupt": method(SubagentInterruptParamsSchema, SubagentResultSchema),
	"turn/start": method(TurnInputSchema, AcceptedOperationSchema),
	"turn/steer": method(TurnSteerParamsSchema, AcceptedOperationSchema),
	"turn/queue": method(TurnInputSchema, QueuedTurnResultSchema),
	"turn/queue/update": method(TurnQueueUpdateParamsSchema, QueuedTurnResultSchema),
	"turn/queue/delete": method(TurnQueueDeleteParamsSchema, QueuedTurnDeleteResultSchema),
	"turn/queue/send": method(TurnQueueSendParamsSchema, AcceptedOperationSchema),
	"turn/interrupt": method(SessionMutationParamsSchema, AcceptedOperationSchema),
	"schedule/create": method(ScheduleCreateParamsSchema, ScheduleTaskResultSchema),
	"schedule/list": method(ScheduleListParamsSchema, ScheduleListResultSchema),
	"schedule/get": method(ScheduleTaskRefParamsSchema, ScheduleTaskResultSchema),
	"schedule/update": method(ScheduleUpdateParamsSchema, ScheduleTaskResultSchema),
	"schedule/pause": method(ScheduleMutationParamsSchema, ScheduleTaskResultSchema),
	"schedule/resume": method(ScheduleMutationParamsSchema, ScheduleTaskResultSchema),
	"schedule/delete": method(ScheduleDeleteParamsSchema, ScheduleDeleteResultSchema),
	"schedule/run-now": method(ScheduleMutationParamsSchema, ScheduleRunResultSchema),
	"schedule/run/list": method(ScheduleRunListParamsSchema, ScheduleRunListResultSchema),
	"schedule/run/get": method(ScheduleRunRefParamsSchema, ScheduleRunResultSchema),
	"schedule/run/mark-read": method(ScheduleRunMarkReadParamsSchema, ScheduleRunMarkReadResultSchema),
	"schedule/subscribe": method(ScheduleSubscribeParamsSchema, ScheduleSubscribeResultSchema),
	"schedule/unsubscribe": method(ScheduleSubscribeParamsSchema, ScheduleUnsubscribeResultSchema),
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
export type McpCredentialInput = Static<typeof McpCredentialInputSchema>;
export type HostParams<Method extends HostRequestMethod> = DefinitionParams<(typeof HostRequestMethods)[Method]>;
export type HostResult<Method extends HostRequestMethod> = DefinitionResult<(typeof HostRequestMethods)[Method]>;
export type ServerParams<Method extends ServerRequestMethod> = DefinitionParams<(typeof ServerRequestMethods)[Method]>;
export type ServerResult<Method extends ServerRequestMethod> = DefinitionResult<(typeof ServerRequestMethods)[Method]>;
export type InteractionResponseInput = Static<typeof InteractionResultSchema>;
