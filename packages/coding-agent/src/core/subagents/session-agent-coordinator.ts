import type { AgentSession } from "../agent-session.ts";
import type { SessionManager } from "../session-manager.ts";
import { loadAgentTypeDefinitions } from "./agent-type-registry.ts";
import { type CreateChildRuntime, SubagentManager, type SubagentManagerOptions } from "./manager.ts";
import { buildAgentCoordinationPrompt } from "./prompts.ts";
import { AgentStore } from "./store.ts";
import { createSubagentTools } from "./tools.ts";
import { AGENT_TOOL_NAMES } from "./types.ts";

const INSTALLED_AGENT_TOOLS = AGENT_TOOL_NAMES;

export interface SessionAgentCoordinatorOptions {
	readonly agentDir: string;
	readonly inheritedManager?: SubagentManager;
	readonly createChildRuntime: (
		input: Parameters<CreateChildRuntime>[0],
		manager: SubagentManager,
	) => ReturnType<CreateChildRuntime>;
	readonly createManager?: (options: SubagentManagerOptions) => SubagentManager;
	readonly isRuntimeAvailable?: () => boolean;
	readonly onDiagnostic: (message: string) => void;
}

/** Owns the subagent coordination lifecycle for one replaceable agent session. */
export class SessionAgentCoordinator {
	private readonly agentDir: string;
	private readonly inheritedManager?: SubagentManager;
	private readonly createChildRuntime: SessionAgentCoordinatorOptions["createChildRuntime"];
	private readonly createManager: NonNullable<SessionAgentCoordinatorOptions["createManager"]>;
	private readonly isRuntimeAvailable: () => boolean;
	private readonly onDiagnostic: (message: string) => void;
	private session?: AgentSession;
	private managerValue?: SubagentManager;
	private ownsManager = false;
	private detachActor?: () => void;
	private unsubscribeManager?: () => void;
	private readonly pendingContinuationIds = new Set<string>();
	private readonly attemptedContinuationIds = new Set<string>();
	private continuationTask?: Promise<void>;
	private generation = 0;

	constructor(options: SessionAgentCoordinatorOptions) {
		this.agentDir = options.agentDir;
		this.inheritedManager = options.inheritedManager;
		this.createChildRuntime = options.createChildRuntime;
		this.createManager = options.createManager ?? ((managerOptions) => new SubagentManager(managerOptions));
		this.isRuntimeAvailable = options.isRuntimeAvailable ?? (() => true);
		this.onDiagnostic = options.onDiagnostic;
	}

	get manager(): SubagentManager | undefined {
		return this.managerValue;
	}

	async initialize(session: AgentSession): Promise<void> {
		if (this.session === session) return;
		await this.recoverDeletes(session);
		this.attach(session);
	}

	attach(session: AgentSession): void {
		if (this.session === session) return;
		if (this.session) throw new Error("Session agent coordinator must be disposed before attach");
		this.session = session;
		this.generation += 1;
		this.pendingContinuationIds.clear();
		this.attemptedContinuationIds.clear();
		this.continuationTask = undefined;
		session.setCollaborationModeGuard(undefined);
		this.bind(session, this.generation);
	}

	async rebind(session: AgentSession): Promise<void> {
		await this.initialize(session);
	}

	async dispose(): Promise<void> {
		if (!this.session && !this.managerValue && !this.detachActor && !this.unsubscribeManager) return;
		const session = this.session;
		const manager = this.managerValue;
		const owned = this.ownsManager;
		const detach = this.detachActor;
		const unsubscribe = this.unsubscribeManager;

		this.generation += 1;
		this.pendingContinuationIds.clear();
		this.attemptedContinuationIds.clear();
		this.continuationTask = undefined;
		this.session = undefined;
		this.managerValue = undefined;
		this.ownsManager = false;
		this.detachActor = undefined;
		this.unsubscribeManager = undefined;

		const errors: unknown[] = [];
		try {
			if (owned) await manager?.unload("parent_unloaded");
			else detach?.();
		} catch (error) {
			errors.push(error);
		}
		try {
			unsubscribe?.();
		} catch (error) {
			errors.push(error);
		}
		try {
			session?.setCollaborationModeGuard(undefined);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose session agent coordinator");
	}

	private async recoverDeletes(session: AgentSession): Promise<void> {
		const header = session.sessionManager.getHeader();
		if (
			this.inheritedManager ||
			!session.sessionManager.isPersisted() ||
			header?.agent ||
			header?.scheduled ||
			session.mode !== "code"
		) {
			return;
		}
		await new AgentStore(session.sessionManager, this.agentDir).recoverDeleteMarkers();
	}

	private bind(session: AgentSession, generation: number): void {
		const header = session.sessionManager.getHeader();
		if (!session.sessionManager.isPersisted() || header?.scheduled) return;

		if (header?.agent) {
			if (!this.inheritedManager) return;
			this.managerValue = this.inheritedManager;
			this.detachActor = this.inheritedManager.attachActor(session);
			this.unsubscribeManager = this.inheritedManager.subscribe((event) => {
				if (!this.isCurrent(session, generation)) return;
				if (
					event.type === "notification_ready" &&
					event.event.parentSessionId === session.sessionManager.getSessionId()
				) {
					this.requestContinuation(session, generation, event.event.eventId);
				}
			});
			if (header.agent.mayDelegate) this.installTools(session);
			this.syncCapabilities(session, header.agent);
			this.resumePendingContinuations(session, generation);
			return;
		}

		if (session.mode !== "code") return;

		if (this.inheritedManager) {
			this.managerValue = this.inheritedManager;
			this.detachActor = this.inheritedManager.attachActor(session);
			this.installTools(session);
			this.syncCapabilities(session);
			this.resumePendingContinuations(session, generation);
			return;
		}

		let manager!: SubagentManager;
		manager = this.createManager({
			parentSessionManager: session.sessionManager,
			agentDir: this.agentDir,
			getWorkspaceRoots: () => session.sessionManager.getWorkspaceRoots(),
			onPermissionRequest: (request) => session.requestPermissionApproval(request),
			createChildRuntime: (input) => this.createChildRuntime(input, manager),
		});
		this.managerValue = manager;
		this.ownsManager = true;
		session.setCollaborationModeGuard((mode) => {
			if (mode === "plan") manager.assertCanEnterPlan(session.sessionManager.getSessionId());
		});
		this.installTools(session);
		this.unsubscribeManager = manager.subscribe((event) => {
			if (!this.isCurrent(session, generation)) return;
			this.syncCapabilities(session);
			if (
				event.type === "notification_ready" &&
				event.event.parentSessionId === session.sessionManager.getSessionId()
			) {
				this.requestContinuation(session, generation, event.event.eventId);
			} else if (event.type === "notification_failed") {
				this.onDiagnostic(`Agent notification failed: ${event.error}`);
			}
		});
		this.detachActor = manager.attachActor(session);
		this.syncCapabilities(session);
		this.resumePendingContinuations(session, generation);
	}

	private installTools(session: AgentSession): void {
		session.installHostTools(
			createSubagentTools({
				getManager: () => this.managerValue,
				getSession: () => session,
			}),
			{ automaticPermissionToolNames: ["inspect_agents"] },
		);
	}

	private isCurrent(session: AgentSession, generation: number): boolean {
		return this.session === session && this.generation === generation && this.isRuntimeAvailable();
	}

	private requestContinuation(session: AgentSession, generation: number, eventId: string): void {
		if (!this.isCurrent(session, generation)) return;
		this.pendingContinuationIds.add(eventId);
		this.scheduleContinuation(session, generation);
	}

	private resumePendingContinuations(session: AgentSession, generation: number): void {
		for (const eventId of session.getPendingAgentMailboxEventIds()) {
			this.requestContinuation(session, generation, eventId);
		}
	}

	private scheduleContinuation(session: AgentSession, generation: number): void {
		if (this.continuationTask || !this.isCurrent(session, generation)) return;
		let task!: Promise<void>;
		task = this.drainContinuation(session, generation)
			.catch((error) => {
				if (!this.isCurrent(session, generation)) return;
				this.onDiagnostic(
					`Automatic agent continuation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				if (this.continuationTask !== task) return;
				this.continuationTask = undefined;
				if (!this.isCurrent(session, generation)) return;
				const pending = new Set(session.getPendingAgentMailboxEventIds());
				const hasUnattempted = [...this.pendingContinuationIds].some(
					(eventId) => pending.has(eventId) && !this.attemptedContinuationIds.has(eventId),
				);
				if (hasUnattempted) this.scheduleContinuation(session, generation);
			});
		this.continuationTask = task;
	}

	private async drainContinuation(session: AgentSession, generation: number): Promise<void> {
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		await session.waitForIdle();
		if (!this.isCurrent(session, generation)) return;

		const pending = new Set(session.getPendingAgentMailboxEventIds());
		for (const eventId of [...this.pendingContinuationIds]) {
			if (!pending.has(eventId)) this.pendingContinuationIds.delete(eventId);
		}
		const unattempted = [...this.pendingContinuationIds].filter(
			(eventId) => !this.attemptedContinuationIds.has(eventId),
		);
		if (unattempted.length === 0) return;
		for (const eventId of unattempted) this.attemptedContinuationIds.add(eventId);

		const continued = await session.continueAgentMailbox(unattempted);
		if (!this.isCurrent(session, generation)) return;
		const remaining = new Set(session.getPendingAgentMailboxEventIds());
		for (const eventId of [...this.pendingContinuationIds]) {
			if (!remaining.has(eventId)) this.pendingContinuationIds.delete(eventId);
		}
		if (continued) {
			for (const eventId of unattempted) {
				if (remaining.has(eventId)) this.attemptedContinuationIds.delete(eventId);
			}
		}
	}

	private syncCapabilities(
		session: AgentSession,
		agentHeader?: NonNullable<ReturnType<SessionManager["getHeader"]>>["agent"],
	): void {
		if (!this.managerValue) return;
		const reserved = new Set<string>(AGENT_TOOL_NAMES);
		const base = session.getConfiguredActiveToolNames().filter((name) => !reserved.has(name));

		if (agentHeader) {
			const agentTools = agentHeader.mayDelegate ? INSTALLED_AGENT_TOOLS : [];
			session.setActiveToolsByName([...base, ...agentTools]);
			session.setHostSystemPrompt(() => undefined);
			return;
		}

		if (session.mode !== "code") {
			session.setActiveToolsByName(base);
			session.setHostSystemPrompt(() => undefined);
			return;
		}

		session.setActiveToolsByName([...base, ...INSTALLED_AGENT_TOOLS]);
		session.setHostSystemPrompt(() => buildAgentCoordinationPrompt(loadAgentTypeDefinitions()));
	}
}
