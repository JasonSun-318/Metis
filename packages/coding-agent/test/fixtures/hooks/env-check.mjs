process.stdout.write(JSON.stringify({
	officeCliSkipUpdate: process.env.OFFICECLI_SKIP_UPDATE,
	hasPath: Boolean(process.env.PATH || process.env.Path),
}));
