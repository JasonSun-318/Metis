import type { ItemView } from "@metis/app-protocol";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
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
			...(index % 10 === 0
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
					text: `第 ${index + 1} 条回答\n\n已整理为独立主题笔记，保留了资料来源，并关联到现有知识点。\n\n${"每篇笔记只围绕一个明确主题展开，避免为拆分而拆分。\n\n".repeat((index % 5) + 1)}`,
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
				hasOlder={older}
				loadingOlder={false}
				autoLoadOlder
				onLoadOlder={async () => {
					setItems((previous) => [...messages(-1), ...previous]);
					setOlder(false);
				}}
			/>
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
