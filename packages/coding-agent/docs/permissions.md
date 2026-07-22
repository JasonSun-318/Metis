# Permissions and Sandbox

Permissions belong to a session. They are restored when that session is resumed or selected, and switching between sessions restores each session's own setting. Use `/permissions` to change the current session. The footer and `/session` show the effective mode.

## Permission modes

| Mode | Automatic actions | Actions that need a decision | Local process boundary |
|---|---|---|---|
| **Ask before changes** | Ordinary, non-sensitive reads and a strict set of known read-only shell commands | Writes, edits, deletion, network, elevation, external side effects, destructive or unknown commands, and custom tool calls ask the user directly | SRT is read-only by default; one approval adds only the paths or network target required for that action |
| **Auto with review** | Ordinary reads plus writes, builds, and tests inside the session workspace | Sensitive reads, writes outside the workspace, destructive actions, network, elevation, external side effects, and custom tool calls go to the reviewer when enabled; otherwise they ask the user | SRT can write the workspace; an approval can add an exact outside target for one action |
| **Full access** | Everything | Nothing | Primary sessions bypass SRT; an Ultra child still uses SRT to enforce its immutable capability roots |

New Chat sessions default to Ask. New Code sessions default to Auto with review enabled. Ask never calls the reviewer. A risky manual `!command` or `!!command` asks the user directly in both Ask and Auto.

Approvals are exact and one-shot. `Allow once` cannot authorize a later tool call. `Run once with Full` is offered only when a requested action cannot be represented safely as exact sandbox paths or network targets; it does not change the persistent permission mode. Denial, cancellation, missing approval UI, sandbox failure, or an unsupported Ask/Auto platform fails closed.

## Automatic reviewer

Auto can use the current session model as a fast, tool-free reviewer. It receives only:

- the normalized tool name, provenance, arguments, risk labels, paths, command, and network targets;
- the effective working directory;
- at most the latest three user messages, truncated to 4 KB total.

The reviewer uses a fixed ArcMind system prompt, has no tools, is limited to 120 output tokens, and has a five-second deadline. It must return one JSON decision: `allow`, `ask`, or `deny`. Invalid output, timeout, model error, a disabled reviewer, or `ask` falls back to the user. The reviewer can allow only the current action and cannot grant Full, persistent permissions, a different path, or a different host.

Reviewer and user decisions are appended to the session journal as audit metadata. They are not transcript messages and do not grant reusable authority.

## What SRT controls

Ask and Auto execute built-in Bash plus the child processes used by `grep` and `find` through `@anthropic-ai/sandbox-runtime` (SRT) 0.0.65. ArcMind constructs the profile from fixed host policy and the exact one-action grant:

- sensitive credential paths such as `~/.ssh`, `~/.aws`, `~/.gnupg`, cloud configuration, `.git-credentials`, browser profiles, OS keychain/credential stores, ArcMind auth, and workspace `.env` files are denied unless the sensitive target was explicitly approved;
- credential-bearing environment variables and common `*_API_KEY`, `*_ACCESS_TOKEN`, `*_CLIENT_SECRET`, `*_PRIVATE_KEY`, and `*_PASSWORD` patterns are removed from sandboxed child processes;
- network is denied unless the action has an exact normalized host and port; redirects are checked again;
- Auto receives workspace write access, while Ask receives no automatic write path;
- SRT is reset in `finally`, and both in-process and cross-process locks prevent profiles from overlapping.

Ordinary reads may target a file outside the workspace because SRT read access is deny-list based. Ordinary actions never receive an `allowRead` exception over the fixed sensitive deny list; only an explicitly approved sensitive target does. Selecting a workspace does not make the rest of the filesystem writable.

On Windows, the first Ask/Auto command may request one-time SRT setup. Approval starts the bundled `srt-win.exe` setup and Windows displays one UAC prompt. Cancelling blocks the command. Neither setup nor normal execution downloads SRT. Status, provisioning, initialize, wrapping, cleanup, and reset run in a dedicated per-command worker process so synchronous native operations do not freeze the CLI or App Server event loop. Sandbox commands still use one global FIFO correctness lock; this improves responsiveness, not Windows sandbox throughput.

macOS and Linux report missing SRT system dependencies instead of falling back to unsandboxed execution. Full deliberately does not initialize SRT.

## Native search helpers

The npm package includes verified `rg` 15.2.0 and `fd` 10.4.2 executables for macOS and Windows on arm64 and x64. Upstream does not publish `fd` 10.4.2 for Intel macOS, so that one pair uses the last official x64 build, `fd` 10.3.0. Release staging verifies every upstream archive with a pinned SHA-256; installed ArcMind verifies each executable against its generated manifest before use.

Linux uses `rg` and `fd`/`fdfind` from `PATH`. Missing or corrupt packaged helpers produce an incomplete-install error. ArcMind never downloads or silently updates these tools at runtime.

## Trust boundaries and limitations

Project trust and action permissions solve different problems. Project trust controls whether repository-provided settings, packages, and extensions are loaded. Permission policy controls model-initiated tool calls after loading.

Installing or configuring an extension, SDK integration, or future MCP server means trusting its in-process code. That code runs with the ArcMind process's OS privileges during load and event hooks. Its model-facing tool invocations are still classified as custom actions, but the sandbox is not malware isolation for trusted JavaScript itself. Skills, prompts, context files, and project files cannot alter ArcMind's fixed sensitive-path policy, reviewer prompt, or SRT fallback rules.

For hostile code or unattended workloads, add a VM, container, micro-VM, or separate OS account around the whole ArcMind process. See [Security](security.md) and [Containerization](containerization.md).
## Child-agent approvals

Ultra child sessions snapshot a permission mode that may only be equal to or stricter than the parent's mode at creation. Each child has independent review, sandbox, and one-shot approval state. Built-in filesystem/process tools are also clamped to canonical read/write roots inside the parent workspace; changing the parent permission mode later cannot widen them. Full removes approval prompts but does not bypass this child capability sandbox. Approval requests are routed through the current parent UI with the child name/ID and exact action details; without an interactive owner they fail closed. Extensions, SDK tools, and MCP implementations remain trusted in-process code. See [Ultra and Subagents](subagents.md).
