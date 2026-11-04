import type { ReactNode } from "react";
import { useDelayedLoading } from "../settings-async.ts";

/**
 * Renders a loading placeholder only once loading lasts long enough to be
 * noticed. Local reads usually resolve in milliseconds, so an immediately
 * painted placeholder flashed for a frame whenever a page mounted.
 */
export function DelayedPlaceholder({ children }: { readonly children: ReactNode }) {
	return useDelayedLoading(true) ? children : null;
}
