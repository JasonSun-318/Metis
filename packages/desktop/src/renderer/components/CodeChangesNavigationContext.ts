import { createContext } from "react";

/** Workspace-owned navigation keeps transcript links on their originating session. */
export const CodeChangesNavigationContext = createContext<
	((sessionId: string, relativePath?: string) => void) | undefined
>(undefined);
