# Security

Metis is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether metis loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Metis considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.metis/settings.json`
- `.metis/extensions`, `.metis/skills`, `.metis/prompts`, or `.metis/themes`
- `.metis/SYSTEM.md` or `.metis/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.metis` directory does not count as a project resource that requires trust.

When an interactive session starts in a project with resources that require trust and no saved decision for the current directory or a parent directory, metis follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.metis/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows metis to load project resources that require trust, including:

- `.metis/settings.json`
- `.metis` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. `AGENTS.md` and `CLAUDE.md` context files are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, metis only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## Action Permissions

Every session stores Ask, Auto, or Full; Auto is the default. Ask and Auto use a fail-closed workspace sandbox for model-initiated Bash unless the approval UI explicitly identifies host execution. Structured tools remain path-guarded, while Full skips Metis approval and runs with current-user authority. See [Permissions](permissions.md) for the decision table, exact project rules, and sandbox boundary.

This boundary limits model-initiated actions; it is not isolation for trusted in-process code. Extensions are TypeScript modules that run with the Metis process's OS permissions during load and event hooks. Installing or configuring an extension, SDK integration, or future MCP server means trusting that code. Model-facing calls exposed by those integrations are still treated as custom permission actions.

Project trust is an input-loading guard. It prevents a repository from silently changing Metis's settings or extensions before approval. It does not make untrusted code, prompts, or model output safe. Prompt injection from repository files, comments, documentation, context files, or build output remains a local-agent risk.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run metis in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole `metis` process inside a container/sandbox
- run host metis while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.metis/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](https://github.com/metis/metis/blob/main/SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected Full-mode behavior, prompt injection from untrusted content, and behavior of user-installed trusted code are generally outside the security boundary unless a report demonstrates an approval bypass or shows Metis granting access beyond the documented boundary.
