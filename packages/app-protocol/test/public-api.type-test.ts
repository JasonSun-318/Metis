import type {
	ClientParams,
	ClientResult,
	ConnectionEventsParams,
	InteractionResponseInput,
	ItemView,
	McpServerDetailView,
	McpServerSummaryView,
	PermissionModeView,
	ProjectPermissionRuleView,
	SessionSnapshot,
	SessionStatusView,
	SessionSummary,
	SkillDetailView,
	SkillSummaryView,
	TurnView,
} from "@metis/app-protocol";

const projectDelete = {
	requestId: "00000000-0000-4000-8000-000000000001",
	mode: "chat",
	cwd: "/tmp/project",
	expectedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} satisfies ClientParams<"project/delete">;
const projectDeletePreview = {
	mode: "chat",
	cwd: "/tmp/project",
	sessionCount: 1,
	blockingScheduleCount: 0,
	revision: projectDelete.expectedRevision,
} satisfies ClientResult<"project/deletePreview">;
const projectDeleteResult = {
	mode: "chat",
	cwd: "/tmp/project",
	deletedSessionCount: 1,
} satisfies ClientResult<"project/delete">;

const sessionRename = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	requestId: "00000000-0000-4000-8000-000000000002",
	name: "Renamed session",
} satisfies ClientParams<"session/rename">;
const sessionDelete = {
	sessionId: sessionRename.sessionId,
	requestId: "00000000-0000-4000-8000-000000000003",
} satisfies ClientParams<"session/delete">;

const sessionStatusParams = {
	sessionId: sessionRename.sessionId,
} satisfies ClientParams<"session/status">;
const sessionStatusResult = {
	sessionId: sessionStatusParams.sessionId,
	mode: "code",
	contextTokens: 64_000,
	contextWindow: 128_000,
	contextBasis: "reported_total",
	contextBreakdown: [
		{ category: "system_prompt", tokens: 4_000 },
		{ category: "conversation", tokens: 60_000 },
	],
	remainingPercent: 50,
	cacheHitPercent: 25,
} satisfies ClientResult<"session/status">;
const sessionStatusView: SessionStatusView = sessionStatusResult;
const sessionCompact = {
	sessionId: sessionRename.sessionId,
	requestId: "00000000-0000-4000-8000-000000000005",
} satisfies ClientParams<"session/compact">;
const sessionCompactResult = {
	sessionId: sessionCompact.sessionId,
	tokensBefore: 64_000,
	estimatedTokensAfter: 8_000,
} satisfies ClientResult<"session/compact">;
const compactedItem = {
	itemId: "item-compacted",
	sessionId: sessionRename.sessionId,
	role: "system",
	state: "completed",
	content: [{ type: "compaction" }],
	createdAt: "2026-08-13T00:00:00.000Z",
	completedAt: "2026-08-13T00:00:00.000Z",
} satisfies ItemView;
const _sessionDeleteResult = {
	sessionId: sessionDelete.sessionId,
	deleted: true,
	method: "trash",
} satisfies ClientResult<"session/delete">;

const subagentInterrupt = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	agentId: "22222222-2222-4222-8222-222222222222",
	requestId: "00000000-0000-4000-8000-000000000004",
} satisfies ClientParams<"subagent/interrupt">;
const subagentInterruptResult = {
	subagent: {
		agentId: subagentInterrupt.agentId,
		name: "researcher",
		status: "closed",
		taskSummary: "Inspect runtime",
		createdAt: "2026-08-06T00:00:00.000Z",
		updatedAt: "2026-08-06T00:00:01.000Z",
	},
} satisfies ClientResult<"subagent/interrupt">;

const session = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	mode: "code",
	cwdOrigin: "user-selected",
	cwd: "/tmp/project",
	createdAt: "2026-07-16T00:00:00.000Z",
	updatedAt: "2026-07-16T00:00:00.000Z",
	state: "idle",
	archived: false,
	unread: false,
} satisfies SessionSummary;

const turns: TurnView[] = [];
const items: ItemView[] = [];
const skill = {
	name: "pdf",
	description: "Read PDF documents",
	source: "system",
} satisfies SkillSummaryView;
const skillDetail = {
	name: "writing-plans",
	description: "Write implementation plans",
	source: "user",
	revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	directoryPath: "/Users/example/.metis/agent/skills/writing-plans",
	entryFile: "SKILL.md",
	files: ["SKILL.md"],
	content: "---\nname: writing-plans\ndescription: Write implementation plans\n---\n\nWrite the plan.",
	instructions: "Write the plan.",
	updatedAt: "2026-08-11T06:32:00.000Z",
	editable: true,
} satisfies SkillDetailView;
const skillUpsert = {
	requestId: "20000000-0000-4000-8000-000000000001",
	cwd: null,
	source: "user",
	name: "writing-plans",
	expectedRevision: null,
	content: skillDetail.content,
} satisfies ClientParams<"skill/upsert">;
const skillGet = skillDetail satisfies ClientResult<"skill/get">;
const skillImportInspect = {
	cwd: "/tmp/project",
	source: "project",
	input: { kind: "github", url: "https://github.com/example/skills" },
} satisfies ClientParams<"skill/import/inspect">;
const skillImport = {
	requestId: "20000000-0000-4000-8000-000000000003",
	cwd: skillImportInspect.cwd,
	source: skillImportInspect.source,
	input: skillImportInspect.input,
	sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	candidateIds: ["skills/writing-plans"],
} satisfies ClientParams<"skill/import">;
const _skillImportInspectResult = {
	revision: skillImport.sourceRevision,
	candidates: [{ id: "skills/writing-plans", name: "writing-plans", description: "Write plans", fileCount: 2 }],
} satisfies ClientResult<"skill/import/inspect">;
const mcpSummary = {
	name: "web",
	scope: "user",
	effective: true,
	revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	transport: "http",
	description: "Repository documentation.",
	enabled: true,
	required: false,
	url: "https://mcp.example.test/rpc",
	startupTimeoutSec: 10,
	toolTimeoutSec: 60,
	disabledTools: [],
	state: "inactive",
	credentialConfigured: false,
	toolCount: 0,
	resourceCount: 0,
	resourceTemplateCount: 0,
	promptCount: 0,
	capabilities: [],
} satisfies McpServerSummaryView;
const mcpDetail = {
	server: mcpSummary,
	tools: [],
	resources: [],
	resourceTemplates: [],
	prompts: [],
} satisfies McpServerDetailView;
const mcpUpsert = {
	requestId: "10000000-0000-4000-8000-000000000001",
	cwd: null,
	scope: "user",
	name: "web",
	expectedRevision: null,
	server: { transport: "http", url: "https://mcp.example.test/rpc" },
	credential: {
		bearerToken: "secret",
		environment: { MCP_TENANT: "tenant-secret" },
	},
} satisfies ClientParams<"mcp/upsert">;
const mcpImportInspect = {
	cwd: "/tmp/project",
	scope: "project",
	text: '{ // comment\n "mcpServers": { "web": { "url": "https://mcp.example.test/rpc" } } }',
} satisfies ClientParams<"mcp/import/inspect">;
const mcpImport = {
	requestId: "10000000-0000-4000-8000-000000000002",
	...mcpImportInspect,
	sourceRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	candidates: [{ id: "web", expectedRevision: null }],
} satisfies ClientParams<"mcp/import">;
const _mcpImportInspectResult = {
	sourceRevision: mcpImport.sourceRevision,
	candidates: [
		{
			id: "web",
			name: "web",
			transport: "http",
			enabled: true,
			existingRevision: null,
			bearerTokenConfigured: false,
			credentialNames: [],
		},
	],
} satisfies ClientResult<"mcp/import/inspect">;
const mcpGet = mcpDetail satisfies ClientResult<"mcp/get">;
const profile = {
	generatedAt: "2026-08-01T00:00:00.000Z",
	totalTokens: 600,
	peakDailyTokens: 400,
	longestSessionMs: 3_600_000,
	currentStreakDays: 2,
	longestStreakDays: 3,
	sessionCount: 2,
	mostUsedMode: "chat",
	mostUsedModePercent: 100,
	mostUsedThinkingLevel: "high",
	mostUsedThinkingLevelPercent: 75,
	usedSkillCount: 2,
	skillUseCount: 3,
	activity: [
		{ date: "2026-07-31", tokens: 200 },
		{ date: "2026-08-01", tokens: 400 },
	],
	topSkills: [
		{ name: "pdf", count: 2 },
		{ name: "documents", count: 1 },
	],
} satisfies ClientResult<"profile/get">;
const personalization = {
	instructions: "Keep explanations concise.",
} satisfies ClientResult<"personalization/get">;
const updatePersonalization = {
	instructions: personalization.instructions,
} satisfies ClientParams<"personalization/update">;
const snapshot: SessionSnapshot = {
	session,
	collaborationMode: "default",
	permissionMode: "ask",
	turns,
	recentItems: items,
	nextBeforeItemId: null,
	activeTurnId: null,
	pendingInteractions: [],
	tasks: [],
	deliveredFiles: [],
	goal: null,
	queuedTurns: [],
	thinkingSelection: "off",
	actualThinkingLevel: "off",
	availableThinkingSelections: ["off"],
	subagents: [],
	serverEpoch: "33333333-3333-4333-8333-333333333333",
	cursor: 0,
};
const goalSet = {
	sessionId: session.sessionId,
	requestId: "22222222-2222-4222-8222-222222222236",
	objective: "keep tests green",
} satisfies ClientParams<"session/goal/set">;
const permissionMode: PermissionModeView = snapshot.permissionMode;
const setCollaborationMode = {
	sessionId: session.sessionId,
	requestId: "00000000-0000-4000-8000-000000000001",
	collaborationMode: "plan",
} satisfies ClientParams<"session/setCollaborationMode">;
const planStartExecution = {
	sessionId: "session-12345678",
	requestId: "00000000-0000-4000-8000-000000000002",
	planId: "00000000-0000-4000-8000-000000000003",
	revision: 2,
} satisfies ClientParams<"plan/startExecution">;
const planCancel = {
	sessionId: "session-12345678",
	requestId: "00000000-0000-4000-8000-000000000004",
	planId: "00000000-0000-4000-8000-000000000003",
	revision: 2,
} satisfies ClientParams<"plan/cancel">;
const planItem = {
	itemId: "item_plan_proposed",
	sessionId: session.sessionId,
	role: "system",
	state: "completed",
	content: [
		{
			type: "plan",
			plan: {
				planId: planCancel.planId,
				revision: planCancel.revision,
				title: "Implementation plan",
				markdown: "# Plan\n\nShip Plan mode.",
				status: "proposed",
				createdAt: "2026-08-25T00:00:00.000Z",
			},
		},
	],
	createdAt: "2026-08-25T00:00:00.000Z",
	completedAt: "2026-08-25T00:00:00.000Z",
} satisfies ItemView;
const permissionRule = {
	id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	toolName: "bash",
	command: "npm test",
	paths: ["/tmp/project"],
	details: [{ label: "Command", value: "npm test" }],
	omittedDetails: 0,
	risks: ["shell"],
	executionTarget: "sandbox",
	createdAt: "2026-08-11T00:00:00.000Z",
} satisfies ProjectPermissionRuleView;
const events: ConnectionEventsParams = {
	serverEpoch: snapshot.serverEpoch,
	fromCursor: 1,
	toCursor: 3,
	events: [
		{ type: "server/state", state: "ready" },
		{
			type: "session/collaborationModeChanged",
			sessionId: session.sessionId,
			collaborationMode: "plan",
		},
		{
			type: "subagent/itemsChanged",
			sessionId: session.sessionId,
			agentId: subagentInterrupt.agentId,
		},
	],
};
const interactionResponse: InteractionResponseInput = {
	interactionId: "44444444-4444-4444-8444-444444444444",
	kind: "confirm",
	confirmed: true,
};
const askUserInteractionResponse: InteractionResponseInput = {
	interactionId: "44444444-4444-4444-8444-444444444445",
	kind: "ask_user",
	cancelled: false,
	answers: [{ questionId: "question:0", choiceIds: ["choice:1"] }],
};

void events;
void interactionResponse;
void askUserInteractionResponse;
void planItem;
void setCollaborationMode;
void planStartExecution;
void planCancel;
void skill;
void skillDetail;
void skillUpsert;
void skillGet;
void mcpSummary;
void mcpDetail;
void mcpUpsert;
void mcpGet;
void profile;
void personalization;
void updatePersonalization;
void projectDelete;
void projectDeletePreview;
void projectDeleteResult;
void sessionStatusView;
void sessionCompactResult;
void compactedItem;
void permissionMode;
void permissionRule;
void subagentInterruptResult;
void goalSet;
