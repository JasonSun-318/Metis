# Permissions

Permissions belong to a session. New Chat and Code sessions default to **Auto**. Use `/permissions` to select Ask, Auto, or Full; switching sessions restores that session's stored mode.

| Mode | Automatic model actions | Actions that ask | Execution |
|---|---|---|---|
| **Ask** | Deterministic ordinary workspace reads, currently classified read-only MCP actions, and fixed internal controls | Other actions require user review, including Bash, writes, built-in web, sensitive access, and outside-workspace access | Built-in Bash uses the granted sandbox scope; integration code runs on the host or externally |
| **Auto** | Low-risk workspace actions, eligible Auto command rules, deterministic reads, and fixed internal controls | Review-required writes, network, destructive/external effects, and critical risks go directly to the user; remaining uncertain reads may use model review, with user fallback | Built-in Bash uses the granted sandbox scope; structured tools remain path-guarded |
| **Full** | All valid model tool calls, including file deletion, scripts, network, and MCP effects | No user or model permission review | Local execution runs as the current OS user; MCP remains external |

All modes validate tool arguments and action bindings. Ask and Auto deny protected workspace metadata writes and recursive deletion of the filesystem root or user home; Auto also denies other recursive deletion commands. Full bypasses these permission blocks and saved project allow/deny rules. It uses the current OS account's authority without a Metis sandbox; switching back to Ask or Auto restores their policy and saved rules.

The approval UI offers **Reject**, **Always allow for this project** when eligible, and **Allow once**. It states whether the action will run in the sandbox, on the host, or externally. An eligible existing project rule can satisfy review without another prompt.

Direct built-in `officecli` commands do not require permission review in Ask, Auto, or Full. Chains containing only direct OfficeCLI calls are also eligible. Shell substitutions, redirections, wrappers, and mixed command chains follow the normal policy. The exemption preserves sandbox routing, read-only ceilings, protected paths, and explicit project deny rules.

## Bash sandbox

Ask and Auto use a lazy sandbox broker per interactive session. No broker is created until the first sandboxed Bash command. The broker is reused while the working directory, read/write/protected roots, network endpoints, and shell stay unchanged; a boundary change rotates it. Switching to Full, replacing or closing the runtime, and application shutdown dispose it and its private temporary directory.

The sandbox is configured from the consumed action grant, including read/write roots, protected metadata, and exact network endpoints. A read-only action keeps the workspace read-only; approved writes or outside reads add their granted scope. Required runtime binaries and libraries remain readable. Network access is limited to granted endpoints; local port binding is blocked. A command cannot use sandbox approval as a fallback to host execution: startup, protocol, timeout, or runtime failure denies the command.

Ask requires user review for model-initiated Bash commands, including `pwd`, builds, and tests, unless an eligible project rule already covers the exact action. Auto runs low-risk shell commands and eligible Auto command rules automatically. Review-required writes, network, deletions, and external effects skip model review and go directly to the user. Other uncertain reads may be model-reviewed; a model denial or unavailable reviewer falls back to the interactive user. Recursive deletion is denied in Auto. Approval does not change an Ask/Auto Bash grant into host execution. Full Bash runs on the host without user or model permission review.

Bash classification is conservative command-text analysis, not program-behavior verification. A command such as `npm test` can execute project code and mutate the granted workspace. Ask requires user review; Auto confines ordinary Bash to its granted paths and network endpoints. Use Ask when shell invocations should require user review rather than automatic policy or model review.

The sandbox depends on the platform sandbox runtime and packaged helpers. If those are unavailable, Ask and Auto fail closed instead of changing the execution target.

## Structured tools and integrations

Structured file tools are path-guarded rather than shell-sandboxed. Ask automatically permits deterministic ordinary reads inside an effective workspace root; writes require review. Auto permits low-risk workspace reads and writes automatically. In Ask and Auto, sensitive reads require the user; ordinary outside reads may receive model review in Auto. Review-required writes and network actions go directly to the user. Full allows valid structured-tool calls without this review or protected-path permission blocks.

Installing or configuring MCP, Extension, or SDK code means trusting that integration's implementation. Its model-facing calls still follow the action policy; installation alone does not automatically approve every call. The current MCP adapter uses annotations and inferred argument scope to classify read-only calls, which the policy may allow in all three modes. This classification does not prove the remote server's behavior. Other integration calls follow their declared scope and risks. Built-in `web_fetch` and `web_search` declare network access and require user review in Ask and Auto unless an eligible project rule applies.

Integration initialization and in-process hooks already run with Metis's OS authority; the Bash sandbox does not contain them.

Project trust controls whether project-provided configuration and code load. It is separate from action permissions. For hostile installed code or whole-process containment, use a container, VM, micro-VM, remote sandbox, or separate limited OS account. See [Security](security.md) and [Containerization](containerization.md).

## One-action and current-project approval

An Allow-once decision is bound to one action ID, tool and provenance, complete arguments, effective command, working directory, workspace-root snapshot, risks, normalized paths and network targets, current permission mode, and sandbox/host execution target. Metis consumes the binding once and rechecks it immediately before execution. Any change denies the action.

**Always allow for this project** stores the same exact signature in the Metis user directory. Matching is equality-only: there are no command prefixes, wildcards, tool-family grants, or renderer-supplied project paths. A changed argument, command, directory, root, risk, provider target, or execution target prompts again. Rules are bounded, locked, atomically written, project-scoped, and revocable from Desktop Settings > Permissions. In Ask and Auto, a corrupt or unreadable rule store fails closed. Full does not consult the rule store.

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
