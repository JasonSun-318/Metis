import type { BrowserObservation, BrowserObserveInput } from "@metis/app-protocol";

// Leave room for stale-action envelopes under the agent's 50,000-character
// externalization threshold. Count serialized JSON, including escaped text.
const MAX_OBSERVATION_JSON_CHARS = 45_000;

export function observationNeedsPaging(observation: BrowserObservation): boolean {
	const { screenshot: _screenshot, ...text } = observation;
	return JSON.stringify(text).length > MAX_OBSERVATION_JSON_CHARS;
}

export function pageBrowserObservation(
	observation: BrowserObservation,
	cursor: BrowserObserveInput["cursor"],
): BrowserObservation {
	const { state, screenshot, ...metadata } = observation;
	const cursorValid =
		cursor &&
		cursor.documentId === observation.documentId &&
		cursor.revision === observation.revision &&
		cursor.offset < state.length &&
		!isLowSurrogate(state.charCodeAt(cursor.offset));
	const offset = cursorValid ? cursor.offset : 0;
	const base = { ...metadata, ...(cursor && !cursorValid ? { cursorReset: true as const } : {}) };
	if (!cursor && !observationNeedsPaging(observation)) return observation;
	const nextCursor = (end: number) => ({
		documentId: observation.documentId,
		revision: observation.revision,
		offset: end,
	});
	const overhead = JSON.stringify({
		...base,
		state: "",
		statePage: { offset, totalChars: state.length, nextCursor: nextCursor(state.length) },
	}).length;
	const budget = MAX_OBSERVATION_JSON_CHARS - overhead;
	if (budget < 2) throw new RangeError("Browser observation metadata exceeds the output budget");
	let low = offset;
	let high = state.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (JSON.stringify(state.slice(offset, middle)).length - 2 <= budget) low = middle;
		else high = middle - 1;
	}
	let end = low;
	if (end < state.length) {
		// Keep nodes whole when possible. A single oversized label may span pages;
		// concatenating the state fragments always restores the exact snapshot.
		const newline = state.lastIndexOf("\n", end - 1);
		if (newline >= offset) end = newline + 1;
		else if (isLowSurrogate(state.charCodeAt(end))) end -= 1;
	}
	return {
		...base,
		state: state.slice(offset, end),
		statePage: { offset, totalChars: state.length, ...(end < state.length ? { nextCursor: nextCursor(end) } : {}) },
		...(screenshot ? { screenshot } : {}),
	};
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}
