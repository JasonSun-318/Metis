import { type Static, type TSchema, Type } from "typebox";
import {
	KnowledgeLibrariesSchema,
	KnowledgeLibrarySchema,
	KnowledgeReadParamsSchema,
	KnowledgeReadSchema,
	KnowledgeRegisterParamsSchema,
	KnowledgeScanParamsSchema,
	KnowledgeScanSchema,
	KnowledgeSessionParamsSchema,
	KnowledgeSetParamsSchema,
} from "./knowledge.ts";
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
	TimestampSchema,
	Utf8String,
	UuidSchema,
} from "./schema.ts";
import {
	ActualThinkingLevelSchema,
	AgentModeSchema,
	AgentSummaryViewSchema,
	AgentTypeIdSchema,
	CollaborationModeSchema,
	ConnectionEventsParamsSchema,
	CustomAgentTypeViewSchema,
	CustomModelReasoningModeSchema,
	CustomModelThinkingLevelMapSchema,
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
	MemoryChangelogEntryViewSchema,
	MemoryConfidenceViewSchema,
	MemoryModelRefViewSchema,
	MemoryNoteSummaryViewSchema,
	MemoryNoteTypeViewSchema,
	MemoryNoteViewSchema,
	MemoryScopeViewSchema,
	MemorySettingsViewSchema,
	MemorySlugSchema,
	MemoryTargetViewSchema,
	ModelOptionViewSchema,
	ModelRefSchema,
	ModelSettingsViewSchema,
	PermissionApprovalChoiceSchema,
	PermissionPresetSchema,
	PermissionSettingsViewSchema,
	PlanViewSchema,
	PluginActivationStatusSchema,
	PluginCatalogEntryViewSchema,
	PluginInspectionViewSchema,
	PluginInstalledViewSchema,
	PluginMarketViewSchema,
	PluginRecordSchema,
	PluginUpdateInspectionViewSchema,
	ProfileUsageSummaryViewSchema,
	ProjectPermissionRuleViewSchema,
	QueuedTurnViewSchema,
	SandboxHealthSchema,
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
	ThinkingSelectionSchema,
	UsageRangeDaysSchema,
	UsageSummaryViewSchema,
	WebSearchProviderSchema,
	WebSearchSettingsViewSchema,
	WritableMcpScopeViewSchema,
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
const McpWritableDefinitionFields = { scope: WritableMcpScopeViewSchema, name: NameSchema } as const;
const McpMutationBaseFields = {
	requestId: UuidSchema,
	...McpDefinitionFields,
} as const;
const McpUpsertMutationFields = {
	requestId: UuidSchema,
	...McpWritableDefinitionFields,
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
	scope: WritableMcpScopeViewSchema,
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
	permissionPreset: Type.Optional(PermissionPresetSchema),
	useMemory: Type.Optional(Type.Boolean()),
	contributeMemory: Type.Optional(Type.Boolean()),
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
	rootSessionId: Type.Optional(SessionIdSchema),
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

export const SessionOpenDeliveredFileParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	rootSessionId: Type.Optional(SessionIdSchema),
	fileId: Type.String({ minLength: 16, maxLength: 16, pattern: "^[a-f0-9]{16}$" }),
	action: Type.Union([Type.Literal("default"), Type.Literal("reveal")]),
});
export const SessionOpenDeliveredFileResultSchema = StrictObject({});

export const SessionReadDeliveredFileParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	rootSessionId: Type.Optional(SessionIdSchema),
	fileId: Type.String({ minLength: 16, maxLength: 16, pattern: "^[a-f0-9]{16}$" }),
});
export const SessionReadDeliveredFileResultSchema = StrictObject({
	fileId: Type.String({ minLength: 16, maxLength: 16, pattern: "^[a-f0-9]{16}$" }),
	name: Type.String({ minLength: 1, maxLength: 255 }),
	byteLength: Type.Integer({ minimum: 0, maximum: 128 * 1024 * 1024 }),
	data: Type.String({ minLength: 0 }),
	mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
	absolutePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
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
	availableThinkingSelections: Type.Array(ThinkingSelectionSchema, { minItems: 1, maxItems: 7, uniqueItems: true }),
});

export const SessionSetPermissionPresetParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	permissionPreset: PermissionPresetSchema,
});
export const SessionPermissionPresetResultSchema = StrictObject({
	permissionPreset: PermissionPresetSchema,
	effectiveSettings: PermissionSettingsViewSchema,
	constrainedByParent: Type.Boolean(),
	sandboxHealth: SandboxHealthSchema,
});

export const SessionSetCollaborationModeParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	collaborationMode: CollaborationModeSchema,
});
export const SessionCollaborationModeResultSchema = StrictObject({ collaborationMode: CollaborationModeSchema });

export const SessionSetMemoryFlagsParamsSchema = Type.Refine(
	StrictObject({
		sessionId: SessionIdSchema,
		requestId: UuidSchema,
		useMemory: Type.Optional(Type.Boolean()),
		contributeMemory: Type.Optional(Type.Boolean()),
	}),
	(value) => value.useMemory !== undefined || value.contributeMemory !== undefined,
	"At least one memory flag is required",
);
export const SessionMemoryFlagsResultSchema = StrictObject({
	useMemory: Type.Boolean(),
	contributeMemory: Type.Boolean(),
});

const PlanMutationFields = {
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	planId: OpaqueIdSchema,
	revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
} as const;
export const PlanStartExecutionParamsSchema = StrictObject(PlanMutationFields);
export const PlanCancelParamsSchema = StrictObject(PlanMutationFields);
export const PlanCancelResultSchema = StrictObject({
	plan: PlanViewSchema,
	collaborationMode: Type.Literal("default"),
});

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
export const AutoCommandRuleSchema = StrictObject({
	command: Utf8String(256, { minLength: 1 }),
	allowNetwork: Type.Boolean(),
});
export const PermissionAutoGetParamsSchema = StrictObject({});
export const PermissionAutoUpdateParamsSchema = StrictObject({
	requestId: UuidSchema,
	rules: Type.Array(AutoCommandRuleSchema, { maxItems: 64 }),
});
export const PermissionAutoSettingsViewSchema = StrictObject({
	rules: Type.Array(AutoCommandRuleSchema, { maxItems: 64 }),
	suggestions: Type.Array(Utf8String(256, { minLength: 1 }), { maxItems: 64, uniqueItems: true }),
});

export const SessionSetModelParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	provider: NameSchema,
	modelId: NameSchema,
});
export const SessionModelResultSchema = StrictObject({
	model: ModelRefSchema,
	thinkingSelection: ThinkingSelectionSchema,
	actualThinkingLevel: ActualThinkingLevelSchema,
	availableThinkingSelections: Type.Array(ThinkingSelectionSchema, { minItems: 1, maxItems: 7, uniqueItems: true }),
});

export const AgentReadItemsParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	taskId: Type.Optional(SessionIdSchema),
	beforeItemId: Type.Optional(Type.Union([OpaqueIdSchema, Type.Null()])),
	limit: Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS }),
});
const AgentMutationFields = {
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	requestId: UuidSchema,
} as const;
export const AgentInterruptParamsSchema = StrictObject(AgentMutationFields);
export const AgentArchiveParamsSchema = StrictObject({
	...AgentMutationFields,
	archived: Type.Boolean(),
});
export const AgentDeleteParamsSchema = StrictObject(AgentMutationFields);
export const AgentListParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	includeArchived: Type.Optional(Type.Boolean()),
	afterAgentId: Type.Optional(Type.Union([SessionIdSchema, Type.Null()])),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const AgentListResultSchema = StrictObject({
	agents: Type.Array(AgentSummaryViewSchema, { maxItems: 100 }),
	nextAfterAgentId: Type.Union([SessionIdSchema, Type.Null()]),
	unreadableAgentCount: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
export const AgentResultSchema = StrictObject({ agent: AgentSummaryViewSchema });
export const AgentDeleteResultSchema = StrictObject({
	agentId: SessionIdSchema,
	status: Type.Literal("deleted"),
});

export const AgentTypeListParamsSchema = StrictObject({});
export const AgentTypeListResultSchema = StrictObject({
	types: Type.Array(CustomAgentTypeViewSchema, { maxItems: 20 }),
	availableTools: Type.Optional(Type.Array(NameSchema, { maxItems: 256, uniqueItems: true })),
});
export const AgentTypeUpsertParamsSchema = StrictObject({
	requestId: UuidSchema,
	type: StrictObject({
		id: AgentTypeIdSchema,
		displayName: NameSchema,
		description: Type.String({ maxLength: 512 }),
		allowedTools: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
		systemPrompt: Type.String({ maxLength: 8192 }),
		writePolicy: Type.Union([Type.Literal("inherit"), Type.Literal("deny")]),
		mayDelegate: Type.Boolean(),
	}),
});
export const AgentTypeUpsertResultSchema = StrictObject({ type: CustomAgentTypeViewSchema });
export const AgentTypeRemoveParamsSchema = StrictObject({ requestId: UuidSchema, id: AgentTypeIdSchema });
export const AgentTypeRemoveResultSchema = StrictObject({ id: AgentTypeIdSchema });

export const FileAttachmentInputSchema = StrictObject({
	path: PathSchema,
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});

const FileSelectionFields = {
	target: Type.Optional(
		Type.Union([
			StrictObject({
				kind: Type.Literal("pdf"),
				page: Type.Integer({ minimum: 1, maximum: 1000000 }),
				endPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
			}),
			StrictObject({
				kind: Type.Literal("pptx"),
				page: Type.Integer({ minimum: 1, maximum: 1000000 }),
				slidePath: Type.String({ pattern: "^ppt/slides/slide[0-9]+\\.xml$" }),
				objectId: Type.String({ minLength: 1, maxLength: 255 }),
				objectType: Type.Union([Type.Literal("shape"), Type.Literal("picture"), Type.Literal("chart")]),
				objectName: Type.String({ maxLength: 255 }),
			}),
			StrictObject({
				kind: Type.Literal("spreadsheet"),
				sheet: Type.String({ minLength: 1, maxLength: 255 }),
				range: Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$" }),
			}),
		]),
	),
	selectedText: Type.String({ minLength: 1, maxLength: 8000 }),
	basis: Type.Union([Type.Literal("source"), Type.Literal("markdown"), Type.Literal("formatted")]),
	sourceExcerpt: Type.Optional(Type.String({ maxLength: 4000 })),
	excerptTruncated: Type.Optional(Type.Boolean()),
	startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
};
export const FileSelectionInputSchema = Type.Union([
	StrictObject({ ...FileSelectionFields, source: Type.Literal("workspace"), relativePath: PathSchema }),
	StrictObject({
		...FileSelectionFields,
		source: Type.Literal("delivered"),
		fileId: Type.String({ pattern: "^[a-f0-9]{16}$" }),
	}),
]);

export const ConversationQuoteInputSchema = StrictObject({
	sourceItemId: OpaqueIdSchema,
	sourceRole: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
	selectedText: Utf8String(32768, { minLength: 1, maxLength: 8000 }),
});

export const TurnInputSchema = StrictObject({
	sessionId: SessionIdSchema,
	// Turn request IDs are scoped to sessionId.
	requestId: UuidSchema,
	text: PromptTextSchema,
	images: Type.Optional(Type.Array(DurableImageRefViewSchema, { maxItems: 32 })),
	attachments: Type.Optional(Type.Array(FileAttachmentInputSchema, { maxItems: 16 })),
	fileSelections: Type.Optional(Type.Array(FileSelectionInputSchema, { maxItems: 8 })),
	conversationQuotes: Type.Optional(Type.Array(ConversationQuoteInputSchema, { maxItems: 8 })),
});

export const AgentSendParamsSchema = StrictObject({
	...AgentMutationFields,
	delivery: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("steer"), Type.Literal("queue")])),
	input: StrictObject({
		text: PromptTextSchema,
		images: Type.Optional(Type.Array(DurableImageRefViewSchema, { maxItems: 32 })),
		attachments: Type.Optional(Type.Array(FileAttachmentInputSchema, { maxItems: 16 })),
		fileSelections: Type.Optional(Type.Array(FileSelectionInputSchema, { maxItems: 8 })),
		conversationQuotes: Type.Optional(Type.Array(ConversationQuoteInputSchema, { maxItems: 8 })),
	}),
});
export const AgentSendResultSchema = StrictObject({
	agentId: SessionIdSchema,
	taskId: SessionIdSchema,
	messageId: OpaqueIdSchema,
	requestId: UuidSchema,
	delivery: Type.Union([Type.Literal("steer"), Type.Literal("start"), Type.Literal("queue")]),
	state: Type.Union([
		Type.Literal("accepted"),
		Type.Literal("queued"),
		Type.Literal("delivered"),
		Type.Literal("cancelled"),
		Type.Literal("failed"),
	]),
	instructionRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const AgentControlParamsSchema = Type.Refine(
	StrictObject({
		...AgentMutationFields,
		action: Type.Union([Type.Literal("stop"), Type.Literal("resume")]),
		scope: Type.Optional(Type.Union([Type.Literal("self"), Type.Literal("subtree")])),
	}),
	(value) => value.action !== "resume" || value.scope !== "subtree",
	"Resume applies to the selected agent only",
);
export const AgentControlResultSchema = StrictObject({
	agentId: SessionIdSchema,
	requestId: UuidSchema,
	state: Type.Union([Type.Literal("enabled"), Type.Literal("user_paused"), Type.Literal("interrupted")]),
	scope: Type.Union([Type.Literal("self"), Type.Literal("subtree")]),
});

export const TurnSteerParamsSchema = StrictObject({
	sessionId: SessionIdSchema,
	requestId: UuidSchema,
	text: PromptTextSchema,
	images: Type.Optional(Type.Array(DurableImageRefViewSchema, { maxItems: 32 })),
	attachments: Type.Optional(Type.Array(FileAttachmentInputSchema, { maxItems: 16 })),
	fileSelections: Type.Optional(Type.Array(FileSelectionInputSchema, { maxItems: 8 })),
	conversationQuotes: Type.Optional(Type.Array(ConversationQuoteInputSchema, { maxItems: 8 })),
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
	reasoningMode: CustomModelReasoningModeSchema,
	thinkingLevelMap: Type.Optional(CustomModelThinkingLevelMapSchema),
	imageInput: Type.Boolean(),
});
const ModelDiscoveryApiSchema = Type.Union([
	Type.Literal("openai-responses"),
	Type.Literal("openai-completions"),
	Type.Literal("anthropic-messages"),
]);
export const ModelDiscoverParamsSchema = StrictObject({
	provider: Type.Optional(NameSchema),
	baseUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
	api: ModelDiscoveryApiSchema,
	apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
});
export const DiscoveredModelSchema = StrictObject({
	modelId: NameSchema,
	name: NameSchema,
	contextWindow: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
	maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
	imageInput: Type.Optional(Type.Boolean()),
});
export const ModelDiscoverResultSchema = StrictObject({
	models: Type.Array(DiscoveredModelSchema, { maxItems: 512 }),
	warnings: Type.Optional(Type.Array(PublicTextSchema, { maxItems: 20 })),
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
		model: Type.Union([ModelRefSchema, Type.Null()]),
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
	kind: Type.Literal("chat"),
	provider: NameSchema,
	modelId: NameSchema,
});
export const AnyModelTestConnectionParamsSchema = ModelTestConnectionParamsSchema;
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

export const MemoryGetParamsSchema = StrictObject({ sessionId: Type.Optional(SessionIdSchema) });
export const MemoryDreamSettingsInputSchema = StrictObject({
	enabled: Type.Optional(Type.Boolean()),
	model: Type.Optional(Type.Union([MemoryModelRefViewSchema, Type.Null()])),
	minHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 8_760 })),
	minSessions: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
	maxUnusedDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_650 })),
});
export const MemoryUpdateParamsSchema = StrictObject({
	sessionId: Type.Optional(SessionIdSchema),
	enabled: Type.Optional(Type.Boolean()),
	dream: Type.Optional(MemoryDreamSettingsInputSchema),
	activeContext: Type.Optional(Type.Boolean()),
});
export const MemoryNotesListParamsSchema = StrictObject({
	sessionId: Type.Optional(SessionIdSchema),
	scope: Type.Optional(MemoryScopeViewSchema),
	type: Type.Optional(MemoryNoteTypeViewSchema),
	query: Type.Optional(Utf8String(4 * 1024, { minLength: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS })),
});
export const MemoryNotesListResultSchema = StrictObject({
	notes: Type.Array(MemoryNoteSummaryViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
});
export const MemoryNotesReadParamsSchema = StrictObject({
	sessionId: Type.Optional(SessionIdSchema),
	scope: MemoryScopeViewSchema,
	slug: MemorySlugSchema,
});
export const MemoryNotesReadResultSchema = StrictObject({ note: MemoryNoteViewSchema });
const MemoryNoteFrontmatterInputSchema = Type.Partial(
	StrictObject({
		name: Utf8String(2 * 1024, { minLength: 1 }),
		description: Utf8String(2 * 1024),
		type: MemoryNoteTypeViewSchema,
		aliases: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 32 }),
		confidence: MemoryConfidenceViewSchema,
		applies_to: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 32 }),
	}),
);
/** Same write surface as the memory_write tool, executed with actor=user. */
export const MemoryNotesWriteParamsSchema = StrictObject({
	sessionId: Type.Optional(SessionIdSchema),
	op: Type.Union([
		Type.Literal("create"),
		Type.Literal("append"),
		Type.Literal("replace"),
		Type.Literal("str_replace"),
		Type.Literal("rename"),
		Type.Literal("delete"),
	]),
	scope: MemoryScopeViewSchema,
	target: MemoryTargetViewSchema,
	newSlug: Type.Optional(MemorySlugSchema),
	frontmatter: Type.Optional(MemoryNoteFrontmatterInputSchema),
	content: Type.Optional(Utf8String(64 * 1024)),
	oldText: Type.Optional(Utf8String(32 * 1024)),
	newText: Type.Optional(Utf8String(32 * 1024)),
});
export const MemoryNotesWriteResultSchema = StrictObject({
	ok: Type.Boolean(),
	changeId: Type.Optional(UuidSchema),
	target: Type.Optional(MemoryTargetViewSchema),
	warning: Type.Optional(PublicTextSchema),
	error: Type.Optional(PublicTextSchema),
});
export const MemoryHistoryListParamsSchema = StrictObject({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTORY_ITEMS })),
});
export const MemoryHistoryListResultSchema = StrictObject({
	entries: Type.Array(MemoryChangelogEntryViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
});
export const MemoryHistoryReadParamsSchema = StrictObject({ changeId: UuidSchema });
export const MemoryHistoryReadResultSchema = StrictObject({
	entry: MemoryChangelogEntryViewSchema,
	/** Unified patch of the change (pre-change snapshot → current content); absent when nothing remains to diff. */
	patch: Type.Optional(Utf8String(4 * 1024 * 1024)),
});
export const MemoryUndoParamsSchema = StrictObject({ changeId: UuidSchema });
export const MemoryUndoResultSchema = StrictObject({
	ok: Type.Boolean(),
	error: Type.Optional(PublicTextSchema),
});
export const MemoryUndoRunParamsSchema = StrictObject({
	runId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const MemoryUndoRunResultSchema = StrictObject({
	undone: Type.Array(UuidSchema, { maxItems: MAX_HISTORY_ITEMS }),
	skipped: Type.Array(StrictObject({ changeId: Type.String({ maxLength: 64 }), reason: PublicTextSchema }), {
		maxItems: MAX_HISTORY_ITEMS,
	}),
});
/** Manual dream trigger: ignores the gate's timing/count thresholds, still needs a model and the vault lock. */
export const MemoryDreamRunParamsSchema = StrictObject({});
export const MemoryDreamRunResultSchema = StrictObject({
	ok: Type.Boolean(),
	runId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	error: Type.Optional(PublicTextSchema),
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
		model: ModelRefSchema,
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
		model: Type.Optional(ModelRefSchema),
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

export const MAX_BROWSER_TABS_PER_SESSION = 16;
export const MAX_BROWSER_PROFILES = 64;
export const MAX_BROWSER_STATE_UTF8_BYTES = 256 * 1024;
export const MAX_BROWSER_SCREENSHOT_UTF8_BYTES = 4 * 1024 * 1024;
export const MAX_BROWSER_ACTION_TEXT_UTF8_BYTES = 32 * 1024;
export const MAX_BROWSER_INTENT_UTF8_BYTES = 1024;

const BrowserIdSchema = UuidSchema;
const BrowserProfileIdSchema = UuidSchema;
const BrowserElementIdSchema = Type.String({ pattern: "^e[1-9][0-9]{0,5}$", maxLength: 7 });
const BrowserSourceIdSchema = Type.Union([
	Type.Literal("chrome"),
	Type.Literal("edge"),
	Type.Literal("brave"),
	Type.Literal("chromium"),
]);
const BrowserControlStateSchema = Type.Union([Type.Literal("idle"), Type.Literal("agent"), Type.Literal("handoff")]);
const BrowserUrlSchema = Utf8String(8192);
const BrowserOriginSchema = Type.Refine(
	Utf8String(2048, { minLength: 1 }),
	(value) => {
		try {
			const parsed = new URL(value);
			return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
		} catch {
			return false;
		}
	},
	"must be an exact HTTP(S) origin",
);
const BrowserNavigationTargetSchema = Type.Refine(
	Utf8String(8192, { minLength: 1 }),
	(value) => {
		try {
			const parsed = new URL(value);
			return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
		} catch {
			return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
		}
	},
	"must be HTTP(S) without credentials or search text",
);
const BrowserCoordinateSchema = Type.Number({ minimum: -2_147_483_648, maximum: 2_147_483_647 });
const BrowserCoordinateTargetSchema = StrictObject({ x: BrowserCoordinateSchema, y: BrowserCoordinateSchema });
const BrowserElementTargetSchema = StrictObject({ elementId: BrowserElementIdSchema });
const BrowserPointTargetSchema = Type.Union([BrowserElementTargetSchema, BrowserCoordinateTargetSchema]);

// Function-calling providers require an explicit object root, including action unions.
export const BrowserTabsInputSchema = Type.Union(
	[
		StrictObject({ action: Type.Literal("list") }),
		StrictObject({ action: Type.Literal("open"), profileId: Type.Optional(BrowserProfileIdSchema) }),
		StrictObject({ action: Type.Literal("close"), browserId: BrowserIdSchema }),
		StrictObject({ action: Type.Literal("release"), browserId: BrowserIdSchema }),
	],
	{ type: "object" },
);

export const BrowserNavigateInputSchema = Type.Union(
	[
		StrictObject({ browserId: BrowserIdSchema, action: Type.Literal("goto"), url: BrowserNavigationTargetSchema }),
		StrictObject({
			browserId: BrowserIdSchema,
			action: Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")]),
		}),
	],
	{ type: "object" },
);

const BrowserStateCursorSchema = StrictObject({
	documentId: UuidSchema,
	revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	offset: Type.Integer({ minimum: 1, maximum: MAX_BROWSER_STATE_UTF8_BYTES }),
});

export const BrowserObserveInputSchema = StrictObject({
	browserId: BrowserIdSchema,
	mode: Type.Optional(Type.Union([Type.Literal("state"), Type.Literal("screenshot"), Type.Literal("both")])),
	sinceRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	cursor: Type.Optional(BrowserStateCursorSchema),
});

export const BrowserRiskSchema = Type.Union([
	Type.Literal("ordinary"),
	Type.Literal("external_side_effect"),
	Type.Literal("sensitive_data"),
	Type.Literal("destructive"),
	Type.Literal("financial"),
]);

export const BrowserActionSchema = Type.Union([
	StrictObject({
		type: Type.Literal("click"),
		target: BrowserPointTargetSchema,
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
	}),
	StrictObject({ type: Type.Literal("hover"), target: BrowserPointTargetSchema }),
	StrictObject({
		type: Type.Literal("type"),
		elementId: BrowserElementIdSchema,
		text: Utf8String(MAX_BROWSER_ACTION_TEXT_UTF8_BYTES),
		replace: Type.Optional(Type.Boolean()),
	}),
	StrictObject({ type: Type.Literal("press"), key: Utf8String(64, { minLength: 1 }) }),
	StrictObject({
		type: Type.Literal("scroll"),
		direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
		pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		elementId: Type.Optional(BrowserElementIdSchema),
	}),
	StrictObject({ type: Type.Literal("drag"), from: BrowserPointTargetSchema, to: BrowserPointTargetSchema }),
	StrictObject({
		type: Type.Literal("select"),
		elementId: BrowserElementIdSchema,
		value: Utf8String(4096),
	}),
	StrictObject({
		type: Type.Literal("select"),
		elementId: BrowserElementIdSchema,
		optionIndex: Type.Integer({ minimum: 0, maximum: 999 }),
	}),
	StrictObject({
		type: Type.Literal("dialog"),
		decision: Type.Union([Type.Literal("accept"), Type.Literal("dismiss")]),
	}),
]);

export const BrowserActInputSchema = StrictObject({
	browserId: BrowserIdSchema,
	documentId: UuidSchema,
	snapshotRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	origin: BrowserOriginSchema,
	intent: Utf8String(MAX_BROWSER_INTENT_UTF8_BYTES, { minLength: 1 }),
	risk: BrowserRiskSchema,
	action: BrowserActionSchema,
});

export const BrowserHandoffInputSchema = StrictObject({
	browserId: BrowserIdSchema,
	reason: Type.Union([
		Type.Literal("login"),
		Type.Literal("otp"),
		Type.Literal("passkey"),
		Type.Literal("device_approval"),
		Type.Literal("captcha"),
		Type.Literal("sensitive_action"),
		Type.Literal("other"),
	]),
});

export const BrowserObservationSchema = StrictObject({
	browserId: BrowserIdSchema,
	profileId: BrowserProfileIdSchema,
	documentId: UuidSchema,
	revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	change: Type.Union([Type.Literal("full"), Type.Literal("diff"), Type.Literal("unchanged")]),
	url: BrowserUrlSchema,
	title: Utf8String(4096),
	loading: Type.Boolean(),
	state: Utf8String(MAX_BROWSER_STATE_UTF8_BYTES),
	statePage: Type.Optional(
		StrictObject({
			offset: Type.Integer({ minimum: 0, maximum: MAX_BROWSER_STATE_UTF8_BYTES }),
			totalChars: Type.Integer({ minimum: 0, maximum: MAX_BROWSER_STATE_UTF8_BYTES }),
			nextCursor: Type.Optional(BrowserStateCursorSchema),
		}),
	),
	cursorReset: Type.Optional(Type.Literal(true)),
	screenshot: Type.Optional(
		StrictObject({
			mediaType: Type.Literal("image/jpeg"),
			data: Utf8String(MAX_BROWSER_SCREENSHOT_UTF8_BYTES, { pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
		}),
	),
});

export const BrowserTabsDetailsSchema = StrictObject({
	profiles: Type.Array(
		StrictObject({
			profileId: BrowserProfileIdSchema,
			name: Utf8String(256, { minLength: 1 }),
			sourceId: Type.Union([BrowserSourceIdSchema, Type.Null()]),
		}),
		{ maxItems: MAX_BROWSER_PROFILES },
	),
	tabs: Type.Array(
		StrictObject({
			browserId: BrowserIdSchema,
			profileId: BrowserProfileIdSchema,
			profileName: Utf8String(256, { minLength: 1 }),
			title: Utf8String(4096),
			url: BrowserUrlSchema,
			loading: Type.Boolean(),
			controlState: BrowserControlStateSchema,
			ownerAgentId: Type.Optional(SessionIdSchema),
		}),
		{ maxItems: MAX_BROWSER_TABS_PER_SESSION },
	),
});

export const BrowserOperationDetailsSchema = Type.Union([
	StrictObject({ status: Type.Literal("completed"), observation: BrowserObservationSchema }),
	StrictObject({
		status: Type.Literal("failed"),
		reason: Type.Union([
			Type.Literal("select_unavailable"),
			Type.Literal("unsupported_select"),
			Type.Literal("option_not_found"),
			Type.Literal("option_ambiguous"),
			Type.Literal("option_changed"),
			Type.Literal("option_unavailable"),
			Type.Literal("select_changed"),
			Type.Literal("selection_changed"),
			Type.Literal("selection_unconfirmed"),
		]),
		execution: Type.Union([Type.Literal("not_started"), Type.Literal("dispatched"), Type.Literal("unknown")]),
		recovery: Type.Union([Type.Literal("observe"), Type.Literal("use_supported_action")]),
		message: Utf8String(1024, { minLength: 1 }),
	}),
	StrictObject({
		status: Type.Literal("stale"),
		reason: Type.Union([
			Type.Literal("origin_changed"),
			Type.Literal("document_changed"),
			Type.Literal("revision_changed"),
			Type.Literal("element_missing"),
			Type.Literal("element_not_interactable"),
		]),
		observation: BrowserObservationSchema,
	}),
	StrictObject({
		status: Type.Literal("cancelled"),
		reason: Type.Literal("user_cancelled"),
	}),
]);

export const BrowserHandoffDetailsSchema = Type.Union([
	StrictObject({ status: Type.Literal("completed"), observation: BrowserObservationSchema }),
	StrictObject({
		status: Type.Literal("cancelled"),
		reason: Type.Union([
			Type.Literal("user_cancelled"),
			Type.Literal("tab_closed"),
			Type.Literal("turn_interrupted"),
			Type.Literal("server_restarted"),
			Type.Literal("timed_out"),
		]),
	}),
]);

export const BrowserToolCallSchema = Type.Union([
	StrictObject({ tool: Type.Literal("browser_tabs"), input: BrowserTabsInputSchema }),
	StrictObject({ tool: Type.Literal("browser_navigate"), input: BrowserNavigateInputSchema }),
	StrictObject({ tool: Type.Literal("browser_observe"), input: BrowserObserveInputSchema }),
	StrictObject({ tool: Type.Literal("browser_act"), input: BrowserActInputSchema }),
	StrictObject({ tool: Type.Literal("browser_handoff"), input: BrowserHandoffInputSchema }),
]);

export const BrowserToolResultSchema = Type.Union([
	StrictObject({ tool: Type.Literal("browser_tabs"), details: BrowserTabsDetailsSchema }),
	StrictObject({ tool: Type.Literal("browser_navigate"), details: BrowserOperationDetailsSchema }),
	StrictObject({ tool: Type.Literal("browser_observe"), observation: BrowserObservationSchema }),
	StrictObject({ tool: Type.Literal("browser_act"), details: BrowserOperationDetailsSchema }),
	StrictObject({ tool: Type.Literal("browser_handoff"), details: BrowserHandoffDetailsSchema }),
]);

export const BrowserToolRequestParamsSchema = StrictObject({
	serverEpoch: UuidSchema,
	sessionId: SessionIdSchema,
	rootSessionId: Type.Optional(SessionIdSchema),
	actorSessionId: Type.Optional(SessionIdSchema),
	agentId: Type.Optional(SessionIdSchema),
	taskId: Type.Optional(SessionIdSchema),
	toolCallId: OpaqueIdSchema,
	call: BrowserToolCallSchema,
});

export const BrowserToolRequestResultSchema = StrictObject({
	toolCallId: OpaqueIdSchema,
	result: BrowserToolResultSchema,
});

export const BrowserToolCancelledParamsSchema = StrictObject({
	serverEpoch: UuidSchema,
	sessionId: SessionIdSchema,
	rootSessionId: Type.Optional(SessionIdSchema),
	actorSessionId: Type.Optional(SessionIdSchema),
	agentId: Type.Optional(SessionIdSchema),
	taskId: Type.Optional(SessionIdSchema),
	toolCallId: OpaqueIdSchema,
	requestId: OpaqueIdSchema,
});

export const InteractionCancelledParamsSchema = StrictObject({
	serverEpoch: UuidSchema,
	sessionId: SessionIdSchema,
	interactionId: UuidSchema,
	requestId: OpaqueIdSchema,
});

export const InteractionRequestParamsSchema = StrictObject({
	serverEpoch: UuidSchema,
	interaction: InteractionViewSchema,
});
export const TrustInteractionResultSchema = StrictObject({
	interactionId: UuidSchema,
	kind: Type.Literal("project_trust"),
	choiceId: OpaqueIdSchema,
});
export const PermissionApprovalInteractionResultSchema = StrictObject({
	interactionId: UuidSchema,
	kind: Type.Literal("session_permission_approval"),
	choice: PermissionApprovalChoiceSchema,
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
	PermissionApprovalInteractionResultSchema,
	SelectInteractionResultSchema,
	ConfirmInteractionResultSchema,
	InputInteractionResultSchema,
	AskUserInteractionResultSchema,
]);

// =========================================================================
// Plugins
// =========================================================================

export const PluginMarketListParamsSchema = StrictObject({});
export const PluginMarketListResultSchema = StrictObject({
	markets: Type.Array(PluginMarketViewSchema),
	selectedSourceId: Type.Union([NameSchema, Type.Null()]),
	registryRevision: Type.Integer({ minimum: 0 }),
});

export const PluginMarketAddParamsSchema = StrictObject({
	requestId: UuidSchema,
	url: Utf8String(2048, { minLength: 1 }),
	expectedRevision: Type.Integer({ minimum: 0 }),
});

export const PluginMarketSelectParamsSchema = StrictObject({
	requestId: UuidSchema,
	sourceId: NameSchema,
	expectedRevision: Type.Integer({ minimum: 0 }),
});

export const PluginMarketRemoveParamsSchema = StrictObject({
	requestId: UuidSchema,
	sourceId: NameSchema,
	expectedRevision: Type.Integer({ minimum: 0 }),
});

export const PluginMarketRefreshParamsSchema = StrictObject({
	requestId: UuidSchema,
	sourceId: NameSchema,
});

export const PluginMarketRefreshResultSchema = StrictObject({
	catalog: Type.Array(PluginCatalogEntryViewSchema),
	entries: Type.Optional(Type.Array(PluginCatalogEntryViewSchema)),
	fetchedAt: TimestampSchema,
	cacheStatus: Type.Union([Type.Literal("fresh"), Type.Literal("cached")]),
});

export const PluginCatalogParamsSchema = StrictObject({
	sourceId: NameSchema,
});

export const PluginCatalogResultSchema = StrictObject({
	entries: Type.Array(PluginCatalogEntryViewSchema),
	cacheStatus: Type.Union([Type.Literal("fresh"), Type.Literal("cached"), Type.Literal("offline")]),
});

export const PluginInspectParamsSchema = StrictObject({
	sourceId: NameSchema,
	entryId: NameSchema,
});

export const PluginInstallParamsSchema = StrictObject({
	requestId: UuidSchema,
	inspectionId: UuidSchema,
	expectedRevision: Type.Integer({ minimum: 0 }),
	allowPartial: Type.Optional(Type.Boolean()),
});

export const PluginInstallResultSchema = StrictObject({
	plugin: PluginInstalledViewSchema,
	registryRevision: Type.Integer({ minimum: 0 }),
	activation: PluginActivationStatusSchema,
});

export const PluginListParamsSchema = StrictObject({});
export const PluginListResultSchema = StrictObject({
	installed: Type.Array(PluginRecordSchema),
	registryRevision: Type.Integer({ minimum: 0 }),
});

export const PluginGetParamsSchema = StrictObject({
	pluginId: Sha256Schema,
});

export const PluginSetEnabledParamsSchema = StrictObject({
	requestId: UuidSchema,
	pluginId: Sha256Schema,
	enabled: Type.Boolean(),
	expectedRevision: Type.Integer({ minimum: 0 }),
});

export const PluginRemoveParamsSchema = StrictObject({
	requestId: UuidSchema,
	pluginId: Sha256Schema,
	expectedRevision: Type.Integer({ minimum: 0 }),
});

export const PluginRemoveResultSchema = StrictObject({
	installed: Type.Array(PluginRecordSchema),
	registryRevision: Type.Integer({ minimum: 0 }),
	activation: PluginActivationStatusSchema,
});

export const PluginUpdateInspectParamsSchema = StrictObject({
	pluginId: Sha256Schema,
});

export const PluginUpdateParamsSchema = StrictObject({
	requestId: UuidSchema,
	pluginId: Sha256Schema,
	inspectionId: UuidSchema,
	expectedRevision: Type.Integer({ minimum: 0 }),
	expectedCommit: Type.String({ minLength: 1, maxLength: 128 }),
	allowPartial: Type.Optional(Type.Boolean()),
});

export const ClientRequestMethods = {
	"knowledge/list": method(StrictObject({}), KnowledgeLibrariesSchema),
	"knowledge/register": method(KnowledgeRegisterParamsSchema, KnowledgeLibrarySchema),
	"knowledge/scan": method(KnowledgeScanParamsSchema, KnowledgeScanSchema),
	"knowledge/read": method(KnowledgeReadParamsSchema, KnowledgeReadSchema),
	"session/knowledge/get": method(KnowledgeSessionParamsSchema, KnowledgeLibrariesSchema),
	"session/knowledge/set": method(KnowledgeSetParamsSchema, KnowledgeLibrariesSchema),
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
	"session/openDeliveredFile": method(SessionOpenDeliveredFileParamsSchema, SessionOpenDeliveredFileResultSchema),
	"session/readDeliveredFile": method(SessionReadDeliveredFileParamsSchema, SessionReadDeliveredFileResultSchema),
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
	"session/setPermissionPreset": method(SessionSetPermissionPresetParamsSchema, SessionPermissionPresetResultSchema),
	"session/setCollaborationMode": method(
		SessionSetCollaborationModeParamsSchema,
		SessionCollaborationModeResultSchema,
	),
	"session/setMemoryFlags": method(SessionSetMemoryFlagsParamsSchema, SessionMemoryFlagsResultSchema),
	"plan/startExecution": method(PlanStartExecutionParamsSchema, AcceptedOperationSchema),
	"plan/cancel": method(PlanCancelParamsSchema, PlanCancelResultSchema),
	"permission/rules/list": method(PermissionRulesListParamsSchema, PermissionRulesResultSchema),
	"permission/rules/delete": method(PermissionRulesDeleteParamsSchema, PermissionRulesResultSchema),
	"permission/rules/clear": method(PermissionRulesClearParamsSchema, PermissionRulesResultSchema),
	"permission/auto/get": method(PermissionAutoGetParamsSchema, PermissionAutoSettingsViewSchema),
	"permission/auto/update": method(PermissionAutoUpdateParamsSchema, PermissionAutoSettingsViewSchema),
	"session/setModel": method(SessionSetModelParamsSchema, SessionModelResultSchema),
	"model/list": method(ModelListParamsSchema, ModelListResultSchema),
	"model/settings/get": method(ModelSettingsGetParamsSchema, ModelSettingsViewSchema),
	"model/settings/update": method(ModelSettingsUpdateParamsSchema, ModelSettingsViewSchema),
	"model/testConnection": method(AnyModelTestConnectionParamsSchema, ModelTestConnectionResultSchema),
	"usage/get": method(UsageGetParamsSchema, UsageSummaryViewSchema),
	"webSearch/get": method(WebSearchGetParamsSchema, WebSearchSettingsViewSchema),
	"webSearch/credential/reveal": method(WebSearchCredentialRevealParamsSchema, WebSearchCredentialRevealResultSchema),
	"webSearch/update": method(WebSearchUpdateParamsSchema, WebSearchSettingsViewSchema),
	"memory/get": method(MemoryGetParamsSchema, MemorySettingsViewSchema),
	"memory/update": method(MemoryUpdateParamsSchema, MemorySettingsViewSchema),
	"memory/notes/list": method(MemoryNotesListParamsSchema, MemoryNotesListResultSchema),
	"memory/notes/read": method(MemoryNotesReadParamsSchema, MemoryNotesReadResultSchema),
	"memory/notes/write": method(MemoryNotesWriteParamsSchema, MemoryNotesWriteResultSchema),
	"memory/history/list": method(MemoryHistoryListParamsSchema, MemoryHistoryListResultSchema),
	"memory/history/read": method(MemoryHistoryReadParamsSchema, MemoryHistoryReadResultSchema),
	"memory/undo": method(MemoryUndoParamsSchema, MemoryUndoResultSchema),
	"memory/undoRun": method(MemoryUndoRunParamsSchema, MemoryUndoRunResultSchema),
	"memory/dream/run": method(MemoryDreamRunParamsSchema, MemoryDreamRunResultSchema),
	"hooks/list": method(HooksListParamsSchema, HooksListViewSchema),
	"hooks/upsert": method(HooksUpsertParamsSchema, HooksListViewSchema),
	"hooks/delete": method(HooksDeleteParamsSchema, HooksListViewSchema),
	"agent/list": method(AgentListParamsSchema, AgentListResultSchema),
	"agent/readItems": method(AgentReadItemsParamsSchema, SessionReadItemsResultSchema),
	"agent/send": method(AgentSendParamsSchema, AgentSendResultSchema),
	"agent/control": method(AgentControlParamsSchema, AgentControlResultSchema),
	"agent/interrupt": method(AgentInterruptParamsSchema, AgentResultSchema),
	"agent/archive": method(AgentArchiveParamsSchema, AgentResultSchema),
	"agent/delete": method(AgentDeleteParamsSchema, AgentDeleteResultSchema),
	"agentType/list": method(AgentTypeListParamsSchema, AgentTypeListResultSchema),
	"agentType/upsert": method(AgentTypeUpsertParamsSchema, AgentTypeUpsertResultSchema),
	"agentType/remove": method(AgentTypeRemoveParamsSchema, AgentTypeRemoveResultSchema),
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
	"plugin/market/list": method(PluginMarketListParamsSchema, PluginMarketListResultSchema),
	"plugin/market/add": method(PluginMarketAddParamsSchema, PluginMarketListResultSchema),
	"plugin/market/select": method(PluginMarketSelectParamsSchema, PluginMarketListResultSchema),
	"plugin/market/remove": method(PluginMarketRemoveParamsSchema, PluginMarketListResultSchema),
	"plugin/market/refresh": method(PluginMarketRefreshParamsSchema, PluginMarketRefreshResultSchema),
	"plugin/catalog": method(PluginCatalogParamsSchema, PluginCatalogResultSchema),
	"plugin/inspect": method(PluginInspectParamsSchema, PluginInspectionViewSchema),
	"plugin/install": method(PluginInstallParamsSchema, PluginInstallResultSchema),
	"plugin/list": method(PluginListParamsSchema, PluginListResultSchema),
	"plugin/get": method(PluginGetParamsSchema, PluginInstalledViewSchema),
	"plugin/setEnabled": method(PluginSetEnabledParamsSchema, PluginInstallResultSchema),
	"plugin/remove": method(PluginRemoveParamsSchema, PluginRemoveResultSchema),
	"plugin/update/inspect": method(PluginUpdateInspectParamsSchema, PluginUpdateInspectionViewSchema),
	"plugin/update": method(PluginUpdateParamsSchema, PluginInstallResultSchema),
	"connection/ack": method(ConnectionAckParamsSchema, ConnectionAckResultSchema),
	"model/discover": method(ModelDiscoverParamsSchema, ModelDiscoverResultSchema),
} as const;

export const HostRequestMethods = {
	"server/shutdown": method(ServerShutdownParamsSchema, ServerShutdownResultSchema),
} as const;

export const ServerRequestMethods = {
	"interaction/request": method(InteractionRequestParamsSchema, InteractionResultSchema),
	"browser/tool": method(BrowserToolRequestParamsSchema, BrowserToolRequestResultSchema),
} as const;

export const ServerNotificationMethods = {
	"connection/events": ConnectionEventsParamsSchema,
	"browser/tool/cancelled": BrowserToolCancelledParamsSchema,
	"interaction/cancelled": InteractionCancelledParamsSchema,
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
export type BrowserTabsInput = Static<typeof BrowserTabsInputSchema>;
export type BrowserNavigateInput = Static<typeof BrowserNavigateInputSchema>;
export type BrowserObserveInput = Static<typeof BrowserObserveInputSchema>;
export type BrowserRisk = Static<typeof BrowserRiskSchema>;
export type BrowserAction = Static<typeof BrowserActionSchema>;
export type BrowserActInput = Static<typeof BrowserActInputSchema>;
export type BrowserHandoffInput = Static<typeof BrowserHandoffInputSchema>;
export type BrowserObservation = Static<typeof BrowserObservationSchema>;
export type BrowserTabsDetails = Static<typeof BrowserTabsDetailsSchema>;
export type BrowserOperationDetails = Static<typeof BrowserOperationDetailsSchema>;
export type BrowserHandoffDetails = Static<typeof BrowserHandoffDetailsSchema>;
export type BrowserToolCall = Static<typeof BrowserToolCallSchema>;
export type BrowserToolResult = Static<typeof BrowserToolResultSchema>;
export type BrowserToolRequestParams = Static<typeof BrowserToolRequestParamsSchema>;
export type BrowserToolRequestResult = Static<typeof BrowserToolRequestResultSchema>;
export type BrowserToolCancelledParams = Static<typeof BrowserToolCancelledParamsSchema>;
