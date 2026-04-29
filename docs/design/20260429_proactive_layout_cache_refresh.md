# Proactive Layout Cache Refresh for content-visibility:auto

Created: 2026-04-29

## Problem

`content-visibility: auto` with `contain-intrinsic-block-size: auto 44px` caches each
paragraph's rendered size after its first paint. Once cached, off-screen paragraphs use that
cached size for layout computations — including `scrollIntoView()` — without needing to be
rendered again. This makes search navigation and scroll restore accurate without forcing a full
layout pass every time.

However, three DOM-mutating operations can create or update `<div>` elements while those divs
are off-screen, leaving the cache stale or absent:

| Operation | What happens to divs | Current handling |
|---|---|---|
| **Multi-line paste** | New `<div>`s inserted by `insertParsedParagraphs` | No cache refresh; `onContentChanged()` sets `contentVisibilityDirty=true` in `SearchPanel` as a compensating measure |
| **Undo/Redo** | `patchParagraphs` calls `div.replaceChildren()` on changed divs | No cache refresh; `onContentChanged()` not called at all — gap |
| **External file edit** | `editorEl.setValue()` calls `replaceChildren()` on the editor root — all divs rebuilt | No cache refresh; `onContentChanged()` not called — gap |

The existing `SearchPanel.contentVisibilityDirty` flag is a compensating measure: it forces
`tate-searching` (a full layout pass) at search-navigation time when it suspects the cache is
stale. But this approach is reactive and over-broad. Every navigation after a paste or Undo/Redo
triggers a full layout of the entire document.

## Goal

Update the `contain-intrinsic-block-size: auto` cache **at the point of mutation**, so that by
the time the user scrolls or searches, the cache is always accurate. This eliminates:

- `SearchPanel.contentVisibilityDirty` flag
- `tate-searching` CSS class and all associated code
- `onContentChanged()` calls from `view.ts` (no longer needed for the cache)

## Background: `contain-intrinsic-block-size: auto` caching model

A `content-visibility: auto` div transitions between two states:

- **Skipped** (off-screen): layout is skipped; the element uses `contain-intrinsic-block-size`
  as its size. With `contain-intrinsic-block-size: auto 44px`, the browser uses the
  *last-remembered size* if one exists, or the 44px fallback if it does not.
- **Non-skipped** (on-screen or forced `content-visibility: visible`): normal layout runs;
  the rendered size is written into the last-remembered size cache.

The cache is invalidated when the element is removed from the DOM. It is **not** automatically
invalidated when the element's content is changed via JavaScript while it is off-screen. This
is the root cause of stale-cache bugs after paste, Undo/Redo, and external edit.

## Two-rAF pattern for cache update

To force the browser to compute the actual size of a specific set of off-screen divs and write
it into the last-remembered size cache, we need those divs to be rendered at least once. The
mechanism used by the existing `tate-scroll-restoring` lifecycle generalises here.

The browser render pipeline within a frame is:

```
[rAF callbacks] → [style recalculation] → [layout] → [paint]
```

rAF callbacks run **before** style recalculation and layout for the same frame. Therefore:

```
Sync code (paste/undo handler):
    add 'tate-layout-refreshing' class to affected divs  ← div is now content-visibility:visible

Frame N:
    rAF 1 (do nothing — do NOT remove class yet)
    style recalculation: tate-layout-refreshing → content-visibility:visible
    layout: actual sizes computed → last-remembered-size CACHE UPDATED ✓
    paint

Frame N+1:
    rAF 2: remove 'tate-layout-refreshing' class
    style recalculation: no class → content-visibility:auto
    layout: uses cached sizes ✓
    paint
```

Removing the class in rAF 1 would prevent Frame N's layout from computing the actual size, so
two rAFs are required — the same reason `tate-scroll-restoring` uses two rAFs.

For full-page refresh (external edit), the same two-rAF pattern applies but using the existing
`tate-scroll-restoring` class on the editor element (more efficient than adding a class to each
div individually when all divs are rebuilt).

**Critical: class must be active during the layout that follows the mutation.** Both approaches
require that the class is applied within the same synchronous execution context as the DOM
mutation (same frame), so that the very next layout pass runs with the class active.

## Design

### 1. New CSS class: `tate-layout-refreshing` (targeted per-div refresh)

```css
/* Temporarily forces content-visibility:visible on specific paragraphs to update
   their contain-intrinsic-block-size:auto cached size after a DOM mutation (paste,
   Undo/Redo). Added synchronously after mutation; removed in the second rAF. */
.tate-editor > div.tate-layout-refreshing {
    content-visibility: visible;
}
```

Used for paste and Undo/Redo. Never needs a spinner (2 frames ≈ 33 ms — imperceptible).

### 2. `patchParagraphs` → returns changed divs

```typescript
// Before (returns void):
private patchParagraphs(prevContent: string, nextContent: string): void

// After (returns changed/added divs, or null for full rebuild):
private patchParagraphs(prevContent: string, nextContent: string): HTMLDivElement[] | null
```

The `null` return signals that `hasCleanDivStructure` failed and a full `replaceChildren` was
performed (see §4 below). In all other cases the returned array contains the divs whose content
was updated or that were newly appended.

`applyFromCm6` propagates this return value:

```typescript
applyFromCm6(prevContent: string, content: string, srcOffset: number): HTMLDivElement[] | null
```

### 3. `handlePaste` → returns divs that need cache refresh

```typescript
// Before (returns void):
handlePaste(e: ClipboardEvent): void

// After:
handlePaste(e: ClipboardEvent): HTMLDivElement[]
```

Returns the newly inserted or modified divs:

| Paste path | Returned divs |
|---|---|
| `insertParsedInline` (single-line, cursor inside a paragraph div) | `[]` — cursor div is always visible, cache updates naturally |
| `insertParsedParagraphs`, `range.startContainer === this.el` path | All newly created `<div>` elements |
| `insertParsedParagraphs`, normal path | The N−1 newly appended `<div>` elements (first div is the cursor div, always visible) |
| Inline-expanded fallback (inserts `<br>`-separated content) | `[]` — same div, always visible |

### 4. New `scheduleLayoutRefresh(divs)` in `view.ts`

```typescript
private scheduleLayoutRefresh(divs: HTMLDivElement[]): void {
    if (divs.length === 0) return;
    divs.forEach(d => d.classList.add('tate-layout-refreshing'));
    requestAnimationFrame(() => {
        // Frame N: layout has run with tate-layout-refreshing active → cache updated.
        // Remove in frame N+1 so we do not interfere with Frame N's layout.
        requestAnimationFrame(() => {
            divs.forEach(d => d.classList.remove('tate-layout-refreshing'));
        });
    });
}
```

No spinner. Two rAFs.

### 5. `doUndoRedo` in `view.ts`: call `scheduleLayoutRefresh` after `applyFromCm6`

```typescript
const changedDivs = editorEl.applyFromCm6(prevContent, newContent, srcOffset);
if (changedDivs === null) {
    // hasCleanDivStructure failed → full rebuild; treat like external edit
    const gen = this.beginScrollRestoring();
    this.scheduleScrollRestoringCleanup(gen);
} else {
    this.scheduleLayoutRefresh(changedDivs);
}
editorEl.scrollCursorIntoView('nearest', 'nearest');
```

### 6. Paste handler in `view.ts`: call `scheduleLayoutRefresh` after `handlePaste`

```typescript
this.registerDomEvent(editorEl.el, 'paste', (e: ClipboardEvent) => {
    const newDivs = editorEl.handlePaste(e);
    this.commitToCm6();
    this.scheduleLayoutRefresh(newDivs);
});
```

### 7. External edit: apply `tate-scroll-restoring` before `setValue`

The `setEditorValue` callback inside `VerticalWritingView.onOpen()` currently calls
`editorEl.setValue(content, preserveCursor)` unconditionally. `preserveCursor=true` is used
exclusively for external edits (`onExternalModify`); file load and file delete always use
`preserveCursor=false`.

Proposed change to the callback:

```typescript
(content, preserveCursor) => {
    this.lastCommittedContent = content;
    if (preserveCursor) {
        // External edit: rebuild all divs under tate-scroll-restoring so they are born
        // with content-visibility:visible → cache is accurate from their first paint.
        // Then restore cursor and scroll, identical to the file-load path.
        const savedOffset = this.editorEl?.getViewCursorOffset() ?? 0;
        const gen = this.beginScrollRestoring();     // adds class BEFORE setValue
        editorEl.setValue(content, false);           // new divs born with class active
        this.plugin.updateCharCount(countChars(content));
        if (this.app.workspace.getActiveViewOfType(VerticalWritingView) === this) {
            this.restoreViewOffset(savedOffset);     // rAF 1 scroll, rAF 2 remove class
        } else {
            this.scheduleScrollRestoringCleanup(gen);
        }
    } else {
        // File load or file delete: caller manages the tate-scroll-restoring lifecycle.
        editorEl.setValue(content, false);
        this.plugin.updateCharCount(countChars(content));
    }
},
```

The spinner is shown by `beginScrollRestoring()` (same as file load) and hidden in
`restoreViewOffset`'s rAF 1. This matches the existing UX for file switching.

### 8. `SearchPanel` simplification

Once the proactive cache refresh is in place, `SearchPanel` no longer needs to manage the
`content-visibility` cache. The following are removed:

| Removed | Replacement |
|---|---|
| `contentVisibilityDirty: boolean` field | (deleted) |
| `contentVisibilityDirty = true` in `open()` | (deleted) |
| `contentVisibilityDirty = true` in `onContentChanged()` | (deleted) |
| `tate-searching` class add/remove in `scrollRangeIntoView` | (deleted) |
| `scrollGen` counter and its rAF guard | (deleted) |
| `tate-searching` CSS rule | (deleted) |

`scrollRangeIntoView` becomes:

```typescript
private scrollRangeIntoView(range: Range): void {
    const node = range.startContainer;
    const el = node instanceof Element ? node : node.parentElement;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
```

`onContentChanged` becomes:

```typescript
onContentChanged(): void {
    if (!this.isOpen) return;
    this.runSearch(false); // update highlights only; no scroll while user is editing
}
```

(The `scroll=false` argument to `runSearch` is unchanged; it was already there to avoid
scrolling while the user types in the editor.)

## Spinner policy

| Operation | Spinner |
|---|---|
| File load / switch | ✅ (existing `tate-scroll-restoring` path, unchanged) |
| External file edit | ✅ (`beginScrollRestoring()` now added to this path) |
| Multi-line paste (any size) | ❌ (2 frames, imperceptible) |
| Undo/Redo (changed divs) | ❌ (2 frames, imperceptible) |
| Undo/Redo (`hasCleanDivStructure` fallback) | ✅ (`beginScrollRestoring()` triggered) |

## Files changed

| File | Change |
|---|---|
| `styles.css` | Add `.tate-editor > div.tate-layout-refreshing` rule; remove `.tate-editor.tate-searching > div` |
| `src/ui/EditorElement.ts` | `patchParagraphs` → returns `HTMLDivElement[] \| null`; `applyFromCm6` → propagates return; `handlePaste` → returns `HTMLDivElement[]` |
| `src/view.ts` | Add `scheduleLayoutRefresh()`; update `doUndoRedo()` and paste handler; update `setEditorValue` callback for external edit |
| `src/ui/SearchPanel.ts` | Remove `contentVisibilityDirty`, `scrollGen`, `tate-searching` management; simplify `scrollRangeIntoView` |

## Remaining gaps (out of scope)

- **Settings change** (font-size, font-family, line-break): all paragraph heights may change.
  Currently not addressed. A full `tate-scroll-restoring` pass on `applySettings()` would fix it.
- **Window resize**: rare edge case; paragraph heights in `writing-mode: vertical-rl` depend on
  the container height. Not addressed.
