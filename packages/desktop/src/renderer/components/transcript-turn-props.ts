import type { ItemView, RetryStatusView, SessionDeliveredFileView } from "@metis/app-protocol";

export interface TranscriptTurnProps {
	readonly items: readonly ItemView[];
	readonly running?: boolean;
	readonly retry?: RetryStatusView;
	readonly waitingForAnswer?: boolean;
	readonly startedAt?: string;
	readonly onFork?: (entryId: string) => void;
	readonly onCopy?: (text: string) => void;
	readonly onJumpToQuote?: (itemId: string, liveItemId?: string) => void;
	readonly onOpenDeliveredFile?: (fileId: string, action: "default" | "reveal") => void;
	readonly onPreviewDeliveredFile?: (file: SessionDeliveredFileView) => void;
}

export function sameTurnProps(left: TranscriptTurnProps, right: TranscriptTurnProps): boolean {
	return (
		left.running === right.running &&
		left.retry === right.retry &&
		left.waitingForAnswer === right.waitingForAnswer &&
		left.startedAt === right.startedAt &&
		left.onFork === right.onFork &&
		left.onCopy === right.onCopy &&
		left.onJumpToQuote === right.onJumpToQuote &&
		left.onOpenDeliveredFile === right.onOpenDeliveredFile &&
		left.onPreviewDeliveredFile === right.onPreviewDeliveredFile &&
		left.items.length === right.items.length &&
		left.items.every((item, index) => item === right.items[index])
	);
}
