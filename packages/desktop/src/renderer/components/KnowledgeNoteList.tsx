import type { KnowledgeNote } from "@metis/app-protocol";
import { CaretRight, FileText, Folder } from "@phosphor-icons/react";
import { useMemo } from "react";

interface NoteFolder {
	readonly name: string;
	readonly path: string;
	readonly folders: Map<string, NoteFolder>;
	readonly notes: KnowledgeNote[];
	count: number;
}

export function KnowledgeNoteList({
	notes,
	onOpen,
	expandAll,
}: {
	readonly notes: readonly KnowledgeNote[];
	readonly onOpen: (path: string) => void;
	readonly expandAll: boolean;
}) {
	const tree = useMemo(() => {
		const root: NoteFolder = { name: "", path: "", folders: new Map(), notes: [], count: 0 };
		for (const note of notes) {
			let folder = root;
			folder.count++;
			for (const name of note.path.split("/").slice(0, -1)) {
				if (!folder.folders.has(name)) {
					folder.folders.set(name, {
						name,
						path: folder.path ? `${folder.path}/${name}` : name,
						folders: new Map(),
						notes: [],
						count: 0,
					});
				}
				folder = folder.folders.get(name)!;
				folder.count++;
			}
			folder.notes.push(note);
		}
		return root;
	}, [notes]);
	const renderFolder = (folder: NoteFolder) => (
		<>
			{[...folder.folders.values()]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((child) => (
					<details className="knowledge-folder" key={child.path} open={expandAll || undefined}>
						<summary title={child.path}>
							<CaretRight aria-hidden="true" className="knowledge-folder-caret" size={12} />
							<Folder aria-hidden="true" size={16} />
							<span>{child.name}</span>
							<small>{child.count}</small>
						</summary>
						<div className="knowledge-folder-children">{renderFolder(child)}</div>
					</details>
				))}
			{folder.notes.map((note) => (
				<button
					className="knowledge-note-row"
					key={note.path}
					type="button"
					title={note.path}
					onClick={() => onOpen(note.path)}
				>
					<FileText aria-hidden="true" size={16} />
					<span>{note.title}</span>
				</button>
			))}
		</>
	);
	return <div className="knowledge-note-list">{renderFolder(tree)}</div>;
}
