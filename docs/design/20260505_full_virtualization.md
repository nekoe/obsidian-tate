# Full DOM Virtualization: Design Notes and Implementation History

Created: 2026-05-05  
Last updated: 2026-05-10

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

`width: 0` (or a placeholder estimate of `fontSizePx × lineHeight × estimatedColumns`) is used for
paragraphs that have never entered the viewport. The actual value is written when the paragraph
first leaves the window and its measured width is captured.

### DOM window management — scroll-event based

The window is defined by `[domStart, domEnd]` (inclusive, paragraph indices). Window expansion
and contraction are driven by the `scroll` event on the scroll container (`tate-scroll-area`).

On every scroll event, `adjustWindowOnScroll()` is called:

1. **`premeasureWindowWidths()`** — batch-reads `getBoundingClientRect().width` for all in-window
   divs before any DOM mutation. This ensures shrink and expand operations use accurate widths.
2. **Expand check** — compute the right and left boundary positions from `scrollLeft`, `scrollWidth`,
   `clientWidth`, and the stored spacer widths. If either boundary is within `EXPAND_MARGIN = 440 px`
   of the viewport, add a paragraph div from the corresponding spacer side (`expandRight()` /
   `expandLeft()`).
3. **Shrink check** — if either boundary is more than `SHRINK_MARGIN = 880 px` past the viewport,
   remove the far-end paragraph div and add its measured width to the corresponding spacer
   (`shrinkLeft()` / `shrinkRight()`).
4. **`correctSpacerAfterExpand()`** — after all DOM mutations, batch-measures newly added divs and
   corrects the spacer by the difference between actual and estimated widths.

The `EXPAND_MARGIN` / `SHRINK_MARGIN` gap (440 px) prevents oscillation: a div is never expanded
and immediately shrunk back in the same scroll event.

**`adjustNow()`** wraps `adjustWindowOnScroll()` for synchronous invocation at programmatic scroll
points (e.g., after `scrollLeft` is set by `scrollRangeIntoView`). This avoids a one-frame flash
where the wrong window layout is visible before the asynchronous scroll event fires.

### Scroll position stability

Because `overflow-anchor: none` is set on `tate-scroll-area`, the browser does not auto-adjust
`scrollLeft` when DOM content is added or removed. All spacer width changes must therefore keep
`scrollWidth` constant manually:

- `shrinkLeft()` / `shrinkRight()`: read the div's actual width (from `premeasureWindowWidths`),
  remove the div, add exactly that width to the spacer → net scrollWidth change = 0.
- `expandLeft()` / `expandRight()`: insert the div, subtract its estimated width from the spacer.
  `correctSpacerAfterExpand()` then corrects any estimate error with the measured actual width.

---

## Why IntersectionObserver Was Abandoned

The initial Phase 2 implementation used `IntersectionObserver` (IO) to drive window management.
IO watches two boundary divs (the `domStart` div and the `domEnd` div) with `rootMargin: '0px 440px
0px 440px'` and triggers expand/shrink on intersection transitions.

### Fundamental incompatibility: initial delivery

IO has an "initial delivery" problem: when a new element is observed, IO fires immediately with the
element's current intersection state. After `expandLeft()` adds a new `domEnd` div and calls
`reobserveBoundaries()`, IO fires for the new div and reports it as already "inside the extended
viewport" (because the expand just put it there). A subsequent rightward scroll that moves the
viewport away from that div produces no `inside → outside` transition — meaning `shrinkLeft()`
never fires. The window only grew, never shrank.

### Band-aid fixes and their failure modes

Several workarounds were attempted, each adding complexity and introducing new edge cases:

| Fix | Commit | Problem |
|---|---|---|
| Hysteresis flags `justExpandedLeft/Right` to block the initial IO delivery | `187c93a` | Flags were sometimes not cleared in time, permanently blocking shrink |
| `reobserveOne()`: re-observe only the new boundary div, not both | `52dd7e4` | Cross-boundary oscillation when expand triggered a cascade |
| Remove `justShrankLeft/Right` flags from shrink branch | `c070bd2` | Shrink re-enabled too early, causing expand→shrink bounce |
| Defer IO re-registration to the next scroll event after Enter/Delete | `38422af` | Added latency; still failed on edge cases with fast typing |

After four successive patches the core instability remained, and each fix had made the code harder
to reason about.

### Why scroll-event geometry is simpler and reliable

The scroll container (`tate-scroll-area`) exposes exact geometry at any moment:

```
rightBoundaryX = scrollWidth - rightSpacerWidth   (start of right spacer in scroll coords)
leftBoundaryX  = leftSpacerWidth                  (end of left spacer in scroll coords)
viewportLeft   = scrollLeft
viewportRight  = scrollLeft + clientWidth
```

Expand/shrink decisions reduce to four comparisons. The geometry is always consistent (no
asynchronous delivery), and the hysteresis gap (`SHRINK_MARGIN - EXPAND_MARGIN = 440 px`) prevents
oscillation without any state flags. The scroll event fires for every pixel of user scroll,
giving sub-pixel responsiveness.

IO was removed in commit `4ce9438`. The following were deleted: `windowObserver`,
`justExpandedLeft/Right`, `needsReobserve`, `reobserveBoundaries()`, `reobserveOne()`,
`onWindowBoundaryIntersection()`.

---

## Technical Challenges and Fixes

### 1. Drag selection spanning virtual boundaries

If the user starts a drag selection and scrolls so that the anchor end of the selection would
leave the DOM window, the selection breaks (the browser cannot represent a range whose anchor is
outside the DOM).

**Solution**: track whether a drag is in progress (between `mousedown` and `mouseup`). Do not
remove a div from the window if it contains `selection.anchorNode` or `selection.focusNode`.

### 2. Width of never-rendered paragraphs

A paragraph that has never been in the viewport has no measured width. Using a flat placeholder
causes the spacer to be inaccurate.

**Solution**: `estimateWidth(viewLen)` computes the initial width from visible character count,
font size, and line height without touching the DOM:

```
charsPerCol = floor(editorHeight / fontSizePx)
cols        = ceil(max(1, viewLen) / charsPerCol)
estimatedWidth = cols × fontSizePx × lineHeight
```

This gives a much better estimate than a fixed constant for multi-column paragraphs. `correctSpacerAfterExpand()`
then corrects any residual estimate error once the paragraph enters the viewport.

### 3. Cursor drift from estimate error during shrink

`shrinkLeft()` / `shrinkRight()` added the stored `rec.width` back to the spacer. If `rec.width`
was an estimate, the net `scrollWidth` change was non-zero, causing the cursor to drift with each
shrink (`overflow-anchor: none` means `scrollLeft` is never auto-adjusted).

**Solution** (`e119221`): `premeasureWindowWidths()` is called at the top of every
`adjustWindowOnScroll()` invocation. It reads `getBoundingClientRect().width` for all in-window
divs and stores the values in `paragraphRecords[i].width` before any DOM mutation. Shrink
operations then use the measured (not estimated) width, ensuring net `scrollWidth` change = 0.

### 4. One-frame flash after programmatic scroll

When `scrollRangeIntoView` sets `container.scrollLeft`, the resulting `scroll` event fires
asynchronously. The browser renders one frame with the stale window layout (potentially showing
the right spacer where paragraph divs should be).

Additionally, when `scrollRangeIntoView('nearest')` finds the cursor already fully visible, it
returns early without changing `scrollLeft`, so no `scroll` event fires at all — leaving the
window unadjusted after `jumpWindowTo()` resets spacers.

**Solution** (`826bad4`): call `adjustNow()` synchronously at both exit points of
`scrollRangeIntoView`: after setting `scrollLeft` and before the early-return when the cursor is
already visible.

### 5. Spacer oscillation after expand (estimate vs actual)

`expandLeft()` / `expandRight()` subtracted the estimated `rec.width` from the spacer when
inserting a div. If the rendered div had a different actual width, `scrollWidth` drifted with each
expansion, causing a visible jump or bounce.

**Solution** (`5298248`): `correctSpacerAfterExpand(domStartBefore, domEndBefore)` is called after
all DOM mutations in `adjustWindowOnScroll()` and `ensureInWindow()`. It batch-reads actual widths
for newly added divs and adjusts the spacer by the cumulative actual-vs-estimated difference in a
single layout flush.

### 6. Undo/Redo cursor slide proportional to Enter count

After N Enter keystrokes inside the DOM window, pressing Undo caused a horizontal scroll
proportional to N × paragraph_width. Root cause:

- `syncWindowSrcs()` adjusts `domEnd` when the DOM div count changes (Enter adds a div), but
  preserves `paragraphRecords[i].width` by index position rather than by content.
- After N Enters, the records at off-window indices carry widths from paragraphs that have since
  shifted; `width: 0` entries also accumulate for newly appended records.
- Undo's `patchParagraphs` calls `spliceRecords()`, which recomputed `leftSpacerWidth` from those
  stale record widths — producing a value that was off by roughly N × paragraph_width.
- The spacer width change shifted the layout, making the cursor appear outside the viewport, and
  `scrollCursorIntoView` scrolled to compensate.

**Solution** (`824dbcb`): `spliceRecords()` detects whether the splice range lies entirely within
`[domStart, domEnd]` before mutating the records array:

```typescript
const spliceWithinWindow =
    lo >= this.domStart &&
    lo <= this.domEnd &&
    lo + deleteCount <= this.domEnd + 1;
```

When `spliceWithinWindow` is true, the off-screen paragraphs (spacer areas) are unchanged, so
stored spacer widths remain correct and recomputation is skipped entirely. Recomputation runs
only when the splice touches the right-spacer or left-spacer region.

### 7. Contenteditable + mouse click on spacer (non-issue)

Spacers are in the off-screen area. The user can only click on positions visible in the viewport,
which are always within the DOM window. Clicks never land on a spacer. Spacers have
`pointer-events: none` and `user-select: none` to prevent accidental selection.

### 8. IME composition (non-issue)

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

`spliceRecords` skips spacer recomputation when the splice is within the window (see challenge 6).

### syncWindowSrcs (typing / commitToCm6)

`syncWindowSrcs(lines)` is called from `commitToCm6()` after every commit. It updates `src` and
`viewLen` in-place for all records without resetting `domStart`, `domEnd`, or spacer widths.
This keeps outline data and off-window reads current after plain typing. It also reconciles
`domEnd` with the actual number of paragraph divs present in the DOM (Enter/Delete can shift the
count inside the window without going through `patchParagraphs`).

**Invariant**: when `syncWindowSrcs` adjusts `domEnd` due to Enter/Delete, it does NOT update
`leftSpacerWidth`. This is intentional: Enter/Delete only add or remove divs inside the window;
the off-screen paragraphs represented by the spacer are unchanged (they are merely renumbered),
so the stored accumulated width stays correct. Recomputing `leftSpacerWidth` from
`paragraphRecords[].width` here would give the wrong result because those widths are indexed by
array position, which shifts after Enter.

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

### ensureWindowAroundCursor

`ensureWindowAroundCursor()` is a no-op safety hook. The scroll-event-based window manager keeps
the cursor paragraph in the window proactively (EXPAND_MARGIN = 440 px prefetch buffer on each
side), so cursor-in-window is maintained automatically by `adjustWindowOnScroll()`.

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

### Phase 2 — DOM window with IntersectionObserver (abandoned)

The first Phase 2 implementation used IO watching the two boundary divs (`domStart` div and
`domEnd` div) with `rootMargin: '0px 440px 0px 440px'`. Four successive bug-fix commits
(`187c93a` → `52dd7e4` → `c070bd2` → `38422af`) attempted to work around IO's initial-delivery
problem. All failed. See "Why IntersectionObserver Was Abandoned" above.

### Phase 2 — DOM window with scroll-event geometry (**current, DONE**)

Replaced IO with an `onScroll` handler that computes expand/shrink from `scrollLeft`,
`scrollWidth`, `clientWidth`, and stored spacer widths directly. IO and all its support
infrastructure were removed in `4ce9438`.

**What was built:**

- `rightSpacer` and `leftSpacer` divs (permanent fixtures, `pointer-events: none`,
  `user-select: none`).
- `adjustWindowOnScroll()`: the core expand/shrink loop, called on every scroll event.
- `premeasureWindowWidths()`: batch-reads actual div widths before any DOM mutation to prevent
  cursor drift.
- `correctSpacerAfterExpand()`: corrects spacer estimate error after expand, in one layout flush.
- `adjustNow()`: synchronous wrapper for `adjustWindowOnScroll()`, called at programmatic scroll
  points.
- `expandRight()` / `shrinkRight()` / `expandLeft()` / `shrinkLeft()` window management methods.
- `ensureInWindow(i)` for cursor restore (`setVisibleOffset`) and outline jump navigation.
- `expandWindowToFull()` for Cmd-A select-all (rebuilds all paragraph divs in one
  `replaceChildren` call, then defers native select-all to one `requestAnimationFrame`).
- `resetWindow(lo, hi)` for repositioning the window with updated spacer widths.
- `jumpWindowTo(center)` in `EditorElement` for teleporting the window to an off-window cursor.
- `loadContent(content, initialViewOffset)` for file open: creates only the initial window of
  `INITIAL_WINDOW_HALF = 50` paragraphs on each side of the saved cursor position.
- `syncWindowSrcs(lines)` for keeping records in sync during typing without disturbing the window.
- `spliceRecords(lo, deleteCount, newLines)` with within-window detection to avoid stale-width
  spacer recomputation during Undo/Redo.
- `paragraphChildIndex(i)` accounting for `rightSpacer` offset in `patchParagraphs`.
- Drag-selection guard: `isDragging` flag set by `mousedown`/`mouseup`; `shrinkLeft()`/
  `shrinkRight()` are no-ops when the target div contains `selection.anchorNode` or `.focusNode`.
- `hasCleanDivStructure()` updated to subtract 2 (spacerCount) from `el.childNodes.length`.
- `content-visibility: auto` and all related CSS removed from `.tate-editor > div` since the
  small DOM window makes it unnecessary.

**Decision log:**

| Question | Decision |
|---|---|
| Window management trigger | Scroll event (geometry), not IntersectionObserver (transitions) |
| Remove `content-visibility: auto`? | Yes. DOM window (~100 divs) makes C-V:auto unnecessary. |
| Width for never-rendered paragraphs | `estimateWidth(viewLen)` from font size and line height. |
| Cmd-A behavior | `expandWindowToFull()` (single `replaceChildren`) then deferred native select-all via rAF. |
| Initial window size | `INITIAL_WINDOW_HALF = 50` (100 total). Covers typical viewports plus expand buffer. |
| Expand margin | 440 px (~10 paragraphs at default font). |
| Shrink margin | 880 px (440 + 440 gap prevents oscillation). |
| Spacer width on shrink | Use premeasured actual width (not estimate) to keep net scrollWidth change = 0. |
| Spacer width on Undo/Redo splice within window | Skip recomputation; stored widths are correct since off-screen content is unchanged. |

---

## Future Features

### Find & Replace — bulk replace

Iterate over all matches in `paragraphRecords` (no DOM access needed for off-window paragraphs),
apply substitutions to `.src` and `.viewLen`, then rebuild the DOM window from updated records and
call `commitToCm6()` once. Because `paragraphRecords` is the source of truth, bulk replace is
a pure data operation followed by a single DOM patch for the visible window.
