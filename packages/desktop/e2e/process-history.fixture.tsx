import type { ClientParams, SessionProcessView } from "@metis/app-protocol";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProcessPanel } from "../src/renderer/components/ProcessPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
setLocale("zh-CN");
const sessionId = "11111111-1111-4111-8111-111111111111";
let revision = 0;
let reads = 0;
let pendingReads = 0;
let peakPendingReads = 0;
const records: SessionProcessView[] = Array.from({ length: Number(params.get("count") ?? 2) }, (_, index) => ({
	processId: `command-${index}`,
	startedAt: index === 0 ? "2026-10-11T12:00:00.000Z" : "2026-10-12T13:24:56.000Z",
	turnId: "turn",
	command: index === 0 ? "printf 'first\\n'" : "printf 'second\\n'",
	output: index === 0 ? "first\n" : `second\n${index}\n`,
	state: "completed",
	truncated: false,
}));
const api = {
	readProcess: async (input: ClientParams<"session/readProcess">) => {
		document.body.dataset.reads = String(++reads);
		document.body.dataset.pendingReads = String(++pendingReads);
		peakPendingReads = Math.max(peakPendingReads, pendingReads);
		document.body.dataset.peakPendingReads = String(peakPendingReads);
		if (params.has("delay")) await new Promise((resolve) => setTimeout(resolve, Number(params.get("delay")) || 150));
		const index = input.processId
			? records.findIndex((record) => record.processId === input.processId)
			: (input.index ?? records.length - 1);
		document.body.dataset.pendingReads = String(--pendingReads);
		return { index, total: records.length, process: records[index] ?? null };
	},
};
const onError = (error: unknown) => {
	throw error;
};
function Fixture() {
	const [latest, setLatest] = useState<SessionProcessView>();
	const [visible, setVisible] = useState(true);
	return (
		<>
			<nav className="fixture-toolbar">
				<button
					type="button"
					onClick={() => {
						const record: SessionProcessView = {
							processId: `command-${records.length}`,
							startedAt: "2026-11-06T12:00:00.000Z",
							turnId: "next-turn",
							revision: ++revision,
							command: "echo live",
							output: "live\n",
							state: "running",
							truncated: false,
						};
						records.push(record);
						setLatest(record);
					}}
				>
					New command
				</button>
				<button
					type="button"
					onClick={() => {
						const record = { ...records.at(-1)!, output: `${records.at(-1)!.output}more\n` };
						records[records.length - 1] = record;
						setLatest(record);
					}}
				>
					More output
				</button>
				<button type="button" onClick={() => setVisible((value) => !value)}>
					Toggle panel
				</button>
			</nav>
			<main style={{ position: "relative", height: 620 }}>
				<ProcessPanel
					api={api}
					sessionId={sessionId}
					process={latest}
					panelId="history"
					theme={theme}
					visible={visible}
					onError={onError}
				/>
			</main>
		</>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
