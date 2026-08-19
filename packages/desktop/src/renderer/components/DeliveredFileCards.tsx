import type { SessionDeliveredFileView } from "@metis/app-protocol";
import { DeliveredFileCard } from "./DeliveredFileCard.tsx";

export function DeliveredFileCards({
	files,
	onOpen,
}: {
	readonly files: readonly SessionDeliveredFileView[];
	readonly onOpen: (fileId: string, action: "default" | "reveal") => void;
}) {
	if (files.length === 0) return null;
	return (
		<div className="transcript-delivered-files">
			{files.map((file) => (
				<DeliveredFileCard file={file} key={file.fileId} onOpen={(action) => onOpen(file.fileId, action)} />
			))}
		</div>
	);
}
