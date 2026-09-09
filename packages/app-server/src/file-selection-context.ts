import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { ClientParams } from "@metis/app-protocol";
import { assertSessionFileSelections, type SessionFileSelection } from "@metis/coding-agent";

type FileSelectionInput = NonNullable<ClientParams<"turn/start">["fileSelections"]>[number];

export async function resolveFileSelections(
	input: readonly FileSelectionInput[],
	context: {
		cwd: string;
		resolveDelivered: (fileId: string) => { name: string; path: string } | undefined;
	},
): Promise<SessionFileSelection[]> {
	const files: SessionFileSelection[] = [];
	for (const selection of input) {
		let target: { name: string; path: string };
		if (selection.source === "workspace") {
			const name = selection.relativePath;
			if (
				!name ||
				isAbsolute(name) ||
				win32.isAbsolute(name) ||
				name.includes("\\") ||
				name.split("/").includes("..")
			)
				throw new TypeError("Invalid selected workspace path");
			const root = await realpath(context.cwd);
			const path = await realpath(resolve(root, name));
			const rel = relative(root, path);
			if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
				throw new TypeError("Selected file is outside the workspace");
			target = { name: basename(name), path };
		} else {
			const delivered = context.resolveDelivered(selection.fileId);
			if (!delivered) throw new Error("Selected delivered file is unavailable");
			target = delivered;
		}
		if (!(await stat(target.path)).isFile()) throw new TypeError("Selected target must be a file");
		const { source: _source, ...quote } = selection;
		const {
			selectedText,
			basis,
			sourceExcerpt,
			excerptTruncated,
			startLine,
			endLine,
			target: documentTarget,
		} = quote;
		files.push({
			source: selection.source,
			...target,
			selectedText,
			basis,
			...(documentTarget === undefined ? {} : { target: documentTarget }),
			...(sourceExcerpt === undefined ? {} : { sourceExcerpt }),
			...(excerptTruncated === undefined ? {} : { excerptTruncated }),
			...(startLine === undefined ? {} : { startLine }),
			...(endLine === undefined ? {} : { endLine }),
		});
	}
	assertSessionFileSelections(files);
	return files;
}
