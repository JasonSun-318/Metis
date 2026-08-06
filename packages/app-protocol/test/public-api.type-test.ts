import type {
	ClientParams,
	ClientResult,
	ConnectionEventsParams,
	InteractionResponseInput,
	ItemView,
	PermissionModeView,
	SessionSnapshot,
	SessionSummary,
	SkillSummaryView,
	TurnView,
} from "@arcmind/app-protocol";

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
const snapshot: SessionSnapshot = {
	session,
	permissionMode: "ask",
	turns,
	recentItems: items,
	nextBeforeItemId: null,
	activeTurnId: null,
	pendingInteractions: [],
	thinkingSelection: "off",
	actualThinkingLevel: "off",
	availableThinkingSelections: ["off"],
	subagents: [],
	serverEpoch: "33333333-3333-4333-8333-333333333333",
	cursor: 0,
};
const permissionMode: PermissionModeView = snapshot.permissionMode;
const events: ConnectionEventsParams = {
	serverEpoch: snapshot.serverEpoch,
	fromCursor: 1,
	toCursor: 2,
	events: [
		{ type: "server/state", state: "ready" },
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

void events;
void interactionResponse;
void skill;
void profile;
void projectDelete;
void projectDeletePreview;
void projectDeleteResult;
void permissionMode;
void subagentInterruptResult;
