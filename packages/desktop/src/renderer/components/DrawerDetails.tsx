import { CaretRight } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

/** Native keyboard disclosure with the same persistent height drawer as tool execution. */
export function DrawerDetails({ className, summary, children, defaultOpen = false, showCaret = true }: {
	readonly className?: string;
	readonly summary: ReactNode;
	readonly children: ReactNode;
	readonly defaultOpen?: boolean;
	readonly showCaret?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<details className={`drawer-details ${className ?? ""}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>{showCaret && <CaretRight aria-hidden="true" className="drawer-details-caret" size={13} />}{summary}</summary>
			<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
				<div>{children}</div>
			</div>
		</details>
	);
}
