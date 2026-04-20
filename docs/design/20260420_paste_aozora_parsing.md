# Copy / Cut / Paste with Aozora Notation

Created: 2026-04-20

## Supersedes

The "Plain-Text Paste" section of `docs/design/20260415_dom_and_ux.md`.

## Background: What the clipboard actually contains

When a user copies text from a `contenteditable` div, the browser writes two formats to the clipboard:

- `text/html` — the raw HTML of the selected DOM nodes (e.g. `<ruby data-ruby-explicit="true">漢字<rt>よみ</rt></ruby>`)
- `text/plain` — the rendered text content only (e.g. `漢字よみ`), without any Aozora annotation marks

The previous paste handler read only `text/plain`, so ruby/tcy/bouten elements were silently lost during copy→paste.

## Copy and Cut design

`EditorElement.handleCopy()` and `handleCut()` intercept the `copy` / `cut` events and write Aozora notation to `text/plain`:

1. Get the current `Selection` and validate it (non-collapsed, within `.tate-editor`).
2. `range.cloneContents()` → `DocumentFragment` of the selected DOM nodes.
3. Walk the fragment with `serializeNode(n, this.el)` (the same function used by `getValue()`) to produce Aozora notation text.
4. `e.preventDefault()` + `e.clipboardData.setData('text/plain', text)`.
5. For **cut** only: `range.deleteContents()` removes the selection; `view.ts` calls `commitToCm6()` immediately after.

`text/html` is not set; the browser's default HTML representation is suppressed by `e.preventDefault()`. Pasting into external apps yields the Aozora plain-text.

### Why `serializeNode` works on a cloned fragment

`serializeNode(node, rootEl)` uses `rootEl` only to detect Chrome's trailing decorative `<br>` (the condition `node.parentElement !== rootEl`). For nodes inside a cloned `DocumentFragment`, `node.parentElement` is never `this.el`, so the condition is always satisfied and trailing `<br>` elements are correctly skipped — the same result as `getValue()`.

The first `<div>` in the fragment has `previousSibling === null`, so no leading `\n` is prepended, matching the `getValue()` behavior for the first paragraph.

### Copy is read-only — no `guardCm6`

`handleCopy` does not modify the DOM or CM6 state, so it runs regardless of CM6 availability (no `guardCm6` check in `view.ts`). `handleCut` does modify content and therefore requires `guardCm6`.

## Paste design

`EditorElement.handlePaste()` parses Aozora notation in the pasted text before inserting it into the DOM. Because copy now writes Aozora notation to `text/plain`, pasting within the editor correctly restores ruby/tcy/bouten elements.

### Single-line paste

Each pasted line is processed through `parseInlineToHtml(line)` → `sanitizeHTMLToDom()`, producing a `DocumentFragment` of inline elements (`<ruby>`, `<span class="tcy">`, `<span class="bouten">`, and text nodes). The nodes are inserted one by one at the cursor position using the Range API.

### Multi-line paste

Multi-line paste creates one paragraph `<div>` per line, matching the paragraph structure that Enter produces.

1. Find the paragraph `<div>` (direct child of `.tate-editor`) that contains the cursor via `findParagraphDiv()`.
2. Extract the content from the cursor to the end of that paragraph into a `DocumentFragment` (`afterFragment`).
3. Append the first line's parsed inline nodes to the now-truncated paragraph div.
4. For each subsequent line, create a new `<div>`, populate it with the parsed inline nodes, and insert it after the previous paragraph.
5. The last new `<div>` also receives `afterFragment` (the original content that followed the cursor).
6. The cursor is placed after the last pasted inline node, immediately before `afterFragment`.

### Fallback

If `findParagraphDiv()` returns `null` or an inline element is currently expanded (`isExpanded()`), the multi-line paste falls back to `<br>`-separated inline insertion to avoid corrupting the `tate-editing` span.

### XSS safety

All HTML strings produced by `parseInlineToHtml()` pass through `sanitizeHTMLToDom()` before being inserted into the DOM, consistent with the prohibition on direct `innerHTML` assignment documented in `20260415_dom_and_ux.md`.

## What is unchanged

- `e.clipboardData.getData('text/plain')` — paste still reads only plain text (Aozora notation written by copy).
- `this.inlineEditor.onBeforeInput()` after paste — `inBurst` flag is still set manually since `beforeinput` does not fire for paste.
- `commitToCm6()` is called by `view.ts` immediately after paste and cut, unchanged.
