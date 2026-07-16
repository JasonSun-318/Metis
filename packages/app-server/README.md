# @arcmind/app-server

Recoverable, multi-session application server shared by ArcMind desktop and automation transports.

The package owns agent runtimes and durable session mutations. It does not spawn one child process per session.

Request idempotency is journal-scoped: `session/create` IDs are global because they become session IDs; all other
request IDs are scoped to their `sessionId`. Reusing an ID with different parameters inside one session is rejected
across process restarts. The same UUID in two different sessions represents two independent operations.
