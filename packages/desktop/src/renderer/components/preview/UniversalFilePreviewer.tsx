import { PreviewHost, type PreviewHostProps, type UniversalPreviewTarget } from "./PreviewHost.tsx";

export type { UniversalPreviewTarget };

export interface UniversalFilePreviewerProps extends Omit<PreviewHostProps, "active"> {
	readonly active?: boolean;
}

export function UniversalFilePreviewer(props: UniversalFilePreviewerProps) {
	return <PreviewHost {...props} active={props.active ?? true} />;
}
