/** Keep keyboard focus inside a modal, including native dialogs at the document edge. */
export function trapDialogTab(
	event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault" | "defaultPrevented">,
	dialog: HTMLElement,
): void {
	if (event.key !== "Tab" || event.defaultPrevented) return;
	const controls = Array.from(
		dialog.querySelectorAll<HTMLElement>(
			'button, input, select, textarea, a[href], summary, [tabindex], [contenteditable="true"]',
		),
	).filter((element) => {
		if (element.closest('[hidden], [inert], [aria-hidden="true"]') || element.matches(":disabled")) return false;
		if (element instanceof HTMLInputElement && element.type === "hidden") return false;
		if (element.hasAttribute("tabindex") && element.tabIndex < 0) return false;
		const style = getComputedStyle(element);
		return style.display !== "none" && style.visibility !== "hidden";
	});
	const first = controls[0];
	const last = controls.at(-1);
	if (!first || !last) return;
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}
