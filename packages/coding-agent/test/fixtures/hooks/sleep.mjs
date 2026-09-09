const ms = Number(process.argv[2] ?? 30000);
setTimeout(() => {
	process.exit(0);
}, ms);
