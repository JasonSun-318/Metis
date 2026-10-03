---
name: metis-markdown
description: Create and edit Metis knowledge notes with Obsidian-compatible Markdown, including wikilinks, embeds, callouts, properties, and advanced syntax. Use when formatting knowledge notes or working with these Markdown extensions.
---

# Metis Markdown

Create and edit valid Obsidian Flavored Markdown. Obsidian extends CommonMark and GFM with wikilinks, embeds, callouts, properties, comments, and other syntax. This skill covers only Obsidian-specific extensions -- standard Markdown (headings, bold, italic, lists, quotes, code blocks, tables) is assumed knowledge.

This reference describes Obsidian-compatible syntax, including advanced forms that Metis may not fully display. For Metis knowledge tasks, follow the `knowledge` skill for library selection, optional artifacts, and current reading capabilities. The examples describe available syntax; they are not a checklist of required note content.

## Optional Note Authoring

1. **Add frontmatter when useful or requested**, with properties (title, tags, aliases) at the top of the file. See `references/PROPERTIES.md` for all property types.
2. **Write content** using standard Markdown for structure, choosing extensions below when useful or requested.
3. **Link related existing notes** using wikilinks (`[[Note]]`) for internal library connections, or ordinary Markdown links for relative note paths and external URLs.
4. **Embed content when useful or requested** from other notes, images, or PDFs using the `![[embed]]` syntax. See `references/EMBEDS.md` for all embed types.
5. **Add callouts when useful or requested** for highlighted information using `> [!type]` syntax. See `references/CALLOUTS.md` for all callout types.
6. **Verify** the written content and linked targets with existing file tools. Check Obsidian's reading view only when the user requests an Obsidian workflow and that application is available; Metis tasks do not require it.

> In Obsidian, when choosing between wikilinks and Markdown links: use `[[wikilinks]]` for notes within the vault (Obsidian tracks renames automatically) and `[text](url)` for external URLs only.

## Internal Links (Wikilinks)

```markdown
[[Note Name]]                          Link to note
[[Note Name|Display Text]]             Custom display text
[[Note Name#Heading]]                  Link to heading
[[Note Name#^block-id]]                Link to block
[[#Heading in same note]]              Same-note heading link
```

Define a block ID by appending `^block-id` to any paragraph:

```markdown
This paragraph can be linked to. ^my-block-id
```

For lists and quotes, place the block ID on a separate line after the block:

```markdown
> A quote block

^quote-id
```

## Embeds

Prefix any wikilink with `!` to embed its content inline:

```markdown
![[Note Name]]                         Embed full note
![[Note Name#Heading]]                 Embed section
![[image.png]]                         Embed image
![[image.png|300]]                     Embed image with width
![[document.pdf#page=3]]               Embed PDF page
```

See `references/EMBEDS.md` for audio, video, search embeds, and external images.

## Callouts

```markdown
> [!note]
> Basic callout.

> [!warning] Custom Title
> Callout with a custom title.

> [!faq]- Collapsed by default
> Foldable callout (- collapsed, + expanded).
```

Common types: `note`, `tip`, `warning`, `info`, `example`, `quote`, `bug`, `danger`, `success`, `failure`, `question`, `abstract`, `todo`.

See `references/CALLOUTS.md` for the full list with aliases, nesting, and custom CSS callouts.

## Properties (Frontmatter)

```yaml
---
title: My Note
date: 2024-01-15
tags:
  - project
  - active
aliases:
  - Alternative Name
cssclasses:
  - custom-class
---
```

Default properties: `tags` (searchable labels), `aliases` (alternative note names for link suggestions), `cssclasses` (CSS classes for styling).

See `references/PROPERTIES.md` for all property types, tag syntax rules, and advanced usage.

## Tags

```markdown
#tag                    Inline tag
#nested/tag             Nested tag with hierarchy
```

Tags can contain letters, numbers (not first character), underscores, hyphens, and forward slashes. Tags can also be defined in frontmatter under the `tags` property.

## Comments

```markdown
This is visible %%but this is hidden%% text.

%%
This entire block is hidden in reading view.
%%
```

## Obsidian-Specific Formatting

```markdown
==Highlighted text==                   Highlight syntax
```

## Math (LaTeX)

```markdown
Inline: $e^{i\pi} + 1 = 0$

Block:
$$
\frac{a}{b} = c
$$
```

## Diagrams (Mermaid)

````markdown
```mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do this]
    B -->|No| D[Do that]
```
````

To link Mermaid nodes to Obsidian notes, add `class NodeName internal-link;`.

## Footnotes

```markdown
Text with a footnote[^1].

[^1]: Footnote content.

Inline footnote.^[This is inline.]
```

## Complete Example

````markdown
---
title: Project Alpha
date: 2024-01-15
tags:
  - project
  - active
status: in-progress
---

# Project Alpha

This project aims to [[improve workflow]] using modern techniques.

> [!important] Key Deadline
> The first milestone is due on ==January 30th==.

## Tasks

- [x] Initial planning
- [ ] Development phase
  - [ ] Backend implementation
  - [ ] Frontend design

## Notes

The algorithm uses $O(n \log n)$ sorting. See [[Algorithm Notes#Sorting]] for details.

![[Architecture Diagram.png|600]]

Reviewed in [[Meeting Notes 2024-01-10#Decisions]].
````

## Local Reference Files

- Read `references/PROPERTIES.md` for property types and tags.
- Read `references/EMBEDS.md` for note, media, PDF, and query embed syntax.
- Read `references/CALLOUTS.md` for callout types, nesting, and custom styling.
