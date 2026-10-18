function invalid(message: string): never {
	throw new TypeError(message);
}

export function dataFields(value: unknown, label = "Session control entry"): Map<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);

	const fields = new Map<string, unknown>();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") invalid(`${label} must not contain symbol fields`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			invalid(`${label} must contain only enumerable data properties`);
		}
		fields.set(key, descriptor.value);
	}
	return fields;
}
