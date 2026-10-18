import { PreviewHost, type PreviewHostProps } from "./PreviewHost.tsx";

export type { UniversalPreviewTarget } from "./preview-kinds.ts";

export interface UniversalFilePreviewerProps extends Omit<PreviewHostProps, "active"> {
	readonly active?: boolean;
}

export function UniversalFilePreviewer(props: UniversalFilePreviewerProps) {
	return <PreviewHost {...props} active={props.active ?? true} />;
}
