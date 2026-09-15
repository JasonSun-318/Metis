/**
 * Host-facing runtime surface for process hosts such as @metis/app-server.
 *
 * Keep this entry limited to APIs a session host needs. Extension/SDK additions
 * belong in the package root unless a host runtime also consumes them.
 */
export * from "./index.ts";
