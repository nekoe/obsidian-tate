# Full DOM Virtualization: Design Notes and Implementation History

Created: 2026-05-05  
Last updated: 2026-05-07

## Background

The existing pseudo-virtualization (`ParagraphVirtualizer`, introduced in
`20260504_dom_virtualization.md`) emptied off-screen paragraph divs. Their content was stored in
`frozenSrc` / `frozenViewLen` WeakMaps and a `paragraphRecords[]` array. Every frozen div shell
still remained in the DOM tree. On a 936 k-character file the editor held ~21,000 div shells.

### Remaining performance problem after pseudo-virtualization

Investigation (2026-05-05) revealed that selecting multiple paragraphs and pressing Backspace/Delete
caused O(N) slowness and a memory spike proportional to the number of selected lines. The root cause:
Chrome's native `contenteditable` deletion (`deleteContentBackward`) performs per-node work —
undo-record allocation, NBSP injection, and `writing-mode: vertical-rl` column layout recomputation
— for every DOM node inside the selection range, including frozen shells.

**Mitigation applied**: intercept `deleteContent*` `beforeinput` events when the selection is
non-collapsed; call `range.deleteContents()` directly and repair the paragraph structure in
JavaScript, bypassing Chrome's internal O(N) processing. Collapsed single-character deletion
continues to use Chrome's native handler (correct grapheme-cluster boundary handling).

After this fix, deletion time is ~25 ms for any selection size (dominated by `range.deleteContents()`
removing N DOM nodes) instead of growing linearly with the number of deleted paragraphs. The fix
is in `EditorElement.handleSelectionDelete()` and `deleteRangeContents()`.

### Why pseudo-virtualization could not fully solve the problem

`range.deleteContents()` still traversed all DOM nodes inside the range, including frozen shells.
Full virtualization — keeping only the visible window in the DOM — reduces the node count that
`deleteContents()` must traverse, cutting deletion cost proportionally.

---

## Full Virtualization: Design

### Core idea

Keep only a contiguous window of paragraph divs in the DOM. Off-screen paragraphs outside the
window are stored as plain data (not DOM nodes). Two spacer divs represent the total width of the
off-screen paragraphs before and after the window:

```
scroll container (overflow-x: auto, writing-mode: vertical-rl)
│
├── [right spacer] style="width: Wpx"   ← total width of paragraphs 0..domStart-1
├── [div] paragraph domStart
├── [div] paragraph domStart+1
│    ...
├── [div] paragraph domEnd
└── [left spacer]  style="width: Wpx"   ← total width of paragraphs domEnd+1..N-1
```

In `writing-mode: vertical-rl` the first paragraph appears on the right side and subsequent
paragraphs extend leftward, so the right spacer covers the paragraphs before the window (not yet
scrolled into view from the right) and the left spacer covers paragraphs after the window.

### Per-paragraph data store

Full virtualization requires per-paragraph width data to survive DOM removal. `WeakMap` entries are
garbage-collected when their key element is removed, so a plain indexed array is necessary:

```typescript
interface ParagraphRecord {
    src: string;       // Aozora source line
    viewLen: number;   // visible character count (excluding annotation markers and rt text)
    width: number;     // measured or estimated pixel width; 0 = unknown (never in window)
}
paragraphRecords: ParagraphRecord[];
```

`width: 0` (or a placeholder estimate of 44 px = one column at the default font size) is used for
paragraphs that have never entered the viewport. The actual value is written when the paragraph
first leaves the window and its measured width is captured.

### DOM window management

The window is defined by `[domStart, domEnd]` (inclusive, paragraph indices). Window expansion
and contraction are triggered by an `IntersectionObserver` on the boundary divs (first and last
of the window):

- **Boundary div enters extended viewport** → expand the window by one paragraph in that direction:
  create a new div from `paragraphRecords[domStart-1]` (or `domEnd+1`), insert it at the
  appropriate end, and shrink the corresponding spacer by the new div's estimated/measured width.
- **Boundary div leaves extended viewport (beyond a buffer threshold)** → contract the window from
  the far end: read the div's current width, add it to the appropriate spacer, then remove the div.

Because the spacer's width change and the div's width change cancel each other, `scrollWidth`
remains constant and `scrollLeft` does not shift.

### Scroll position stability

When a new div is inserted at the right end of the window (right-side expansion in vertical-rl),
the content shifts leftward if the browser adds the new div width to `scrollWidth` without
adjusting `scrollLeft`. This is the classic "prepend items to a horizontal scroll container"
problem. The spacer approach resolves it: the right spacer shrinks by exactly the new div's
width simultaneously with the div insertion, keeping `scrollWidth` constant and eliminating any
visual jump.

For paragraphs with an estimated width (never measured), the spacer size will be slightly
inaccurate until the paragraph is measured. Accepting a small one-time positional correction on
first measurement is the same trade-off made by all variable-height virtual scrollers.

---

## Technical Challenges

### 1. Drag selection spanning virtual boundaries

If the user starts a drag selection and scrolls so that the anchor end of the selection would
leave the DOM window, the selection breaks (the browser cannot represent a range whose anchor is
outside the DOM).

**Solution**: track whether a drag is in progress (between `mousedown` and `mouseup`). Do not
remove a div from the window if it contains `selection.anchorNode` or `selection.focusNode`.

### 2. Width of never-rendered paragraphs

A paragraph that has never been in the viewport has no measured width. Using 44 px (one column
width at the default font size 22px × lineHeight 2) as a placeholder causes the spacer to be
inaccurate by `(realWidth - 44) × count` pixels for all unrendered paragraphs.

**Acceptable trade-off**: the inaccuracy only affects paragraphs in the right spacer (not yet
scrolled to from the right, i.e., not yet read). The error corrects itself the first time each
paragraph enters the viewport. For a document read front-to-back this causes no visible jump.
For random-access navigation (e.g., the outline panel jumping to an unrendered heading), a
one-time correction is acceptable.

**Width estimation**: `estimateWidth(viewLen)` computes the initial width from the visible
character count, font size, and line height, without touching the DOM. This produces a much better
initial estimate than the flat 44 px fallback for multi-column paragraphs.

### 3. Contenteditable + mouse click on spacer (non-issue)

Spacers are in the off-screen area. The user can only click on positions that are visible in
the viewport, which are always within the DOM window. Clicks never land on a spacer.
Spacers have `pointer-events: none` and `user-select: none` to prevent accidental selection.

### 4. IME composition (non-issue)

IME input occurs at the cursor position, which is always inside a visible paragraph div and
therefore inside the DOM window.

---

## Impact on Existing Features

### getValue()

`getValue()` iterates by `paragraphRecords` index. For in-window paragraphs it calls
`serializeNode()` on the DOM div; for off-window paragraphs it reads `paragraphRecords[i].src`
directly. Off-window reads are faster (no DOM traversal) and are always accurate because
`syncWindowSrcs()` keeps records in sync after every commit.

### patchParagraphs (Undo/Redo)

`patchParagraphs` diffs previous and next content and updates only changed divs. With full
virtualization it also calls `spliceRecords(lo, deleteCount, newLines)` to keep `paragraphRecords`
in sync with the DOM changes. For changes entirely outside the current DOM window,
`patchParagraphs` updates only the records (no DOM manipulation). `paragraphChildIndex(i)`
accounts for the `rightSpacer` offset so `el.children[...]` references the correct div.

### syncWindowSrcs (typing / commitToCm6)

`syncWindowSrcs(lines)` is called from `commitToCm6()` after every commit. It updates `src` and
`viewLen` in-place for all records without resetting `domStart`, `domEnd`, or spacer widths.
This keeps outline data and off-window reads current after plain typing. It also reconciles
`domEnd` with the actual number of paragraph divs present in the DOM (Enter/Delete can shift the
count inside the window without going through `patchParagraphs`).

### loadContent (file open)

`loadContent(content, initialViewOffset)` creates only an initial DOM window of
`INITIAL_WINDOW_HALF = 50` paragraphs on each side of the initial cursor position (100 total).
All other paragraphs are represented by estimated-width spacers with no DOM nodes. This avoids
loading all N paragraph divs on file open, which was the main O(N) cost for large files.

`initRecords(lines, lo, hi)` accepts optional `domStart`/`domEnd` arguments to set the initial
window directly; `resetWindow(lo, hi)` updates spacer widths from estimated record widths.

### setVisibleOffset (cursor restore)

`setVisibleOffset(offset)` iterates by `paragraphRecords` index. For in-window paragraphs it
walks the DOM text nodes; for off-window paragraphs it checks `remaining > viewLen` to skip
without touching the DOM. If the cursor lands in an off-window paragraph, `jumpWindowTo(center)`
teleports the window to be centered on that paragraph, rebuilding only the new window's divs from
records' `.src` and calling `resetWindow(lo, hi)`.

### selectionchange / ensureWindowAroundCursor

`ensureWindowAroundCursor()` is a no-op safety hook. The `IntersectionObserver` keeps the cursor
paragraph in the window proactively (the IO fires before the cursor div would leave the extended
viewport), so cursor-in-window is an invariant maintained automatically.

### SearchPanel (CSS Custom Highlight API)

The search panel highlights matches using `CSS.highlights`. Off-window paragraphs are handled via
`paragraphRecords[i].src` for text extraction. When navigating to an off-window match,
`ensureInWindow(i)` expands the DOM window to include the target paragraph before creating the
highlight range.

### Find & Replace

One-by-one and bulk replace operate on `paragraphRecords[i].src` for off-window paragraphs and
on the DOM for in-window paragraphs. After any replace, `commitToCm6()` propagates the change.

---

## Implementation History

### Phase 1 — `paragraphRecords[]` data store (superseded by Phase 2)

Introduced the per-paragraph data store alongside the existing frozen-div infrastructure.
`data-src` / `data-view-len` DOM attributes were removed; `paragraphRecords` was populated in
parallel with the WeakMap-based frozen system. `getSrcByIndex(i)` / `getViewLenByIndex(i)` were
added for O(1) index-based access.

**Why WeakMaps in Phase 1:**

`paragraphRecords` was indexed by DOM position. Any DOM insertion or deletion between a freeze
and the next `patchParagraphs` call (e.g., Enter key, paste) shifted frozen div positions without
updating the array, causing `getValue()` to read the wrong paragraph content. WeakMaps keyed by
div element identity were unaffected by positional shifts.

Phase 2 eliminated the WeakMap approach entirely by removing frozen divs from the DOM, making
`paragraphRecords` the sole source of truth.

### Phase 2 — DOM window management + spacers (**DONE**)

Replaced frozen-div shells with true DOM removal. Only a sliding window of `~100` paragraph divs
stays in the DOM; two spacer divs (`rightSpacer`, `leftSpacer`) represent the collapsed width of
off-screen paragraphs. The frozen infrastructure (`FROZEN_CLASS`, `frozenSrc`/`frozenViewLen`
WeakMaps, `freezeDiv()`/`thawDiv()`, `seenDivs`, `lastKnownWidths`, etc.) was removed entirely.

**What was built:**

- `rightSpacer` and `leftSpacer` divs (permanent fixtures, `pointer-events: none`,
  `user-select: none`).
- `IntersectionObserver` watching the two boundary divs (`domStart` div and `domEnd` div) with
  `rootMargin: '0px 440px 0px 440px'` (~10 paragraphs of prefetch buffer on each side).
- `expandRight()` / `shrinkRight()` / `expandLeft()` / `shrinkLeft()` window management methods.
- `reobserveBoundaries()` to re-register the IO on new boundary divs after each expand/shrink.
- `ensureInWindow(i)` for cursor restore (`setVisibleOffset`) and outline jump navigation.
- `expandWindowToFull()` for Cmd-A select-all (rebuilds all paragraph divs in one
  `replaceChildren` call, then defers native select-all to one `requestAnimationFrame`).
- `resetWindow(lo, hi)` for repositioning the window with updated spacer widths.
- `jumpWindowTo(center)` in `EditorElement` for teleporting the window to an off-window cursor.
- `loadContent(content, initialViewOffset)` for file open: creates only the initial window of
  `INITIAL_WINDOW_HALF = 50` paragraphs on each side of the saved cursor position.
- `syncWindowSrcs(lines)` for keeping records in sync during typing without disturbing the window.
- `paragraphChildIndex(i)` accounting for `rightSpacer` offset in `patchParagraphs`.
- Drag-selection guard: `isDragging` flag set by `mousedown`/`mouseup`; `shrinkLeft()`/
  `shrinkRight()` are no-ops when the target div contains `selection.anchorNode` or `.focusNode`.
- `hasCleanDivStructure()` updated to subtract 2 (spacerCount) from `el.childNodes.length`.
- `content-visibility: auto` and all related CSS removed from `.tate-editor > div` since the
  small DOM window makes it unnecessary.

**Decision log:**

| Question | Decision |
|---|---|
| Remove `content-visibility: auto`? | Yes. DOM window (~100 divs) makes C-V:auto unnecessary. |
| Width for never-rendered paragraphs | `UNRENDERED_WIDTH_PX = 44` (one column at default font). Also `estimateWidth(viewLen)` for better initial estimates. |
| Cmd-A behavior | `expandWindowToFull()` (single `replaceChildren`) then deferred native select-all via rAF. |
| IO trigger target | Boundary divs only (domStart div and domEnd div), rootMargin 440px. |
| Initial window size | `INITIAL_WINDOW_HALF = 50` (100 total). Covers typical viewports plus IO prefetch buffer. |

---

## Future Features

### Find & Replace — bulk replace

Iterate over all matches in `paragraphRecords` (no DOM access needed for off-window paragraphs),
apply substitutions to `.src` and `.viewLen`, then rebuild the DOM window from updated records and
call `commitToCm6()` once. Because `paragraphRecords` is the source of truth, bulk replace is
a pure data operation followed by a single DOM patch for the visible window.
