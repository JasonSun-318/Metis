export async function readBoundedResponseBytes(
	response: Response,
	maxBytes: number,
): Promise<{ data: Uint8Array; bytes: number }> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
		throw new TypeError("maxBytes must be a non-negative safe integer");
	const declaredBytes = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
		await response.body?.cancel();
		throw new Error(`Response exceeds the ${maxBytes.toLocaleString("en-US")} bytes limit`);
	}
	if (!response.body) return { data: new Uint8Array(), bytes: 0 };

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel();
				throw new Error(`Response exceeds the ${maxBytes.toLocaleString("en-US")} bytes limit`);
			}
			chunks.push(value);
		}
		const data = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			data.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { data, bytes };
	} finally {
		reader.releaseLock();
	}
}
