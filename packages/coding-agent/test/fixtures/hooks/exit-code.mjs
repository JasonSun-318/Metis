const code = Number(process.argv[2] ?? 0);
if (process.argv[3]) {
	process.stderr.write(process.argv[3]);
}
process.exit(code);
