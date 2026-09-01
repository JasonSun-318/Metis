// @vitest-environment jsdom

import type { DeclarativeHookView, McpCatalogEntryView, McpServerSummaryView, SessionSummary, SkillDetailView, SkillSourceView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginsPanel } from "../src/renderer/components/PluginsPanel.tsx";
import { AppStore } from "../src/renderer/store/app-store.ts";

function session(
	sessionId: string,
	cwd: string,
	state: SessionSummary["state"] = "idle",
	cwdOrigin: SessionSummary["cwdOrigin"] = "user-selected",
): SessionSummary {
	return {
		sessionId,
		mode: "chat",
		cwdOrigin,
		cwd,
		name: sessionId,
		createdAt: "2026-07-29T00:00:00.000Z",
		updatedAt: "2026-07-29T00:00:00.000Z",
		state,
		archived: false,
	};
}

function skill(name: string, source: SkillSourceView, instructions = "## Workflow\n\nUse this Skill carefully."): SkillDetailView {
	const content = `---\nname: ${name}\ndescription: ${name} description\n---\n\n${instructions}\n`;
	return {
		name,
		description: `${name} description`,
		source,
		revision: source[0]!.repeat(64),
		directoryPath: `/skills/${name}`,
		entryFile: "SKILL.md",
		files: ["SKILL.md", "references/example.md"],
		content,
		instructions,
		updatedAt: "2026-08-11T08:00:00.000Z",
		editable: source !== "system",
	};
}

const systemSkill = skill("pdf", "system");
const userSkill = skill("writing-plans", "user", "## 工作流程\n\n1. Clarify the goal.\n2. Write the plan.");
const projectSkill = skill("repository", "project");

const mcpServer: McpServerSummaryView = {
	name: "github",
	scope: "user",
	effective: true,
	revision: "a".repeat(64),
	transport: "http",
	enabled: true,
	required: false,
	url: "https://mcp.example.test/rpc",
	disabledTools: [],
	state: "connected",
	credentialConfigured: false,
	toolCount: 1,
	resourceCount: 0,
	resourceTemplateCount: 0,
	promptCount: 0,
	capabilities: ["tools"],
};

const sampleHook: DeclarativeHookView = {
	id: "hook-1",
	name: "lint-on-save",
	enabled: true,
	event: "PreToolUse",
	matcher: "write_to_file",
	runMode: "shell",
	command: "npm run lint",
	statusMessage: "Running linter...",
	timeoutSeconds: 30,
};

function api() {
	const details = new Map([systemSkill, userSkill, projectSkill].map((detail) => [`${detail.source}:${detail.name}`, detail]));
	const hooks = [sampleHook];
	return {
		listSkills: vi.fn().mockResolvedValue({
			skills: [...details.values()].map(({ name, description, source }) => ({ name, description, source })),
		}),
		getSkill: vi.fn().mockImplementation(({ source, name }) => Promise.resolve(details.get(`${source}:${name}`))),
		upsertSkill: vi.fn().mockImplementation(({ source, name, content }) => Promise.resolve({
			...skill(name, source),
			content,
			instructions: content.split("---\n").at(-1)?.trim() ?? content,
		})),
		removeSkill: vi.fn().mockResolvedValue({
			skills: [systemSkill, projectSkill].map(({ name, description, source }) => ({ name, description, source })),
		}),
		inspectSkillImport: vi.fn().mockResolvedValue({
			revision: "c".repeat(64),
			candidates: [{ id: "demo", name: "demo", description: "Demo Skill", fileCount: 1 }],
		}),
		importSkills: vi.fn().mockResolvedValue({ skills: [] }),
		openSkillFolder: vi.fn().mockResolvedValue(undefined),
		selectProjectFolder: vi.fn().mockResolvedValue("/work/chosen-project"),
		selectAttachmentFiles: vi.fn().mockResolvedValue([]),
		resolveDroppedFiles: vi.fn().mockReturnValue([]),
		listMcpServers: vi.fn().mockResolvedValue({ servers: [mcpServer] }),
		inspectMcpImport: vi.fn().mockResolvedValue({
			sourceRevision: "d".repeat(64),
			candidates: [
				{ id: "docs", name: "docs", transport: "http", enabled: true, existingRevision: null, bearerTokenConfigured: true, credentialNames: ["DOCS_KEY"] },
				{ id: "github", name: "github", transport: "http", enabled: true, existingRevision: mcpServer.revision, bearerTokenConfigured: false, credentialNames: [] },
			],
		}),
		importMcpServers: vi.fn().mockResolvedValue({ servers: [mcpServer] }),
		getMcpServer: vi.fn().mockResolvedValue({
			server: mcpServer,
			tools: [{ id: "repo_search", name: "repo_search", description: "Search repositories" }],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		}),
		getMcpCatalogItem: vi.fn().mockResolvedValue({
			kind: "tool",
			id: "repo_search",
			name: "repo_search",
			description: "Search repositories",
			inputSchema: '{"type":"object","properties":{"query":{"type":"string"}}}',
		}),
		upsertMcpServer: vi.fn().mockResolvedValue({ servers: [mcpServer] }),
		removeMcpServer: vi.fn().mockResolvedValue({ servers: [] }),
		restartMcpServer: vi.fn().mockResolvedValue({ server: mcpServer, tools: [{ id: "repo_search", name: "repo_search", description: "Search repositories" }], resources: [], resourceTemplates: [], prompts: [] }),
		setMcpCredential: vi.fn(),
		clearMcpCredential: vi.fn(),
		listHooks: vi.fn().mockResolvedValue({ hooks, loadErrors: [] }),
		upsertHook: vi.fn().mockImplementation(({ hook }) => Promise.resolve({ hooks: [hook], loadErrors: [] })),
		deleteHook: vi.fn().mockResolvedValue({ hooks: [], loadErrors: [] }),
	};
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function setInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(container: ParentNode, label: string): T {
	const match = [...container.querySelectorAll("label")].find((candidate) => candidate.firstChild?.textContent?.trim() === label);
	const input = match?.querySelector<T>("input, textarea");
	if (!input) throw new Error(`Missing field: ${label}`);
	return input;
}

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function renderPanel(desktop = api(), live = true, onSkillsChanged = vi.fn(), sessionState: SessionSummary["state"] = "idle", onCreateSkillWithMetis = vi.fn().mockResolvedValue(undefined), cwdOrigin: SessionSummary["cwdOrigin"] = "user-selected") {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const store = new AppStore();
	if (live) store.setSessions({ sessions: [session("live", "/work/project", sessionState, cwdOrigin)], nextAfterSessionId: null });
	const state = live ? { ...store.getSnapshot(), activeSessionId: "live" } : store.getSnapshot();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const renderState = async (nextState: ReturnType<AppStore["getSnapshot"]>) => {
		await act(async () => root.render(<PluginsPanel api={desktop} onCreateSkillWithMetis={onCreateSkillWithMetis} onSkillsChanged={onSkillsChanged} preferences={new Map()} serverReady state={nextState} />));
		await flush();
	};
	await renderState(state);
	await flush();
	return { container, desktop, renderState, root, store };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("PluginsPanel", () => {
	it("navigates through the approved Skill and MCP list/detail sequence", async () => {
		const { container, desktop, root } = await renderPanel();
		expect(container.querySelector(".plugins-catalog-page")).not.toBeNull();
		expect(container.querySelector(".plugins-detail-page")).toBeNull();

		await act(async () => button(container, "writing-plans").click());
		await flush();
		expect(container.querySelector('[data-plugin-detail="skill"]')?.textContent).toContain("工作流程");
		expect(container.querySelector(".plugins-catalog-page")).toBeNull();
		await act(async () => button(container, "Back to Skills").click());
		expect(container.querySelector(".plugins-catalog-page")).not.toBeNull();

		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "github").click());
		await flush();
		expect(container.querySelector('[data-plugin-detail="mcp"]')?.textContent).toContain("repo_search");
		await act(async () => button(container, "repo_search").click());
		await flush();
		expect(desktop.getMcpCatalogItem).toHaveBeenCalledWith({ sessionId: "live", server: "github", kind: "tool", id: "repo_search" });
		expect(container.querySelector('[data-plugin-detail="mcp"]')?.textContent).toContain("query");
		expect(desktop.listSkills).toHaveBeenCalledWith({ sessionId: "live" });
		expect(desktop.listMcpServers).toHaveBeenCalledWith({ sessionId: "live" });
		await act(async () => root.unmount());
	});

	it("reloads Skills through the active session and disables reload while it is running", async () => {
		const changed = vi.fn();
		const desktop = api();
		const { container, root } = await renderPanel(desktop, true, changed);
		expect(desktop.listSkills).toHaveBeenCalledTimes(1);

		await act(async () => button(container, "Reload Skills").click());
		await flush();

		expect(desktop.listSkills).toHaveBeenCalledTimes(2);
		expect(desktop.listSkills).toHaveBeenLastCalledWith({ sessionId: "live" });
		expect(changed).toHaveBeenCalledOnce();
		await act(async () => button(container, "MCP").click());
		expect([...container.querySelectorAll("button")].some((item) => item.getAttribute("aria-label") === "Reload Skills")).toBe(false);
		await act(async () => root.unmount());

		const runningDesktop = api();
		const running = await renderPanel(runningDesktop, true, vi.fn(), "running");
		expect(button(running.container, "Reload Skills").disabled).toBe(true);
		expect(runningDesktop.listSkills).toHaveBeenCalledWith({ cwd: "/work/project" });
		await act(async () => button(running.container, "MCP").click());
		await flush();
		expect(runningDesktop.listMcpServers).toHaveBeenCalledWith({ cwd: "/work/project" });
		await act(async () => running.root.unmount());
	});

	it("keeps catalog filtering local and preserves each tab's query after detail navigation", async () => {
		const { container, desktop, root } = await renderPanel();
		const skillSearch = container.querySelector<HTMLInputElement>('[aria-label="Search Skills"]')!;
		for (let index = 0; index < 20; index += 1) await act(async () => setInput(skillSearch, `plan${index}`));
		await act(async () => setInput(skillSearch, "writing"));
		for (const source of ["User", "All sources", "System", "User", "All sources"]) {
			await act(async () => button(container, "Skill sources").click());
			await act(async () => button(document.body, source).click());
		}
		expect(desktop.listSkills).toHaveBeenCalledTimes(1);
		await act(async () => button(container, "writing-plans").click());
		await flush();
		await act(async () => button(container, "Back to Skills").click());
		expect(container.querySelector<HTMLInputElement>('[aria-label="Search Skills"]')?.value).toBe("writing");

		await act(async () => button(container, "MCP").click());
		await flush();
		const mcpSearch = container.querySelector<HTMLInputElement>('[aria-label="Search MCP servers"]')!;
		await act(async () => setInput(mcpSearch, "git"));
		for (const scope of ["User", "All scopes", "User", "All scopes", "User"]) {
			await act(async () => button(container, "MCP scopes").click());
			await act(async () => button(document.body, scope).click());
		}
		expect(desktop.listMcpServers).toHaveBeenCalledTimes(1);
		await act(async () => button(container, "github").click());
		await flush();
		await act(async () => button(container, "Back to MCP").click());
		expect(container.querySelector<HTMLInputElement>('[aria-label="Search MCP servers"]')?.value).toBe("git");
		expect(container.querySelectorAll(".plugins-list-row")).toHaveLength(1);
		await act(async () => root.unmount());
	});

	it("protects system Skills and sends exact identity, revision, and bytes for user mutations", async () => {
		const changed = vi.fn();
		const desktop = api();
		const { container, root } = await renderPanel(desktop, true, changed);
		await act(async () => button(container, "pdf").click());
		await flush();
		expect([...container.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Edit")).toBe(false);
		expect([...container.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Delete")).toBe(false);
		expect([...container.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Open containing folder")).toBe(false);
		expect(desktop.openSkillFolder).not.toHaveBeenCalled();

		await act(async () => button(container, "Back to Skills").click());
		await act(async () => button(container, "writing-plans").click());
		await flush();
		await act(async () => button(container, "Open containing folder").click());
		expect(desktop.openSkillFolder).toHaveBeenCalledWith({ cwd: "/work/project", source: "user", name: "writing-plans" });
		await act(async () => button(container, "Edit").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		const edited = `${userSkill.content}\n## Extra\n\nKeep it short.\n`;
		await act(async () => setInput(dialog.querySelector("textarea")!, edited));
		await act(async () => button(dialog, "Save").click());
		await flush();
		expect(desktop.upsertSkill).toHaveBeenCalledWith(expect.objectContaining({
			cwd: "/work/project",
			source: "user",
			name: "writing-plans",
			expectedRevision: userSkill.revision,
			content: edited,
		}));

		await act(async () => button(container, "Delete").click());
		expect(desktop.removeSkill).not.toHaveBeenCalled();
		await act(async () => button(container.querySelector('[role="dialog"]')!, "Move to Trash").click());
		await flush();
		expect(desktop.removeSkill).toHaveBeenCalledWith(expect.objectContaining({
			cwd: "/work/project",
			source: "user",
			name: "writing-plans",
		}));
		expect(changed).toHaveBeenCalledTimes(2);
		await act(async () => root.unmount());
	});

	it("requires a Project target before assisted creation without an active cwd", async () => {
		const onCreate = vi.fn().mockResolvedValue(undefined);
		const { container, desktop, root } = await renderPanel(api(), false, vi.fn(), "idle", onCreate);
		expect(desktop.listSkills).toHaveBeenCalledWith({ cwd: null });
		await act(async () => button(container, "New Skill").click());
		const menu = document.body.querySelector<HTMLElement>(".plugins-new-menu")!;
		expect(button(menu, "Project").disabled).toBe(false);
		await act(async () => button(menu, "Project").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(dialog.querySelector("select")).toBeNull();
		expect(button(dialog, "Create in").tagName).toBe("BUTTON");
		const createIn = button(dialog, "Create in");
		await act(async () => createIn.click());
		const projectMenu = dialog.querySelector<HTMLElement>('[role="listbox"][aria-label="Create in"]')!;
		expect(projectMenu).not.toBeNull();
		createIn.focus();
		await act(async () => createIn.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
		expect(container.querySelector('[role="dialog"]')).toBe(dialog);
		expect(dialog.querySelector('[role="listbox"][aria-label="Create in"]')).toBeNull();
		expect(button(dialog, "Create with Metis").disabled).toBe(true);
		await act(async () => button(dialog, "Choose folder…").click());
		await flush();
		expect(button(dialog, "Create with Metis").disabled).toBe(false);
		await act(async () => button(dialog, "Create with Metis").click());
		await flush();
		expect(onCreate).toHaveBeenCalledWith({ source: "project", cwd: "/work/chosen-project" });
		await act(async () => root.unmount());
	});

	it("does not treat a managed Chat workspace as a project target", async () => {
		const { container, desktop, root } = await renderPanel(api(), true, vi.fn(), "idle", vi.fn(), "managed");
		await act(async () => button(container, "New Skill").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "Project").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(dialog.querySelector("select")).toBeNull();
		expect(button(dialog, "Create in").textContent).toContain("Choose a project");
		expect(button(dialog, "Create with Metis").disabled).toBe(true);
		await act(async () => button(dialog, "Cancel").click());
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "New MCP").click());
		const project = button(document.body.querySelector(".plugins-new-menu")!, "Project");
		expect(project.disabled).toBe(false);
		await act(async () => project.click());
		const mcpDialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(button(mcpDialog, "Create in").textContent).toContain("Choose a project");
		await act(async () => button(mcpDialog, "Choose folder…").click());
		await flush();
		expect(desktop.selectProjectFolder).toHaveBeenCalled();
		expect(button(mcpDialog, "Add by URL").disabled).toBe(false);
		await act(async () => root.unmount());
	});

	it("creates a custom Skill from semantic name, description, and instruction fields", async () => {
		const { container, desktop, root } = await renderPanel(api(), false);
		await act(async () => button(container, "New Skill").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "User").click());
		const creationDialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(button(creationDialog, "Close")).not.toBeNull();
		await act(async () => button(creationDialog, "Custom").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(dialog.textContent).toContain("Write skill instructions");
		const fields = dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
		expect(fields).toHaveLength(3);
		await act(async () => setInput(fields[0]!, "daily-brief"));
		await act(async () => setInput(fields[1]!, "Summarize the day when the user asks for a daily brief."));
		await act(async () => setInput(fields[2]!, "Collect the completed work and blockers, then write a concise brief."));
		await act(async () => button(dialog, "Create").click());
		await flush();
		expect(desktop.upsertSkill).toHaveBeenCalledWith(expect.objectContaining({
			cwd: null,
			source: "user",
			name: "daily-brief",
			expectedRevision: null,
			content: '---\nname: daily-brief\ndescription: "Summarize the day when the user asks for a daily brief."\n---\n\nCollect the completed work and blockers, then write a concise brief.\n',
		}));

		await act(async () => button(container, "Back to Skills").click());
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "New MCP").click());
		expect(button(document.body.querySelector(".plugins-new-menu")!, "Project").disabled).toBe(false);
		await act(async () => root.unmount());
	});

	it("keeps a custom project Skill bound to the project chosen in its creation dialog", async () => {
		const desktop = api();
		const { container, root } = await renderPanel(desktop);
		await act(async () => button(container, "New Skill").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "Project").click());
		let dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Choose folder…").click());
		await flush();
		await act(async () => button(dialog, "Custom").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		const fields = dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
		await act(async () => setInput(fields[0]!, "project-brief"));
		await act(async () => setInput(fields[1]!, "Create project briefs."));
		await act(async () => setInput(fields[2]!, "Summarize this project."));
		await act(async () => button(dialog, "Create").click());
		await flush();

		await act(async () => button(container, "Open containing folder").click());
		expect(desktop.openSkillFolder).toHaveBeenCalledWith({
			cwd: "/work/chosen-project",
			source: "project",
			name: "project-brief",
		});
		await act(async () => button(container, "Edit").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Save").click());
		await flush();
		expect(desktop.upsertSkill).toHaveBeenLastCalledWith(expect.objectContaining({
			cwd: "/work/chosen-project",
			source: "project",
			name: "project-brief",
		}));
		await act(async () => root.unmount());
	});

	it("inspects and imports a selected uploaded Skill without losing its target", async () => {
		const changed = vi.fn();
		const desktop = api();
		desktop.selectAttachmentFiles.mockResolvedValue([{ path: "/tmp/demo.skill", name: "demo.skill" }]);
		desktop.importSkills.mockResolvedValue({
			skills: [{ name: "demo", description: "Demo Skill", source: "user" }],
		});
		const { container, root } = await renderPanel(desktop, false, changed);
		await act(async () => button(container, "New Skill").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "User").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Upload Skill").click());
		await act(async () => dialog.querySelector<HTMLButtonElement>(".skill-upload-dropzone")!.click());
		await flush();
		expect(desktop.inspectSkillImport).toHaveBeenCalledWith({
			cwd: null,
			source: "user",
			input: { kind: "archive", path: "/tmp/demo.skill" },
		});
		expect(dialog.textContent).toContain("Demo Skill");
		await act(async () => button(dialog, "Import selected").click());
		await flush();
		expect(desktop.importSkills).toHaveBeenCalledWith(expect.objectContaining({
			cwd: null,
			source: "user",
			input: { kind: "archive", path: "/tmp/demo.skill" },
			sourceRevision: "c".repeat(64),
			candidateIds: ["demo"],
		}));
		expect(changed).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => root.unmount());
	});

	it("passes a public GitHub URL to inspection", async () => {
		const desktop = api();
		const { container, root } = await renderPanel(desktop, false);
		await act(async () => button(container, "New Skill").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "User").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Import from GitHub").click());
		expect(dialog.querySelector(".skill-create-github button")).toBeNull();
		const footer = dialog.querySelector<HTMLElement>(".mcp-dialog-actions")!;
		expect(button(footer, "Cancel")).not.toBeNull();
		expect(button(footer, "Inspect")).not.toBeNull();
		await act(async () => setInput(dialog.querySelector<HTMLInputElement>('input[type="url"]')!, "https://github.com/acme/skills"));
		await act(async () => button(dialog, "Inspect").click());
		await flush();
		expect(desktop.inspectSkillImport).toHaveBeenCalledWith({
			cwd: null,
			source: "user",
			input: { kind: "github", url: "https://github.com/acme/skills" },
		});
		await act(async () => root.unmount());
	});

	it("creates a URL MCP with a bearer token and multiple scoped secrets", async () => {
		const desktop = api();
		const { container, root } = await renderPanel(desktop);
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "New MCP").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "User").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Add by URL").click());
		await act(async () => setInput(field(dialog, "Name"), "docs"));
		await act(async () => setInput(field(dialog, "Server URL"), "https://mcp.example.test/docs"));
		await act(async () => setInput(field(dialog, "Bearer token (optional)"), "bearer-secret"));
		await act(async () => button(dialog, "Add secret").click());
		await act(async () => button(dialog, "Add secret").click());
		const rows = dialog.querySelectorAll<HTMLElement>(".mcp-secret-row");
		await act(async () => {
			setInput(rows[0]!.querySelectorAll<HTMLInputElement>("input")[0]!, "DOCS_KEY");
			setInput(rows[0]!.querySelectorAll<HTMLInputElement>("input")[1]!, "docs-secret");
			setInput(rows[1]!.querySelectorAll<HTMLInputElement>("input")[0]!, "TENANT_KEY");
			setInput(rows[1]!.querySelectorAll<HTMLInputElement>("input")[1]!, "tenant-secret");
		});
		await act(async () => button(dialog, "Inspect").click());
		await flush();
		const inspected = desktop.inspectMcpImport.mock.calls.at(-1)?.[0]?.text as string;
		expect(inspected).toContain('"docs"');
		expect(inspected).not.toContain("bearer-secret");
		expect(inspected).not.toContain("docs-secret");
		expect(inspected).not.toContain("tenant-secret");
		await act(async () => button(dialog, "Add selected").click());
		await flush();
		expect(desktop.upsertMcpServer).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "live",
			scope: "user",
			name: "docs",
			expectedRevision: null,
			server: expect.objectContaining({ transport: "http", url: "https://mcp.example.test/docs" }),
			credential: {
				bearerToken: "bearer-secret",
				environment: { DOCS_KEY: "docs-secret", TENANT_KEY: "tenant-secret" },
			},
		}));
		await act(async () => root.unmount());
	});

	it("creates a custom local MCP without native selects and rejects duplicate secret names", async () => {
		const desktop = api();
		const { container, root } = await renderPanel(desktop);
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "New MCP").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "User").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Custom MCP").click());
		await act(async () => button(dialog, "Transport").click());
		await act(async () => button(dialog, "STDIO").click());
		expect(dialog.querySelector("select")).toBeNull();
		expect(dialog.textContent).not.toContain("Startup timeout");
		expect(dialog.textContent).not.toContain("Tool timeout");
		await act(async () => setInput(field(dialog, "Server name"), "local-tools"));
		await act(async () => setInput(field(dialog, "Command"), "npx"));
		await act(async () => button(dialog, "Add secret").click());
		await act(async () => button(dialog, "Add secret").click());
		const rows = dialog.querySelectorAll<HTMLElement>(".mcp-secret-row");
		await act(async () => {
			for (const [index, value] of ["first", "second"].entries()) {
				setInput(rows[index]!.querySelectorAll<HTMLInputElement>("input")[0]!, "API_KEY");
				setInput(rows[index]!.querySelectorAll<HTMLInputElement>("input")[1]!, value);
			}
		});
		await act(async () => button(dialog, "Save").click());
		expect(desktop.upsertMcpServer).not.toHaveBeenCalled();
		expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("valid and unique");
		await act(async () => setInput(rows[1]!.querySelectorAll<HTMLInputElement>("input")[0]!, "TENANT_KEY"));
		await act(async () => button(dialog, "Save").click());
		await flush();
		expect(desktop.upsertMcpServer).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "live",
			scope: "user",
			name: "local-tools",
			server: expect.objectContaining({ transport: "stdio", command: "npx" }),
			credential: { environment: { API_KEY: "first", TENANT_KEY: "second" } },
		}));
		await act(async () => root.unmount());
	});

	it("opens custom MCP with the compact HTTP-first configuration", async () => {
		const desktop = api();
		const { container, root } = await renderPanel(desktop);
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "New MCP").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "User").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Custom MCP").click());
		expect(button(dialog, "Transport").textContent).toContain("HTTP");
		expect(dialog.querySelector("h2")?.textContent).toBe("MCP configuration");
		expect(field(dialog, "Server name")).not.toBeNull();
		expect(field(dialog, "Description (optional)")).not.toBeNull();
		expect(field(dialog, "Server URL")).not.toBeNull();
		expect(dialog.textContent).toContain("Custom headers (optional)");
		expect(dialog.textContent).not.toContain("Credentials");
		expect(dialog.querySelector('input[type="file"]')).toBeNull();
		await act(async () => setInput(field(dialog, "Server name"), "private-docs"));
		await act(async () => setInput(field(dialog, "Server URL"), "https://mcp.example.test/private"));
		await act(async () => button(dialog, "Add header").click());
		const header = dialog.querySelector<HTMLElement>(".mcp-quick-header-row")!;
		await act(async () => {
			setInput(field(header, "Header name"), "Authorization");
			setInput(field(header, "Environment name (optional)"), "PRIVATE_TOKEN");
			setInput(field(header, "Secret value"), "secret");
		});
		await act(async () => button(dialog, "Save").click());
		await flush();
		expect(desktop.upsertMcpServer).toHaveBeenCalledWith(expect.objectContaining({
			name: "private-docs",
			server: expect.objectContaining({
				transport: "http",
				url: "https://mcp.example.test/private",
				envHttpHeaders: { Authorization: "PRIVATE_TOKEN" },
			}),
			credential: { environment: { PRIVATE_TOKEN: "secret" } },
		}));
		await act(async () => root.unmount());
	});

	it("keeps a custom project MCP bound to the project chosen in its creation dialog", async () => {
		const desktop = api();
		const created = { ...mcpServer, name: "project-docs", scope: "project" as const };
		desktop.listMcpServers.mockImplementation((target) => Promise.resolve({
			servers: "cwd" in target && target.cwd === "/work/chosen-project" ? [created] : [mcpServer],
		}));
		desktop.upsertMcpServer.mockResolvedValue({ servers: [created] });
		const { container, root } = await renderPanel(desktop);
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "New MCP").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "Project").click());
		let dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Choose folder…").click());
		await flush();
		await act(async () => button(dialog, "Custom MCP").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => setInput(field(dialog, "Server name"), "project-docs"));
		await act(async () => setInput(field(dialog, "Server URL"), "https://mcp.example.test/project-docs"));
		await act(async () => button(dialog, "Save").click());
		await flush();

		expect(desktop.getMcpServer).not.toHaveBeenCalled();
		await act(async () => button(container, "Edit MCP server").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Save").click());
		await flush();
		expect(desktop.upsertMcpServer).toHaveBeenLastCalledWith(expect.objectContaining({
			cwd: "/work/chosen-project",
			scope: "project",
			name: "project-docs",
		}));
		await act(async () => root.unmount());
	});

	it("locks the MCP target before JSON inspection and requires explicit replacement", async () => {
		const desktop = api();
		const { container, renderState, root, store } = await renderPanel(desktop);
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "New MCP").click());
		await act(async () => button(document.body.querySelector(".plugins-new-menu")!, "Project").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Import JSON").click());
		store.setSessions({ sessions: [session("live", "/work/project"), session("other", "/work/other")], nextAfterSessionId: null });
		await renderState({ ...store.getSnapshot(), activeSessionId: "other" });
		const text = '{"mcpServers":{"docs":{"url":"https://mcp.example.test/docs"}}}';
		await act(async () => setInput(field(dialog, "MCP JSON or JSONC"), text));
		await act(async () => button(dialog, "Inspect").click());
		await flush();
		expect(desktop.inspectMcpImport).toHaveBeenCalledWith({ sessionId: "live", scope: "project", text });
		const candidates = dialog.querySelectorAll<HTMLElement>(".mcp-import-candidate");
		expect(candidates[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
		const existing = candidates[1]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		await act(async () => existing.click());
		await act(async () => button(dialog, "Import selected").click());
		expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Confirm Replace");
		const replace = candidates[1]!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
		await act(async () => replace.click());
		await act(async () => button(dialog, "Import selected").click());
		await flush();
		expect(desktop.importMcpServers).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "live",
			scope: "project",
			text,
			sourceRevision: "d".repeat(64),
			candidates: [
				{ id: "docs", expectedRevision: null },
				{ id: "github", expectedRevision: mcpServer.revision },
			],
		}));
		await act(async () => root.unmount());
	});

	it("disables MCP mutations while a restart is pending", async () => {
		let resolveRestart!: (value: Awaited<ReturnType<ReturnType<typeof api>["restartMcpServer"]>>) => void;
		const desktop = api();
		desktop.restartMcpServer.mockImplementation(
			() => new Promise((resolve) => { resolveRestart = resolve; }),
		);
		const { container, root } = await renderPanel(desktop);
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "github").click());
		await flush();
		await act(async () => button(container, "Restart").click());
		expect(button(container, "Delete").disabled).toBe(true);
		expect(button(container, "Authentication").disabled).toBe(true);
		await act(async () => resolveRestart({
			server: mcpServer,
			tools: [{ id: "repo_search", name: "repo_search", description: "Search repositories" }],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		}));
		await flush();
		expect(button(container, "Delete").disabled).toBe(false);
		await act(async () => root.unmount());
	});

	it("ignores late detail responses without polling an open MCP detail", async () => {
		const alpha = { ...mcpServer, name: "alpha" };
		const beta = { ...mcpServer, name: "beta" };
		let resolveAlpha!: (value: { server: McpServerSummaryView; tools: McpCatalogEntryView[]; resources: never[]; resourceTemplates: never[]; prompts: never[] }) => void;
		const desktop = api();
		desktop.listMcpServers.mockResolvedValue({ servers: [alpha, beta] });
		desktop.getMcpServer.mockImplementation(({ name }) => name === "alpha"
			? new Promise((resolve) => { resolveAlpha = resolve; })
			: Promise.resolve({ server: beta, tools: [{ id: "beta_tool", name: "beta_tool" }], resources: [], resourceTemplates: [], prompts: [] }));
		const { container, root } = await renderPanel(desktop);
		vi.useFakeTimers();
		await act(async () => button(container, "MCP").click());
		await act(async () => Promise.resolve());
		await act(async () => button(container, "alpha").click());
		await act(async () => button(container, "Back to MCP").click());
		await act(async () => button(container, "beta").click());
		await act(async () => Promise.resolve());
		expect(container.textContent).toContain("beta_tool");
		await act(async () => resolveAlpha({ server: alpha, tools: [{ id: "alpha_tool", name: "alpha_tool" }], resources: [], resourceTemplates: [], prompts: [] }));
		expect(container.textContent).not.toContain("alpha_tool");

		const callsAfterOpeningDetail = desktop.listMcpServers.mock.calls.length;
		await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); });
		expect(desktop.listMcpServers).toHaveBeenCalledTimes(callsAfterOpeningDetail);
		await act(async () => button(container, "Back to MCP").click());
		const callsAfterClosingDetail = desktop.listMcpServers.mock.calls.length;
		await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
		expect(desktop.listMcpServers).toHaveBeenCalledTimes(callsAfterClosingDetail);
		await act(async () => root.unmount());
	});

	it("ignores a late catalog-item response after switching MCP servers", async () => {
		const alpha = { ...mcpServer, name: "alpha" };
		const beta = { ...mcpServer, name: "beta" };
		let resolveAlpha!: (value: Awaited<ReturnType<ReturnType<typeof api>["getMcpCatalogItem"]>>) => void;
		const desktop = api();
		desktop.listMcpServers.mockResolvedValue({ servers: [alpha, beta] });
		desktop.getMcpServer.mockImplementation(({ name }) => Promise.resolve({
			server: name === "alpha" ? alpha : beta,
			tools: [{ id: `${name}_tool`, name: `${name}_tool` }],
			resources: [], resourceTemplates: [], prompts: [],
		}));
		desktop.getMcpCatalogItem.mockImplementation(({ server }) => server === "alpha"
			? new Promise((resolve) => { resolveAlpha = resolve; })
			: Promise.resolve({ kind: "tool", id: "beta_tool", name: "beta_tool", inputSchema: '{"title":"beta"}' }));
		const { container, root } = await renderPanel(desktop);
		await act(async () => button(container, "MCP").click());
		await flush();
		await act(async () => button(container, "alpha").click());
		await flush();
		await act(async () => button(container, "alpha_tool").click());
		await act(async () => button(container, "Back to MCP").click());
		await act(async () => button(container, "beta").click());
		await flush();
		await act(async () => button(container, "beta_tool").click());
		await flush();
		await act(async () => resolveAlpha({ kind: "tool", id: "alpha_tool", name: "alpha_tool", inputSchema: '{"title":"alpha"}' }));
		expect(container.textContent).not.toContain('"alpha"');
		await act(async () => root.unmount());
	});

	it("navigates through Hooks catalog, opens detail, toggles state, and opens editor dialog with custom dropdown and advanced accordion", async () => {
		const desktop = api();
		const { container, root } = await renderPanel(desktop);
		await act(async () => button(container, "Hooks").click());
		await flush();

		expect(container.textContent).toContain("lint-on-save");
		expect(container.textContent).toContain("npm run lint");

		await act(async () => button(container, "lint-on-save").click());
		await flush();

		expect(container.querySelector('[data-plugin-detail="hook"]')).not.toBeNull();
		expect(container.textContent).toContain("Running linter...");
		expect(container.textContent).toContain("write_to_file");

		await act(async () => button(container, "Disable").click());
		expect(desktop.upsertHook).toHaveBeenCalledWith(expect.objectContaining({
			hook: expect.objectContaining({ id: "hook-1", enabled: false }),
		}));

		await act(async () => button(container, "Back to Hooks").click());
		await flush();
		expect(container.querySelector(".plugins-catalog-page")).not.toBeNull();

		await act(async () => button(container, "New Hook").click());
		await flush();
		const dialog = document.body.querySelector<HTMLElement>(".hook-editor-dialog")!;
		expect(dialog).not.toBeNull();

		// 没有原生的 select
		expect(dialog.querySelector("select")).toBeNull();

		// 高级选项默认折叠
		expect(dialog.querySelector('input[placeholder="30"]')).toBeNull();

		// 展开高级选项
		await act(async () => button(dialog, "Advanced options").click());
		await flush();
		expect(dialog.querySelector('input[placeholder="30"]')).not.toBeNull();

		// 点击 Event 下拉
		await act(async () => button(dialog, "PreToolUse (Pre tool use)").click());
		await flush();
		const stopOption = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((el) => el.textContent?.includes("Stop"));
		expect(stopOption).toBeDefined();
		await act(async () => stopOption!.click());
		await flush();

		// 填写表单
		await act(async () => setInput(dialog.querySelector<HTMLInputElement>('input[placeholder="pre-commit-lint"]')!, "notify-done"));
		await act(async () => setInput(dialog.querySelector<HTMLInputElement>('input[placeholder="/usr/local/bin/node"]')!, "/usr/bin/say"));
		await act(async () => setInput(dialog.querySelector<HTMLInputElement>('input[placeholder="30"]')!, "45"));
		await act(async () => button(dialog, "Create").click());
		await flush();

		expect(desktop.upsertHook).toHaveBeenCalledWith(expect.objectContaining({
			hook: expect.objectContaining({
				name: "notify-done",
				event: "Stop",
				command: "/usr/bin/say",
				timeoutSeconds: 45,
			}),
		}));

		await act(async () => root.unmount());
	});
});

