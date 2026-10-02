---
name: knowledge
description: Organize materials into linked Markdown knowledge libraries, search and answer questions from their notes, or update existing knowledge. Use when the user asks to save materials into a knowledge library, find stored knowledge, or work with linked libraries.
---

# Knowledge libraries

Read the latest `<knowledge_context>` attached to the current user message. It lists the libraries linked to this conversation using complete absolute directory paths. Each directory and its subdirectories form one library. Viewing a directory in the sidebar does not link it; previous messages may describe outdated links.

If no library is linked and the user requests a knowledge workflow, ask them to open the Knowledge sidebar, select a directory, and link it to this conversation. Do not guess a directory from other conversations. If the user explicitly provides a new directory or different instructions, follow their current request using the normal file-tool permissions.

For note formatting, read [Obsidian Markdown](../obsidian-markdown/SKILL.md) as a syntax reference. This knowledge workflow determines which artifacts to create; its formatting features are optional. Do not follow its suggested frontmatter, callout, embed, or Obsidian verification steps as mandatory tasks. Do not create frontmatter, callouts, index pages, concept notes, or extra files unless useful for the material or requested by the user. Obsidian does not need to be installed or running.

## Organize materials

- Read the user's supplied material with the existing attachment and file tools. If a format cannot be read, explain what is needed; do not claim to have processed unread content.
- Inspect relevant existing notes before deciding where the new material belongs. Use the linked absolute paths; create subdirectories when useful.
- Preserve the material's important content. A simple material can remain one Markdown note; split or summarize when the user requests it or the content benefits from it.
- Use descriptive filenames. Link related existing notes with `[[path/from/library/root/Note]]`, adding a path when names are ambiguous. Ordinary Markdown links are relative to the note's directory. Links between separate libraries must be explicit filesystem/URI references, since Obsidian wikilinks are local to one library.
- With multiple libraries, determine the destination from the user's request and existing organization. Ask a normal conversational clarification only if the target cannot be determined.
- Write with ordinary file tools and briefly report the resulting note paths. Do not add compilation databases, embeddings, mandatory versions, provenance logs, or graph output files.

## Query and maintain

Search linked directories and their subdirectories with existing file/search tools, then read the relevant notes before answering. Refer to the actual note paths. Distinguish statements supported by notes from your inference. Update, move, or delete notes when the user's request calls for it, following the ordinary file-tool permissions.

Metis derives the displayed graph from links in Markdown notes. Create useful links in the notes; do not generate a separate graph as a required artifact.
