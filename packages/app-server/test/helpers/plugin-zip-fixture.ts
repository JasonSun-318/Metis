function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(
	entries: Record<string, string | { readonly content: string; readonly mode: number }>,
): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(entries)) {
		const fileName = Buffer.from(name);
		const bytes = Buffer.from(typeof value === "string" ? value : value.content);
		const mode = typeof value === "string" ? 0o100600 : value.mode;
		const checksum = crc32(bytes);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(checksum, 14);
		header.writeUInt32LE(bytes.length, 18);
		header.writeUInt32LE(bytes.length, 22);
		header.writeUInt16LE(fileName.length, 26);
		local.push(header, fileName, bytes);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(0x0314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(checksum, 16);
		directory.writeUInt32LE(bytes.length, 20);
		directory.writeUInt32LE(bytes.length, 24);
		directory.writeUInt16LE(fileName.length, 28);
		directory.writeUInt32LE((mode << 16) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, fileName);
		offset += header.length + fileName.length + bytes.length;
	}
	const directoryBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(directoryBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directoryBytes, end]);
}
