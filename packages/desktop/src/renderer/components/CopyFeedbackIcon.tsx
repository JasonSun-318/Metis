import { Check, Copy } from "@phosphor-icons/react";

export function CopyFeedbackIcon({ copied }: { readonly copied: boolean }) {
	return (
		<span aria-hidden="true" className="copy-feedback-icon" data-copied={copied}>
			<Copy size={13} />
			<Check size={13} />
		</span>
	);
}
