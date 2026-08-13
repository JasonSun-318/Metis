# Permissions

Permissions belong to a session. New Chat and Code sessions default to **Auto**. Use `/permissions` to select Ask, Auto, or Full; switching sessions restores that session's stored mode.

| Mode | Automatic model actions | Actions that ask | Execution |
|---|---|---|---|
| **Ask** | Proven ordinary built-in structured reads inside the workspace, plus fixed internal controls | Bash, writes, web, MCP, Extensions, SDK/custom tools, sensitive or outside access, and unknown actions | Approved ordinary/destructive Bash stays in the workspace sandbox; network, elevation, or external-side-effect Bash is explicitly shown as host execution |
| **Auto** | Workspace reads/writes, ordinary sandboxed Bash, built-in web, and installed MCP/Extension/SDK tools | Dangerous Bash and sensitive, outside, or unknown built-in actions | Ordinary Bash runs in the workspace sandbox; structured tools remain path-guarded; approved boundary-crossing Bash runs on the host |
| **Full** | All model tool actions | None | Runs directly as the current OS user |

The approval UI offers **Reject**, **Always allow for this project** when eligible, and **Allow once**. It always states whether the action will run in the sandbox or directly on the host.

## Bash sandbox

Ask and Auto share one lazy sandbox broker per interactive session. No broker is created until the first sandboxed Bash command. The broker is reused while the working directory, workspace roots, app-owned attachment/work roots, and shell stay unchanged; a boundary change rotates it. Switching to Full, replacing or closing the runtime, and application shutdown dispose it and its private temporary directory.

The sandbox permits reads and writes in the active workspace roots and its private temporary directory. Session attachments are read-only; an active app-owned work directory is writable. Required runtime binaries and libraries are readable. Network access and local port binding are blocked. A command cannot use sandbox approval as a fallback to host execution: startup, protocol, timeout, or runtime failure denies the command.

Ask prompts for every model-initiated Bash command, including `pwd`, builds, and tests. Auto runs ordinary shell commands automatically in the sandbox. Known destructive commands such as `rm`, `git reset --hard`, or `git clean`, sensitive-path references, and opaque inline or encoded execution prompt; destruction-only commands remain sandboxed. Commands classified as networked, elevated, or externally side-effecting prompt with a host warning and run on the host only after approval. Full Bash runs on the host without Metis approval.

Bash classification is conservative command-text analysis, not program-behavior verification. A command such as `npm test` can execute project code, and the sandbox intentionally permits that code to mutate the active workspace. The security boundary is that Ask still requires approval, while Auto confines ordinary Bash from outside reads/writes and network access; use Ask when every shell invocation must be confirmed.

The sandbox depends on the platform sandbox runtime and packaged helpers. If those are unavailable, Ask and Auto fail closed instead of changing the execution target.

## Structured tools and integrations

Structured file tools are path-guarded rather than shell-sandboxed. Ask automatically permits only proven ordinary built-in reads inside an effective workspace root; writes and other model tools ask. Auto permits ordinary workspace reads and writes automatically. Sensitive paths, outside-root targets, unprovable objects, and unknown built-in actions still ask.

Installing or configuring MCP, Extension, or SDK code means trusting that integration. Its model-facing tools ask in Ask and run automatically in Auto. Integration initialization and in-process hooks already run with Metis's OS authority; the Bash sandbox does not contain them. Built-in `web_fetch` and `web_search` also run automatically in Auto.

Project trust controls whether project-provided configuration and code load. It is separate from action permissions. For hostile installed code or whole-process containment, use a container, VM, micro-VM, remote sandbox, or separate limited OS account. See [Security](security.md) and [Containerization](containerization.md).

## One-action and current-project approval

An Allow-once decision is bound to one action ID, tool and provenance, complete arguments, effective command, working directory, workspace-root snapshot, risks, normalized paths and network targets, current permission mode, and sandbox/host execution target. Metis consumes the binding once and rechecks it immediately before execution. Any change denies the action.

**Always allow for this project** stores the same exact signature in the Metis user directory. Matching is equality-only: there are no command prefixes, wildcards, tool-family grants, or renderer-supplied project paths. A changed argument, command, directory, root, risk, provider target, or execution target prompts again. Rules are bounded, locked, atomically written, project-scoped, and revocable from Desktop Settings > Permissions. A corrupt or unreadable rule store fails closed.

Project rules are available only to primary interactive sessions. Subagents and scheduled tasks cannot create or consume them.

The approval dialog never silently authorizes truncated or incomplete targets. Cancellation, timeout, disconnect, a missing owner, malformed output, an aborted request, persistence failure, or sandbox failure denies the action.

## Actions outside the model-tool boundary

`!command` and `!!command` are explicit user terminal actions, so they run directly on the host in every mode. `!` adds output to model context; `!!` does not. Extensions may still intercept the user-Bash event.

Metis runtime bookkeeping, provider traffic, authentication, model discovery, and package installation explicitly initiated by the user do not use the model-action dialog. Skills, prompts, context files, and model text receive no authority by themselves; model-facing tool calls they cause still follow the selected mode.

## Child agents and scheduled tasks

Permission rank is Ask < Auto < Full. A child may start only at or below its parent's current mode. Parent downgrades immediately cap running, queued, and resumed children; later parent upgrades never re-upgrade them. Children use the same approval UI and Bash sandbox rules, but never inherit current-project rules.

Scheduled tasks use a separate non-interactive sandbox profile. They expose only the scheduled tool allowlist, restrict file writes to their task workspace, and deny dangerous, networked, elevated, or externally side-effecting Bash. They never show an approval UI and never fall back to Full. See [Scheduled tasks](scheduled-tasks.md).

## Native search helpers

The npm package includes verified `rg` 15.2.0 and `fd` 10.4.2 executables for macOS and Windows on arm64 and x64. Upstream does not publish `fd` 10.4.2 for Intel macOS, so that pair uses `fd` 10.3.0. Release staging verifies pinned archive hashes and the installed executable manifest. Linux uses `rg` and `fd`/`fdfind` from `PATH`. Metis does not download or silently update these helpers at runtime.
