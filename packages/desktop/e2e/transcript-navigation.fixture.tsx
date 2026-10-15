import type { ItemView } from "@metis/app-protocol";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { TerminalPanel } from "../src/renderer/components/TerminalPanel.tsx";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { setLocale } from "../src/renderer/i18n.ts";

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
			...(params.has("references") && index === 0 ? {
				content: [{ type: "text" as const, text: "翻译一下 [literal.md:1–8]" }],
				fileSelections: [
					{ name: "AGENTS.md", source: "workspace" as const, selectedText: "# 1. Language and communication\n\n- Default language: Chinese.\n- Preserve unrelated content.", startLine: 1, endLine: 8 },
					{ name: "report.pdf", source: "delivered" as const, selectedText: "Selected document text", target: { kind: "pdf" as const, page: 2, endPage: 3 } },
				],
			} : {}),
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
			content: [
				{
					type: "text",
					text: `第 ${index + 1} 条回答\n\n已整理为独立主题笔记，保留了资料来源，并关联到现有知识点。\n\n${"每篇笔记只围绕一个明确主题展开，避免为拆分而拆分。\n\n".repeat((index % 5) + 1)}` + (params.has("selection") ? [
						"\n\nSelection paragraph: selectable conversation content.",
						"\n\n[Selectable link](https://example.test/)",
						"\n\n| Column | Value |\n| --- | --- |\n| Selection | Table content |",
						"\n\n```ts\nconst selectable = true;\n```",
					].join("") : ""),
				},
			],
		},
	];
}
function Fixture() {
	const [items, setItems] = useState(() => Array.from({ length: Number(params.get("count") ?? 121) }, (_, index) => messages(index)).flat());
	const [older, setOlder] = useState(true);
	const [session, setSession] = useState(sessionId);
	return (
		<main className="fixture-workspace">
			<header>
				<span>产品资料整理</span>
				<div>
					<button type="button" onClick={() => setItems((previous) => [...previous, ...messages(122)])}>
						Append reply
					</button>
					<button
						type="button"
						onClick={() => {
							setSession("22222222-2222-4222-8222-222222222222");
						setOlder(false);
							setItems(messages(0));
						}}
					>
						Switch session
					</button>
				</div>
			</header>
			<Transcript
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
			{params.has("terminal") && <div style={{ position: "relative", height: 130, flex: "0 0 130px" }}>
				<TerminalPanel api={{ createTerminal: async () => undefined, resizeTerminal: async () => undefined,
					writeTerminal: async () => undefined, subscribeTerminal: () => () => undefined } as unknown as MetisDesktopApi}
					cwd="/isolated-fixture" terminalId="fixture-terminal" theme={params.get("theme") === "light" ? "light" : "dark"} visible />
			</div>}
			<footer>
				发送消息给 Metis <span>＋</span>
			</footer>
		</main>
	);
}
await setLocale("zh-CN");
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Fixture />
	</StrictMode>,
);
