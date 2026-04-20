# Paste with Aozora Notation Parsing

Created: 2026-04-20

## Supersedes

The "Plain-Text Paste" section of `docs/design/20260415_dom_and_ux.md`.

## Motivation

Previously, pasting text that contained Aozora notation (e.g. `｜漢字《よみ》`) inserted it as raw characters rather than rendering it as `<ruby>` / `.tcy` / `.bouten` elements. This broke the copy→paste workflow: selected text in the vertical writing view is serialized to Aozora notation on the clipboard, so re-pasting it would lose the visual markup.

## Design

`EditorElement.handlePaste()` now parses Aozora notation in the pasted text before inserting it into the DOM.

### Single-line paste

Each pasted line is processed through `parseInlineToHtml(line)` → `sanitizeHTMLToDom()`, producing a `DocumentFragment` of inline elements (`<ruby>`, `<span class="tcy">`, `<span class="bouten">`, and text nodes). The nodes are inserted one by one at the cursor position using the Range API, preserving cursor placement after insertion.

### Multi-line paste

Multi-line paste creates one paragraph `<div>` per line, matching the paragraph structure that Enter produces.

1. Find the paragraph `<div>` (direct child of `.tate-editor`) that contains the cursor via `findParagraphDiv()`.
2. Extract the content from the cursor to the end of that paragraph into a `DocumentFragment` (`afterFragment`).
3. Append the first line's parsed inline nodes to the now-truncated paragraph div.
4. For each subsequent line, create a new `<div>`, populate it with the parsed inline nodes, and insert it after the previous paragraph.
5. The last new `<div>` also receives `afterFragment` (the original content that followed the cursor).
6. The cursor is placed after the last pasted inline node, immediately before `afterFragment`.

### Fallback

If `findParagraphDiv()` returns `null` (cursor is not inside a block `<div>`, which should not occur in normal use since `setValue()` always wraps paragraphs), the multi-line paste falls back to `<br>`-separated inline insertion.

### XSS safety

All HTML strings produced by `parseInlineToHtml()` pass through `sanitizeHTMLToDom()` before being inserted into the DOM, consistent with the prohibition on direct `innerHTML` assignment documented in `20260415_dom_and_ux.md`.

## What is unchanged

- `e.preventDefault()` + `e.clipboardData.getData('text/plain')` — rich text (HTML) from the clipboard is still discarded.
- `this.inlineEditor.onBeforeInput()` after paste — `inBurst` flag is still set manually since `beforeinput` does not fire for paste.
- `commitToCm6()` is called by `view.ts` immediately after paste, unchanged.
