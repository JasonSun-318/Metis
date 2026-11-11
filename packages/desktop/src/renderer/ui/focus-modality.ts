/**
 * Text fields match :focus-visible even when a pointer focuses them, so CSS alone
 * cannot keep a quiet click target and a visible keyboard focus hint apart.
 * Track the last input modality so only Tab-driven focus paints the hint.
 */
export function installFocusModality(target: Document = document): () => void {
	const root = target.documentElement;
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Tab") root.dataset.focusModality = "keyboard";
	};
	const onPointerDown = () => {
		root.dataset.focusModality = "pointer";
	};
	target.addEventListener("keydown", onKeyDown, true);
	target.addEventListener("pointerdown", onPointerDown, true);
	return () => {
		target.removeEventListener("keydown", onKeyDown, true);
		target.removeEventListener("pointerdown", onPointerDown, true);
	};
}
