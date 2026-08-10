# MCP servers

Metis connects to local MCP servers over stdio and remote MCP servers over Streamable HTTP. The normal setup path is the unified `/mcp` manager, so you do not need to edit JSON.

## Configure a server with `/mcp`

Run `/mcp`, then choose **Add server**:

1. Choose **Personal** or **Project**. Project configuration is available only for a trusted project.
2. Enter a server name.
3. Choose **Local command (stdio)** or **Remote URL (HTTP)**.
4. Enter the executable and arguments, or the HTTP URL.

Metis validates and saves the definition, starts the server, initializes its capabilities and catalog, and shows the resulting connection state. Press Escape in any child menu or form to return one level without saving; Escape closes the manager only at its root.

For an HTTP server, Metis first connects without credentials:

- A successful connection needs no authentication.
- A `401` opens **Authentication**, where you can enter a token through a masked field, reference an environment variable, or go back and configure it later.

MCP OAuth is not currently supported. Use a server-issued token or an environment variable when the server requires authentication.

For stdio, MCP has no protocol-level way to discover a credential name. Choose **Authentication** → **Set environment variable**, enter the name documented by that server, then either enter its value through the masked field or forward an existing environment variable.

Select a configured server in `/mcp` to see its status and catalog counts, open details, change authentication, restart it, sign out, or remove it. **Sign out** deletes stored credentials but keeps the definition. **Remove** deletes the selected definition and its `mcp:<server>` credential.

## Where configuration and credentials are stored

- Personal definitions: `~/.metis/agent/settings.json`
- Project definitions: `.metis/settings.json` in a trusted project
- Directly entered tokens and directly entered stdio environment values: `~/.metis/agent/auth.json`, written with file mode `0600`
- Environment-backed values: remain in the process environment and are not copied into Metis files

`settings.json` stores server definitions and environment-variable references, never values entered in a masked field. `auth.json` is Metis's existing credential store; it is protected by filesystem permissions but is not encrypted or backed by an OS keychain. Keep the account and filesystem trusted.

Stored MCP credentials are bound to the configured HTTP URL or the stdio command, arguments, and working directory. Changing that server identity requires authentication again; credentials written by older builds without an identity binding are not forwarded automatically.

Secret values are not placed in model context, MCP status, diagnostics, logs, or `metis mcp` output. The target server still receives the credential when Metis connects or starts its process.

## Scriptable configuration

The CLI uses the same settings mutation and validation path as `/mcp`. It accepts environment-variable names but deliberately has no literal `--token` option, which prevents a token from being retained in shell history.

```bash
# Local stdio server
metis mcp add context7 --env CONTEXT7_TOKEN -- npx -y @upstash/context7-mcp

# Remote HTTP server
metis mcp add companyDocs \
  --url https://mcp.example.com/mcp \
  --bearer-token-env-var COMPANY_MCP_TOKEN

# Inspect definitions without reading auth.json
metis mcp list
metis mcp get companyDocs

# Project configuration requires trust
metis mcp add projectDocs --scope project --approve -- node server.mjs

# Removes both the selected definition and its stored MCP credential
metis mcp remove companyDocs
```

Use `/mcp` when you want to enter a real token.

## What the model receives

Metis initializes each enabled server and keeps its capabilities, instructions, tools, resources, resource templates, and prompts in process memory. The first model request receives `tool_search`, a short source list made from configured server names and initialization instructions, and direct resource/prompt access tools. It does not receive every MCP tool schema.

When `tool_search` finds a match, its result records the loaded tool name. The next model request in the same agent run receives that tool's complete schema. OpenAI and Anthropic use native deferred-tool representations when available; other providers receive the active schema as an ordinary function definition.

The catalog, capabilities, instructions, normalized names, and search index are not written to a database or cache file. Session history persists only loaded model-visible names through the existing tool-result format. MCP credentials are never part of this catalog or source metadata.

## Permissions and results

Every MCP tool invocation passes through Metis's one-action permission guard. A `readOnlyHint` tool is classified as an ordinary read, a `destructiveHint` tool is destructive with an external side effect, and an unannotated tool uses the normal custom-action review and approval route. Metis does not automatically replay a failed MCP tool call after a disconnect because the first call may already have changed external state.

Text, images, embedded resources, resource links, and structured output become normal Metis tool results. Existing large-output externalization applies automatically. MCP prompts are returned as role/content data in a tool result; Metis never silently inserts them as user instructions.

## Advanced JSON configuration

JSON remains available for timeouts, tool filters, custom header references, `cwd`, and other uncommon settings. Run `/reload` after editing it outside Metis.

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "envVars": ["CONTEXT7_TOKEN"],
      "cwd": "~/work",
      "startupTimeoutSec": 10,
      "toolTimeoutSec": 60
    },
    "companyDocs": {
      "url": "https://mcp.example.com/mcp",
      "bearerTokenEnvVar": "COMPANY_MCP_TOKEN",
      "envHttpHeaders": { "X-Tenant": "COMPANY_TENANT" },
      "enabledTools": ["search", "read"],
      "disabledTools": ["admin_delete"],
      "required": false,
      "enabled": true
    }
  }
}
```

A server defines exactly one of `command` or `url`. Startup defaults to 10 seconds and tool calls default to 60 seconds. `enabledTools` is applied before `disabledTools`. Set `required` when Metis must refuse session startup if that server cannot initialize.

Metis does not currently advertise MCP sampling, elicitation, roots, resource subscriptions, logging control, completions, or task-augmented tool execution capabilities.
