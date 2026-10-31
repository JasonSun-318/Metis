import type { CodeFileChangeView, ItemView } from "@metis/app-protocol";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeChangesNavigationContext } from "../src/renderer/components/CodeChangesNavigationContext.ts";
import { CodeTranscriptTurn } from "../src/renderer/components/CodeTranscriptTurn.tsx";
import { DeliveredFileCard } from "../src/renderer/components/DeliveredFileCard.tsx";
import { FileSelectionPopover } from "../src/renderer/components/preview/FileSelectionPopover.tsx";
import { ReviewPanel } from "../src/renderer/components/ReviewPanel.tsx";
import { TranscriptTurn } from "../src/renderer/components/TranscriptTurn.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

document.documentElement.dataset.theme = "dark";
const base = { sessionId: "chain", turnId: "turn", createdAt: "2026-10-30T00:00:00Z" };

function Fixture() {
	const [complete, setComplete] = useState(false);
	const [revision, setRevision] = useState(0);
	const thought = `先核对列名。\n\n${Array.from({ length: 20 }, (_, i) => `${i + 1}. **检查字段**：保留格式并确认数据类型。`).join("\n")}\n\n${new URLSearchParams(location.search).has("long") ? "这是持续生成的较长思考内容。".repeat(60) : `正在核对第 ${revision} 列。`}`;
	const items: ItemView[] = [
		{
			...base,
			itemId: "thinking",
			role: "assistant",
			state: complete ? "completed" : "streaming",
			content: [{ type: "thinking", text: thought }],
		},
	];
	if (complete)
		items.push(
			{
				...base,
				itemId: "work",
				role: "assistant",
				state: "completed",
				content: [
					{
						type: "tool_call",
						toolCallId: "command",
						name: "bash",
						state: "completed",
						inputPreview: '{"command":"pwd"}',
					},
					{ type: "thinking", text: "第二段思考。\n\n".repeat(30) },
				],
			},
			{
				...base,
				itemId: "result",
				role: "tool",
				state: "completed",
				content: [
					{
						type: "tool_result",
						toolCallId: "command",
						name: "bash",
						isError: false,
						output: "检查输出。\n".repeat(40),
					},
				],
			},
			{
				...base,
				itemId: "answer",
				role: "assistant",
				state: "completed",
				content: [{ type: "text", text: "| 字段 | 状态 |\n| --- | --- |\n| 标题 | 已确认 |" }],
			},
		);
	return (
		<main style={{ maxWidth: 760, margin: "40px auto", padding: 20 }}>
			<nav style={{ display: "flex", gap: 20, marginBottom: 40 }}>
				<button onClick={() => setRevision((value) => value + 1)} type="button">
					追加思考
				</button>
				<button onClick={() => setComplete(true)} type="button">
					完成任务
				</button>
			</nav>
			<TranscriptTurn items={items} running={!complete} />
		</main>
	);
}

const textFiles: CodeFileChangeView[] = [
	{
		path: "src/triple.mjs",
		kind: "added" as const,
		additions: 3,
		deletions: 0,
		diff: "--- /dev/null\n+++ b/src/triple.mjs\n@@ -0,0 +1,3 @@\n+export function triple(n) {\n+  return n * 3;\n+}\n",
	},
	{
		path: "src/triple.test.mjs",
		kind: "added" as const,
		additions: 7,
		deletions: 0,
		diff: "--- /dev/null\n+++ b/src/triple.test.mjs\n@@ -0,0 +1,7 @@\n+import test from 'node:test';\n+import assert from 'node:assert/strict';\n+import { triple } from './triple.mjs';\n+\n+test('triple scales numbers', () => {\n+  assert.equal(triple(3), 9);\n+});\n",
	},
];
if (new URLSearchParams(location.search).has("modified"))
	textFiles[0] = {
		path: "src/triple.mjs",
		kind: "modified",
		additions: 1,
		deletions: 1,
		diff: "--- a/src/triple.mjs\n+++ b/src/triple.mjs\n@@ -1,3 +1,3 @@\n export function triple(n) {\n-  return n * 2;\n+  return n * 3;\n }\n",
	};
const edgeFiles = [
	textFiles[0]!,
	{ path: "../../../private/tmp/metis.icns", kind: "added" as const, binary: true },
	{ path: "../../../private/tmp/metis.rsrc", kind: "added" as const, additions: 0, deletions: 0 },
];
const files = new URLSearchParams(location.search).has("edge")
	? edgeFiles
	: new URLSearchParams(location.search).has("many")
		? [
				...textFiles,
				...Array.from(
					{ length: 8 },
					(_, i): CodeFileChangeView => ({ path: `src/extra-${i}.ts`, kind: "added", additions: 1, deletions: 0 }),
				),
			]
		: textFiles;
const turn = {
	additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
	deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
	partial: false,
};
const changes = { version: 1 as const, sequence: 1, partial: false, turn, files, turnFiles: files };
const operations = [
	{
		id: "list",
		name: "bash",
		input: '{"command":"ls -la && node --version"}',
		output:
			"total 0\ndrwxr-xr-x  3 user  staff   96 Oct 30 10:56 .\ndrwxr-xr-x  6 user  staff  192 Oct 30 10:54 ..\nv22.23.2",
	},
	...files.map((file, i) => ({
		id: `create-${i}`,
		name: "write",
		input: JSON.stringify({ path: file.path }),
		output: "Created file",
		changes: { ...changes, sequence: i + 1, files: [file] },
	})),
	{
		id: "test",
		name: "bash",
		input: '{"command":"node --test src/triple.test.mjs"}',
		output: "✔ triple scales numbers\nℹ tests 1\nℹ pass 1\nℹ fail 0",
	},
	{
		id: "status",
		name: "bash",
		input: '{"command":"git status --short"}',
		output: "?? src/triple.mjs\n?? src/triple.test.mjs",
	},
];
const codeItems: ItemView[] = [
	{
		...base,
		itemId: "code-user",
		role: "user",
		state: "completed",
		content: [{ type: "text", text: "创建 triple 函数和测试，并运行验证。" }],
	},
	...operations.flatMap((operation): ItemView[] => [
		{
			...base,
			itemId: `${operation.id}-call`,
			role: "assistant",
			state: "completed",
			content: [
				{
					type: "tool_call",
					toolCallId: operation.id,
					name: operation.name,
					state: "completed",
					inputPreview: operation.input,
				},
			],
		},
		{
			...base,
			itemId: `${operation.id}-result`,
			role: "tool",
			state: "completed",
			content: [
				{
					type: "tool_result",
					toolCallId: operation.id,
					name: operation.name,
					isError: false,
					output: operation.output,
					...("changes" in operation ? { codeChanges: operation.changes } : {}),
				},
			],
		},
	]),
	{
		...base,
		itemId: "code-final",
		role: "assistant",
		state: "completed",
		content: [
			{ type: "text", text: "已创建 **triple.mjs** 和 **triple.test.mjs**，验证通过。\n\n`triple(3)` 返回 `9`。" },
		],
	},
];
const reviewApi = {
	getWorkspaceReview: async () => ({
		kind: "review",
		repositoryRoot: "/tmp/project",
		branch: "main",
		head: null,
		revision: "working-tree",
		commits: [],
		files: textFiles.map((file) => ({
			relativePath: file.path,
			previousRelativePath: null,
			status: file.kind,
			additions: file.additions,
			deletions: file.deletions,
			binary: false,
		})),
	}),
	getWorkspaceReviewFileDiff: async ({ relativePath }: { relativePath: string }) => ({
		kind: "text",
		patch: textFiles.find((file) => file.path === relativePath)?.diff ?? "",
	}),
} as unknown as MetisDesktopApi;
function CodeFixture() {
	const [focus, setFocus] = useState<{ id: string; path?: string }>();
	return (
		<CodeChangesNavigationContext.Provider value={(_sessionId, path) => setFocus({ id: crypto.randomUUID(), path })}>
			<div style={{ display: "flex", height: "100vh" }}>
				<main className="transcript-code" style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "40px 24px" }}>
					<div style={{ maxWidth: 780, margin: "0 auto" }}>
						<CodeTranscriptTurn items={codeItems} />
					</div>
				</main>
				{focus && (
					<aside
						style={{
							position: "relative",
							flex: "none",
							width: "40%",
							borderLeft: "1px solid var(--surface-10)",
						}}
					>
						<ReviewPanel api={reviewApi} sessionId="chain" theme="dark" visible focusRequest={focus} />
					</aside>
				)}
			</div>
		</CodeChangesNavigationContext.Provider>
	);
}

function FileControlsFixture() {
	const [anchor, setAnchor] = useState<HTMLElement | null>(null);
	return (
		<main style={{ maxWidth: 760, margin: "40px auto", padding: 20 }}>
			<DeliveredFileCard
				file={{
					fileId: "0123456789abcdef",
					name: "report.pptx",
					byteLength: 100,
					availability: "available",
					deliveredAt: "2026-10-30T00:00:00Z",
				}}
				onOpen={() => undefined}
				onPreview={() => undefined}
			/>
			<button type="button" style={{ marginTop: 40 }} onClick={(event) => setAnchor(event.currentTarget)}>
				选择标题
			</button>
			{anchor && (
				<FileSelectionPopover
					selection={{
						id: "selection",
						sessionId: "session",
						name: "report.pptx",
						input: {
							source: "workspace",
							relativePath: "report.pptx",
							basis: "source",
							selectedText: "Claude 入门",
						},
					}}
					range={anchor}
					open
					enabled
					onAdd={() => undefined}
					onRequestChange={async () => undefined}
					onDismiss={() => setAnchor(null)}
					onAccepted={() => undefined}
				/>
			)}
		</main>
	);
}

void setLocale(new URLSearchParams(location.search).has("english") ? "en" : "zh-CN").then(() =>
	createRoot(document.getElementById("root")!).render(
		new URLSearchParams(location.search).has("code") ? (
			<CodeFixture />
		) : new URLSearchParams(location.search).has("controls") ? (
			<FileControlsFixture />
		) : (
			<Fixture />
		),
	),
);
