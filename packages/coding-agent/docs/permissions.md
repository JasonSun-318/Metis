# Permissions

Permissions belong to a session. Both new Chat and Code sessions default to Ask. Use `/permissions` to select Ask or Full for the current session; the footer and `/session` show the stored mode. Switching sessions restores each session's own mode. Legacy `auto` records load as Ask.

| Mode | Automatic model actions | Actions that ask | Execution |
|---|---|---|---|
| **Ask** | Proven safe built-in structured reads and safe internal controls | Every write/edit, Bash/Git/build/test, network, sensitive read, MCP/Extension/SDK/custom, destructive, elevated, external, or unknown action | After **Allow once**, the exact action runs directly as the current OS user without an ArcMind sandbox |
| **Full** | All model tool actions | None | Runs directly as the current OS user |

The approval UI has two choices: **Allow once** and **Deny**. There is no automatic reviewer and no persistent approval created by either choice.

## One-action approval

An approval is bound to one tool call, its complete arguments, the session working directory, the permission mode, and any normalized network target. ArcMind snapshots the arguments before showing the dialog, consumes the approval once, and checks the binding again immediately before execution. A changed argument, path, provider target, or Full-to-Ask downgrade invalidates it.

The dialog shows the complete Bash command or structured arguments, the affected paths/hosts, the requesting child identity when applicable, and a direct-host warning. It never silently truncates a command. Cancellation, timeout, disconnect, a missing UI, malformed UI output, or an aborted request denies the action without recording a false user decision.

Approval means host execution. It does not add filesystem, process, credential, or network isolation. A command can affect anything available to the user account that started ArcMind, including data outside the session working directory.

## What Ask permits automatically

Ask automatically permits only:

- built-in `read`, `grep`, `find`, and `ls` calls whose target can be proven to be an ordinary readable regular file or directory;
- fixed no-host controls such as `update_plan`, `tool_search`, `inspect_agents`, and `wait_agents`.

Structured reads require an existing, canonical target. Traversal reads such as `grep`, `find`, and `ls` ask when the target intersects a sensitive location. Direct reads of known credential/configuration locations and workspace `.env*` files also ask. Device nodes, sockets, FIFOs, broken links, missing paths, unreadable objects, and targets whose type cannot be proven are not automatic.

Bash is never inferred to be safe from command text: even `pwd`, Git reads, builds, and tests ask when initiated by the model. MCP `readOnlyHint` does not make an MCP call automatic; MCP annotations only improve the warning.

## Actions outside the model-tool boundary

`!command` and `!!command` are explicit user terminal actions, so they run directly in both modes. `!` adds the result to model context; `!!` does not. Extensions may still intercept the user-Bash event.

ArcMind's own runtime bookkeeping—session journals, settings, caches, managed workspaces, tool-output storage, and similar internal writes—is not a model tool call. Provider API traffic, authentication, model discovery, package installation explicitly initiated by the user, and installed integration initialization likewise do not use the action dialog.

Skills, prompts, context files, and model text receive no authority by themselves. Any model-facing tool call they cause still follows Ask or Full.

## Installed code and external isolation

Installing or configuring an Extension, SDK integration, or MCP server means trusting its code and runtime. Load hooks and in-process code run with ArcMind's OS authority. Their model-facing tools still ask in Ask, but ArcMind cannot isolate what trusted integration code does internally.

Project trust controls whether project-provided configuration and code are loaded; it is separate from action permissions.

For hostile code, unattended work, or a real containment boundary, run the whole ArcMind process in a container, VM, micro-VM, remote sandbox, or separate OS account with limited mounts, credentials, and network access. See [Security](security.md) and [Containerization](containerization.md).

## Child-agent permissions

A child inherits the parent's current mode unless the parent chooses a narrower one. An Ask parent can create only Ask children; a Full parent can create Ask or Full children. When a parent changes from Full to Ask, every existing child is immediately capped at Ask and durably downgraded. Returning the parent to Full never re-upgrades those children.

Child approval requests use the same queue and dialog, labeled with the child name and ID. The decision is audited in the child session, not inserted into the parent model transcript. See [Ultra and Subagents](subagents.md).

## Native search helpers

The npm package includes verified `rg` 15.2.0 and `fd` 10.4.2 executables for macOS and Windows on arm64 and x64. Upstream does not publish `fd` 10.4.2 for Intel macOS, so that pair uses `fd` 10.3.0. Release staging verifies pinned archive hashes and the installed executable manifest. Linux uses `rg` and `fd`/`fdfind` from `PATH`. ArcMind does not download or silently update these helpers at runtime.
