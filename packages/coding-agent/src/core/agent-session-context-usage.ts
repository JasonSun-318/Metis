import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, BeforeProviderRequestContext } from "@metis/agent-core";
import type { AssistantMessage, Model, Tool } from "@metis/ai/compat";
import { calculateContextTokens } from "./compaction/index.ts";
import {
	estimateContextUsageBreakdown,
	mergeContextUsageBreakdown,
	reconcileContextUsageBreakdown,
	reconcileContextUsageBreakdownWithFixed,
} from "./context-usage-breakdown.ts";
import type { ContextUsage, ContextUsageBreakdownItem } from "./extensions/index.ts";
import { AGENT_TOOL_NAMES } from "./subagents/types.ts";
import type { SystemPromptPart } from "./system-prompt.ts";

interface PreparedContextUsageSnapshot {
	readonly configurationFingerprint: string;
	readonly breakdown: readonly ContextUsageBreakdownItem[];
	readonly rawFixed: readonly ContextUsageBreakdownItem[];
}

interface ReportedContextUsageSnapshot extends PreparedContextUsageSnapshot {
	readonly assistant: AssistantMessage;
	readonly prefix: readonly AgentMessage[];
	readonly tokens: number;
}

interface ContextUsageCalibration {
	readonly configurationFingerprint: string;
	readonly fixedBreakdown: readonly ContextUsageBreakdownItem[];
}

const AGENT_CONTEXT_TOOL_NAMES = new Set<string>(AGENT_TOOL_NAMES);

export interface AgentSessionContextUsageSource {
	getMcpToolNames(): ReadonlySet<string>;
	getBaseSystemPromptParts(): readonly SystemPromptPart[];
	getMessages(): readonly AgentMessage[];
	getModel(): Model<any> | undefined;
	getSystemPrompt(): string;
	getTools(): readonly Tool[];
}

export class AgentSessionContextUsage {
	private readonly _source: AgentSessionContextUsageSource;
	private _prepared: PreparedContextUsageSnapshot | undefined;
	private _reported: ReportedContextUsageSnapshot | undefined;
	private _calibration: ContextUsageCalibration | undefined;

	constructor(source: AgentSessionContextUsageSource) {
		this._source = source;
	}

	capturePrepared(prepared: BeforeProviderRequestContext): void {
		const systemPrompt = prepared.llmContext.systemPrompt ?? "";
		const tools = prepared.llmContext.tools ?? [];
		this._prepared = {
			configurationFingerprint: this._fingerprint(prepared.model, systemPrompt, tools),
			breakdown: this._estimateBreakdown(systemPrompt, prepared.agentMessages, tools),
			rawFixed: this._estimateBreakdown(systemPrompt, [], tools),
		};
	}

	/**
	 * Estimate prepared prompt tokens for a context view without touching the
	 * pending `_prepared` snapshot or reported anchors. Reuses the fixed
	 * calibration when the configuration fingerprint matches.
	 */
	estimatePreparedTokens(prepared: BeforeProviderRequestContext): number {
		const systemPrompt = prepared.llmContext.systemPrompt ?? "";
		const tools = prepared.llmContext.tools ?? [];
		const breakdown = this._estimateBreakdown(systemPrompt, prepared.agentMessages, tools);
		const estimatedTotal = breakdown.reduce((sum, item) => sum + item.tokens, 0);
		const calibration = this._calibration;
		const fingerprint = this._fingerprint(prepared.model, systemPrompt, tools);
		if (calibration?.configurationFingerprint !== fingerprint) return estimatedTotal;
		const rawFixedTotal = this._estimateBreakdown(systemPrompt, [], tools).reduce(
			(sum, item) => sum + item.tokens,
			0,
		);
		const calibratedFixed = calibration.fixedBreakdown.reduce((sum, item) => sum + item.tokens, 0);
		return estimatedTotal - rawFixedTotal + calibratedFixed;
	}

	/**
	 * Drop the last reported-usage anchor after a durable context rewrite so a
	 * stale large total cannot immediately retrigger full compaction. Fixed
	 * calibration for the same configuration is kept.
	 */
	invalidateReportedContext(): void {
		this._reported = undefined;
	}

	captureReported(message: AssistantMessage): void {
		const prepared = this._prepared;
		this._prepared = undefined;
		const reportedTokens = calculateContextTokens(message.usage);
		if (!prepared || message.stopReason === "error" || message.stopReason === "aborted" || reportedTokens <= 0) {
			return;
		}
		// Calibrate the prompt separately: generated output belongs only to the conversation.
		const outputTokens = Math.min(reportedTokens, Math.max(0, message.usage.output));
		const promptTokens = reportedTokens - outputTokens;
		const rawTotal = prepared.breakdown.reduce((sum, item) => sum + item.tokens, 0);
		const rawFixedTotal = prepared.rawFixed.reduce((sum, item) => sum + item.tokens, 0);
		let calibration = this._calibration;
		if (calibration?.configurationFingerprint !== prepared.configurationFingerprint) {
			calibration = {
				configurationFingerprint: prepared.configurationFingerprint,
				fixedBreakdown: reconcileContextUsageBreakdown(
					prepared.rawFixed,
					rawTotal > 0 ? Math.round((promptTokens * rawFixedTotal) / rawTotal) : 0,
				),
			};
			this._calibration = calibration;
		}
		const promptBreakdown = reconcileContextUsageBreakdownWithFixed(
			prepared.breakdown,
			promptTokens,
			calibration.fixedBreakdown,
			prepared.rawFixed,
		);
		const breakdown =
			promptTokens > 0 && promptBreakdown.length === 0
				? []
				: mergeContextUsageBreakdown(promptBreakdown, [{ category: "conversation", tokens: outputTokens }]);
		const messages = this._source.getMessages();
		let stateAssistant = message;
		for (let index = messages.length - 1; index >= 0; index--) {
			const candidate = messages[index];
			if (candidate.role === "assistant" && (candidate === message || isDeepStrictEqual(candidate, message))) {
				stateAssistant = candidate;
				break;
			}
		}
		this._reported = {
			assistant: stateAssistant,
			prefix: messages.slice(0, messages.indexOf(stateAssistant) + 1),
			configurationFingerprint: prepared.configurationFingerprint,
			breakdown,
			rawFixed: prepared.rawFixed,
			tokens: reportedTokens,
		};
	}

	getUsage(): ContextUsage | undefined {
		const model = this._source.getModel();
		if (!model) return undefined;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const systemPrompt = this._source.getSystemPrompt();
		const tools = this._source.getTools();
		const messages = this._source.getMessages();
		const fingerprint = this._fingerprint(model, systemPrompt, tools);
		const reported = this._reported;
		const assistantIndex = reported ? messages.indexOf(reported.assistant) : -1;
		// Compaction or branch changes can retain the assistant while replacing its prompt.
		const samePrefix =
			reported &&
			reported.prefix.length === assistantIndex + 1 &&
			reported.prefix.every((message, index) => message === messages[index]);
		if (reported && reported.configurationFingerprint === fingerprint && assistantIndex >= 0 && samePrefix) {
			const tail = this._estimateBreakdown("", messages.slice(assistantIndex + 1), []);
			const breakdown = mergeContextUsageBreakdown(reported.breakdown, tail);
			const tokens = reported.tokens + tail.reduce((sum, item) => sum + item.tokens, 0);
			return {
				tokens,
				contextWindow,
				percent: (tokens / contextWindow) * 100,
				basis: "reported_total",
				breakdown: breakdown.reduce((sum, item) => sum + item.tokens, 0) === tokens ? breakdown : null,
			};
		}

		const estimatedBreakdown = this._estimateBreakdown(systemPrompt, messages, tools);
		const calibration = this._calibration;
		const rawFixed = this._estimateBreakdown(systemPrompt, [], tools);
		const estimatedTotal = estimatedBreakdown.reduce((sum, item) => sum + item.tokens, 0);
		const breakdown =
			calibration?.configurationFingerprint === fingerprint
				? reconcileContextUsageBreakdownWithFixed(
						estimatedBreakdown,
						estimatedTotal -
							rawFixed.reduce((sum, item) => sum + item.tokens, 0) +
							calibration.fixedBreakdown.reduce((sum, item) => sum + item.tokens, 0),
						calibration.fixedBreakdown,
						rawFixed,
					)
				: estimatedBreakdown;
		const tokens = breakdown.reduce((sum, item) => sum + item.tokens, 0);
		return {
			tokens,
			contextWindow,
			percent: (tokens / contextWindow) * 100,
			basis: "estimated_total",
			breakdown,
		};
	}

	private _fingerprint(model: Model<any>, systemPrompt: string, tools: readonly Tool[]): string {
		let serializedTools = "[unserializable]";
		try {
			serializedTools = JSON.stringify(tools) ?? "[]";
		} catch {}
		return createHash("sha256")
			.update(model.provider)
			.update("\0")
			.update(model.id)
			.update("\0")
			.update(String(model.contextWindow ?? 0))
			.update("\0")
			.update(systemPrompt)
			.update("\0")
			.update(serializedTools)
			.digest("hex");
	}

	private _toolCategories(
		tools: readonly Tool[],
	): ReadonlyMap<string, "tool_definitions" | "mcp_dynamic_tools" | "agent_definitions"> {
		const mcpToolNames = this._source.getMcpToolNames();
		return new Map(
			tools.map(
				(tool) =>
					[
						tool.name,
						AGENT_CONTEXT_TOOL_NAMES.has(tool.name)
							? "agent_definitions"
							: mcpToolNames.has(tool.name)
								? "mcp_dynamic_tools"
								: "tool_definitions",
					] as const,
			),
		);
	}

	private _systemPromptParts(systemPrompt: string): readonly SystemPromptPart[] {
		const baseSystemPromptParts = this._source.getBaseSystemPromptParts();
		if (baseSystemPromptParts.map((part) => part.content).join("") === systemPrompt) {
			return baseSystemPromptParts;
		}
		return systemPrompt ? [{ category: "system_prompt", content: systemPrompt }] : [];
	}

	private _estimateBreakdown(
		systemPrompt: string,
		messages: readonly AgentMessage[],
		tools: readonly Tool[],
	): ContextUsageBreakdownItem[] {
		return estimateContextUsageBreakdown({
			systemPromptParts: this._systemPromptParts(systemPrompt),
			messages,
			tools,
			toolCategories: this._toolCategories(tools),
		});
	}
}
