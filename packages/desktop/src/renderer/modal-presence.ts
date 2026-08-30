import { useSyncExternalStore } from "react";

const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let current = false;

function readModalPresence(): boolean {
	return document.querySelector(MODAL_SELECTOR) !== null;
}

function nodeContainsModal(node: Node): boolean {
	return node instanceof Element && (node.matches(MODAL_SELECTOR) || node.querySelector(MODAL_SELECTOR) !== null);
}

function refreshModalPresence(): void {
	const next = readModalPresence();
	if (next === current) return;
	current = next;
	for (const listener of listeners) listener();
}

function mutationCanChangeModalPresence(records: readonly MutationRecord[]): boolean {
	return records.some(
		(record) =>
			record.type === "attributes" ||
			Array.from(record.addedNodes).some(nodeContainsModal) ||
			Array.from(record.removedNodes).some(nodeContainsModal),
	);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		current = readModalPresence();
		observer = new MutationObserver((records) => {
			if (mutationCanChangeModalPresence(records)) refreshModalPresence();
		});
		observer.observe(document.body, {
			attributeFilter: ["aria-modal", "open"],
			attributes: true,
			childList: true,
			subtree: true,
		});
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		observer?.disconnect();
		observer = null;
	};
}

function snapshot(): boolean {
	if (!observer) current = readModalPresence();
	return current;
}

export function useModalPresence(): boolean {
	return useSyncExternalStore(subscribe, snapshot, () => false);
}
