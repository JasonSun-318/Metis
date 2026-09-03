# @metis/app-server

Recoverable, multi-session application server shared by Metis desktop and automation transports.

The package owns agent runtimes and durable session mutations. It does not spawn one child process per session.

Durable session-mutation idempotency is journal-scoped: `session/create` IDs are global because they become session
IDs, while mutations carrying a `sessionId` are scoped to that session and reject conflicting reuse across process
restarts. Global mutations without a `sessionId` are deduplicated for the lifetime of the App Server process; their
own services remain responsible for durable retry semantics.
