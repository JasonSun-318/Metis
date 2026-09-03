import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToolIdentity, describeToolAction } from "../src/core/tool-permission-adapter.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

const cwd = join(process.cwd(), "builtin-permission-project");
const definitions = createAllToolDefinitions(cwd, {
	webSearch: {
		getSettings: () => ({ enabled: true, provider: "brave" }),
		getApiKey: async () => "test",
	},
	describeImage: {
		getSettings: () => ({
			api: "openai-completions",
			name: "Vision",
			modelId: "vision-test",
			baseUrl: "https://vision.example.test/v1",
		}),
		getApiKey: async () => "test",
		streamSimple: () => {
			throw new Error("not executed");
		},
	},
});

const params: Record<keyof typeof definitions, unknown> = {
	read: { path: "README.md" },
	bash: { command: "pwd" },
	edit: { path: "src/index.ts", edits: [{ oldText: "before", newText: "after" }] },
	write: { path: "out.txt", content: "value" },
	grep: { pattern: "value", path: "src" },
	find: { pattern: "*.ts", path: "src" },
	ls: { path: "." },
	web_fetch: { url: "https://example.com/page" },
	web_search: { query: "metis" },
	set_tasks: { tasks: [{ task: "verify", completed: false }] },
	get_goal: {},
	create_goal: { objective: "verify permissions" },
	update_goal: { status: "complete" },
	describe_image: { path: "image.png" },
};

describe("built-in tool permission descriptors", () => {
	it("covers every executable built-in with a complete normalized action", () => {
		expect(Object.keys(definitions).sort()).toEqual(Object.keys(params).sort());
		for (const [name, definition] of Object.entries(definitions)) {
			const action = describeToolAction(definition, params[name as keyof typeof definitions] as never, {
				actionId: `builtin-${name}`,
				cwd,
				workspaceRoots: [cwd],
				provenance: "builtin",
				toolIdentity: createToolIdentity({
					provenance: "builtin",
					sourceIdentity: "@metis/coding-agent",
					toolName: name,
					implementationVersion: "test",
					descriptorVersion: definition.permission.version,
				}),
			});
			expect(action.toolName).toBe(name);
		}
	});

	it("describes exact file, shell, and network scope", () => {
		const read = definitions.read.permission.describe(
			{ path: "README.md" },
			{ actionId: "r", cwd, workspaceRoots: [cwd] },
		);
		const write = definitions.write.permission.describe(
			{ path: "out.txt", content: "secret payload" },
			{ actionId: "w", cwd, workspaceRoots: [cwd] },
		);
		const bash = definitions.bash.permission.describe(
			{ command: "rm -rf ./build" },
			{ actionId: "b", cwd, workspaceRoots: [cwd] },
		);
		const web = definitions.web_fetch.permission.describe(
			{ url: "https://example.com/page" },
			{ actionId: "n", cwd, workspaceRoots: [cwd] },
		);
		expect(read.readPaths).toEqual(["README.md"]);
		expect(write.writePaths).toEqual(["out.txt"]);
		expect(JSON.stringify(write)).not.toContain("secret payload");
		expect(bash).toMatchObject({ command: "rm -rf ./build", writePaths: ["./build"] });
		expect(bash.effects).toContain("destructive");
		expect(web.networkEndpoints).toEqual([{ hostname: "example.com", port: 443 }]);
	});

	it("fails closed when a Bash network destination is not exact", () => {
		const context = { actionId: "network", cwd, workspaceRoots: [cwd] };
		const curl = definitions.bash.permission.describe({ command: "curl https://api.example.test/v1" }, context);
		expect(curl.networkEndpoints).toEqual([{ hostname: "api.example.test", port: 443 }]);
		expect(curl.effects).not.toContain("external-side-effect");

		expect(() =>
			describeToolAction(
				definitions.bash,
				{ command: "git push origin main" },
				{
					...context,
					provenance: "builtin",
					toolIdentity: "builtin-bash-test",
				},
			),
		).toThrow("scope is incomplete");
		const exactPush = describeToolAction(
			definitions.bash,
			{ command: "git push https://github.com/example/repo.git" },
			{
				...context,
				provenance: "builtin",
				toolIdentity: "builtin-bash-exact-push",
			},
		);
		expect(exactPush.networkEndpoints).toEqual([{ hostname: "github.com", port: 443 }]);
		expect(exactPush.effects).toContain("external-side-effect");
	});

	it("binds exact shell redirections and rejects dynamic redirection targets", () => {
		const context = { actionId: "redirection", cwd, workspaceRoots: [cwd] };
		const target = join(cwd, "..", "outside.log");
		const exact = describeToolAction(
			definitions.bash,
			{ command: `echo result > ${target}` },
			{ ...context, provenance: "builtin", toolIdentity: "builtin-bash-redirection" },
		);
		expect(exact.writePaths).toEqual([cwd, target]);
		expect(() =>
			describeToolAction(
				definitions.bash,
				{ command: 'echo result > "$OUTPUT_PATH"' },
				{ ...context, provenance: "builtin", toolIdentity: "builtin-bash-dynamic-redirection" },
			),
		).toThrow("scope is incomplete");
	});

	it("binds shell filesystem operands and rejects unclassified path-bearing commands", () => {
		const context = { actionId: "operands", cwd, workspaceRoots: [cwd] };
		const outside = join(cwd, "..", "outside.txt");
		const describe = (command: string, identity: string) =>
			describeToolAction(
				definitions.bash,
				{ command },
				{
					...context,
					provenance: "builtin",
					toolIdentity: identity,
				},
			);

		expect(describe(`touch ${outside}`, "builtin-bash-touch").writePaths).toContain(outside);
		const copy = describe(`cp ./source.txt ${outside}`, "builtin-bash-copy");
		expect(copy.readPaths).toContain(join(cwd, "source.txt"));
		expect(copy.writePaths).toContain(outside);
		const localCopy = describe(`cp ${outside} output.txt`, "builtin-bash-local-copy");
		expect(localCopy.readPaths).toContain(outside);
		expect(localCopy.writePaths).not.toContain(outside);
		const secondDirectory = join(cwd, "..", "outside-directory");
		const installDirectories = describe(
			`install -dv ${outside} ${secondDirectory}`,
			"builtin-bash-install-directories",
		);
		expect(installDirectories.writePaths).toEqual(expect.arrayContaining([outside, secondDirectory]));
		const read = describe(`cat ${outside}`, "builtin-bash-cat");
		expect(read.readPaths).toContain(outside);
		expect(read.writePaths).toEqual([]);
		expect(() => describe(`python ./script.py ${outside}`, "builtin-bash-unknown-paths")).toThrow(
			"scope is incomplete",
		);
		expect(() => describe("touch $OUTPUT_PATH", "builtin-bash-dynamic-operand")).toThrow("scope is incomplete");
		expect(() => describe(`cp -t ${outside} ./source.txt`, "builtin-bash-target-directory")).toThrow(
			"scope is incomplete",
		);
	});

	it("marks structured and shell reads of credential-shaped paths as sensitive", () => {
		const context = { actionId: "sensitive", cwd, workspaceRoots: [cwd] };
		expect(definitions.read.permission.describe({ path: ".env" }, context).effects).toEqual(["sensitive-read"]);
		expect(definitions.read.permission.describe({ path: ".env.example" }, context).effects).toEqual([]);
		expect(definitions.read.permission.describe({ path: ".ssh/.env.example" }, context).effects).toEqual([
			"sensitive-read",
		]);
		expect(definitions.bash.permission.describe({ command: "cat ~/.git-credentials" }, context).effects).toContain(
			"sensitive-read",
		);
	});

	it("binds pure Bash command preparation to the described command", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const managedWorkDir = join(cwd, ".metis-work");
		const definition = createBashToolDefinition(cwd, {
			operations: { exec },
			prepareCommand: (command) => `readonly METIS_WORK_DIR TMPDIR TMP TEMP\n${command}`,
			spawnHook: (context) => ({
				...context,
				env: {
					...context.env,
					METIS_WORK_DIR: managedWorkDir,
					TMPDIR: managedWorkDir,
					TMP: managedWorkDir,
					TEMP: managedWorkDir,
				},
			}),
		});
		const claim = definition.permission.describe(
			{ command: "pwd" },
			{ actionId: "prepared", cwd, workspaceRoots: [cwd, managedWorkDir], managedWorkDir },
		);
		expect(claim.command).toBe("readonly METIS_WORK_DIR TMPDIR TMP TEMP\npwd");
		expect(claim.writePaths).toEqual([]);
		await definition.execute("prepared", { command: "pwd" }, undefined, undefined, {} as never);
		expect(exec).toHaveBeenCalledWith(
			"readonly METIS_WORK_DIR TMPDIR TMP TEMP\npwd",
			cwd,
			expect.objectContaining({
				actionId: "prepared",
				env: expect.objectContaining({
					METIS_WORK_DIR: managedWorkDir,
					TMPDIR: managedWorkDir,
					TMP: managedWorkDir,
					TEMP: managedWorkDir,
				}),
			}),
		);
	});

	it("rejects spawn hooks that mutate authorized command or cwd", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const definition = createBashToolDefinition(cwd, {
			operations: { exec },
			spawnHook: (context) => ({ ...context, command: `echo bypass\n${context.command}` }),
		});
		await expect(
			definition.execute("mutated", { command: "pwd" }, undefined, undefined, {} as never),
		).rejects.toThrow("authorized command or cwd");
		expect(exec).not.toHaveBeenCalled();
	});
});
