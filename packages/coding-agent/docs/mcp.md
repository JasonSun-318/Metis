# MCP servers

ArcMind can connect to local stdio servers and remote MCP Streamable HTTP servers. Put personal servers in `~/.arcmind/agent/settings.json`. Project servers belong in `.arcmind/settings.json` and are ignored until the project is trusted.

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "envVars": ["CONTEXT7_TOKEN"],
      "startupTimeoutSec": 10,
      "toolTimeoutSec": 60
    },
    "companyDocs": {
      "url": "https://mcp.example.com/mcp",
      "bearerTokenEnvVar": "COMPANY_MCP_TOKEN",
      "enabledTools": ["search", "read"],
      "disabledTools": ["admin_delete"],
      "required": false,
      "enabled": true
    }
  }
}
```

Stdio servers use `command`, optional `args`, literal `env`, forwarded `envVars`, and `cwd`. HTTP servers use `url`, `bearerTokenEnvVar`, and `envHttpHeaders`; the values come from the current process environment. A server defines exactly one of `command` or `url`. Startup defaults to 10 seconds and tool calls default to 60 seconds. `enabledTools` is applied before `disabledTools`. Set `required` when ArcMind must refuse session startup if that server cannot initialize.

Run `/reload` after editing settings. Use `/mcp` or `/mcp verbose` for connection and catalog status, `/mcp login <server>` for OAuth, `/mcp logout <server>` to remove stored OAuth material, and `/mcp restart [server]` to reconnect.

## What the model receives

ArcMind initializes each enabled server and keeps its capabilities, instructions, tools, resources, resource templates, and prompts in process memory. The first model request receives `tool_search`, a short source list made from configured server names and initialization instructions, and direct resource/prompt access tools. It does not receive every MCP tool schema.

When `tool_search` finds a match, the tool result records the loaded name. The next model request in the same agent run receives that tool's complete schema at the search-result boundary. OpenAI and Anthropic use their native deferred-tool representations when available; other providers receive the now-active schema as an ordinary function definition.

The catalog, capabilities, instructions, normalized names, and BM25 index are never written to a database or cache file. Session history persists only loaded model-visible names through the existing tool-result format. OAuth tokens, client registration data, and PKCE data are stored in the existing mode-`0600` `auth.json`; bearer tokens remain in environment variables.

## Permissions and results

Every actual MCP tool invocation passes through ArcMind's one-action permission guard. A `readOnlyHint` tool is classified as an ordinary read, a `destructiveHint` tool is destructive with an external side effect, and an unannotated tool is custom and requires the normal review/approval route. ArcMind never automatically replays a failed MCP tool call after disconnect because the first call may already have changed external state.

Text, images, embedded resources, resource links, and structured output become normal ArcMind tool results. Existing large-output externalization applies automatically. MCP prompts are returned as role/content data in a tool result; ArcMind never silently inserts them as user instructions.

ArcMind does not currently advertise MCP sampling, elicitation, roots, resource subscriptions, logging control, completions, or task-augmented tool execution capabilities.
