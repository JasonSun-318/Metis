import { createRoot } from "react-dom/client";
import { AskUserAnswerSummary } from "../src/renderer/components/AskUserAnswerSummary.tsx";
import { SessionStatusPanel } from "../src/renderer/components/SessionStatusPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.motion = new URLSearchParams(location.search).get("motion") ?? "full";
void setLocale("zh-CN").then(() =>
	createRoot(document.getElementById("root")!).render(
		<main style={{ width: "100%", maxWidth: 760, margin: "60px auto", padding: 16 }}>
			<AskUserAnswerSummary
				result={{
					type: "tool_result",
					toolCallId: "answer",
					name: "ask_user",
					isError: false,
					output: `User answers:\n${JSON.stringify([
						{ question: "是否修改权限和显示方式？", selected: ["可以，按已确认方案执行。"] },
						{ question: "是否统一展开动画？", selected: ["统一使用抽屉动画。"] },
					])}`,
				}}
			/>
			<SessionStatusPanel
				loading={false}
				onClose={() => undefined}
				status={{
					sessionId: "fixture",
					mode: "chat",
					contextTokens: 15_000,
					contextWindow: 1_000_000,
					contextBasis: "reported_total",
					remainingPercent: 98.5,
					cacheHitPercent: 99,
					contextBreakdown: [
						{ category: "system_prompt", tokens: 1700 },
						{ category: "tool_definitions", tokens: 5700 },
						{ category: "skills", tokens: 600 },
						{ category: "conversation", tokens: 7000 },
					],
				}}
			/>
		</main>,
	),
);
