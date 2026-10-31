/**
 * Shared, dependency-free resource caps for the permission pipeline. Importing
 * them from a leaf module keeps policy and the tool adapter from depending on
 * each other.
 */

/** Ask/Auto shell commands above this limit are rejected by policy, not truncated. */
export const MAX_SHELL_COMMAND_BYTES = 32 * 1024;

/** Hard cap for any single Git configuration file read during analysis. */
export const MAX_GIT_CONFIG_BYTES = 256 * 1024;
