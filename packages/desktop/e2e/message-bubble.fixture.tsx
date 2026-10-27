import type { AgentMode, ItemView } from "@metis/app-protocol";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const params = new URLSearchParams(location.search);
const mode: AgentMode = params.get("mode") === "code" ? "code" : "chat";
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.style.setProperty("--content-font-size", params.get("font") === "20" ? "20px" : "13px");
setLocale("en");
document.documentElement.style.setProperty("--fixture-columns", mode === "code" ? "3" : "2");

const longText = [
	"OpenDesign 修复验收：仅回复",
	"METIS_OPENDESIGN_APP_OK_METIS_BROWSER_TOOL_APP_OK_METIS_DEEPSEEK_FINAL_APP_OK",
	`https://example.test/resource_name_without_breaks?token=${"A".repeat(120)}`,
	`/Users/example/Desktop/${"unbroken_directory_name_".repeat(6)}report.md`,
	"    find /Users/example/.Trash -mindepth 1 -maxdepth 1 -print0 | xargs -0 stat -f '%N|%HT|%z|%Sm'",
	"\t缩进、换行和原文应当保留。",
].join("\n");
const codeLine = `printf '${"unbroken_code_token_".repeat(24)}'`;
const shortText = "短消息 hello";

function Conversation({ owner }: { readonly owner: "main" | "agent" | "detail" }) {
	const agent = owner !== "main";
	const [copied, setCopied] = useState("");
	const sessionId = agent ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111";
	const base = { sessionId, state: "completed" as const, createdAt: "2026-10-25T00:00:00Z" };
	const items: ItemView[] = [
		{
			...base,
			itemId: `${sessionId}-long`,
			turnId: "long-turn",
			role: "user",
			...(agent ? { origin: { kind: "agent" as const, sessionId: "11111111-1111-4111-8111-111111111111" } } : {}),
			content: [{ type: "text", text: longText }],
		},
		{
			...base,
			itemId: `${sessionId}-answer`,
			turnId: "long-turn",
			role: "assistant",
			content: [{ type: "text", text: `代码块保留原有横向滚动：\n\n\`\`\`sh\n${codeLine}\n\`\`\`` }],
		},
		{
			...base,
			itemId: `${sessionId}-short`,
			turnId: "short-turn",
			role: "user",
			content: [{ type: "text", text: shortText }],
		},
	];
	return (
		<div
			className={`fixture-conversation conversation-column${owner === "agent" ? " agent-conversation" : owner === "detail" ? " subagent-detail" : ""}`}
			data-owner={owner}
			data-copied-text={copied}
			data-source-text={longText}
			data-code-line={codeLine}
		>
			<header className={agent ? "agent-conversation-header" : "fixture-header"}>
				{owner === "detail" ? "Sidebar agent detail" : agent ? "Child agent conversation" : "Main conversation"} ·{" "}
				{mode}
			</header>
			<Transcript
				appearance={mode}
				hasOlder={false}
				loadingOlder={false}
				itemIds={items.map((item) => item.itemId)}
				itemsById={new Map(items.map((item) => [item.itemId, item]))}
				onLoadOlder={async () => undefined}
				onCopy={setCopied}
			/>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<main className="fixture-grid">
			<Conversation owner="main" />
			<Conversation owner="agent" />
			{mode === "code" && <Conversation owner="detail" />}
		</main>
	</StrictMode>,
);
