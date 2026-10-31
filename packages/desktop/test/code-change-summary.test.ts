import type { CodeChangesView } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import { codeStepLabel, summarizeCodeChanges } from "../src/renderer/components/code-change-summary.ts";

function step(sequence: number): CodeChangesView {
	return {
		version: 1,
		sequence,
		files: [{ path: "src/main.ts", kind: "modified", additions: 1, deletions: 1 }],
		partial: false,
		turn: { additions: 1, deletions: 1, partial: false },
	};
}

describe("Code turn file summaries", () => {
	it("uses actual net files instead of adding repeated step counts", () => {
		const latest = {
			...step(2),
			turnFiles: [{ path: "src/main.ts", kind: "modified" as const, additions: 1, deletions: 1 }],
		};
		const summary = summarizeCodeChanges([latest, step(1)])!;
		expect(summary.counts).toEqual({ additions: 1, deletions: 1, partial: false });
		expect(summary.files).toHaveLength(1);
		expect(summary.files[0]?.file.additions).toBe(1);
		expect(summary.files[0]?.counts).toEqual({ additions: 1, deletions: 1 });
	});
	it("respects an empty net snapshot after a reversion", () => {
		expect(summarizeCodeChanges([step(1), { ...step(2), turnFiles: [] }])?.files).toEqual([]);
	});
	it("marks repeated historical edits rather than inventing their net count", () => {
		const summary = summarizeCodeChanges([step(1), step(2)])!;
		expect(summary.counts).toEqual({ additions: 1, deletions: 1, partial: false });
		expect(summary.files[0]?.counts).toBeUndefined();
	});
	it("labels real operations and retains command text without manufacturing a semantic description", () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), key);
		const call = {
			type: "tool_call" as const,
			toolCallId: "command",
			name: "bash",
			state: "completed" as const,
			inputPreview: '{"command":"node --test"}',
		};
		expect(codeStepLabel(call, undefined, "Ran command", t)).toBe("Ran node --test");
		expect(
			codeStepLabel(
				call,
				{
					type: "tool_result",
					toolCallId: "command",
					name: "bash",
					isError: false,
					output: "",
					codeChanges: step(1),
				},
				"Ran command",
				t,
			),
		).toBe("Updated main.ts");
	});
});
