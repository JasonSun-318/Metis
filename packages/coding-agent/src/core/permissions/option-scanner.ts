/**
 * Quote/cluster-aware option scanner for one static command argv. Pure over
 * the evaluated argv words: it never inspects shell state or effects.
 */

export interface ShellValue {
	readonly text?: string;
	readonly dynamic: boolean;
	readonly glob: boolean;
}

export interface ParsedOption {
	readonly name: string;
	readonly value?: ShellValue;
}

export interface OptionSpec {
	readonly boolean: readonly string[];
	readonly value: readonly string[];
	readonly optionalValue?: readonly string[];
}

export interface OptionScan {
	readonly ok: boolean;
	readonly options: readonly ParsedOption[];
	readonly positionals: readonly ShellValue[];
	readonly reason?: string;
}

export function scanCommandOptions(args: readonly ShellValue[], spec: OptionSpec, numericShort = false): OptionScan {
	const boolean = new Set(spec.boolean);
	const value = new Set(spec.value);
	const optionalValue = new Set(spec.optionalValue ?? []);
	const options: ParsedOption[] = [];
	const positionals: ShellValue[] = [];
	let index = 0;
	while (index < args.length) {
		const argument = args[index]!;
		if (argument.dynamic || argument.text === undefined) {
			return { ok: false, options, positionals, reason: "argument is not statically known" };
		}
		const text = argument.text;
		if (text === "--") {
			for (const rest of args.slice(index + 1)) positionals.push(rest);
			break;
		}
		if (text === "-" || !text.startsWith("-")) {
			positionals.push(argument);
			index += 1;
			continue;
		}
		if (text.startsWith("--")) {
			const equals = text.indexOf("=");
			const name = equals >= 0 ? text.slice(0, equals) : text;
			const inline = equals >= 0 ? text.slice(equals + 1) : undefined;
			if (boolean.has(name)) {
				if (inline !== undefined) {
					return { ok: false, options, positionals, reason: `${name} does not accept a value` };
				}
				options.push({ name });
				index += 1;
				continue;
			}
			if (value.has(name)) {
				if (inline !== undefined) {
					options.push({ name, value: { text: inline, dynamic: false, glob: false } });
					index += 1;
					continue;
				}
				const next = args[index + 1];
				if (!next || next.dynamic || next.text === undefined) {
					return { ok: false, options, positionals, reason: `${name} requires a statically known value` };
				}
				options.push({ name, value: next });
				index += 2;
				continue;
			}
			if (optionalValue.has(name)) {
				options.push(
					inline === undefined ? { name } : { name, value: { text: inline, dynamic: false, glob: false } },
				);
				index += 1;
				continue;
			}
			return { ok: false, options, positionals, reason: `unsupported option: ${name}` };
		}
		if (numericShort && /^-\d+$/u.test(text)) {
			options.push({ name: text });
			index += 1;
			continue;
		}
		let consumedNext = false;
		for (let position = 1; position < text.length; position += 1) {
			const name = `-${text[position]}`;
			if (value.has(name)) {
				const attached = text.slice(position + 1);
				if (attached.length > 0) {
					options.push({ name, value: { text: attached, dynamic: false, glob: false } });
					break;
				}
				const next = args[index + 1];
				if (!next || next.dynamic || next.text === undefined) {
					return { ok: false, options, positionals, reason: `${name} requires a statically known value` };
				}
				options.push({ name, value: next });
				consumedNext = true;
				break;
			}
			if (optionalValue.has(name)) {
				options.push({ name });
				continue;
			}
			if (boolean.has(name)) {
				options.push({ name });
				continue;
			}
			return { ok: false, options, positionals, reason: `unsupported option: ${name}` };
		}
		index += consumedNext ? 2 : 1;
	}
	return { ok: true, options, positionals };
}
