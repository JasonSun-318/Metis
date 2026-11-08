import type { SessionDeliveredFileView } from "@metis/app-protocol";
import { createContext } from "react";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

export interface ImageGenerationActions {
	readonly api: Pick<MetisDesktopApi, "readPreviewFile">;
	readonly onConfigure?: () => void;
	readonly onEdit?: (sessionId: string, image: SessionDeliveredFileView, prompt?: string) => void;
	readonly onReveal?: (sessionId: string, fileId: string) => Promise<void> | void;
}

export const ImageGenerationContext = createContext<ImageGenerationActions | null>(null);
