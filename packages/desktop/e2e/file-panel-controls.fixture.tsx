import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePanel, type WorkspaceFileDraft } from "../src/renderer/components/FilePanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type {
	DesktopWorkspaceEntry,
	DesktopWorkspaceFile,
	DesktopWorkspaceMutationInput,
	DesktopWorkspaceMutationResult,
	MetisDesktopApi,
} from "../src/shared/desktop-api.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";
import "../src/renderer/styles/file-panel-controls.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.motion = params.has("reduced") ? "reduced" : "full";
const text = "# File controls fixture\n\nOnly in-memory files are used.\n";
const file = (relativePath: string): Extract<DesktopWorkspaceFile, { kind: "text" }> => ({
	kind: "text",
	relativePath,
	absolutePath: `/fixture/project/${relativePath}`,
	text,
	revision: "fixture-1",
	byteLength: text.length,
});
const directories: Record<string, DesktopWorkspaceEntry[]> = {
	"": [
		{ name: "notes", relativePath: "notes", kind: "directory" },
		{ name: "README.md", relativePath: "README.md", kind: "file" },
		{
			name: "a-very-long-file-name-for-ellipsis-validation.txt",
			relativePath: "a-very-long-file-name-for-ellipsis-validation.txt",
			kind: "file",
		},
	],
	notes: [{ name: "child.md", relativePath: "notes/child.md", kind: "file" }],
};
const calls = {
	clipboard: [] as string[],
	opens: [] as string[],
	saves: 0,
	mutations: [] as string[],
	errors: [] as string[],
};
const api = {
	listWorkspaceDirectory: async ({ relativePath }: { relativePath: string }) =>
		structuredClone(directories[relativePath] ?? []),
	readWorkspaceFile: async ({ relativePath }: { relativePath: string }) => file(relativePath),
	searchWorkspaceFiles: async () => [],
	writeClipboardText: async ({ text: value }: { text: string }) => {
		calls.clipboard.push(value);
	},
	openWorkspaceFile: async ({ action }: { action: string }) => {
		calls.opens.push(action);
	},
	subscribe: () => () => undefined,
	mutateWorkspaceEntry: async (input: DesktopWorkspaceMutationInput): Promise<DesktopWorkspaceMutationResult> => {
		if (input.action !== "rename") throw new Error("Only in-memory rename is supported by this fixture");
		calls.mutations.push(input.name);
		const entries = directories[""];
		const entry = entries.find((candidate) => candidate.relativePath === input.relativePath);
		if (!entry || entry.kind === "symlink") throw new Error("Unknown fixture rename target");
		directories[""] = entries.map((candidate) =>
			candidate === entry ? { ...candidate, name: input.name, relativePath: input.name } : candidate,
		);
		return {
			action: "rename",
			kind: entry.kind,
			previousRelativePath: input.relativePath,
			previousAbsolutePath: `/fixture/project/${input.relativePath}`,
			relativePath: input.name,
			absolutePath: `/fixture/project/${input.name}`,
		};
	},
} satisfies Partial<MetisDesktopApi>;

function Fixture() {
	const [active, setActive] = useState("README.md");
	const [expanded, setExpanded] = useState<readonly string[]>([]);
	const [draft, setDraft] = useState<WorkspaceFileDraft>({ file: file(active), text, savedText: text });
	const [visible, setVisible] = useState(true);
	const [mounted, setMounted] = useState(true);
	const [width, setWidth] = useState(Number(params.get("width")) || 1100);
	const onError = useCallback((cause: unknown) => {
		calls.errors.push(cause instanceof Error ? cause.message : String(cause));
	}, []);
	Object.assign(window, { __filePanelFixture: { setVisible, setMounted, setWidth, calls } });
	return (
		<main
			className="file-controls-fixture"
			style={{ width, maxWidth: "100vw", height: "100vh", marginLeft: "auto", display: "flex" }}
		>
			{mounted && (
				<FilePanel
					activePath={active}
					api={api as unknown as MetisDesktopApi}
					cwd="/fixture/project"
					draft={draft}
					dirtyPaths={draft.text === draft.savedText ? [] : [active]}
					expandedPaths={expanded}
					onDraftChange={(value) => setDraft((current) => ({ ...current, text: value }))}
					onDraftLoaded={(loaded) => setDraft({ file: loaded, text: loaded.text, savedText: loaded.text })}
					onExpandedPathsChange={setExpanded}
					onOpenFile={setActive}
					onError={onError}
					onSave={async () => {
						calls.saves += 1;
						setDraft((current) => ({ ...current, savedText: current.text }));
					}}
					onWorkspaceMutation={() => undefined}
					saving={false}
					savingPaths={[]}
					sessionId="11111111-1111-4111-8111-111111111111"
					visible={visible}
				/>
			)}
		</main>
	);
}
await setLocale(params.get("locale") === "zh-CN" ? "zh-CN" : "en");
createRoot(document.getElementById("root")!).render(<Fixture />);
