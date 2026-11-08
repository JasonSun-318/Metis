import type { AgentMode, ItemView } from "@metis/app-protocol";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationScopeContext } from "../src/renderer/components/ConversationScope.tsx";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const params = new URLSearchParams(location.search);
const mode: AgentMode = params.get("mode") === "code" ? "code" : "chat";
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
setLocale("zh-CN");
const sessionId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const base = { sessionId, state: "completed" as const, createdAt: "2026-11-05T00:00:00Z" };
const tree = `Claude-Desktop-Shell-Spec/          748K
├── README.md                        14K
├── preview.html                     60K
├── preview.png                     210K  ← 最大单文件
└── demo/
    └── ${"unbroken_directory_name_".repeat(8)} END_OF_TREE`;
const report: ItemView = {
	...base,
	itemId: "report",
	role: "system",
	origin: { kind: "system", eventId: "report" },
	agentTargetId: agentId,
	agentReport: { name: "Trash read-only inventory", status: "done" },
	content: [
		{
			type: "text",
			text: "已完成只读检查，**没有修改任何文件**。\n\n| 目录 | 结果 |\n| --- | --- |\n| 桌面 | 发现 3 个文件夹 |\n| 回收站 | 发现 2 个项目 |\n\n需要你确认是否继续处理。",
		},
	],
};
const items: ItemView[] = [
	{ ...base, itemId: "user", role: "user", content: [{ type: "text", text: "好的，随时叫我。" }] },
	{
		...report,
		itemId: "receipt",
		agentReport: undefined,
		agentMessageId: "input",
		content: [{ type: "text", text: "Hidden intervention receipt" }],
	},
	report,
	{
		...base,
		itemId: "parent",
		role: "assistant",
		content: [{ type: "text", text: "子代理已经完成检查。你希望继续处理哪一部分？" }],
	},
	{
		...report,
		itemId: "failure",
		agentReport: { name: `归档检查 ${"较长的子代理名称".repeat(10)}`, status: "failed" },
		content: [
			{
				type: "text",
				text: `无法访问目录：/Users/example/${"long_directory_".repeat(12)}。\n\n请确认目录访问权限后重试。`,
			},
		],
	},
	{
		...base,
		itemId: "instruction",
		role: "user",
		origin: { kind: "agent", sessionId },
		content: [{ type: "text", text: "检查目录并保留原有缩进。" }],
	},
	{
		...report,
		itemId: "tree",
		content: [{ type: "text", text: `**A. 目录树（3 层）**\n\n\`\`\`text\n${tree}\n\`\`\`` }],
	},
	{ ...report, itemId: "short", content: [{ type: "text", text: "好的，随时叫我。" }] },
	{ ...base, itemId: "user-emoji", role: "user", content: [{ type: "text", text: "👌" }] },
	{ ...report, itemId: "emoji", content: [{ type: "text", text: "👌" }] },
];

function Fixture() {
	const [opened, setOpened] = useState("");
	return (
		<ConversationScopeContext.Provider
			value={{
				rootSessionId: sessionId,
				openAgent: (target) => setOpened(`${target.agentId}:${target.name}`),
				openParent: () => setOpened(`parent:${sessionId}`),
			}}
		>
			<main className="conversation-column fixture-conversation" data-opened={opened} data-code-tree={tree}>
				<Transcript
					appearance={mode}
					hasOlder={false}
					loadingOlder={false}
					itemIds={items.map((item) => item.itemId)}
					itemsById={new Map(items.map((item) => [item.itemId, item]))}
					onLoadOlder={async () => undefined}
				/>
			</main>
		</ConversationScopeContext.Provider>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
