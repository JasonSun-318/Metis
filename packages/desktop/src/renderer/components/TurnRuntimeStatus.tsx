import type { ItemView, RetryStatusView } from "@metis/app-protocol";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatElapsed } from "../format-elapsed.ts";
import { actionSummary, type ToolCallBlock } from "./transcript-turn-model.ts";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function estimateOutputTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const character of text) {
		if (CJK.test(character)) cjk += 1;
		else other += 1;
	}
	return cjk + Math.ceil(other / 4);
}

function assistantOutputText(item: ItemView): string {
	return item.content
		.flatMap((block) => {
			if (block.type === "text" || block.type === "thinking") return [block.text];
			if (block.type === "tool_call") return [block.name, block.inputPreview ?? ""];
			return [];
		})
		.join("");
}

export function turnTokenTarget(items: readonly ItemView[]): { readonly tokens: number; readonly exact: boolean } {
	let tokens = 0;
	let exact = true;
	for (const item of items) {
		if (item.role !== "assistant") continue;
		if (item.state === "completed" && item.usage) tokens += item.usage.outputTokens;
		else {
			exact = false;
			tokens += Math.max(item.usage?.outputTokens ?? 0, estimateOutputTokens(assistantOutputText(item)));
		}
	}
	return { tokens, exact };
}

export function TurnRuntimeStatus({
	items,
	running,
	startedAt,
	waitingForAnswer = false,
	variant = "turn",
	retry,
	runId,
	replyVisible = false,
}: {
	readonly items: readonly ItemView[];
	readonly running: boolean;
	readonly waitingForAnswer?: boolean;
	readonly startedAt?: string;
	readonly variant?: "turn" | "compaction";
	readonly retry?: RetryStatusView;
	readonly runId?: string;
	readonly replyVisible?: boolean;
}) {
	const { t } = useTranslation();
	const target = useMemo(() => turnTokenTarget(items), [items]);
	const activity = useMemo(() => {
		const completedTools = new Set(
			items.flatMap((item) =>
				item.content.flatMap((block) => (block.type === "tool_result" ? [block.toolCallId] : [])),
			),
		);
		const tools = items.flatMap((item) =>
			item.content.filter(
				(block): block is ToolCallBlock =>
					block.type === "tool_call" &&
					(block.state === "running" || block.state === "pending") &&
					!completedTools.has(block.toolCallId),
			),
		);
		if (tools.length > 0)
			return tools.every((tool) => tool.name === "read") ? t("Reading files…") : actionSummary(tools, t);
		const assistant = [...items].reverse().find((item) => item.role === "assistant");
		return replyVisible ||
			(assistant?.state === "streaming" &&
				assistant.content.some((block) => block.type === "text" && block.text.trim() !== "") &&
				!assistant.content.some((block) => block.type === "thinking" || block.type === "tool_call"))
			? t("Writing reply…")
			: t("Thinking…");
	}, [items, replyVisible, t]);
	const parsedStartedAt = useMemo(() => {
		const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
		return Number.isFinite(parsed) ? parsed : undefined;
	}, [startedAt]);
	const [now, setNow] = useState(() => Date.now());
	const [runClock, setRunClock] = useState(() => ({
		runId,
		startedAtMs: parsedStartedAt ?? Date.now(),
	}));
	let startedAtMs = runClock.startedAtMs;

	if (runClock.runId !== runId) {
		startedAtMs = parsedStartedAt ?? Date.now();
		setRunClock({ runId, startedAtMs });
		setNow(Date.now());
	} else if (parsedStartedAt !== undefined && parsedStartedAt !== runClock.startedAtMs) {
		startedAtMs = parsedStartedAt;
		setRunClock({ runId, startedAtMs: parsedStartedAt });
	}

	useEffect(() => {
		if (!running || waitingForAnswer) return;
		const interval = window.setInterval(() => {
			setNow(Date.now());
		}, 1000);
		return () => window.clearInterval(interval);
	}, [running, waitingForAnswer]);

	if (!running) return null;
	if (waitingForAnswer)
		return <output className="status-block turn-runtime-status is-waiting">{t("Waiting for your answer")}</output>;
	const elapsedMs = Math.max(0, now - startedAtMs);
	const elapsed = formatElapsed(elapsedMs);
	const waitingForOutput = target.tokens === 0 && !replyVisible && elapsedMs >= 20_000 && activity === t("Thinking…");
	const label =
		variant === "compaction"
			? t("Compacting conversation…")
			: retry
				? t("Retrying ({{attempt}}/{{maxAttempts}})", retry)
				: waitingForOutput
					? t("Still waiting for model output…")
					: activity;
	return (
		<div
			className="status-block turn-runtime-status"
			data-runtime-tokens={variant === "turn" ? target.tokens : undefined}
		>
			<output aria-label={label} className="turn-runtime-activity">
				<span aria-hidden="true" className="turn-runtime-spinner">
					<span />
				</span>
				<span aria-hidden="true" className="turn-runtime-label" key={label}>
					{label}
				</span>
			</output>
			{variant === "turn" && target.tokens > 0 && (
				<span
					className="turn-runtime-usage"
					title={t(target.exact ? "Generated tokens" : "Estimated generated tokens")}
				>
					{!target.exact && "≈ "}
					{t("{{count}} tokens", { count: target.tokens.toLocaleString() })}
				</span>
			)}
			{elapsedMs >= 3000 && (
				<span aria-hidden="true" className="turn-runtime-elapsed">
					{elapsed}
				</span>
			)}
		</div>
	);
}
