import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { KnowledgeGraph } from "../src/renderer/components/KnowledgeGraph.tsx";
import type { KnowledgeGraphData } from "../src/renderer/components/knowledge-graph-layout.ts";
import { setLocale } from "../src/renderer/i18n.ts";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const titles = [
	"资料总览",
	"知识库边界",
	"知识点拆分",
	"主题笔记",
	"资料来源",
	"语义链接",
	"复用已有知识",
	"目录与子目录",
	"对话链接",
	"完整路径",
	"多知识库",
	"知识检索",
	"交互设计",
	"节点拖动",
	"弹簧连接",
	"节点斥力",
	"自动适配",
	"鼠标缩放",
];
const count = Number(params.get("count") ?? titles.length);
const graph: KnowledgeGraphData = {
	notes: Array.from({ length: count }, (_, index) => ({
		path: `主题/笔记${index}.md`,
		title: titles[index] ?? `知识点 ${index}`,
		links: [],
	})),
	edges: Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
		source: `主题/笔记${Math.floor(index / 3)}.md`,
		target: `主题/笔记${index + 1}.md`,
	})),
	warnings: [],
};

function Fixture() {
	const [data, setData] = useState(graph);
	const [opened, setOpened] = useState("");
	return (
		<aside className="knowledge-panel">
			<div className="knowledge-toolbar">
				<strong>产品资料</strong>
				<button onClick={() => setData(structuredClone(graph))} type="button" aria-label="Refresh">
					刷新
				</button>
			</div>
			<KnowledgeGraph graph={data} onOpen={setOpened} />
			<div className="knowledge-footer">
				<span>/资料/产品资料</span>
				<span>{count} 篇笔记</span>
			</div>
			<output data-opened-note>{opened}</output>
		</aside>
	);
}

await setLocale("en");
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Fixture />
	</StrictMode>,
);
