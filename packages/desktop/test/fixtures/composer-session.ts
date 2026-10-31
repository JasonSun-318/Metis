import type { InteractionView, SessionSnapshot } from "@metis/app-protocol";

export const COMPOSER_SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const COMPOSER_EPOCH = "22222222-2222-4222-8222-222222222222";

export function composerInteraction(kind: "ask_user" | "session_permission_approval"): InteractionView {
	const common = {
		interactionId: kind === "ask_user" ? "question-1" : "approval-1",
		sessionId: COMPOSER_SESSION_ID,
		title: "Waiting for your response",
		message: "Review the request to continue.",
		createdAt: "2026-10-17T00:00:00.000Z",
	};
	if (kind === "ask_user") {
		return {
			...common,
			kind,
			questions: [
				{
					id: "question-0",
					question: "Where should the task results be stored?",
					multiple: false,
					choices: [
						{ id: "local", label: "Local folder", description: "Keep the results in this project." },
						{ id: "library", label: "Knowledge library", description: "Link the results to the library." },
					],
				},
			],
		};
	}
	return {
		...common,
		kind,
		requestId: "approval-request-1",
		actionId: "action-1",
		toolLabel: "bash",
		command: "curl https://example.test",
		riskLevel: "high",
		executionTarget: "external",
		reason: "This command needs network access.",
		scopeComplete: true,
		details: [{ label: "Command", value: "curl https://example.test" }],
		choices: ["deny-once", "allow-once", "always-allow-exact"],
	};
}

export function composerSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		session: {
			sessionId: COMPOSER_SESSION_ID,
			mode: "chat",
			cwdOrigin: "user-selected",
			cwd: "/tmp/composer-fixture",
			name: "Composer layout verification",
			createdAt: "2026-10-17T00:00:00.000Z",
			updatedAt: "2026-10-17T00:00:00.000Z",
			state: "running",
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		},
		collaborationMode: "default",
		permissionPreset: "ask",
		effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
		constrainedByParent: false,
		sandboxHealth: "healthy",
		turns: [],
		recentItems: [],
		nextBeforeItemId: null,
		activeTurnId: "running-turn",
		pendingInteractions: [],
		queuedTurns: [
			{
				queueItemId: "queued-1",
				revision: "revision-1",
				state: "queued",
				text: "Please also check the documentation.",
				attachments: [],
			},
		],
		tasks: [
			{ task: "Inspect the current implementation", completed: true },
			{ task: "Validate the updated interface", completed: false },
		],
		deliveredFiles: [],
		goal: {
			goalId: "goal-1",
			objective: "Keep the conversation usable while reviewing requests",
			status: "active",
			timeUsedSeconds: 3,
			activeStartedAt: null,
		},
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		agents: [],
		serverEpoch: COMPOSER_EPOCH,
		cursor: 0,
		...overrides,
	};
}
