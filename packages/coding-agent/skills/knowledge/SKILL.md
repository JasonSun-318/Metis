---
name: knowledge
description: Organize materials into linked Markdown knowledge libraries, search and answer questions from their notes, or update existing knowledge. Use when the user asks to save materials into a knowledge library, find stored knowledge, or work with linked libraries.
---

# Knowledge libraries

Read the latest `<knowledge_context>` attached to the current user message. It lists the libraries linked to this conversation using complete absolute directory paths. Each directory and its subdirectories form one library. Viewing a directory in the sidebar does not link it; previous messages may describe outdated links.

If no library is linked and the user requests a knowledge workflow, ask them to open the Knowledge sidebar and select a directory, then use the conversation composer's `+` menu > Knowledge to link it to this conversation. Do not guess a directory from other conversations. If the user explicitly provides a new directory or different instructions, follow their current request using the normal file-tool permissions.

For note formatting, read `../metis-markdown/SKILL.md`, relative to this skill's directory. It retains the complete Obsidian-compatible syntax reference and local manuals; this knowledge workflow determines which features and artifacts to use. Frontmatter, callouts, embeds, index pages, and extra bookkeeping files are optional, not required steps. Focused notes follow the content boundaries below; no fixed note taxonomy is required. Preserve existing or user-requested advanced syntax rather than removing it because of the current reader. No Obsidian application, CLI, or plugin is needed.

For notes intended to be read in Metis, prefer standard Markdown and resolved note links. Metis recognizes frontmatter titles and aliases, hides frontmatter in the reader, and derives the graph from resolved note links. Heading/block links open the whole note, and embedded Markdown notes become note links. Obsidian callouts, highlights, comments, embedded local media/PDFs, property styling, Mermaid, math, and interactive queries do not receive their full Obsidian rendering in Metis. In particular, do not rely on `%%comments%%` to hide text in the Metis reader. Keep useful or requested advanced content, but do not promise unsupported visual effects.

## Organize materials

- Read the user's supplied material with the existing attachment and file tools. If a format cannot be read, explain what is needed; do not claim to have processed unread content.
- Inspect relevant existing notes before deciding where the new material belongs. Use the linked absolute paths; create subdirectories when useful.
- Identify independently useful knowledge points before writing: concepts, entities, processes, decisions, questions, or conclusions. When a material contains multiple such points, organize them into focused notes by default, even if the user only asks to save it into the library. Do not merely copy the entire material into one note and stop.
- Reuse and enrich relevant existing notes instead of creating duplicates for every source. Each new note should explain one coherent topic with enough context to be useful on its own. Choose boundaries from the content, not a fixed note count, sentence count, or one file per paragraph. A short material about a single topic can remain one note; honor an explicit request to preserve a material as one file.
- Preserve the material's important information in the library, using a copy of the original file or a faithful source note, with meaningful links to the focused notes. Link those notes back to the source and to related existing or newly created notes where the material supports a relationship. Explain the relationship in the surrounding prose; do not invent connections or empty notes to make the graph look larger. A source/overview note is useful when it ties together several extracted topics, but it is not a required extra file for a single-topic material.
- Use descriptive filenames. Link related existing notes with `[[path/from/library/root/Note]]`, adding a path when names are ambiguous. Ordinary Markdown links are relative to the note's directory. For references in another library, report the complete absolute file path and use normal file tools to read it; wikilinks resolve within one library.
- With multiple libraries, determine the destination from the user's request and existing organization. Ask a normal conversational clarification only if the target cannot be determined.
- Write with ordinary file tools and briefly report the resulting note paths. Do not add compilation databases, embeddings, mandatory versions, provenance logs, or graph output files.

## Query and maintain

Search linked directories and their subdirectories with existing file/search tools, then read the relevant notes before answering. Refer to the actual note paths. Distinguish statements supported by notes from your inference. Update, move, or delete notes when the user's request calls for it, following the ordinary file-tool permissions. When moving or renaming a note, update affected links as needed; Metis does not rewrite them automatically.

Metis displays one graph node per Markdown note and derives graph edges from resolved links between notes. Headings inside a single note do not become separate nodes. When organizing multi-topic materials, write the focused notes and actual links needed to expose that structure; do not generate a separate graph file. Briefly report what knowledge points were organized and which notes and relationships were created or reused.
