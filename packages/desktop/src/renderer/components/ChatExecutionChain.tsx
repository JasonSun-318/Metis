import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretRight, CheckCircle, CircleNotch, ClockCounterClockwise, TerminalWindow, Tool } from "../icons.tsx";
import { PermissionReceipt } from "./ConversationInteractionCards.tsx";
import { Markdown } from "./Markdown.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import {
	actionSummary,
	commandText,
	isCommandTool,
	type ToolCallBlock,
	type ToolDetailLine,
	type ToolResultBlock,
	toolTranscriptPresentation,
} from "./transcript-turn-model.ts";
import type { TranscriptTurnProps } from "./transcript-turn-props.ts";

function ThinkingStep({ text }: { readonly text: string }) {
	const { t } = useTranslation();
	const id = useId();
	const [expanded, setExpanded] = useState(false);
	const [overflowing, setOverflowing] = useState(false);
	const viewportRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies(text): Markdown grows as tokens arrive, including before ResizeObserver delivers a notification.
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		const content = contentRef.current;
		if (!viewport || !content) return;
		const measure = () => {
			const lineHeight = Number.parseFloat(getComputedStyle(viewport).lineHeight) || 21;
			const height = content.getBoundingClientRect().height;
			viewport.style.setProperty("--thinking-content-height", `${height}px`);
			setOverflowing(height > lineHeight * 7 + 1);
			// Only the single-line group summary follows new text. A closed thought keeps its beginning.
			if (!expanded) viewport.scrollTop = 0;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		return () => observer.disconnect();
	}, [expanded, text]);

	return (
		<div className="activity-step activity-step-thinking">
			<span className="activity-step-icon">
				<ClockCounterClockwise aria-hidden="true" size={16} />
			</span>
			<div
				className={`thinking-preview${expanded ? " is-expanded" : ""}${overflowing ? " is-overflowing" : ""}`}
				id={id}
				onFocusCapture={() => {
					if (overflowing) setExpanded(true);
				}}
				ref={viewportRef}
			>
				<div className="activity-step-message" ref={contentRef}>
					<Markdown text={text} />
				</div>
			</div>
			{overflowing && (
				<button
					aria-controls={id}
					aria-expanded={expanded}
					className="thinking-show-more"
					onClick={() => setExpanded(!expanded)}
					type="button"
				>
					<CaretRight aria-hidden="true" size={11} />
					{t(expanded ? "Show less" : "Show more")}
				</button>
			)}
		</div>
	);
}

export function ChatExecutionChain({
	activity,
	items,
	results,
	running,
	startedAt,
	runId,
	waitingForAnswer,
	retry,
	replyVisible,
}: {
	readonly activity: readonly ItemContentBlockView[];
	readonly items: readonly ItemView[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly running: boolean;
	readonly startedAt?: string;
	readonly runId?: string;
	readonly waitingForAnswer: boolean;
	readonly retry?: TranscriptTurnProps["retry"];
	readonly replyVisible?: boolean;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const calls = activity.filter((block): block is ToolCallBlock => block.type === "tool_call");
	const latestAssistant = [...items].reverse().find((item) => item.role === "assistant");
	const latestBlock =
		latestAssistant &&
		[...latestAssistant.content].reverse().find((block) => block.type !== "text" || block.text.trim() !== "");
	const liveThinking =
		running &&
		!replyVisible &&
		!waitingForAnswer &&
		!retry &&
		latestAssistant?.state === "streaming" &&
		latestBlock?.type === "thinking" &&
		activity.includes(latestBlock)
			? (latestBlock.text.trim().split(/\n+/u).at(-1)?.trim() ?? "")
			: "";
	const preview = !open && liveThinking;

	return (
		<>
			{activity.length > 0 && (
				<details
					className={`execution-chain${preview ? " is-thinking" : ""}`}
					onToggle={(event) => setOpen(event.currentTarget.open)}
					open={open}
				>
					<summary aria-label={preview ? t("Thought process") : undefined}>
						{preview ? (
							<span className="execution-chain-live-preview">
								<span>{liveThinking.slice(-240)}</span>
							</span>
						) : (
							<span>{actionSummary(calls, t)}</span>
						)}
						<CaretRight aria-hidden="true" className="execution-chain-caret" size={14} />
					</summary>
					<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
						<div>
							<div className="execution-chain-content">
								<div className="execution-chain-timeline">
									{activity.map((block, index) => {
										if (block.type === "thinking")
											// biome-ignore lint/suspicious/noArrayIndexKey: Append-only blocks retain independent expansion while text streams.
											return <ThinkingStep key={`thinking-${index}`} text={block.text} />;
										if (block.type === "text")
											return (
												/* biome-ignore lint/suspicious/noArrayIndexKey: Transcript blocks are append-only. */
												<div className="activity-step activity-step-message" key={`text-${index}`}>
													<Markdown text={block.text} />
												</div>
											);
										if (block.type === "tool_call")
											return (
												<ToolStep
													call={block}
													key={`tool-${block.toolCallId}`}
													result={results.get(block.toolCallId)}
												/>
											);
										if (block.type === "tool_result") {
											const presentation = toolTranscriptPresentation(undefined, block, t);
											return (
												<div className="activity-step tool-step-orphan" key={`result-${block.toolCallId}`}>
													<span className="activity-step-icon">
														<CheckCircle aria-hidden="true" size={16} />
													</span>
													<p>{presentation.label}</p>
													<SafeToolDetails lines={presentation.detailLines} />
													{presentation.rawOutput !== undefined && (
														<pre
															className={`tool-step-output${presentation.rawOutputIsError ? " tool-step-output-error" : ""}`}
														>
															{presentation.rawOutput}
														</pre>
													)}
												</div>
											);
										}
										return null;
									})}
								</div>
							</div>
						</div>
					</div>
				</details>
			)}
			{running && (
				<TurnRuntimeStatus
					items={items}
					running
					retry={retry}
					startedAt={startedAt}
					runId={runId}
					waitingForAnswer={waitingForAnswer}
					replyVisible={replyVisible}
				/>
			)}
		</>
	);
}

function SafeToolDetails({ lines }: { readonly lines: readonly ToolDetailLine[] }) {
	if (lines.length === 0) return null;
	return (
		<dl className="tool-safe-details">
			{lines.map((line, index) => (
				<div className="tool-safe-row" key={`${line.label ?? "detail"}-${index}`}>
					{line.label && <dt>{line.label}</dt>}
					<dd>{line.value}</dd>
				</div>
			))}
		</dl>
	);
}

function ToolStep({ call, result }: { readonly call: ToolCallBlock; readonly result?: ToolResultBlock }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const commandTool = isCommandTool(call.name);
	const presentation = toolTranscriptPresentation(call, result, t);
	if (!commandTool) {
		return (
			<div className="tool-step tool-step-static">
				<div className="tool-step-static-label">
					<span className="activity-step-icon">
						<Tool aria-hidden="true" size={16} />
					</span>
					<span>{presentation.label}</span>
					{call.state === "running" && (
						<CircleNotch aria-label={t("Running")} className="tool-step-spinner" size={15} />
					)}
				</div>
				<SafeToolDetails lines={presentation.detailLines} />
				<PermissionReceipt call={call} />
				{presentation.rawOutputIsError && presentation.rawOutput !== undefined && (
					<pre className="tool-step-output tool-step-output-error">{presentation.rawOutput}</pre>
				)}
			</div>
		);
	}
	const command = commandText(presentation.rawInput);
	return (
		<details
			className="tool-step tool-step-command"
			onToggle={(event) => setOpen(event.currentTarget.open)}
			open={open}
		>
			<summary>
				<span className="activity-step-icon">
					<TerminalWindow aria-hidden="true" size={16} />
				</span>
				<span>{presentation.label}</span>
				{call.state === "running" && (
					<CircleNotch aria-label={t("Running")} className="tool-step-spinner" size={15} />
				)}
			</summary>
			<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
				<div>
					<div className="tool-step-details">
						{command && <pre className="tool-step-input">{command}</pre>}
						{presentation.rawOutput !== undefined && (
							<pre
								className={
									presentation.rawOutputIsError
										? "tool-step-output tool-step-output-error"
										: "tool-step-output"
								}
							>
								{presentation.rawOutput}
							</pre>
						)}
						<PermissionReceipt call={call} />
					</div>
				</div>
			</div>
		</details>
	);
}
