import type { ItemView } from "@metis/app-protocol";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer, type ComposerSubmission } from "../src/renderer/components/Composer.tsx";
import { ConversationQuoteProvider } from "../src/renderer/components/ConversationQuoteContext.tsx";
import { TerminalPanel } from "../src/renderer/components/TerminalPanel.tsx";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const sessionId = "11111111-1111-4111-8111-111111111111";
function messages(index: number): ItemView[] {
	const base = { sessionId, turnId: `turn-${index}`, state: "completed" as const, createdAt: "2026-10-03T00:00:00Z" };
	return [
		{
			...base,
			itemId: `user-${index}`,
			role: "user",
			content: [{ type: "text", text: `第 ${index + 1} 个问题：请整理产品资料中的知识点，并补充笔记之间的关联。` }],
			...(params.has("references") && index === 0
				? {
						content: [{ type: "text" as const, text: "翻译一下 [literal.md:1–8]" }],
						fileSelections: [
							{
								name: "AGENTS.md",
								source: "workspace" as const,
								selectedText:
									"# 1. Language and communication\n\n- Default language: Chinese.\n- Preserve unrelated content.",
								startLine: 1,
								endLine: 8,
							},
							{
								name: "report.pdf",
								source: "delivered" as const,
								selectedText: "Selected document text",
								target: { kind: "pdf" as const, page: 2, endPage: 3 },
							},
						],
					}
				: {}),
			...(index % 10 === 0 && !params.has("references")
				? {
						attachments: [
							{ name: "产品调研报告.pdf", byteLength: 243712 },
							{ name: "系统设计说明.md", byteLength: 8420 },
						],
					}
				: {}),
		},
		...(index === 45
			? [
					{
						...base,
						itemId: "steer-45",
						role: "user" as const,
						content: [{ type: "text" as const, text: "补充要求：关联已有笔记。" }],
					},
				]
			: []),
		{
			...base,
			itemId: `answer-${index}`,
			role: "assistant",
			...(params.has("streaming") && index === 0 ? { state: "streaming" as const } : {}),
			content: [
				{
					type: "text",
					text:
						`第 ${index + 1} 条回答\n\n已整理为独立主题笔记，保留了资料来源，并关联到现有知识点。\n\n${"每篇笔记只围绕一个明确主题展开，避免为拆分而拆分。\n\n".repeat((index % 5) + 1)}` +
						(params.has("selection")
							? [
									"\n\nSelection paragraph: selectable conversation content.",
									"\n\n[Selectable link](https://example.test/)",
									"\n\n| Column | Value |\n| --- | --- |\n| Selection | Table content |",
									"\n\n```ts\nconst selectable = true;\n```",
								].join("")
							: ""),
				},
			],
		},
	];
}
const quoteStorage = `metis-conversation-quote-fixture-${params.get("mode")}-${params.get("theme")}`;
function Fixture() {
	const [items, setItems] = useState<ItemView[]>(() => {
		if (params.has("quotes") && localStorage.getItem(quoteStorage))
			return JSON.parse(localStorage.getItem(quoteStorage)!);
		const initial = Array.from({ length: Number(params.get("count") ?? 121) }, (_, index) => messages(index)).flat();
		if (params.has("quoteHistory")) {
			const user = [...initial].reverse().find((item) => item.role === "user")!;
			initial[initial.indexOf(user)] = {
				...user,
				conversationQuotes: [
					{
						sourceItemId: "durable-answer--1",
						sourceLiveItemId: "answer--1",
						sourceRole: "assistant",
						selectedText: "Earlier quoted answer",
					},
				],
			};
		}
		if (params.has("cards")) {
			const base = { sessionId, state: "completed" as const, createdAt: "2026-10-03T00:00:00Z" };
			initial.push(
				{
					...base,
					itemId: "card-user",
					turnId: "card-turn",
					role: "user",
					content: [{ type: "text", text: "Prepare a plan" }],
				},
				{
					...base,
					itemId: "card-call",
					turnId: "card-turn",
					role: "assistant",
					content: [
						{
							type: "tool_call",
							name: "set_tasks",
							toolCallId: "tasks",
							state: "completed",
							inputPreview: JSON.stringify({ tasks: [{ task: "Inspect", completed: true }] }),
						},
						{
							type: "tool_call",
							name: "bash",
							toolCallId: "inspect",
							state: "completed",
							inputPreview: JSON.stringify({ command: "pwd" }),
						},
					],
				},
				{
					...base,
					itemId: "card-result",
					turnId: "card-turn",
					role: "tool",
					content: [
						{ type: "tool_result", toolCallId: "inspect", name: "bash", output: "/workspace", isError: false },
						{
							type: "tool_result",
							toolCallId: "tasks",
							name: "set_tasks",
							output: "- [x] Inspect",
							isError: false,
						},
					],
				},
				{ ...base, itemId: "hidden-plan-call", role: "assistant", content: [] },
				{
					...base,
					itemId: "card-plan",
					role: "assistant",
					content: [
						{
							type: "plan",
							plan: {
								planId: "plan",
								revision: 1,
								title: "Improve transcript",
								status: "proposed",
								markdown: "Body shown only in the side panel",
								createdAt: base.createdAt,
							},
						},
					],
				},
				{
					...base,
					itemId: "card-answer",
					turnId: "card-turn",
					role: "assistant",
					content: [{ type: "text", text: "Ready for your review." }],
				},
				{ ...base, itemId: "hidden-plan-result", role: "assistant", content: [] },
			);
		}
		return initial;
	});
	const [older, setOlder] = useState(true);
	const [submittedTurnId, setSubmittedTurnId] = useState<string>();
	const [session, setSession] = useState(sessionId);
	const send = async (input: ComposerSubmission) => {
		(globalThis as typeof globalThis & { quoteSubmission?: ComposerSubmission }).quoteSubmission = input;
		if (params.has("submission") && input.text === "fail") throw new Error("Send failed");
		if (params.has("submission") && input.text === "queue") return;
		const user: ItemView = {
			itemId: `sent-${items.length}`,
			sessionId: session,
			turnId: `sent-turn-${items.length}`,
			role: "user",
			state: "completed",
			content: [{ type: "text", text: input.text }],
			createdAt: new Date().toISOString(),
			...(input.conversationQuotes?.length ? { conversationQuotes: input.conversationQuotes } : {}),
		};
		const next = [...items, user];
		localStorage.setItem(quoteStorage, JSON.stringify(next));
		setItems(next);
		setSubmittedTurnId(user.turnId);
	};
	return (
		<ConversationQuoteProvider enabled>
			<main className="fixture-workspace">
				<header>
					<span>产品资料整理</span>
					<div>
						{params.has("streaming") && (
							<button
								type="button"
								onClick={() =>
									setItems((previous) => previous.map((item) => ({ ...item, state: "completed" })))
								}
							>
								Finish reply
							</button>
						)}
						<button type="button" onClick={() => setItems((previous) => [...previous, ...messages(122)])}>
							Append reply
						</button>
						<button
							type="button"
							onClick={() => {
								setSession((current) =>
									current === sessionId ? "22222222-2222-4222-8222-222222222222" : sessionId,
								);
								setOlder(false);
								setItems(messages(0));
							}}
						>
							Switch session
						</button>
					</div>
				</header>
				<Transcript
					submittedTurnId={submittedTurnId}
					activeTurnId={submittedTurnId ?? (params.has("running") ? items.at(-1)?.turnId : undefined)}
					quoteSessionId={params.has("quotes") ? session : undefined}
					appearance={params.get("mode") === "code" ? "code" : "chat"}
					showNavigation={params.get("surface") !== "editor"}
					itemIds={items.map((item) => item.itemId)}
					itemsById={new Map(items.map((item) => [item.itemId, { ...item, sessionId: session }]))}
					hasOlder={older && !params.has("references")}
					loadingOlder={false}
					autoLoadOlder
					onLoadOlder={async () => {
						setItems((previous) => [...messages(-1), ...previous]);
						setOlder(false);
					}}
				/>
				{params.has("terminal") && (
					<div style={{ position: "relative", height: 130, flex: "0 0 130px" }}>
						<TerminalPanel
							api={
								{
									createTerminal: async () => undefined,
									resizeTerminal: async () => undefined,
									writeTerminal: async () => undefined,
									subscribeTerminal: () => () => undefined,
								} as unknown as MetisDesktopApi
							}
							cwd="/isolated-fixture"
							terminalId="fixture-terminal"
							theme={params.get("theme") === "light" ? "light" : "dark"}
							visible
						/>
					</div>
				)}
				{params.has("quotes") ? (
					<div className="fixture-quote-composer">
						<Composer
							key={session}
							appearance={params.get("mode") === "code" ? "code" : "chat"}
							disabled={false}
							running={false}
							selectionSessionId={session}
							inputId={`composer-input-${session}`}
							onSubmit={send}
							onInterrupt={async () => {}}
						/>
					</div>
				) : (
					<footer>
						发送消息给 Metis <span>＋</span>
					</footer>
				)}
			</main>
		</ConversationQuoteProvider>
	);
}
await setLocale("zh-CN");
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Fixture />
	</StrictMode>,
);
