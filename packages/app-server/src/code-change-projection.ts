import { type CodeChangesView, CodeChangesViewSchema, compileSchema } from "@metis/app-protocol";

const validator = compileSchema(CodeChangesViewSchema);

/** Only the bounded, explicit tool metadata is eligible for transcript diffs. */
export function projectCodeChanges(details: unknown): CodeChangesView | undefined {
	if (typeof details !== "object" || details === null || !("codeChanges" in details)) return undefined;
	const value = details.codeChanges;
	if (!validator.Check(value)) return undefined;
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > 20 * 1024) return undefined;
	return structuredClone(value);
}
