import type {
	BrowserHandoffDetails,
	BrowserObservation,
	BrowserOperationDetails,
	BrowserToolCall,
} from "@metis/app-protocol";

type ControlState = "idle" | "agent" | "handoff";
type HandoffReason = Extract<BrowserToolCall, { tool: "browser_handoff" }>["input"]["reason"];
type CancellationReason = Extract<BrowserHandoffDetails, { status: "cancelled" }>["reason"];
type CloseReason = Extract<CancellationReason, "server_restarted" | "tab_closed">;

interface BrowserTabRuntimeOptions {
	readonly browserId: string;
	readonly controller: {
		leaseSignal(): AbortSignal;
		invalidate(): void;
		observe(input: { readonly browserId: string }, signal: AbortSignal): Promise<BrowserObservation>;
		close(): void;
	};
	readonly handoffTimeoutMs: number;
	readonly activityIdleDelayMs: number;
	readonly placeSurface: (foreground: boolean) => void;
	readonly emitActivity: (active: boolean) => void;
	readonly clearPendingActivity: () => void;
	readonly emitHandoff: (
		event:
			| { readonly status: "requested"; readonly reason: HandoffReason }
			| { readonly status: "completed" | "cancelled" },
	) => void;
	readonly cleanup: () => void;
}

interface HandoffRecord {
	readonly reason: HandoffReason;
	readonly promise: Promise<HandoffOutcome>;
	readonly resolve: (outcome: HandoffOutcome) => void;
	readonly timer: NodeJS.Timeout;
}

type HandoffOutcome =
	| { readonly status: "complete" }
	| { readonly status: "cancel"; readonly reason: CancellationReason };

/** Owns one browser tab's control state machine, serialization, and lifecycle cleanup. */
export class BrowserTabRuntime {
	private readonly options: BrowserTabRuntimeOptions;
	private controlState: ControlState = "idle";
	private presented = false;
	private activityActive = false;
	private activityIdleTimer?: NodeJS.Timeout;
	private activeAbort?: AbortController;
	private takeoverRequested = false;
	private handoffRecord?: HandoffRecord;
	private commandTail = Promise.resolve();
	private pendingAgentCommands = 0;
	private pendingUserCommands = 0;
	private closed = false;
	private closeReason?: CloseReason;

	constructor(options: BrowserTabRuntimeOptions) {
		this.options = options;
	}

	view(): { readonly controlState: ControlState; readonly handoffReason?: HandoffReason } {
		return this.handoffRecord
			? { controlState: this.controlState, handoffReason: this.handoffRecord.reason }
			: { controlState: this.controlState };
	}

	syncPresentation(visible: boolean): void {
		this.presented = visible;
		this.options.placeSurface(visible);
	}

	async runMutation(
		signal: AbortSignal,
		operation: (signal: AbortSignal) => Promise<BrowserOperationDetails>,
	): Promise<BrowserOperationDetails> {
		if (this.controlState === "handoff") throw new Error("Browser handoff is active");
		return this.enqueueOwned("agent", signal, async () => {
			if (this.controlState !== "idle") throw new Error("Browser control is unavailable");
			const activeAbort = new AbortController();
			const abortActive = () => activeAbort.abort(signal.reason);
			signal.addEventListener("abort", abortActive, { once: true });
			const operationSignal = AbortSignal.any([activeAbort.signal, this.options.controller.leaseSignal()]);
			this.activeAbort = activeAbort;
			this.takeoverRequested = false;
			try {
				this.transition("agent");
				let result: BrowserOperationDetails;
				try {
					result = await operation(operationSignal);
				} catch (cause) {
					if (!this.takeoverRequested) throw cause;
					return await this.takeoverHandoff(signal);
				}
				if (this.takeoverRequested) return await this.takeoverHandoff(signal);
				return result;
			} finally {
				signal.removeEventListener("abort", abortActive);
				this.activeAbort = undefined;
				this.takeoverRequested = false;
				if (!this.closed) this.transition("idle");
			}
		});
	}

	async runUserMutation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return this.enqueueOwned("user", this.options.controller.leaseSignal(), async () => {
			if (this.controlState !== "idle") throw new Error("Browser control is unavailable");
			return operation(this.options.controller.leaseSignal());
		});
	}

	async runObservation(
		signal: AbortSignal,
		operation: (signal: AbortSignal) => Promise<BrowserObservation>,
	): Promise<BrowserObservation> {
		if (this.controlState !== "idle") {
			throw new Error("Browser is currently controlled by the user or agent");
		}
		const leaseSignal = AbortSignal.any([signal, this.options.controller.leaseSignal()]);
		return this.enqueueOwned("agent", leaseSignal, async () => {
			if (this.controlState !== "idle") throw new Error("Browser control is unavailable");
			return this.runAgentObservation(leaseSignal, operation);
		});
	}

	async handoff(reason: HandoffReason, signal: AbortSignal): Promise<BrowserHandoffDetails> {
		if (this.controlState === "handoff") throw new Error("Browser handoff is already active");
		return this.enqueueOwned("agent", signal, async () => {
			if (this.controlState !== "idle") throw new Error("Browser control is unavailable");
			return this.awaitHandoff(reason, signal);
		});
	}

	takeControl(): void {
		if (this.controlState === "handoff") return;
		if (this.controlState !== "agent" || !this.activeAbort) throw new Error("Browser automation is not active");
		this.takeoverRequested = true;
		this.activeAbort.abort();
	}

	resolveHandoff(decision: "complete" | "cancel"): void {
		if (!this.handoffRecord) throw new Error("Browser handoff is not active");
		this.handoffRecord.resolve(
			decision === "complete" ? { status: "complete" } : { status: "cancel", reason: "user_cancelled" },
		);
	}

	cancelHandoff(reason: CancellationReason): void {
		this.handoffRecord?.resolve({ status: "cancel", reason });
	}

	close(reason: CloseReason): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = reason;
		this.takeoverRequested = false;
		this.activeAbort?.abort(new Error(`Browser ${reason.replace("_", " ")}`));
		if (this.activityIdleTimer) clearTimeout(this.activityIdleTimer);
		this.activityIdleTimer = undefined;
		this.activityActive = false;
		this.cancelHandoff(reason);
		try {
			this.options.controller.close();
		} finally {
			this.options.cleanup();
		}
	}

	private async takeoverHandoff(signal: AbortSignal): Promise<BrowserOperationDetails> {
		const result = await this.awaitHandoff("other", signal);
		if (result.status === "completed") return result;
		if (result.reason === "user_cancelled") return { status: "cancelled", reason: "user_cancelled" };
		throw new Error(`Browser handoff ended: ${result.reason}`);
	}

	private async awaitHandoff(reason: HandoffReason, signal: AbortSignal): Promise<BrowserHandoffDetails> {
		if (this.closed) return { status: "cancelled", reason: this.closeReason ?? "tab_closed" };
		this.options.controller.invalidate();
		let settled = false;
		let resolvePromise!: (outcome: HandoffOutcome) => void;
		const promise = new Promise<HandoffOutcome>((resolve) => {
			resolvePromise = (outcome) => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};
		});
		const timer = setTimeout(
			() => resolvePromise({ status: "cancel", reason: "timed_out" }),
			this.options.handoffTimeoutMs,
		);
		timer.unref?.();
		this.handoffRecord = { reason, promise, resolve: resolvePromise, timer };
		const onAbort = () => resolvePromise({ status: "cancel", reason: "turn_interrupted" });
		try {
			this.transition("handoff");
			this.options.emitHandoff({ status: "requested", reason });
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			const outcome = await promise;
			signal.removeEventListener("abort", onAbort);
			clearTimeout(timer);
			if (this.handoffRecord?.promise === promise) this.handoffRecord = undefined;
			if (this.closed) return { status: "cancelled", reason: this.closeReason ?? "tab_closed" };
			if (outcome.status === "cancel") {
				this.transition("idle");
				this.options.emitHandoff({ status: "cancelled" });
				return { status: "cancelled", reason: outcome.reason };
			}
			this.options.emitHandoff({ status: "completed" });
			this.options.controller.invalidate();
			return {
				status: "completed",
				observation: await this.runAgentObservation(signal, (operationSignal) =>
					this.options.controller.observe({ browserId: this.options.browserId }, operationSignal),
				),
			};
		} finally {
			signal.removeEventListener("abort", onAbort);
			clearTimeout(timer);
			if (this.handoffRecord?.promise === promise) this.handoffRecord = undefined;
			if (!this.closed && this.controlState === "handoff") this.transition("idle");
		}
	}

	private async runAgentObservation(
		signal: AbortSignal,
		operation: (signal: AbortSignal) => Promise<BrowserObservation>,
	): Promise<BrowserObservation> {
		const activeAbort = new AbortController();
		const operationSignal = AbortSignal.any([signal, activeAbort.signal, this.options.controller.leaseSignal()]);
		this.activeAbort = activeAbort;
		this.takeoverRequested = false;
		try {
			this.transition("agent");
			let observation: BrowserObservation | undefined;
			try {
				observation = await operation(operationSignal);
			} catch (cause) {
				if (this.closed) throw new Error(`Browser ${(this.closeReason ?? "tab_closed").replace("_", " ")}`);
				if (!this.takeoverRequested) throw cause;
			}
			if (this.closed) throw new Error(`Browser ${(this.closeReason ?? "tab_closed").replace("_", " ")}`);
			if (!this.takeoverRequested) return observation!;
			const handoff = await this.awaitHandoff("other", signal);
			if (handoff.status === "completed") return handoff.observation;
			if (handoff.reason === "user_cancelled") return await this.runAgentObservation(signal, operation);
			throw new Error(`Browser handoff ended: ${handoff.reason}`);
		} finally {
			this.activeAbort = undefined;
			this.takeoverRequested = false;
			if (!this.closed && this.controlState === "agent") this.transition("idle");
		}
	}

	private transition(state: ControlState): void {
		const previous = this.controlState;
		if (previous === state) return;
		this.controlState = state;
		if (state === "agent") {
			if (this.activityIdleTimer) clearTimeout(this.activityIdleTimer);
			this.activityIdleTimer = undefined;
			this.options.placeSurface(this.presented);
			if (!this.activityActive) {
				this.activityActive = true;
				this.options.emitActivity(true);
			}
			return;
		}
		if (state === "handoff") {
			if (this.activityIdleTimer) clearTimeout(this.activityIdleTimer);
			this.activityIdleTimer = undefined;
			this.activityActive = false;
			this.options.clearPendingActivity();
			this.options.placeSurface(this.presented);
			return;
		}
		if (previous === "agent") {
			if (this.activityIdleTimer) clearTimeout(this.activityIdleTimer);
			this.activityIdleTimer = setTimeout(() => {
				this.activityIdleTimer = undefined;
				if (!this.activityActive || this.controlState === "agent" || this.closed) return;
				this.activityActive = false;
				this.options.emitActivity(false);
			}, this.options.activityIdleDelayMs);
			this.activityIdleTimer.unref?.();
		}
		this.options.placeSurface(this.presented);
	}

	private enqueueOwned<T>(owner: "agent" | "user", signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		if (owner === "agent" && this.pendingUserCommands > 0) {
			return Promise.reject(new Error("Browser is currently controlled by the user"));
		}
		if (owner === "user" && (this.pendingAgentCommands > 0 || this.controlState !== "idle")) {
			return Promise.reject(new Error("Browser is currently controlled by the agent"));
		}
		if (owner === "agent") this.pendingAgentCommands += 1;
		else this.pendingUserCommands += 1;
		return this.enqueue(signal, operation).finally(() => {
			if (owner === "agent") this.pendingAgentCommands -= 1;
			else this.pendingUserCommands -= 1;
		});
	}

	private async enqueue<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		const previous = this.commandTail.catch(() => undefined);
		let release!: () => void;
		this.commandTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			signal.throwIfAborted();
			if (this.closed) throw new Error("Browser is not running");
			return await operation();
		} finally {
			release();
		}
	}
}
