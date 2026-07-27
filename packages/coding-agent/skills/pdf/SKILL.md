---
name: pdf
description: Read, extract, analyze, create, edit, merge, split, rotate, crop, watermark, fill, encrypt, render, and verify PDF files. Use whenever a PDF is attached or requested, including text PDFs, scanned PDFs, forms, annotations, embedded images, and page-level operations.
---

# PDF

Use local tools already present in ArcMind. Never upload a PDF, page image, or extracted asset to a remote service. Never install or update tools during a task, and never use OCR.

## Paths and lifecycle

- Use the exact absolute PDF path from the `<attachment>` or `<attachments>` block.
- A simple read must stream results to stdout. Do not create a work directory, extracted-text file, rendered page, or copied PDF for metadata, text extraction, search, Q&A, or summary.
- Final PDFs and other user-requested deliverables go only in `$ARCMIND_ATTACHMENTS_DIR`.
- ArcMind creates a unique `$ARCMIND_WORK_DIR` for the current run. Temporary page renders, extracted images, overlays, and conversion files go only there; never create `.work`, `work`, `tmp`, or another scratch directory beside an attachment.
- For an operation that produces temporary files, start from `cd "$ARCMIND_WORK_DIR"`. ArcMind clears the directory when the agent run ends.
- Preserve the input by default. Write modifications to a new final file unless the user explicitly requests an in-place change to an ArcMind-owned attachment.

## Choose the smallest sufficient operation

| Need | Preferred local tool |
|---|---|
| Metadata, page count, dimensions | `pdfinfo` |
| Text with page/layout hints | `pdftotext -layout` |
| Tables or positioned text | installed Python `pdfplumber` |
| Merge, split, reorder, rotate, crop, metadata, forms, encryption | installed Python `pypdf` |
| Lossless page operations, validation, repair, encryption | `qpdf` when available |
| Create a new PDF or overlay/watermark | installed Python `reportlab` |
| List or extract embedded images | `pdfimages` |
| Render selected pages | `pdftoppm` |

Check a tool before relying on it. If the required local capability is absent, explain the limitation instead of downloading a dependency or using a remote fallback.

## Read and analyze

Start with structural and text inspection. Do not render the whole document by default.

```bash
pdfinfo "$PDF"
pdftotext -layout "$PDF" -
```

- Keep page numbers with extracted text and citations.
- Run `pdfimages -list "$PDF"` only when the question involves embedded images.
- Use `pdfplumber` only when tables, bounding boxes, or reading order require it.
- Extract or render only images/pages relevant to the question. Do not describe every visual for a focused Q&A or summary.
- For a complete accessible export, process pages in order and place each image description or placeholder at its page and figure position.

## Scanned PDFs

Scanned content is vision-only. Do not use Tesseract, PaddleOCR, system OCR APIs, cloud OCR, or hidden OCR fallbacks.

```bash
cd "$ARCMIND_WORK_DIR"
pdftoppm -png -r 144 -f "$FIRST" -l "$LAST" "$PDF" page
```

- If the current model accepts image input, read only the needed rendered pages.
- If image input is unavailable, use `[Page N requires a vision-capable model]`; do not guess.
- A printed PNG path is not image input. The page must actually be supplied to the model through the available image-reading mechanism.

## Create and edit

- Use `pypdf` for page manipulation, metadata, AcroForm fields, annotations, and encryption.
- Use `reportlab` for new page content or a transparent overlay, then merge that overlay with the original using `pypdf`.
- Prefer lossless page operations for merge, split, reorder, rotate, crop, and metadata changes.
- Preserve page boxes, rotation, bookmarks, form fields, and metadata unless the request says otherwise.
- For filled forms, set field values and appearance-generation flags, then verify the values can be read back.
- For redaction, do not cover text with an opaque rectangle and call it redacted. Remove the underlying content with a suitable installed tool or state that secure redaction is unavailable.
- Write directly to a final path in `$ARCMIND_ATTACHMENTS_DIR`; keep overlay sources and scratch outputs in `$ARCMIND_WORK_DIR`.

## Verification

Always run structural checks appropriate to the change:

```bash
pdfinfo "$OUTPUT"
qpdf --check "$OUTPUT"   # when qpdf is available
pdftotext -layout "$OUTPUT" -
```

Confirm page count/order, expected text, metadata, form values, encryption, crop, or rotation as relevant.

Visual inspection is conditional, not mandatory. Render and read affected pages only when the task requires visual confirmation of layout, images, handwriting, equations, clipping, overlays, or final appearance. If visual confirmation is needed but the model cannot accept images, report exactly what remains visually unverified; do not block a structurally verified operation that did not require vision.
