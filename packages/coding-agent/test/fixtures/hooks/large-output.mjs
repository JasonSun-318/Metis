const sizeBytes = Number(process.argv[2] ?? 100000);
const chunk = "X".repeat(1000);
let written = 0;
while (written < sizeBytes) {
	process.stdout.write(chunk);
	written += chunk.length;
}
