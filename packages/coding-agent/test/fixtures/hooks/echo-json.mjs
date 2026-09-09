let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
	const parsed = JSON.parse(data);
	const response = {
		hookSpecificOutput: {
			hookEventName: parsed.event,
			additionalContext: `Echoed: ${parsed.sessionId ?? "unknown"}`,
		},
	};
	process.stdout.write(JSON.stringify(response));
});
