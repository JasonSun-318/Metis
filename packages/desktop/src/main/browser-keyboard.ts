const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;

const SUPPRESSED_TEXT_MODIFIERS = ALT | CONTROL | META;

interface NamedKey {
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	readonly text?: string;
}

interface PunctuationKey {
	readonly code: string;
	readonly keyCode: number;
	readonly text: string;
	readonly shiftedText: string;
}

const NAMED_KEYS: Readonly<Record<string, NamedKey>> = {
	enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", keyCode: 9 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	home: { key: "Home", code: "Home", keyCode: 36 },
	end: { key: "End", code: "End", keyCode: 35 },
	escape: { key: "Escape", code: "Escape", keyCode: 27 },
	backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	delete: { key: "Delete", code: "Delete", keyCode: 46 },
	space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

const PUNCTUATION_KEYS: Readonly<Record<string, PunctuationKey>> = {
	"`": { code: "Backquote", keyCode: 192, text: "`", shiftedText: "~" },
	"-": { code: "Minus", keyCode: 189, text: "-", shiftedText: "_" },
	"=": { code: "Equal", keyCode: 187, text: "=", shiftedText: "+" },
	"[": { code: "BracketLeft", keyCode: 219, text: "[", shiftedText: "{" },
	"]": { code: "BracketRight", keyCode: 221, text: "]", shiftedText: "}" },
	"\\": { code: "Backslash", keyCode: 220, text: "\\", shiftedText: "|" },
	";": { code: "Semicolon", keyCode: 186, text: ";", shiftedText: ":" },
	"'": { code: "Quote", keyCode: 222, text: "'", shiftedText: '"' },
	",": { code: "Comma", keyCode: 188, text: ",", shiftedText: "<" },
	".": { code: "Period", keyCode: 190, text: ".", shiftedText: ">" },
	"/": { code: "Slash", keyCode: 191, text: "/", shiftedText: "?" },
};

const SHIFTED_PUNCTUATION = new Map(Object.values(PUNCTUATION_KEYS).map((key) => [key.shiftedText, key] as const));

const SHIFTED_DIGITS: Readonly<Record<string, string>> = {
	"0": ")",
	"1": "!",
	"2": "@",
	"3": "#",
	"4": "$",
	"5": "%",
	"6": "^",
	"7": "&",
	"8": "*",
	"9": "(",
};

const SHIFTED_DIGIT_KEYS = new Map(Object.entries(SHIFTED_DIGITS).map(([digit, shifted]) => [shifted, digit] as const));

const MODIFIER_ALIASES: Readonly<Record<string, number>> = {
	alt: ALT,
	option: ALT,
	control: CONTROL,
	ctrl: CONTROL,
	meta: META,
	command: META,
	cmd: META,
	shift: SHIFT,
};

// CDP editing commands execute in the renderer. Chromium handles the platform's
// accelerator at the browser level, so a Meta/Ctrl mask alone can produce a key
// event without the OS-level editing effect (notably Cmd+A on macOS).
const PLATFORM_EDIT_COMMANDS: Readonly<Record<string, string>> = {
	a: "selectAll",
	c: "copy",
	x: "cut",
	v: "paste",
	z: "undo",
};

interface KeyIdentity {
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	readonly text?: string;
	readonly unmodifiedText?: string;
	readonly baseKey?: string;
}

interface ParsedKey {
	readonly identity: KeyIdentity;
	readonly impliedShift: boolean;
}

function invalid(message: string): never {
	throw new Error(message);
}

function acceleratorMask(token: string, acceleratorModifier: number): number | undefined {
	const normalized = token.toLowerCase();
	if (normalized === "controlormeta") {
		if (acceleratorModifier !== CONTROL && acceleratorModifier !== META) {
			invalid("acceleratorModifier must be 2 (Control) or 4 (Meta) when using ControlOrMeta");
		}
		return acceleratorModifier;
	}
	// Tables inherit Object.prototype; only own entries are valid accelerator tokens.
	return Object.hasOwn(MODIFIER_ALIASES, normalized) ? MODIFIER_ALIASES[normalized] : undefined;
}

function splitAccelerator(key: string): string[] {
	// "+" is both the delimiter and a valid punctuation key.
	if (key === "+") return ["+"];
	if (key === " ") return ["Space"];
	return key.split("+");
}

function characterKey(token: string, modifiers: number): ParsedKey | undefined {
	const direct = Object.hasOwn(PUNCTUATION_KEYS, token) ? PUNCTUATION_KEYS[token] : undefined;
	if (direct) {
		const shifted = (modifiers & SHIFT) !== 0;
		const text = shifted ? direct.shiftedText : direct.text;
		return {
			identity: {
				key: text,
				code: direct.code,
				keyCode: direct.keyCode,
				text,
				unmodifiedText: direct.text,
				baseKey: direct.text,
			},
			impliedShift: false,
		};
	}

	const shiftedPunctuation = SHIFTED_PUNCTUATION.get(token);
	if (shiftedPunctuation) {
		return {
			identity: {
				key: shiftedPunctuation.shiftedText,
				code: shiftedPunctuation.code,
				keyCode: shiftedPunctuation.keyCode,
				text: shiftedPunctuation.shiftedText,
				unmodifiedText: shiftedPunctuation.text,
				baseKey: shiftedPunctuation.text,
			},
			impliedShift: true,
		};
	}

	const unshiftedDigit = SHIFTED_DIGIT_KEYS.get(token);
	if (unshiftedDigit !== undefined) {
		return {
			identity: {
				key: token,
				code: `Digit${unshiftedDigit}`,
				keyCode: unshiftedDigit.charCodeAt(0),
				text: token,
				unmodifiedText: unshiftedDigit,
				baseKey: unshiftedDigit,
			},
			impliedShift: true,
		};
	}

	return undefined;
}

function resolveKey(token: string, modifiers: number): ParsedKey {
	if (token === " ") {
		return { identity: NAMED_KEYS.space!, impliedShift: false };
	}

	const normalized = token.toLowerCase();
	if (normalized === "plus") {
		return characterKey("+", modifiers) ?? invalid('Unsupported browser key "Plus"');
	}

	const named = Object.hasOwn(NAMED_KEYS, normalized) ? NAMED_KEYS[normalized] : undefined;
	if (named) return { identity: named, impliedShift: false };

	// Accelerator letters are case-insensitive and Shift decides casing. Shifted
	// punctuation and digits imply Shift because those characters require it.
	if (token.length === 1) {
		if (/^[a-z]$/i.test(token)) {
			const upper = token.toUpperCase();
			const impliedShift = modifiers === 0 && token === upper;
			const shifted = (modifiers & SHIFT) !== 0 || impliedShift;
			return {
				identity: {
					key: shifted ? upper : upper.toLowerCase(),
					code: `Key${upper}`,
					keyCode: upper.charCodeAt(0),
					text: shifted ? upper : upper.toLowerCase(),
					unmodifiedText: upper.toLowerCase(),
					baseKey: upper.toLowerCase(),
				},
				impliedShift,
			};
		}

		if (/^[0-9]$/.test(token)) {
			const shifted = (modifiers & SHIFT) !== 0;
			const text = shifted ? SHIFTED_DIGITS[token]! : token;
			return {
				identity: {
					key: text,
					code: `Digit${token}`,
					keyCode: token.charCodeAt(0),
					text,
					unmodifiedText: token,
					baseKey: token,
				},
				impliedShift: false,
			};
		}

		const character = characterKey(token, modifiers);
		if (character) return character;
	}

	return invalid(`Unsupported browser key ${JSON.stringify(token)}`);
}

function editCommands(
	baseKey: string | undefined,
	modifiers: number,
	acceleratorModifier: number,
): string[] | undefined {
	const platformModifier = acceleratorModifier === META ? META : acceleratorModifier === CONTROL ? CONTROL : 0;
	if (!baseKey || !platformModifier) return undefined;

	const otherPlatformModifier = platformModifier === META ? CONTROL : META;
	if ((modifiers & platformModifier) === 0 || (modifiers & (ALT | otherPlatformModifier)) !== 0) return undefined;

	const shifted = (modifiers & SHIFT) !== 0;
	if (shifted) {
		// Only redo is a common Shift variant; other editing shortcuts with Shift
		// mean something different and should be left to the page.
		return baseKey === "z" ? ["redo"] : undefined;
	}
	if (baseKey === "y" && platformModifier === CONTROL) return ["redo"];

	const command = Object.hasOwn(PLATFORM_EDIT_COMMANDS, baseKey) ? PLATFORM_EDIT_COMMANDS[baseKey] : undefined;
	return command ? [command] : undefined;
}

/**
 * Parses a browser accelerator into the CDP payloads for a key down/up pair.
 *
 * Modifier masks follow Input.dispatchKeyEvent: Alt=1, Control=2, Meta=4,
 * Shift=8. Invalid accelerators throw instead of returning a partial payload.
 * Dispatch lifecycle (release, cancellation, timeouts) remains the caller's job.
 */
export function parseBrowserKey(
	key: string,
	acceleratorModifier: number,
): { down: Record<string, unknown>; up: Record<string, unknown> } {
	if (typeof key !== "string" || key.length === 0 || (key.trim().length === 0 && key !== " ")) {
		invalid("Browser key combination must not be empty");
	}

	const tokens = splitAccelerator(key);
	let modifiers = 0;
	let primaryToken: string | undefined;

	for (const rawToken of tokens) {
		const token = rawToken.trim();
		if (!token) invalid("Browser key combination contains an empty segment");

		const modifier = acceleratorMask(token, acceleratorModifier);
		if (modifier !== undefined) {
			if (primaryToken !== undefined) {
				invalid(`Modifier ${JSON.stringify(token)} must precede the primary key`);
			}
			if ((modifiers & modifier) !== 0) {
				invalid(`Duplicate modifier ${JSON.stringify(token)}`);
			}
			modifiers |= modifier;
			continue;
		}

		if (primaryToken !== undefined) {
			invalid(
				`Multiple primary keys are not supported: ${JSON.stringify(primaryToken)} and ${JSON.stringify(token)}`,
			);
		}
		primaryToken = token;
	}

	if (!primaryToken) invalid("Browser key combination must contain a primary key");

	const parsed = resolveKey(primaryToken, modifiers);
	if (parsed.impliedShift) modifiers |= SHIFT;

	const { identity } = parsed;
	const text = (modifiers & SUPPRESSED_TEXT_MODIFIERS) === 0 ? identity.text : undefined;
	const commands = editCommands(identity.baseKey, modifiers, acceleratorModifier);
	const eventIdentity = {
		key: identity.key,
		code: identity.code,
		windowsVirtualKeyCode: identity.keyCode,
		nativeVirtualKeyCode: identity.keyCode,
		modifiers,
	};

	const down: Record<string, unknown> = {
		type: text === undefined ? "rawKeyDown" : "keyDown",
		...eventIdentity,
		...(text === undefined ? {} : { text, unmodifiedText: identity.unmodifiedText ?? text }),
		...(commands ? { commands: [...commands] } : {}),
	};

	return {
		down,
		// Keyup releases input; it must not repeat an editing operation.
		up: { type: "keyUp", ...eventIdentity },
	};
}
