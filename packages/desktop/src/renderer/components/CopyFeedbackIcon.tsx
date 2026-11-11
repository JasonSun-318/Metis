import { Check, Copy } from "../icons.tsx";
import { iconSize } from "../ui/icon-size.ts";

export function CopyFeedbackIcon({ copied }: { readonly copied: boolean }) {
	return (
		<span aria-hidden="true" className="copy-feedback-icon" data-copied={copied}>
			<Copy size={iconSize.md} />
			<Check size={iconSize.md} />
		</span>
	);
}
