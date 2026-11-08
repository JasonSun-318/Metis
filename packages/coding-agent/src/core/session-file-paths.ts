import { createHash } from "crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { canonicalizePathForCreation, resolvePath } from "../utils/paths.ts";
import { assertValidSessionId } from "./session-id.ts";

const SESSION_DISPLAY_METADATA_SUFFIX = ".metadata.json";
const SESSION_UNREAD_STATE_SUFFIX = ".unread.json";

export function canonicalSessionPath(filePath: string): string {
	return canonicalizePathForCreation(filePath);
}

export function getSessionAssetDirFromStoragePath(storagePath: string, assetName: "images" | "tool-results"): string {
	const resolvedFile = resolve(storagePath);
	const defaultSessionsDir = canonicalSessionPath(getSessionsDir());
	const relativePath = relative(defaultSessionsDir, resolvedFile);
	const isDefaultSession =
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
	const assetRoot = isDefaultSession
		? join(canonicalSessionPath(getDefaultAgentDir()), assetName)
		: join(dirname(resolvedFile), assetName);
	const sessionKey = createHash("sha256").update(resolve(resolvedFile)).digest("hex");
	return join(assetRoot, sessionKey);
}

function getSessionAssetDir(sessionFile: string, assetName: "images" | "tool-results"): string {
	return getSessionAssetDirFromStoragePath(canonicalSessionPath(sessionFile), assetName);
}

export function getSessionImageDir(sessionFile: string): string {
	return getSessionAssetDir(sessionFile, "images");
}

export function getSessionToolOutputDir(sessionFile: string): string {
	return getSessionAssetDir(sessionFile, "tool-results");
}

export function getSessionDisplayMetadataPath(sessionFile: string): string {
	return `${canonicalSessionPath(sessionFile)}${SESSION_DISPLAY_METADATA_SUFFIX}`;
}

export function getSessionUnreadStatePath(sessionFile: string): string {
	return `${canonicalSessionPath(sessionFile)}${SESSION_UNREAD_STATE_SUFFIX}`;
}

/** Root-session-owned directory for Agent System v2 child session journals. */
export function getSessionAgentDir(agentDir: string, rootSessionId: string): string {
	assertValidSessionId(rootSessionId);
	return join(resolvePath(agentDir), "agents", rootSessionId);
}
