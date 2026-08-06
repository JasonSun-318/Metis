import type { DesktopWorkspaceReviewFile } from "../../shared/desktop-api.ts";

export interface ReviewTreeDirectory {
	readonly kind: "directory";
	readonly name: string;
	readonly path: string;
	readonly children: readonly ReviewTreeNode[];
}

export interface ReviewTreeFile {
	readonly kind: "file";
	readonly name: string;
	readonly path: string;
	readonly file: DesktopWorkspaceReviewFile;
}

export type ReviewTreeNode = ReviewTreeDirectory | ReviewTreeFile;

interface MutableDirectory {
	readonly directories: Map<string, MutableDirectory>;
	readonly files: ReviewTreeFile[];
}

export function buildReviewTree(files: readonly DesktopWorkspaceReviewFile[]): readonly ReviewTreeNode[] {
	const root: MutableDirectory = { directories: new Map(), files: [] };
	for (const file of files) {
		const parts = file.relativePath.split("/");
		let parent = root;
		for (const part of parts.slice(0, -1)) {
			let directory = parent.directories.get(part);
			if (!directory) {
				directory = { directories: new Map(), files: [] };
				parent.directories.set(part, directory);
			}
			parent = directory;
		}
		parent.files.push({ kind: "file", name: parts.at(-1) ?? file.relativePath, path: file.relativePath, file });
	}

	const materialize = (directory: MutableDirectory, parentPath: string): readonly ReviewTreeNode[] => [
		...[...directory.directories]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, child]) => {
				const path = parentPath ? `${parentPath}/${name}` : name;
				return { kind: "directory" as const, name, path, children: materialize(child, path) };
			}),
		...directory.files.sort((left, right) => left.name.localeCompare(right.name)),
	];
	return materialize(root, "");
}

export function reviewPatchKey(revision: string, relativePath: string): string {
	return `${revision}\0${relativePath}`;
}
