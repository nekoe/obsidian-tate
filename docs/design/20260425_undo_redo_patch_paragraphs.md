# Undo/Redo: Differential Paragraph Update

Created: 2026-04-25

## Problems

Two symptoms from the same code path in `applyFromCm6`:

### 1. Slow Undo/Redo on large files

A typical Undo changes one character in one paragraph, but `applyFromCm6` rebuilt the
entire DOM. For a 200 k-char file (~2,800 paragraphs), this meant six O(N) passes:

| Pass | Cost |
|---|---|
| `this.getValue() !== content` | O(N) DOM serialization |
| `parseToHtml(content)` | O(N) string processing (all paragraphs) |
| `sanitizeHTMLToDom(...)` | O(N) HTML parsing (all paragraphs) |
| `this.el.replaceChildren(...)` | O(N) DOM insertion + layout invalidation |
| `buildSegmentMap(content)` | O(N) segment map construction |
| `setVisibleOffset(viewOffset)` | O(N) TreeWalker traversal |

The first four passes are the expensive ones: DOM manipulation triggers layout
recomputation for all paragraph columns.

### 2. Scroll position jump after Undo/Redo

`replaceChildren` destroys all paragraph `<div>` nodes and creates new ones. New
nodes have no cached size for `contain-intrinsic-block-size: auto`, so the browser
falls back to the 44 px estimate for every off-screen paragraph.

The total scroll width of `.tate-editor` drops from the real value (~252 kpx for
a typical large file) to the fallback estimate (~126 kpx). `.tate-container`'s
`scrollLeft` is preserved in pixels, but if it now exceeds the new total width it
is clamped to the new maximum — the viewport snaps to the rightmost columns.

Additionally, `setVisibleOffset` places the caret at the cursor position, and
the browser's auto-scroll (to make the caret visible) uses the 44 px fallback
sizes to compute the target position, landing further from the intended location.

Both effects are rooted in the same cause as the view-reopen scroll regression
described in `20260425_scroll_restore_content_visibility.md` and
`20260425_content_visibility_ime_performance.md`.

## Fix: differential DOM update (`patchParagraphs`)

### Core idea

Instead of rebuilding all paragraph divs, diff `prevContent` and `content` line by
line and replace only the `<div>` elements whose source line changed.

```typescript
private patchParagraphs(prevContent: string, nextContent: string): void {
    const prevLines = prevContent.split('\n');
    const nextLines = nextContent ? nextContent.split('\n') : [''];
    const el = this.el;

    if (!this.hasCleanDivStructure(prevLines.length)) {
        el.replaceChildren(sanitizeHTMLToDom(parseToHtml(nextContent)));
        return;
    }

    while (el.children.length < nextLines.length)
        el.appendChild(document.createElement('div'));
    while (el.children.length > nextLines.length)
        el.removeChild(el.lastChild!);

    for (let i = 0; i < nextLines.length; i++) {
        if (prevLines[i] === nextLines[i]) continue;
        const div = el.children[i] as HTMLElement;
        div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(nextLines[i]) || '<br>'));
    }
}

// Returns true iff el.childNodes consists of exactly expectedCount <div> elements.
private hasCleanDivStructure(expectedCount: number): boolean {
    if (this.el.childNodes.length !== expectedCount) return false;
    for (const node of Array.from(this.el.childNodes)) {
        if (!(node instanceof HTMLElement) || node.tagName !== 'DIV') return false;
    }
    return true;
}
```

### `hasCleanDivStructure` guard

`patchParagraphs` assumes that `el.childNodes[i]` is a `<div>` whose content matches
`prevLines[i]`. This invariant breaks when the **paste fallback path** is triggered.

The fallback fires in `insertParsedParagraphs` when `findParagraphDiv(range.startContainer)`
returns `null` — which happens when the cursor lands directly on the `.tate-editor`
element itself rather than inside a child `<div>`. This occurs after cutting whole
paragraph divs: `range.deleteContents()` collapses the range to a position between
sibling divs (e.g., `.tate-editor, offset 1`), outside any `<div>` child.

The fallback inserts pasted lines as bare text nodes and `<br>` elements directly
inside `.tate-editor`:

```
<div class="tate-editor">
  <div>paragraph before</div>
  "pasted line 1"          ← bare text node
  <br>                     ← not a <div>
  "pasted line 2"          ← bare text node
  <div>paragraph after</div>
</div>
```

`getValue()` serializes `<br>` nodes (whose parent is the root element, not a `<div>`)
as `'\n'`, so `lastCommittedContent` ends up with the correct line count. However,
`el.children.length` (which counts only element children, including `<br>`) does not
equal `el.childNodes.length` (which also counts text nodes). Simply comparing
`el.children.length` to `prevLines.length` is insufficient — `<br>` is an element
child and would inflate the count to match.

`hasCleanDivStructure` checks `el.childNodes` (not `el.children`) and verifies that
every node is an `HTMLElement` with `tagName === 'DIV'`. This correctly rejects:

- Structures with bare text nodes (`childNodes.length > children.length`)
- Structures where element children are `<br>` instead of `<div>`

When the guard fires, the method falls back to `replaceChildren(parseToHtml(nextContent))`,
which rebuilds the DOM correctly from the post-Undo source text.

### Why it solves both problems

**Performance:** For a single-character Undo, only one `<div>` changes. DOM operations
drop from O(N) to O(1). The O(N) `getValue()` comparison is eliminated entirely —
the caller (`doUndoRedo`) already holds `prevContent` as `lastCommittedContent`.

**Scroll jump:** Unchanged paragraph `<div>` nodes are never destroyed. Their
`contain-intrinsic-block-size: auto` cached sizes are preserved. The total scroll
width of `.tate-editor` does not change after Undo, so `scrollLeft` is not clamped
and no size-estimate-based auto-scroll occurs.

### `prevContent` guarantee

`patchParagraphs` requires `prevContent` to accurately describe the current DOM.
This is guaranteed by the call chain in `doUndoRedo`:

1. `commitToCm6()` — flushes the debounce buffer; sets `lastCommittedContent` to the
   current serialized editor content.
2. `prevContent = this.lastCommittedContent` — captured immediately after the flush.
3. `inlineEditor.reset()` at the start of `applyFromCm6` — collapses any expanded
   inline span, making the DOM reflect the plain source text (matching `prevContent`).
4. `patchParagraphs(prevContent, content)` — diff is therefore valid.

### `applyFromCm6` signature change

The method signature changed from:
```typescript
applyFromCm6(content: string, srcOffset: number): void
```
to:
```typescript
applyFromCm6(prevContent: string, content: string, srcOffset: number): void
```

The caller passes `prevContent` explicitly. The internal O(N) `getValue()` check is
removed: `doUndoRedo` already returns early if `newContent === prevContent`, so the
content is always different when `applyFromCm6` is reached.

## Remaining O(N) costs

Two O(N) passes remain after this fix:

| Pass | Notes |
|---|---|
| `buildSegmentMap(content)` | Required to convert `srcOffset` → `viewOffset`. Pure JS string scan — no DOM involvement. |
| `setVisibleOffset(viewOffset)` | TreeWalker scan from the start of the editor to the cursor position. Pure JS DOM traversal, no layout invalidation. |

These are significantly lighter than DOM manipulation (which triggers layout) and are
acceptable for now. A future optimization could start the TreeWalker from the changed
paragraph div rather than from the start of the editor, reducing `setVisibleOffset`
to O(cursor_paragraph_index) in the common case.

## Interaction with `setValue`

`setValue` (used for file load and external-modify sync) continues to use full
`replaceChildren`. This is intentional:

- **File load:** The entire content changes; there are no unchanged paragraphs to
  preserve. Scroll restore is handled separately by `tate-scroll-restoring`.
- **External modify:** Rare event; a full rebuild is simpler and correct.

`patchParagraphs` is called only from `applyFromCm6`, which is only called from
`doUndoRedo`.

## Edge cases

| Case | Behavior |
|---|---|
| Newline inserted | Paragraph count increases by 1; a new `<div>` is appended and all subsequent lines are re-evaluated. |
| Newline deleted | Paragraph count decreases by 1; the last `<div>` is removed and the merged line is updated. |
| Large paste or multi-line Undo | Multiple lines differ; each changed `<div>` is updated individually. Still faster than `replaceChildren` unless all lines change. |
| Empty content | `nextContent.split('\n')` → `['']`; produces one `<div>` containing `<br>`, matching `parseToHtml('')`. |
| No actual change (undo stack empty) | `doUndoRedo` returns early before calling `applyFromCm6`; `patchParagraphs` is never reached. |
| Paste fallback left dirty DOM | `hasCleanDivStructure` returns false; falls back to full `replaceChildren`. |
