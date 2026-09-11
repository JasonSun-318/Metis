import { type Static, Type } from "typebox";
import {
	CursorSchema,
	DeltaTextSchema,
	MAX_ASK_USER_OPTIONS,
	MAX_ASK_USER_QUESTIONS,
	MAX_HISTORY_ITEMS,
	MAX_INTERACTION_CHOICES,
	MAX_PERMISSION_OPERATION_ROWS,
	MAX_PUBLIC_TEXT_UTF8_BYTES,
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
export const PermissionPresetSchema = Type.Union([Type.Literal("ask"), Type.Literal("auto"), Type.Literal("full")]);
export const SandboxPolicySchema = Type.Union([
	Type.Literal("read-only"),
	Type.Literal("workspace-write"),
	Type.Literal("danger-full-access"),
	Type.Literal("external-sandbox"),
]);
export const ApprovalPolicySchema = Type.Union([
	Type.Literal("never"),
	Type.Literal("user"),
	Type.Literal("auto-review"),
	Type.Literal("deny"),
]);
export const PermissionSettingsViewSchema = StrictObject({
	sandboxPolicy: SandboxPolicySchema,
	approvalPolicy: ApprovalPolicySchema,
});
export const PermissionRiskLevelSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);
export const SandboxHealthSchema = Type.Union([
	Type.Literal("healthy"),
	Type.Literal("unavailable"),
	Type.Literal("misconfigured"),
]);
export const PermissionReviewerSchema = Type.Union([Type.Literal("model"), Type.Literal("user")]);
export const PermissionActiveReviewViewSchema = StrictObject({
	actionId: OpaqueIdSchema,
	reviewer: PermissionReviewerSchema,
	riskLevel: PermissionRiskLevelSchema,
});
export const CwdOriginSchema = Type.Union([Type.Literal("managed"), Type.Literal("user-selected")]);
export const ActualThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
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
	mode: AgentModeSchema,
	cwdOrigin: CwdOriginSchema,
	// Legacy journals may not contain a working directory. App-server projects
	// their empty-string sentinel to null instead of exposing it on the wire.
	cwd: Type.Union([PathSchema, Type.Null()]),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	state: SessionStateSchema,
	lastTurnOutcome: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("failed")])),
	attentionRequired: Type.Optional(Type.Boolean()),
	archived: Type.Boolean(),
	unread: Type.Boolean(),
	recoveryNotice: Type.Optional(PublicTextSchema),
	scheduled: Type.Optional(StrictObject({ taskId: SessionIdSchema, runId: SessionIdSchema })),
});

export const SkillSourceViewSchema = Type.Union([
	Type.Literal("system"),
	Type.Literal("user"),
	Type.Literal("project"),
	Type.Literal("plugin"),
]);
export const WritableSkillSourceViewSchema = Type.Union([Type.Literal("user"), Type.Literal("project")]);
export const PluginOwnerSchema = StrictObject({
	pluginId: Sha256Schema,
	displayName: PublicTextSchema,
	componentId: NameSchema,
});
export const SkillNameSchema = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});
export const SkillContentSchema = Utf8String(256 * 1024, { minLength: 1, maxLength: 256 * 1024 });

export const SkillSummaryViewSchema = StrictObject({
	name: NameSchema,
	description: PublicTextSchema,
	source: Type.Optional(SkillSourceViewSchema),
	pluginOwner: Type.Optional(PluginOwnerSchema),
	originalName: Type.Optional(PublicTextSchema),
});

export const SkillDetailViewSchema = Type.Refine(
	StrictObject({
		name: SkillNameSchema,
		description: Utf8String(1024, { minLength: 1, maxLength: 1024 }),
		source: SkillSourceViewSchema,
		revision: Sha256Schema,
		directoryPath: PathSchema,
		entryFile: Utf8String(1024, { minLength: 1, maxLength: 1024 }),
		files: Type.Array(Utf8String(4096, { minLength: 1, maxLength: 4096 }), {
			maxItems: 256,
			uniqueItems: true,
		}),
		content: SkillContentSchema,
		instructions: SkillContentSchema,
		updatedAt: TimestampSchema,
		editable: Type.Boolean(),
		pluginOwner: Type.Optional(PluginOwnerSchema),
		originalName: Type.Optional(PublicTextSchema),
	}),
	(value) => value.editable === (value.source !== "system" && value.source !== "plugin"),
	"Skill editability must match its source",
);

export const SkillImportInputViewSchema = Type.Union([
	StrictObject({ kind: Type.Literal("archive"), path: PathSchema }),
	StrictObject({
		kind: Type.Literal("github"),
		url: Type.String({
			minLength: 1,
			maxLength: 4096,
			pattern: "^https://github\\.com/[^/]+/[^/]+(?:/.*)?$",
		}),
	}),
]);

export const SkillImportCandidateViewSchema = StrictObject({
	id: Utf8String(4096, { minLength: 1, maxLength: 4096 }),
	name: SkillNameSchema,
	description: Utf8String(1024, { minLength: 1, maxLength: 1024 }),
	fileCount: Type.Integer({ minimum: 1, maximum: 2048 }),
});

export const WritableMcpScopeViewSchema = Type.Union([Type.Literal("user"), Type.Literal("project")]);
export const McpScopeViewSchema = Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("plugin")]);
export const McpTransportViewSchema = Type.Union([Type.Literal("stdio"), Type.Literal("http")]);
export const McpStateViewSchema = Type.Union([
	Type.Literal("inactive"),
	Type.Literal("disabled"),
	Type.Literal("connecting"),
	Type.Literal("connected"),
	Type.Literal("auth_required"),
	Type.Literal("reconnecting"),
	Type.Literal("error"),
	Type.Literal("closed"),
	Type.Literal("shadowed"),
]);

export const McpHttpUrlSchema = Type.Refine(
	Type.String({ minLength: 1, maxLength: 8192 }),
	(value) => {
		try {
			const url = new URL(value);
			return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
		} catch {
			return false;
		}
	},
	"MCP URL must use HTTP(S) and must not contain credentials",
);

export const McpEnvironmentNameSchema = Type.String({
	minLength: 1,
	maxLength: 256,
	pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
});

export const McpEnvironmentMapSchema = Type.Refine(
	Type.Record(Type.String({ minLength: 1, maxLength: 256 }), McpEnvironmentNameSchema),
	(value) => Object.keys(value).length <= 128,
	"MCP environment mapping has too many entries",
);

export const McpImportCandidateViewSchema = StrictObject({
	id: NameSchema,
	name: NameSchema,
	transport: McpTransportViewSchema,
	enabled: Type.Boolean(),
	existingRevision: Type.Union([Sha256Schema, Type.Null()]),
	bearerTokenConfigured: Type.Boolean(),
	credentialNames: Type.Array(McpEnvironmentNameSchema, { maxItems: 128, uniqueItems: true }),
});

export const McpImportInspectionViewSchema = StrictObject({
	sourceRevision: Sha256Schema,
	candidates: Type.Array(McpImportCandidateViewSchema, { minItems: 1, maxItems: 128 }),
});

const McpServerViewFields = {
	name: NameSchema,
	pluginOwner: Type.Optional(PluginOwnerSchema),
	originalName: Type.Optional(PublicTextSchema),
	description: Type.Optional(Utf8String(4096, { minLength: 1, maxLength: 4096 })),
	scope: McpScopeViewSchema,
	effective: Type.Boolean(),
	revision: Sha256Schema,
	transport: McpTransportViewSchema,
	enabled: Type.Boolean(),
	required: Type.Boolean(),
	command: Type.Optional(PublicTextSchema),
	args: Type.Optional(Type.Array(PublicTextSchema, { maxItems: 128 })),
	envVars: Type.Optional(Type.Array(McpEnvironmentNameSchema, { maxItems: 128, uniqueItems: true })),
	inlineEnvKeys: Type.Optional(Type.Array(NameSchema, { maxItems: 128, uniqueItems: true })),
	cwd: Type.Optional(PathSchema),
	url: Type.Optional(McpHttpUrlSchema),
	bearerTokenEnvVar: Type.Optional(McpEnvironmentNameSchema),
	envHttpHeaders: Type.Optional(McpEnvironmentMapSchema),
	startupTimeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3_600 })),
	toolTimeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 86_400 })),
	enabledTools: Type.Optional(Type.Array(NameSchema, { maxItems: 512, uniqueItems: true })),
	disabledTools: Type.Array(NameSchema, { maxItems: 512, uniqueItems: true }),
	state: McpStateViewSchema,
	credentialConfigured: Type.Boolean(),
	toolCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
	resourceCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
	resourceTemplateCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
	promptCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
	capabilities: Type.Array(NameSchema, { maxItems: 128, uniqueItems: true }),
	serverInfo: Type.Optional(StrictObject({ name: NameSchema, version: PublicTextSchema })),
	lastError: Type.Optional(PublicTextSchema),
} as const;

type McpTransportFields = Record<string, unknown> & {
	transport: Static<typeof McpTransportViewSchema>;
	state: Static<typeof McpStateViewSchema>;
	effective: boolean;
};

function hasConsistentMcpTransport(value: McpTransportFields): boolean {
	const stdioFields = ["command", "args", "envVars", "inlineEnvKeys", "cwd"];
	const httpFields = ["url", "bearerTokenEnvVar", "envHttpHeaders"];
	return value.transport === "stdio"
		? httpFields.every((field) => value[field] === undefined)
		: stdioFields.every((field) => value[field] === undefined);
}

export const McpServerSummaryViewSchema = Type.Refine(
	StrictObject(McpServerViewFields),
	(value) => {
		const server = value as McpTransportFields;
		return hasConsistentMcpTransport(server) && (server.state === "shadowed") === !server.effective;
	},
	"MCP server summary is inconsistent",
);
export const McpCatalogEntryViewSchema = StrictObject({
	id: PublicTextSchema,
	name: PublicTextSchema,
	description: Type.Optional(PublicTextSchema),
});
export const McpCatalogItemKindViewSchema = Type.Union([
	Type.Literal("tool"),
	Type.Literal("prompt"),
	Type.Literal("resource"),
	Type.Literal("resourceTemplate"),
]);
const McpCatalogItemCommonFields = {
	id: PublicTextSchema,
	name: PublicTextSchema,
	description: Type.Optional(PublicTextSchema),
} as const;
export const McpCatalogItemDetailViewSchema = Type.Union([
	StrictObject({
		...McpCatalogItemCommonFields,
		kind: Type.Literal("tool"),
		inputSchema: Utf8String(256 * 1024, { minLength: 1, maxLength: 256 * 1024 }),
		outputSchema: Type.Optional(Utf8String(256 * 1024, { minLength: 1, maxLength: 256 * 1024 })),
		annotations: Type.Optional(Utf8String(256 * 1024, { minLength: 1, maxLength: 256 * 1024 })),
	}),
	StrictObject({
		...McpCatalogItemCommonFields,
		kind: Type.Literal("prompt"),
		arguments: Type.Array(
			StrictObject({
				name: NameSchema,
				description: Type.Optional(PublicTextSchema),
				required: Type.Boolean(),
			}),
			{ maxItems: 256 },
		),
	}),
	StrictObject({
		...McpCatalogItemCommonFields,
		kind: Type.Literal("resource"),
		uri: PublicTextSchema,
		mimeType: Type.Optional(NameSchema),
		size: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	}),
	StrictObject({
		...McpCatalogItemCommonFields,
		kind: Type.Literal("resourceTemplate"),
		uriTemplate: PublicTextSchema,
		mimeType: Type.Optional(NameSchema),
	}),
]);
export const McpServerDetailViewSchema = Type.Refine(
	StrictObject({
		server: McpServerSummaryViewSchema,
		tools: Type.Array(McpCatalogEntryViewSchema, { maxItems: 10_000 }),
		resources: Type.Array(McpCatalogEntryViewSchema, { maxItems: 10_000 }),
		resourceTemplates: Type.Array(McpCatalogEntryViewSchema, { maxItems: 10_000 }),
		prompts: Type.Array(McpCatalogEntryViewSchema, { maxItems: 10_000 }),
	}),
	(value) => {
		const detail = value as {
			server: { toolCount: number; resourceCount: number; resourceTemplateCount: number; promptCount: number };
			tools: unknown[];
			resources: unknown[];
			resourceTemplates: unknown[];
			prompts: unknown[];
		};
		return (
			detail.server.toolCount === detail.tools.length &&
			detail.server.resourceCount === detail.resources.length &&
			detail.server.resourceTemplateCount === detail.resourceTemplates.length &&
			detail.server.promptCount === detail.prompts.length
		);
	},
	"MCP server detail is inconsistent",
);

function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const ProfileActivityDayViewSchema = StrictObject({
	date: Type.Refine(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), isCalendarDate, "invalid calendar date"),
	tokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

export const ProfileSkillUsageViewSchema = StrictObject({
	name: NameSchema,
	count: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});

export const ProfileUsageSummaryViewSchema = Type.Refine(
	StrictObject({
		generatedAt: TimestampSchema,
		totalTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		peakDailyTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		longestSessionMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		currentStreakDays: Type.Integer({ minimum: 0, maximum: 366_000 }),
		longestStreakDays: Type.Integer({ minimum: 0, maximum: 366_000 }),
		sessionCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		mostUsedMode: Type.Union([AgentModeSchema, Type.Null()]),
		mostUsedModePercent: Type.Integer({ minimum: 0, maximum: 100 }),
		mostUsedThinkingLevel: Type.Union([ActualThinkingLevelSchema, Type.Null()]),
		mostUsedThinkingLevelPercent: Type.Integer({ minimum: 0, maximum: 100 }),
		usedSkillCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		skillUseCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		activity: Type.Array(ProfileActivityDayViewSchema, { maxItems: 371 }),
		topSkills: Type.Array(ProfileSkillUsageViewSchema, { maxItems: 5 }),
	}),
	(value) => {
		const activitySorted = value.activity.every(
			(day, index) => index === 0 || value.activity[index - 1]!.date < day.date,
		);
		const skillsUnique = new Set(value.topSkills.map((skill) => skill.name)).size === value.topSkills.length;
		const skillsSorted = value.topSkills.every((skill, index) => {
			if (index === 0) return true;
			const previous = value.topSkills[index - 1]!;
			return previous.count > skill.count || (previous.count === skill.count && previous.name < skill.name);
		});
		const listedSkillUses = value.topSkills.reduce((total, skill) => total + skill.count, 0);
		return (
			activitySorted &&
			skillsUnique &&
			skillsSorted &&
			value.currentStreakDays <= value.longestStreakDays &&
			value.peakDailyTokens <= value.totalTokens &&
			(value.mostUsedMode === null) === (value.mostUsedModePercent === 0) &&
			(value.mostUsedThinkingLevel === null) === (value.mostUsedThinkingLevelPercent === 0) &&
			value.usedSkillCount >= value.topSkills.length &&
			value.skillUseCount >= listedSkillUses
		);
	},
	"profile summary fields are inconsistent",
);

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

export const SessionDeliveredFileViewSchema = StrictObject({
	fileId: Type.String({ minLength: 16, maxLength: 16, pattern: "^[a-f0-9]{16}$" }),
	name: Type.String({ minLength: 1, maxLength: 255 }),
	byteLength: Type.Integer({ minimum: 1, maximum: 128 * 1024 * 1024 }),
	message: Type.Optional(Utf8String(512, { minLength: 1, maxLength: 512 })),
	deliveredAt: TimestampSchema,
	availability: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
});

export const ToolResultBlockViewSchema = StrictObject({
	type: Type.Literal("tool_result"),
	toolCallId: OpaqueIdSchema,
	name: NameSchema,
	isError: Type.Boolean(),
	output: PublicTextSchema,
	images: Type.Optional(Type.Array(DurableImageRefViewSchema, { maxItems: 4 })),
	deliveredFile: Type.Optional(SessionDeliveredFileViewSchema),
});

export const NoticeBlockViewSchema = StrictObject({
	type: Type.Literal("notice"),
	level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
	text: PublicTextSchema,
});

export const CompactionBlockViewSchema = StrictObject({
	type: Type.Literal("compaction"),
});

export const CollaborationModeSchema = Type.Union([Type.Literal("default"), Type.Literal("plan")]);
export const PlanStatusSchema = Type.Union([
	Type.Literal("proposed"),
	Type.Literal("superseded"),
	Type.Literal("accepted"),
	Type.Literal("cancelled"),
]);
export const PlanViewSchema = StrictObject({
	planId: OpaqueIdSchema,
	revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	title: NameSchema,
	markdown: Utf8String(MAX_PUBLIC_TEXT_UTF8_BYTES, { minLength: 1 }),
	status: PlanStatusSchema,
	createdAt: TimestampSchema,
});
export const PlanBlockViewSchema = StrictObject({ type: Type.Literal("plan"), plan: PlanViewSchema });

export const ItemContentBlockViewSchema = Type.Union([
	TextBlockViewSchema,
	ThinkingBlockViewSchema,
	ImageBlockViewSchema,
	ToolCallBlockViewSchema,
	ToolResultBlockViewSchema,
	NoticeBlockViewSchema,
	CompactionBlockViewSchema,
	PlanBlockViewSchema,
]);

export const ItemUsageViewSchema = StrictObject({
	outputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	inputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});

export const ItemViewSchema = StrictObject({
	itemId: OpaqueIdSchema,
	sessionId: SessionIdSchema,
	turnId: Type.Optional(OpaqueIdSchema),
	role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("system")]),
	state: Type.Union([Type.Literal("streaming"), Type.Literal("completed"), Type.Literal("interrupted")]),
	content: Type.Array(ItemContentBlockViewSchema, { maxItems: 256 }),
	usage: Type.Optional(ItemUsageViewSchema),
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

export const PermissionOperationRowViewSchema = StrictObject({
	label: NameSchema,
	value: PublicTextSchema,
});

export const PermissionExecutionTargetSchema = Type.Union([
	Type.Literal("sandbox"),
	Type.Literal("host"),
	Type.Literal("external"),
]);

export const PermissionOperationViewSchema = StrictObject({
	toolName: NameSchema,
	rows: Type.Array(PermissionOperationRowViewSchema, { maxItems: MAX_PERMISSION_OPERATION_ROWS }),
	omittedRows: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	scopeComplete: Type.Boolean(),
	irreversible: Type.Boolean(),
	executionTarget: PermissionExecutionTargetSchema,
	rememberProjectEligible: Type.Boolean(),
});

export const ProjectPermissionRuleViewSchema = StrictObject({
	id: OpaqueIdSchema,
	decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
	toolName: NameSchema,
	command: Type.Optional(PublicTextSchema),
	paths: Type.Array(PathSchema, { maxItems: MAX_PERMISSION_OPERATION_ROWS }),
	details: Type.Array(PermissionOperationRowViewSchema, { maxItems: MAX_PERMISSION_OPERATION_ROWS }),
	omittedDetails: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	risks: Type.Array(NameSchema, { maxItems: 16 }),
	executionTarget: PermissionExecutionTargetSchema,
	createdAt: TimestampSchema,
});

export const PermissionApprovalChoiceSchema = Type.Union([
	Type.Literal("allow-once"),
	Type.Literal("deny-once"),
	Type.Literal("always-allow-exact"),
	Type.Literal("always-deny-exact"),
]);

export const PermissionApprovalInteractionViewSchema = StrictObject({
	...InteractionBase,
	kind: Type.Literal("session_permission_approval"),
	requestId: UuidSchema,
	actionId: OpaqueIdSchema,
	toolLabel: NameSchema,
	riskLevel: PermissionRiskLevelSchema,
	executionTarget: PermissionExecutionTargetSchema,
	reason: PublicTextSchema,
	scopeComplete: Type.Boolean(),
	details: Type.Array(PermissionOperationRowViewSchema, { maxItems: MAX_PERMISSION_OPERATION_ROWS }),
	priorReviewer: Type.Optional(Type.Literal("model")),
	priorReviewerOutcome: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("unavailable")])),
	choices: Type.Array(PermissionApprovalChoiceSchema, { minItems: 1, maxItems: 4, uniqueItems: true }),
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

export const AskUserQuestionViewSchema = Type.Refine(
	StrictObject({
		id: OpaqueIdSchema,
		question: PublicTextSchema,
		multiple: Type.Boolean(),
		choices: Type.Array(InteractionChoiceSchema, { minItems: 2, maxItems: MAX_ASK_USER_OPTIONS }),
	}),
	(value) => new Set(value.choices.map((choice) => choice.id)).size === value.choices.length,
	"ask_user choice ids must be unique within each question",
);

export const AskUserInteractionViewSchema = Type.Refine(
	StrictObject({
		...InteractionBase,
		kind: Type.Literal("ask_user"),
		questions: Type.Array(AskUserQuestionViewSchema, { minItems: 1, maxItems: MAX_ASK_USER_QUESTIONS }),
	}),
	(value) => new Set(value.questions.map((question) => question.id)).size === value.questions.length,
	"ask_user question ids must be unique",
);

export const InteractionViewSchema = Type.Union([
	TrustInteractionViewSchema,
	PermissionApprovalInteractionViewSchema,
	SelectInteractionViewSchema,
	ConfirmInteractionViewSchema,
	InputInteractionViewSchema,
	AskUserInteractionViewSchema,
]);

export const ThinkingSelectionSchema = Type.Union([ActualThinkingLevelSchema, Type.Literal("ultra")]);
export const ModelRefSchema = StrictObject({ provider: NameSchema, modelId: NameSchema });
export const ModelOptionViewSchema = StrictObject({
	provider: NameSchema,
	modelId: NameSchema,
	name: NameSchema,
});
export const ModelSettingsModelViewSchema = StrictObject({
	provider: NameSchema,
	modelId: NameSchema,
	name: NameSchema,
	contextWindow: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
	maxOutputTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
	reasoning: Type.Boolean(),
	imageInput: Type.Boolean(),
	custom: Type.Boolean(),
});
export const ModelAuthStatusViewSchema = StrictObject({
	configured: Type.Boolean(),
	source: Type.Optional(Type.Union([Type.Literal("stored"), Type.Literal("environment"), Type.Literal("oauth")])),
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
});
export const ModelSettingsProviderViewSchema = StrictObject({
	provider: NameSchema,
	name: NameSchema,
	builtin: Type.Boolean(),
	baseUrl: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
	api: Type.Union([
		Type.Literal("openai-responses"),
		Type.Literal("openai-completions"),
		Type.Literal("anthropic-messages"),
		Type.Null(),
	]),
	auth: ModelAuthStatusViewSchema,
	models: Type.Array(ModelSettingsModelViewSchema, { maxItems: 512 }),
});
export const VisionApiViewSchema = Type.Union([
	Type.Literal("openai-responses"),
	Type.Literal("openai-completions"),
	Type.Literal("anthropic-messages"),
]);
/** User-configured vision-describer service; the API key is never returned. */
export const VisionSettingsViewSchema = StrictObject({
	name: Type.String({ minLength: 1, maxLength: 120 }),
	baseUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
	api: VisionApiViewSchema,
	modelId: Type.String({ minLength: 1, maxLength: 300 }),
	authConfigured: Type.Boolean(),
});
export const EmbeddingSettingsViewSchema = StrictObject({
	name: Type.String({ minLength: 1, maxLength: 120 }),
	provider: Type.String({ minLength: 1, maxLength: 120 }),
	baseUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
	api: Type.Literal("openai-compatible"),
	modelId: Type.String({ minLength: 1, maxLength: 200 }),
	dimensions: Type.Optional(Type.Integer({ minimum: 1, maximum: 8_192 })),
	authConfigured: Type.Boolean(),
});
export const RerankSettingsViewSchema = StrictObject({
	name: Type.String({ minLength: 1, maxLength: 120 }),
	provider: Type.String({ minLength: 1, maxLength: 120 }),
	endpointUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
	modelId: Type.String({ minLength: 1, maxLength: 200 }),
	authConfigured: Type.Boolean(),
});
export const ModelSettingsViewSchema = StrictObject({
	defaultModel: Type.Union([ModelRefSchema, Type.Null()]),
	/** Vision-describer service for image-less models; null when unset. */
	vision: Type.Union([VisionSettingsViewSchema, Type.Null()]),
	embedding: Type.Union([EmbeddingSettingsViewSchema, Type.Null()]),
	rerank: Type.Union([RerankSettingsViewSchema, Type.Null()]),
	defaultThinkingSelection: ThinkingSelectionSchema,
	providers: Type.Array(ModelSettingsProviderViewSchema, { maxItems: 128 }),
	loadError: Type.Union([PublicTextSchema, Type.Null()]),
});

export const WebSearchProviderSchema = Type.Union([
	Type.Literal("brave"),
	Type.Literal("tavily"),
	Type.Literal("serpapi"),
]);
export const WebSearchSettingsViewSchema = StrictObject({
	enabled: Type.Boolean(),
	provider: WebSearchProviderSchema,
	authConfigured: Type.Boolean(),
	configuredProviders: Type.Optional(Type.Array(WebSearchProviderSchema, { maxItems: 3, uniqueItems: true })),
	authSource: Type.Optional(Type.Union([Type.Literal("stored"), Type.Literal("environment")])),
});

export const MemoryEngineSchema = Type.Union([Type.Literal("index"), Type.Literal("extract")]);
export const MemorySettingsViewSchema = StrictObject({
	autoMemoryEnabled: Type.Boolean(),
	memoryEngine: MemoryEngineSchema,
	embeddingConfigured: Type.Boolean(),
	rerankConfigured: Type.Boolean(),
	lastError: Type.Union([PublicTextSchema, Type.Null()]),
	memoryMigrationNotice: Type.Union([PublicTextSchema, Type.Null()]),
});

export const HookEventNameSchema = Type.Union([
	Type.Literal("SessionStart"),
	Type.Literal("UserPromptSubmit"),
	Type.Literal("PreToolUse"),
	Type.Literal("PostToolUse"),
	Type.Literal("PostToolUseFailure"),
	Type.Literal("Stop"),
]);
export const HookRunModeSchema = Type.Union([Type.Literal("process"), Type.Literal("shell")]);
export const HookProtocolSchema = Type.Union([Type.Literal("legacy"), Type.Literal("command-v1")]);
export const DeclarativeHookViewSchema = StrictObject({
	id: Type.String({ minLength: 1, maxLength: 128 }),
	name: Type.String({ minLength: 1, maxLength: 200 }),
	enabled: Type.Boolean(),
	event: HookEventNameSchema,
	matcher: Type.Optional(Type.String({ minLength: 0, maxLength: 200 })),
	runMode: HookRunModeSchema,
	protocol: Type.Optional(HookProtocolSchema),
	command: Type.String({ minLength: 1, maxLength: 4096 }),
	args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 64 })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
	statusMessage: Type.Optional(Type.String({ maxLength: 500 })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	pluginOwner: Type.Optional(PluginOwnerSchema),
});
export const HooksListViewSchema = StrictObject({
	hooks: Type.Array(DeclarativeHookViewSchema, { maxItems: 100 }),
	loadErrors: Type.Array(PublicTextSchema, { maxItems: 100 }),
});

export const UsageRangeDaysSchema = Type.Union([Type.Literal(7), Type.Literal(30), Type.Literal(90)]);
export const UsageDailyViewSchema = StrictObject({
	date: Type.Refine(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), isCalendarDate, "invalid calendar date"),
	chatTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	codeTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	inputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	outputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	cacheReadTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	cacheWriteTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const UsageModelViewSchema = StrictObject({
	provider: NameSchema,
	modelId: NameSchema,
	totalTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const UsageSummaryViewSchema = Type.Refine(
	StrictObject({
		generatedAt: TimestampSchema,
		rangeDays: UsageRangeDaysSchema,
		totalTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		inputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		outputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		cacheReadTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		cacheWriteTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		chatTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		codeTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		sessionCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		chatSessionCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		codeSessionCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		daily: Type.Array(UsageDailyViewSchema, { minItems: 7, maxItems: 90 }),
		topModels: Type.Array(UsageModelViewSchema, { maxItems: 8 }),
	}),
	(value) =>
		value.daily.length === value.rangeDays &&
		value.sessionCount === value.chatSessionCount + value.codeSessionCount &&
		value.totalTokens === value.chatTokens + value.codeTokens,
	"usage summary fields are inconsistent",
);
export const AgentTypeIdSchema = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-z][a-z0-9-]{0,63}$",
});
export const AgentTypeViewSchema = AgentTypeIdSchema;
export const CustomAgentTypeViewSchema = StrictObject({
	id: AgentTypeIdSchema,
	displayName: NameSchema,
	description: Type.String({ maxLength: 512 }),
	allowedTools: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
	systemPrompt: Type.String({ maxLength: 8192 }),
	writePolicy: Type.Union([Type.Literal("inherit"), Type.Literal("deny")]),
	mayDelegate: Type.Boolean(),
	builtIn: Type.Boolean(),
});
export const AgentStatusViewSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
]);
export const AgentUsageViewSchema = StrictObject({
	model: ModelRefSchema,
	input: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	output: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	cacheRead: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	cacheWrite: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	elapsedMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	toolCalls: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	cost: Type.Optional(Type.Number({ minimum: 0 })),
});
export const AgentTaskSummaryViewSchema = StrictObject({
	taskId: SessionIdSchema,
	status: AgentStatusViewSchema,
	taskSummary: PublicTextSchema,
	finalMessage: Type.Optional(PublicTextSchema),
	error: Type.Optional(PublicTextSchema),
	usage: Type.Optional(AgentUsageViewSchema),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
});
export const AgentSummaryViewSchema = StrictObject({
	agentId: SessionIdSchema,
	name: NameSchema,
	agentType: AgentTypeViewSchema,
	depth: Type.Integer({ minimum: 1, maximum: 2 }),
	status: AgentStatusViewSchema,
	archived: Type.Boolean(),
	parentSessionId: SessionIdSchema,
	rootSessionId: SessionIdSchema,
	agentPath: Type.Array(SessionIdSchema, { minItems: 1, maxItems: 2 }),
	tasks: Type.Array(AgentTaskSummaryViewSchema, { maxItems: 256 }),
	currentTask: Type.Optional(AgentTaskSummaryViewSchema),
	latestTask: Type.Optional(AgentTaskSummaryViewSchema),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
});

export const SessionTaskViewSchema = StrictObject({
	task: Type.String({ minLength: 1, maxLength: 512 }),
	completed: Type.Boolean(),
});

export const SessionTasksSchema = Type.Array(SessionTaskViewSchema, { maxItems: 256 });

export const SessionDeliveredFilesSchema = Type.Array(SessionDeliveredFileViewSchema, { maxItems: 32 });

export const SessionGoalStatusSchema = Type.Union([
	Type.Literal("active"),
	Type.Literal("paused"),
	Type.Literal("blocked"),
	Type.Literal("usage_limited"),
	Type.Literal("complete"),
]);

export const SessionGoalViewSchema = StrictObject({
	goalId: UuidSchema,
	objective: Utf8String(4000, { minLength: 1, maxLength: 4000 }),
	status: SessionGoalStatusSchema,
	timeUsedSeconds: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	activeStartedAt: Type.Union([TimestampSchema, Type.Null()]),
});

export const QueuedTurnAttachmentViewSchema = StrictObject({
	name: Type.String({ minLength: 1, maxLength: 255 }),
	byteLength: Type.Integer({ minimum: 1, maximum: 128 * 1024 * 1024 }),
});

export const QueuedTurnViewSchema = StrictObject({
	queueItemId: OpaqueIdSchema,
	revision: OpaqueIdSchema,
	state: Type.Union([Type.Literal("queued"), Type.Literal("paused"), Type.Literal("sending")]),
	text: PromptTextSchema,
	attachments: Type.Array(QueuedTurnAttachmentViewSchema, { maxItems: 16 }),
});

export const QueuedTurnsSchema = Type.Array(QueuedTurnViewSchema, { maxItems: 32 });

export const ContextUsageBasisViewSchema = Type.Union([
	Type.Literal("reported_total"),
	Type.Literal("estimated_total"),
	Type.Literal("unavailable"),
]);

export const ContextUsageCategoryViewSchema = Type.Union([
	Type.Literal("system_prompt"),
	Type.Literal("tool_definitions"),
	Type.Literal("rules"),
	Type.Literal("skills"),
	Type.Literal("mcp_dynamic_tools"),
	Type.Literal("agent_definitions"),
	Type.Literal("summarized_conversation"),
	Type.Literal("conversation"),
]);

export const ContextUsageBreakdownItemViewSchema = StrictObject({
	category: ContextUsageCategoryViewSchema,
	tokens: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});

export const SessionStatusViewSchema = Type.Refine(
	StrictObject({
		sessionId: SessionIdSchema,
		mode: AgentModeSchema,
		contextTokens: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
		contextWindow: Type.Union([Type.Integer({ minimum: 1, maximum: 10_000_000 }), Type.Null()]),
		contextBasis: ContextUsageBasisViewSchema,
		contextBreakdown: Type.Union([Type.Array(ContextUsageBreakdownItemViewSchema, { maxItems: 9 }), Type.Null()]),
		remainingPercent: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
		cacheHitPercent: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
	}),
	(value) => {
		if (value.contextBasis === "unavailable") {
			return value.contextTokens === null && value.contextBreakdown === null;
		}
		if (value.contextTokens === null || value.contextWindow === null) return false;
		if (value.contextBreakdown === null) return true;
		const categories = value.contextBreakdown.map((item) => item.category);
		return (
			new Set(categories).size === categories.length &&
			value.contextBreakdown.reduce((sum, item) => sum + item.tokens, 0) === value.contextTokens
		);
	},
	"Context usage status is inconsistent",
);

export const SessionSnapshotSchema = StrictObject({
	session: SessionSummarySchema,
	collaborationMode: CollaborationModeSchema,
	permissionPreset: PermissionPresetSchema,
	effectiveSettings: PermissionSettingsViewSchema,
	constrainedByParent: Type.Boolean(),
	sandboxHealth: SandboxHealthSchema,
	activeReview: Type.Optional(PermissionActiveReviewViewSchema),
	model: Type.Optional(ModelRefSchema),
	availableModels: Type.Optional(Type.Array(ModelOptionViewSchema, { maxItems: 512 })),
	turns: Type.Array(TurnViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	recentItems: Type.Array(ItemViewSchema, { maxItems: MAX_HISTORY_ITEMS }),
	nextBeforeItemId: Type.Union([OpaqueIdSchema, Type.Null()]),
	activeTurnId: Type.Union([OpaqueIdSchema, Type.Null()]),
	pendingInteractions: Type.Array(InteractionViewSchema, { maxItems: MAX_INTERACTION_CHOICES }),
	queuedTurns: QueuedTurnsSchema,
	tasks: SessionTasksSchema,
	deliveredFiles: SessionDeliveredFilesSchema,
	goal: Type.Union([SessionGoalViewSchema, Type.Null()]),
	thinkingSelection: ThinkingSelectionSchema,
	actualThinkingLevel: ActualThinkingLevelSchema,
	availableThinkingSelections: Type.Array(ThinkingSelectionSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
	agents: Type.Array(AgentSummaryViewSchema, { maxItems: 100 }),
	nextAgentAfterId: Type.Optional(Type.Union([SessionIdSchema, Type.Null()])),
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

export const PermissionPresetChangedEventSchema = StrictObject({
	type: Type.Literal("session/permissionPresetChanged"),
	sessionId: SessionIdSchema,
	permissionPreset: PermissionPresetSchema,
	effectiveSettings: PermissionSettingsViewSchema,
	constrainedByParent: Type.Boolean(),
	sandboxHealth: SandboxHealthSchema,
});

export const PermissionReviewStartedEventSchema = StrictObject({
	type: Type.Literal("session/permissionReviewStarted"),
	sessionId: SessionIdSchema,
	actionId: OpaqueIdSchema,
	reviewer: PermissionReviewerSchema,
	riskLevel: PermissionRiskLevelSchema,
});

export const PermissionReviewCompletedEventSchema = StrictObject({
	type: Type.Literal("session/permissionReviewCompleted"),
	sessionId: SessionIdSchema,
	actionId: OpaqueIdSchema,
	reviewer: PermissionReviewerSchema,
	outcome: Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("unavailable")]),
	riskLevel: PermissionRiskLevelSchema,
});

export const CollaborationModeChangedEventSchema = StrictObject({
	type: Type.Literal("session/collaborationModeChanged"),
	sessionId: SessionIdSchema,
	collaborationMode: CollaborationModeSchema,
});

export const ModelChangedEventSchema = StrictObject({
	type: Type.Literal("session/modelChanged"),
	sessionId: SessionIdSchema,
	model: ModelRefSchema,
	thinkingSelection: ThinkingSelectionSchema,
	actualThinkingLevel: ActualThinkingLevelSchema,
	availableThinkingSelections: Type.Array(ThinkingSelectionSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
});

export const TasksChangedEventSchema = StrictObject({
	type: Type.Literal("session/tasksChanged"),
	sessionId: SessionIdSchema,
	tasks: SessionTasksSchema,
});

export const DeliveredFilesChangedEventSchema = StrictObject({
	type: Type.Literal("session/deliveredFilesChanged"),
	sessionId: SessionIdSchema,
	deliveredFiles: SessionDeliveredFilesSchema,
});

export const GoalChangedEventSchema = StrictObject({
	type: Type.Literal("session/goalChanged"),
	sessionId: SessionIdSchema,
	goal: Type.Union([SessionGoalViewSchema, Type.Null()]),
});

export const TurnQueueChangedEventSchema = StrictObject({
	type: Type.Literal("turn/queueChanged"),
	sessionId: SessionIdSchema,
	queuedTurns: QueuedTurnsSchema,
});

export const AgentUpdatedEventSchema = StrictObject({
	type: Type.Literal("agent/updated"),
	sessionId: SessionIdSchema,
	agent: AgentSummaryViewSchema,
});
export const AgentDeletedEventSchema = StrictObject({
	type: Type.Literal("agent/deleted"),
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	deletedAgentIds: Type.Array(SessionIdSchema, { minItems: 1, maxItems: 256, uniqueItems: true }),
});

const AgentItemStartedEventObjectSchema = StrictObject({
	type: Type.Literal("agent/item/started"),
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	item: ItemViewSchema,
});
export const AgentItemStartedEventSchema = Type.Refine(
	AgentItemStartedEventObjectSchema,
	(value) => value.item.sessionId === value.agentId,
	"child item sessionId must equal agentId",
);

export const AgentItemDeltaEventSchema = StrictObject({
	type: Type.Literal("agent/item/delta"),
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	itemId: OpaqueIdSchema,
	delta: Type.Union([
		StrictObject({ type: Type.Literal("text"), text: DeltaTextSchema }),
		StrictObject({ type: Type.Literal("thinking"), text: DeltaTextSchema }),
	]),
});

const AgentItemCompletedEventObjectSchema = StrictObject({
	type: Type.Literal("agent/item/completed"),
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	item: ItemViewSchema,
});
export const AgentItemCompletedEventSchema = Type.Refine(
	AgentItemCompletedEventObjectSchema,
	(value) => value.item.sessionId === value.agentId,
	"child item sessionId must equal agentId",
);

export const AgentItemsChangedEventSchema = StrictObject({
	type: Type.Literal("agent/itemsChanged"),
	sessionId: SessionIdSchema,
	agentId: SessionIdSchema,
	taskId: SessionIdSchema,
});

export const SessionUpdatedEventSchema = StrictObject({
	type: Type.Literal("session/updated"),
	session: SessionSummarySchema,
});

export const SessionInvalidatedEventSchema = StrictObject({
	type: Type.Literal("session/invalidated"),
	sessionId: SessionIdSchema,
	reason: Type.Union([Type.Literal("deleted"), Type.Literal("reload_required")]),
});

export const ProjectInvalidatedEventSchema = StrictObject({
	type: Type.Literal("project/invalidated"),
	mode: AgentModeSchema,
	cwd: PathSchema,
	reason: Type.Union([Type.Literal("deleted"), Type.Literal("reload_required")]),
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
		StrictObject({
			type: Type.Literal("text"),
			text: DeltaTextSchema,
			outputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		}),
		StrictObject({
			type: Type.Literal("thinking"),
			text: DeltaTextSchema,
			outputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		}),
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
export const ScheduleNameSchema = Type.String({ minLength: 1, maxLength: 120 });
export const ScheduleDescriptionInputSchema = Type.String({ maxLength: 512 });

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
	StrictObject({
		kind: Type.Literal("general"),
		workspace: Type.Literal("task"),
		additionalWorkspaceCwd: Type.Optional(PathSchema),
	}),
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
	name: ScheduleNameSchema,
	description: Type.Optional(PublicTextSchema),
	instruction: Utf8String(MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES, { minLength: 1 }),
	model: ModelRefSchema,
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
	name: ScheduleNameSchema,
	description: Type.Optional(PublicTextSchema),
	instruction: Utf8String(MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES, { minLength: 1 }),
	model: ModelRefSchema,
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
	activeRunId: Type.Optional(SessionIdSchema),
	unreadCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	lastRun: Type.Optional(ScheduleRunSummaryViewSchema),
	pauseReason: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("workspace_missing"), Type.Literal("model_unavailable")]),
	),
});

export const ScheduleSnapshotViewSchema = StrictObject({
	serverEpoch: UuidSchema,
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

export const ScheduleRunUpdatedEventSchema = StrictObject({
	type: Type.Literal("schedule/runUpdated"),
	task: ScheduleTaskViewSchema,
	run: ScheduleRunSummaryViewSchema,
});
export const ScheduleRefreshedEventSchema = StrictObject({ type: Type.Literal("schedule/refreshed") });

export const DomainEventSchema = Type.Union([
	SessionUpdatedEventSchema,
	SessionInvalidatedEventSchema,
	ProjectInvalidatedEventSchema,
	TurnStartedEventSchema,
	TurnCompletedEventSchema,
	TurnInterruptedEventSchema,
	ItemStartedEventSchema,
	ItemDeltaEventSchema,
	ItemCompletedEventSchema,
	InteractionNotifyEventSchema,
	ServerStateEventSchema,
	PermissionPresetChangedEventSchema,
	PermissionReviewStartedEventSchema,
	PermissionReviewCompletedEventSchema,
	CollaborationModeChangedEventSchema,
	ThinkingSelectionChangedEventSchema,
	ModelChangedEventSchema,
	TasksChangedEventSchema,
	DeliveredFilesChangedEventSchema,
	GoalChangedEventSchema,
	TurnQueueChangedEventSchema,
	AgentUpdatedEventSchema,
	AgentDeletedEventSchema,
	AgentItemStartedEventSchema,
	AgentItemDeltaEventSchema,
	AgentItemCompletedEventSchema,
	AgentItemsChangedEventSchema,
	ScheduleUpdatedEventSchema,
	ScheduleDeletedEventSchema,
	ScheduleRunUpdatedEventSchema,
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
export type SkillSourceView = Static<typeof SkillSourceViewSchema>;
export type WritableSkillSourceView = Static<typeof WritableSkillSourceViewSchema>;
export type PluginOwnerView = Static<typeof PluginOwnerSchema>;
export type SkillDetailView = Static<typeof SkillDetailViewSchema>;
export type SkillImportInputView = Static<typeof SkillImportInputViewSchema>;
export type SkillImportCandidateView = Static<typeof SkillImportCandidateViewSchema>;
export type WritableMcpScopeView = Static<typeof WritableMcpScopeViewSchema>;
export type McpScopeView = Static<typeof McpScopeViewSchema>;
export type McpTransportView = Static<typeof McpTransportViewSchema>;
export type McpStateView = Static<typeof McpStateViewSchema>;
export type McpServerSummaryView = Static<typeof McpServerSummaryViewSchema>;
export type McpServerDetailView = Static<typeof McpServerDetailViewSchema>;
export type McpCatalogEntryView = Static<typeof McpCatalogEntryViewSchema>;
export type McpCatalogItemKindView = Static<typeof McpCatalogItemKindViewSchema>;
export type McpCatalogItemDetailView = Static<typeof McpCatalogItemDetailViewSchema>;
export type McpImportCandidateView = Static<typeof McpImportCandidateViewSchema>;
export type McpImportInspectionView = Static<typeof McpImportInspectionViewSchema>;
export type ProfileActivityDayView = Static<typeof ProfileActivityDayViewSchema>;
export type ProfileSkillUsageView = Static<typeof ProfileSkillUsageViewSchema>;
export type ProfileUsageSummaryView = Static<typeof ProfileUsageSummaryViewSchema>;
export type DurableImageRefView = Static<typeof DurableImageRefViewSchema>;
export type CollaborationModeView = Static<typeof CollaborationModeSchema>;
export type PlanStatusView = Static<typeof PlanStatusSchema>;
export type PlanView = Static<typeof PlanViewSchema>;
export type PlanBlockView = Static<typeof PlanBlockViewSchema>;
export type ItemContentBlockView = Static<typeof ItemContentBlockViewSchema>;
export type ItemUsageView = Static<typeof ItemUsageViewSchema>;
export type ItemView = Static<typeof ItemViewSchema>;
export type TurnView = Static<typeof TurnViewSchema>;
export type InteractionChoice = Static<typeof InteractionChoiceSchema>;
export type InteractionView = Static<typeof InteractionViewSchema>;
export type SessionTaskView = Static<typeof SessionTaskViewSchema>;
export type SessionDeliveredFileView = Static<typeof SessionDeliveredFileViewSchema>;
export type SessionGoalStatusView = Static<typeof SessionGoalStatusSchema>;
export type SessionGoalView = Static<typeof SessionGoalViewSchema>;
export type QueuedTurnAttachmentView = Static<typeof QueuedTurnAttachmentViewSchema>;
export type QueuedTurnView = Static<typeof QueuedTurnViewSchema>;
export type ContextUsageBasisView = Static<typeof ContextUsageBasisViewSchema>;
export type ContextUsageCategoryView = Static<typeof ContextUsageCategoryViewSchema>;
export type ContextUsageBreakdownItemView = Static<typeof ContextUsageBreakdownItemViewSchema>;
export type SessionStatusView = Static<typeof SessionStatusViewSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type ThinkingSelectionView = Static<typeof ThinkingSelectionSchema>;
export type PermissionPresetView = Static<typeof PermissionPresetSchema>;
export type PermissionSettingsView = Static<typeof PermissionSettingsViewSchema>;
export type PermissionExecutionTargetView = Static<typeof PermissionExecutionTargetSchema>;
export type ProjectPermissionRuleView = Static<typeof ProjectPermissionRuleViewSchema>;
export type ModelOptionView = Static<typeof ModelOptionViewSchema>;
export type ModelSettingsModelView = Static<typeof ModelSettingsModelViewSchema>;
export type ModelSettingsProviderView = Static<typeof ModelSettingsProviderViewSchema>;
export type ModelSettingsView = Static<typeof ModelSettingsViewSchema>;
export type WebSearchProvider = Static<typeof WebSearchProviderSchema>;
export type WebSearchSettingsView = Static<typeof WebSearchSettingsViewSchema>;
export type MemoryEngine = Static<typeof MemoryEngineSchema>;
export type MemorySettingsView = Static<typeof MemorySettingsViewSchema>;
export type VisionApiView = Static<typeof VisionApiViewSchema>;
export type VisionSettingsView = Static<typeof VisionSettingsViewSchema>;
export type EmbeddingSettingsView = Static<typeof EmbeddingSettingsViewSchema>;
export type RerankSettingsView = Static<typeof RerankSettingsViewSchema>;
export type HookEventNameView = Static<typeof HookEventNameSchema>;
export type HookRunModeView = Static<typeof HookRunModeSchema>;
export type HookProtocolView = Static<typeof HookProtocolSchema>;
export type DeclarativeHookView = Static<typeof DeclarativeHookViewSchema>;
export type HooksListView = Static<typeof HooksListViewSchema>;
export type UsageRangeDays = Static<typeof UsageRangeDaysSchema>;
export type UsageDailyView = Static<typeof UsageDailyViewSchema>;
export type UsageModelView = Static<typeof UsageModelViewSchema>;
export type UsageSummaryView = Static<typeof UsageSummaryViewSchema>;
export type AgentSummaryView = Static<typeof AgentSummaryViewSchema>;
export type AgentTaskSummaryView = Static<typeof AgentTaskSummaryViewSchema>;
export type ScheduleInputSpecView = Static<typeof ScheduleInputSpecSchema>;
export type ScheduleTaskView = Static<typeof ScheduleTaskViewSchema>;
export type ScheduleRunView = Static<typeof ScheduleRunViewSchema>;
export type ScheduleSnapshotView = Static<typeof ScheduleSnapshotViewSchema>;
export type ScheduleTaskSnapshotView = Static<typeof ScheduleTaskSnapshotViewSchema>;
export type DomainEvent = Static<typeof DomainEventSchema>;
export type ConnectionEventsParams = Static<typeof ConnectionEventsParamsSchema>;
export type CustomAgentTypeView = Static<typeof CustomAgentTypeViewSchema>;

// =========================================================================
// Plugins
// =========================================================================

export const PluginFormatSchema = Type.Union([
	Type.Literal("claude"),
	Type.Literal("codex"),
	Type.Literal("agent-skills"),
]);

export const PluginCapabilityKindSchema = Type.Union([
	Type.Literal("skill"),
	Type.Literal("mcp"),
	Type.Literal("hook"),
	Type.Literal("unsupported"),
]);

export const PluginComponentStatusSchema = Type.Union([
	Type.Literal("ready"),
	Type.Literal("needs-configuration"),
	Type.Literal("unsupported"),
	Type.Literal("failed"),
]);

export const PluginActivationStatusSchema = Type.Union([
	Type.Literal("applied"),
	Type.Literal("next-turn"),
	Type.Literal("failed"),
	Type.Literal("not-running"),
]);

export const PluginComponentPublicViewSchema = StrictObject({
	componentId: NameSchema,
	kind: PluginCapabilityKindSchema,
	displayName: PublicTextSchema,
	originalName: PublicTextSchema,
	status: PluginComponentStatusSchema,
	reason: Type.Optional(PublicTextSchema),
});

export const PluginIssueSchema = StrictObject({
	code: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	componentId: NameSchema,
	status: Type.Union([Type.Literal("needs-configuration"), Type.Literal("unsupported"), Type.Literal("warning")]),
	message: PublicTextSchema,
});

export const PluginManifestHintsSchema = StrictObject({
	name: Type.Optional(NameSchema),
	description: Type.Optional(PublicTextSchema),
	strict: Type.Optional(Type.Boolean()),
	skills: Type.Optional(Type.Array(SkillNameSchema, { maxItems: 128 })),
});

export const PluginRecordSchema = StrictObject({
	id: Sha256Schema,
	name: NameSchema,
	displayName: PublicTextSchema,
	format: PluginFormatSchema,
	repository: Utf8String(2048, { minLength: 1 }),
	subdir: Utf8String(1024),
	commit: Type.String({ minLength: 1, maxLength: 128 }),
	version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	trackingRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	pinnedCommit: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	manifestHints: Type.Optional(PluginManifestHintsSchema),
	sourceId: NameSchema,
	enabled: Type.Boolean(),
	installedAt: TimestampSchema,
	issues: Type.Array(PluginIssueSchema),
});

export const PluginRuntimeErrorViewSchema = StrictObject({
	componentId: NameSchema,
	message: PublicTextSchema,
});

export const PluginInstalledViewSchema = StrictObject({
	plugin: PluginRecordSchema,
	components: Type.Array(PluginComponentPublicViewSchema),
	activation: PluginActivationStatusSchema,
	runtimeErrors: Type.Array(PluginRuntimeErrorViewSchema),
});

export const PluginMarketViewSchema = StrictObject({
	id: NameSchema,
	url: Utf8String(2048, { minLength: 1 }),
	displayName: PublicTextSchema,
	selected: Type.Boolean(),
	fetchedAt: Type.Optional(TimestampSchema),
	commit: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	root: Type.Optional(Utf8String(1024)),
	trackingRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	pinnedCommit: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

export const PluginCatalogEntryViewSchema = StrictObject({
	installedPluginId: Type.Optional(Sha256Schema),
	id: NameSchema,
	name: NameSchema,
	description: PublicTextSchema,
	formatHint: PluginFormatSchema,
	sourceSupported: Type.Boolean(),
	installState: Type.Union([
		Type.Literal("installed"),
		Type.Literal("not-installed"),
		Type.Literal("update-available"),
	]),
});

export const PluginInspectionInfoSchema = StrictObject({
	id: Sha256Schema,
	name: NameSchema,
	displayName: PublicTextSchema,
	format: PluginFormatSchema,
	version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	description: PublicTextSchema,
	repository: Utf8String(2048, { minLength: 1 }),
	subdir: Utf8String(1024),
	commit: Type.String({ minLength: 1, maxLength: 128 }),
	trackingRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	sourceId: NameSchema,
});

export const PluginInspectionViewSchema = StrictObject({
	inspectionId: UuidSchema,
	plugin: PluginInspectionInfoSchema,
	components: Type.Array(PluginComponentPublicViewSchema),
	issues: Type.Array(PluginIssueSchema),
	sourceCommit: Type.String({ minLength: 1, maxLength: 128 }),
	registryRevision: Type.Integer({ minimum: 0 }),
});

export const PluginUpdateInspectionViewSchema = StrictObject({
	pluginId: Sha256Schema,
	currentCommit: Type.String({ minLength: 1, maxLength: 128 }),
	upToDate: Type.Boolean(),
	newCommit: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	inspectionId: Type.Optional(UuidSchema),
	inspection: Type.Optional(PluginInspectionViewSchema),
});

export type PluginFormat = Static<typeof PluginFormatSchema>;
export type PluginCapabilityKind = Static<typeof PluginCapabilityKindSchema>;
export type PluginComponentStatus = Static<typeof PluginComponentStatusSchema>;
export type PluginActivationStatus = Static<typeof PluginActivationStatusSchema>;
export type PluginComponentPublicView = Static<typeof PluginComponentPublicViewSchema>;
export type PluginIssue = Static<typeof PluginIssueSchema>;
export type PluginManifestHints = Static<typeof PluginManifestHintsSchema>;
export type PluginRecord = Static<typeof PluginRecordSchema>;
export type PluginInstalledView = Static<typeof PluginInstalledViewSchema>;
export type PluginMarketView = Static<typeof PluginMarketViewSchema>;
export type PluginCatalogEntryView = Static<typeof PluginCatalogEntryViewSchema>;
export type PluginInspectionView = Static<typeof PluginInspectionViewSchema>;
export type PluginUpdateInspectionView = Static<typeof PluginUpdateInspectionViewSchema>;
