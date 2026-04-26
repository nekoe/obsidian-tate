# Scroll Restore with content-visibility: auto

Created: 2026-04-25

## Background

A previous session added `content-visibility: auto` + `contain-intrinsic-block-size: auto 44px`
to `.tate-editor > div` paragraph elements to eliminate IME lag on large files. This works by
skipping layout and paint for off-screen paragraphs during editing. However, the change introduced
a regression: closing and reopening the vertical writing view no longer restored the scroll
position to the cursor.

## Root Cause

`content-visibility: auto` uses size containment for off-screen elements. When no real size has
been recorded for an element (i.e., the element was just created and has never been rendered),
the browser falls back to the `contain-intrinsic-block-size` value: `44px` per paragraph div.

When the view is **closed and reopened**, `onOpen()` calls `container.empty()` and constructs
a new `EditorElement`, destroying the old DOM entirely. `loadFile()` then calls
`el.replaceChildren(...)`, creating fresh paragraph divs. These new elements have no cached
size — `contain-intrinsic-block-size: auto 44px` falls back to the 44 px estimate for all
of them.

`scrollCursorIntoView()` calls `element.scrollIntoView({ block: 'center', inline: 'center' })`.
The browser computes the target element's document position by summing the block sizes of all
preceding paragraphs. With the 44 px fallback in effect, this sum is systematically too small.

### Quantified example

A 200 k-char file with ~2,857 paragraph divs, average ~2 lines per paragraph at 22 px font
with `line-height: 2`:

| | Per paragraph | Total |
|---|---|---|
| Estimated (44 px fallback) | 44 px | ~126 kpx |
| Real (2 lines × 44 px) | ~88 px | ~252 kpx |

For a cursor at the 50 % point, `scrollIntoView` targets ~63 kpx instead of ~126 kpx — the
cursor ends up roughly one scroll-width off screen.

## Fix

### CSS: `tate-scroll-restoring` override class

```css
.tate-editor.tate-scroll-restoring > div {
    content-visibility: visible;
}
```

When this class is present on `.tate-editor`, `content-visibility: visible` overrides `auto`
for every direct `<div>` child. The browser computes real paragraph sizes from actual content
instead of the 44 px fallback. The class is transient — removed after the scroll completes.

CSS specificity: `.tate-editor.tate-scroll-restoring > div` is `(0,2,1)` vs `.tate-editor > div`
at `(0,1,1)`, so the override wins unconditionally.

### Key design decision: set the class BEFORE `replaceChildren`

Setting the class immediately before calling `scrollIntoView` (with the DOM already built)
would rely on a CSS-invalidation-triggered forced reflow to recompute all paragraph sizes.
This was tried first but failed to reliably restore scroll.

The correct approach is to add the class **before** `syncCoordinator.loadFile()`, which calls
`editorEl.setValue()` → `el.replaceChildren(...)`. With the class already active, new paragraph
divs are created with `content-visibility: visible` from the start — they never pass through
the 44 px fallback state. When `scrollIntoView` is subsequently called, the sizes were always
real and no recomputation trick is needed.

### Key design decision: defer scroll to `requestAnimationFrame`

Calling `scrollCursorIntoView()` synchronously inside `loadInitialFile` or `restoreViewOffset`
fails because Obsidian's view-activation sequence — including `active-leaf-change` events,
`focus()` calls that reset the caret, and `revealLeaf()` — runs after `onOpen()` returns and
can overwrite or ignore the scroll position.

Deferring to a `requestAnimationFrame` ensures the scroll executes in the first frame *after*
all synchronous activation logic has completed, when the container has its final layout
dimensions.

### Two-rAF removal pattern

```
add class  →  loadFile  →  [active-leaf-change fires if needed]
  →  rAF 1: setViewCursorOffset + scrollCursorIntoView
  →  rAF 2: classList.remove('tate-scroll-restoring')
```

The class is held for two frames rather than removed synchronously for one reason:
`contain-intrinsic-block-size: auto` caches the real rendered size per element. This cache
is populated when the element is rendered (layout + paint). Keeping the class through one
full paint frame ensures all paragraph sizes are cached before `content-visibility: auto`
resumes. Subsequent `scrollCursorIntoView()` calls within the same DOM session are then
accurate even without the class.

## Additional fixes landed in the same change

### `lastKnownViewOffset` synchronous update

`restoreViewOffset()` and the `pendingCursorOffset` path in `active-leaf-change` now set
`this.lastKnownViewOffset = savedOffset` synchronously, immediately after
`el.setViewCursorOffset(savedOffset)`. This eliminates the window where `lastKnownViewOffset`
is `null` after a restore (because `selectionchange` fires asynchronously), which was the
root cause of the rare Cmd-W cursor loss documented in `20260424_cursor_persistence.md`.

### Generation counter for fast file switching

`scrollRestoringGeneration` is a monotonic integer incremented each time `tate-scroll-restoring`
is added to the editor element. Every `classList.remove` rAF snapshots the counter at scheduling
time and skips removal if the counter has since advanced:

```typescript
const gen = ++this.scrollRestoringGeneration;
el.classList.add('tate-scroll-restoring');
// ... (async loadFile) ...
requestAnimationFrame(() => {
    if (this.scrollRestoringGeneration === gen)
        el.classList.remove('tate-scroll-restoring');
});
```

Without this guard, rapid file switching causes multiple concurrent async IIFEs. A superseded
IIFE's early-return cleanup rAF could remove the class that belongs to a newer load, causing
that load's `scrollCursorIntoView()` to run with 44 px estimates.

## Code paths

| Trigger | Class added | Scroll executed | Class removed |
|---|---|---|---|
| View open (view active during `loadInitialFile`) | before `loadFile()` in `loadInitialFile` | rAF 1 in `restoreViewOffset` | rAF 2 in `restoreViewOffset` |
| View open (view not yet active) | before `loadFile()` in `loadInitialFile` | `active-leaf-change` pendingCursorOffset path | rAF in `active-leaf-change` |
| File switch (`file-open` event) | before `loadFile()` in `file-open` handler | rAF 1 in `restoreViewOffset` | rAF 2 in `restoreViewOffset` |
| No saved cursor (any trigger) | before `loadFile()` | — | cleanup rAF (generation-guarded) |
| File changed during async load | before `loadFile()` | — | cleanup rAF (generation-guarded) |
| Undo/Redo (`Cmd+Z` / `Cmd+Shift+Z`) | — (not needed; `patchParagraphs` preserves size cache for unchanged paragraphs) | synchronously in `doUndoRedo` | — |
