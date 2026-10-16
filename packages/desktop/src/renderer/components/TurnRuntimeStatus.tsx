import type { ItemView } from "@metis/app-protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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

export function advanceDisplayedTokens(current: number, target: number): number {
	if (current === target) return current;
	const difference = target - current;
	const step = Math.max(1, Math.ceil(Math.abs(difference) / 4));
	return current + Math.sign(difference) * Math.min(step, Math.abs(difference));
}

export function TurnRuntimeStatus({
	items,
	running,
	startedAt,
	waitingForAnswer = false,
	variant = "turn",
}: {
	readonly items: readonly ItemView[];
	readonly running: boolean;
	readonly waitingForAnswer?: boolean;
	readonly startedAt?: string;
	readonly variant?: "turn" | "compaction";
}) {
	const { t } = useTranslation();
	const target = useMemo(() => turnTokenTarget(items), [items]);
	const targetRef = useRef(target.tokens);
	targetRef.current = target.tokens;
	const [startedAtMs] = useState(() => {
		const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
		return Number.isFinite(parsed) ? parsed : Date.now();
	});
	const [displayedTokens, setDisplayedTokens] = useState(0);
	const [elapsedSeconds, setElapsedSeconds] = useState(() =>
		Math.max(0, Math.floor((Date.now() - startedAtMs) / 1_000)),
	);

	useEffect(() => {
		if (!running || waitingForAnswer) return;
		const interval = window.setInterval(() => {
			if (variant === "turn") setDisplayedTokens((current) => advanceDisplayedTokens(current, targetRef.current));
			setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1_000)));
		}, 100);
		return () => window.clearInterval(interval);
	}, [running, startedAtMs, variant, waitingForAnswer]);

	if (!running) return null;
	if (waitingForAnswer)
		return <output className="status-block turn-runtime-status is-waiting">{t("Waiting for your answer")}</output>;
	return (
		<output
			aria-label={t(variant === "compaction" ? "Compacting conversation…" : "Thinking…")}
			className="status-block turn-runtime-status"
			data-runtime-tokens={variant === "turn" ? displayedTokens : undefined}
		>
			<span aria-hidden="true" className="turn-runtime-spinner">
				{[0, 1, 2, 3, 4, 5].map((dot) => (
					<span key={dot} />
				))}
			</span>
			<span aria-hidden="true">
				{variant === "compaction"
					? `${elapsedSeconds}s · ${t("Compacting conversation…")}`
					: `${elapsedSeconds}s · ${t("{{count}} tokens", { count: displayedTokens })} · ${t("Thinking…")}`}
			</span>
		</output>
	);
}
