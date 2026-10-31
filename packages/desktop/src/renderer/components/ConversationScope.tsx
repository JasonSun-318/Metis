import { createContext, type ReactNode, useContext } from "react";
import type { AgentConversationTarget } from "../conversation-target.ts";
import { ConversationQuoteProvider } from "./ConversationQuoteContext.tsx";

export interface PermissionRuleReference {
	readonly id: string;
	readonly name: string;
	readonly scope: string;
}

export interface ConversationScope {
	readonly rootSessionId?: string;
	readonly openAgent?: (target: AgentConversationTarget) => void;
	readonly openParent?: () => void;
	readonly viewPermissionRule?: (rule: PermissionRuleReference) => void;
}
export const ConversationScopeContext = createContext<ConversationScope>({});
export function useConversationScope(): ConversationScope {
	return useContext(ConversationScopeContext);
}

/** Shared conversation controls without adding another DOM wrapper. */
export function ConversationScopeProvider({
	value,
	enabled,
	children,
}: {
	readonly value: ConversationScope;
	readonly enabled: boolean;
	readonly children: ReactNode;
}) {
	return (
		<ConversationScopeContext.Provider value={value}>
			<ConversationQuoteProvider enabled={enabled}>{children}</ConversationQuoteProvider>
		</ConversationScopeContext.Provider>
	);
}
