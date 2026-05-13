# Full DOM Virtualization: Design Notes and Implementation History

Created: 2026-05-05  
Last updated: 2026-05-13

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

### 1. Gap-spanning selection and scroll (Phase B — VirtualSelection)

If the user makes a selection that spans paragraphs outside the current DOM window (gap-spanning
selection: Shift+Arrow past the window edge, Cmd-A, mouse drag with scroll), the browser cannot
represent a Range whose endpoints are outside the DOM.

**Phase A solution** (earlier): block removal of a div if `selection.anchorNode` or
`selection.focusNode` is inside it. This prevented scrolling from breaking the selection, but also
prevented the window from shrinking, causing the window to "stall" at the selection boundary.

**Phase B solution**: `VirtualSelection` interface + proxy-based DOM Range. When a non-collapsed
selection endpoint is about to be evicted from the DOM window, `clampSelectionOnShrink()` saves the
endpoint's true position in `virtualSelection` and moves the DOM Range endpoint to a proxy at the
window boundary (start of `domStart` div for off-right; end of `domEnd` div for off-left). The
removal proceeds. After all shrinks, `syncDomRangeToVirtual()` reconstructs the DOM Range from the
current proxy positions, keeping native `::selection` coverage across all visible paragraphs.

On `selectionchange` (Shift+Arrow), `tryUpdateFocusFromDom()` reads the new focus position from the
DOM and updates `virtualSelection.focusViewOff`, then `syncDomRangeToVirtual()` re-syncs the anchor
proxy. This allows Shift+Arrow to shrink the selection from the focus end even when the anchor is
off-window.

**Cycle prevention**: `markProgrammaticSelection()` increments `programmaticSelectionUpdates` before
each `setBaseAndExtent()` call and schedules `setTimeout(() => count--, 0)`. The `selectionchange`
event (macrotask) fires and sees `isSyncingSelection=true`, skipping the VS update. The setTimeout
fires next, decrementing the counter.

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
all DOM mutations in `adjustWindowOnScroll()`. It batch-reads actual widths for newly added divs
and adjusts the spacer by the cumulative actual-vs-estimated difference in a single layout flush.

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

### 8. IME composition

Two edge cases arise from the interaction between DOM window management and IME.

#### VS active when IME starts

When a gap-spanning VS is active and the user starts IME input, the VS content must be deleted
**before** Chrome anchors its composition. Chrome records the IME anchor when it passes `keydown`
to the IME engine — after `keydown` handlers complete but **before** `compositionstart` fires.
Deleting the VS inside `compositionstart` is therefore too late: the anchor is already set to
the stale position.

**Solution** (`a3709e9`): the `keydown` handler in `view.ts` detects printable keys while VS is
active (`!isComposing && key.length === 1 && getVirtualSelection()`) and calls
`deleteVirtualSelection(vs)` synchronously. By the time Chrome passes control to the IME engine,
the VS has been deleted and the cursor sits at the correct insertion point.

#### Non-VS range selection when IME starts

When a non-collapsed DOM Range selection exists (no VS) and IME begins, the browser deletes the
selected text and inserts the composition string in the first `isComposing=true` `input` event —
**after** `compositionstart` fires. Calling `adjustNow()` in `compositionstart` is therefore too
early to repair the layout, because the in-window divs have not been removed yet.

**Solution** (`eb86757`): at `compositionstart`, if no VS is active and the selection is
non-collapsed, a flag `needsLayoutRepairOnFirstComposingInput` is set to `true`. The `input`
event handler calls `adjustNow()` and clears the flag on the first `isComposing=true` event.
Subsequent composition steps (candidate switching) do not call `adjustNow()`, avoiding both
unnecessary DOM reads and any risk of interrupting the IME anchor.

### 9. SearchPanel Range staleness after replaceChildren

`teleportWindowTo()` calls `editorEl.replaceChildren()`, which removes old paragraph divs.
The DOM Range live-update spec moves any Range boundary that was inside a removed node to the
nearest living ancestor — in this case `tate-editor`. Since `tate-editor` stays
`isConnected === true`, checking `!range.startContainer.isConnected` is insufficient to detect
these stale ranges.

`createRangeInParagraph()` always produces Text-node boundaries (never element boundaries). After
`replaceChildren`, the corrupted Range has `startContainer === tate-editor` (an `HTMLElement`).
Therefore `!(range.startContainer instanceof Text)` unambiguously identifies a stale Range.

`setFocus()` checks both conditions before using a cached Range. `refreshWindowRanges()` applies
the same check across all match entries. On detection, `entry.div` and `entry.range` are set to
null, triggering fresh resolution at the next navigation or window refresh.

### 10. Large paste memory spike

`insertParsedParagraphs()` inserts all pasted lines as individual divs before `commitToCm6()`
can consolidate them. For thousands of pasted lines this creates a proportionally large DOM that
consumes significant memory.

**Solution** (`2ba0ee7`): After `insertParsedParagraphs` completes (only for `lines.length > 1`
and non-expanded inline state):

1. `virt.syncWindowSrcs(newLines)` — expands `domEnd` to match the actual DOM child count
   (old_window + pasted_count). Without this, `getVisibleOffset()` iterates only
   `paragraphRecords.length` (old) times with stale `domEnd` and cannot find the cursor div
   that was just inserted beyond the old `domEnd`.
2. `getVisibleOffset()` — reads the cursor position from the temporarily full DOM.
3. `virt.initWindowFromLines(newLines, lo, hi)` — replaces all inserted divs with a windowed
   rebuild centered on the cursor.
4. `setVisibleOffset(cursorPos)` — restores the cursor in the new window.

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

The search panel highlights matches using `CSS.highlights`. Text extraction uses
`extractHybridText()`: in-window divs are read via `extractSegmentsFromDiv()` (DOM TreeWalker);
off-window paragraphs are read via `paragraphRecords[i].src` + `buildParagraphVisibleText()`.
Matches are stored as `MatchEntry` objects with `paragraphIndex`, `localStart`, `localEnd`,
`viewStart`, `div` (null for off-window), and `range` (null until the paragraph is in-window).

**Navigation to off-window matches**: `teleportWindowTo(entry.paragraphIndex)` replaces the
former `ensureInWindow(i)`. It rebuilds a fixed-size window centered on the target paragraph in
one `replaceChildren` call — O(window_size) DOM operations regardless of how far away the target
is. `ensureInWindow` was O(distance) incremental expand and has been removed entirely.

**Stale Range detection**: `teleportWindowTo()` calls `editorEl.replaceChildren()`, which
triggers the DOM Range live-update spec: when a paragraph div is removed, any Range boundary
inside it is moved up to `tate-editor` (the nearest living ancestor). Since `tate-editor` stays
`isConnected === true`, a disconnected check alone is insufficient. `createRangeInParagraph()`
always produces Text-node boundaries, so `!(range.startContainer instanceof Text)` unambiguously
identifies a stale range. Both `setFocus()` and `refreshWindowRanges()` apply this check.

**Range refresh after window changes**: `refreshWindowRanges()` clears stale non-Text ranges and
builds ranges for entries newly in the DOM window. It is called:
- In the rAF inside `scrollRangeIntoView()` (after teleport scroll lands).
- From a scroll listener (`onScrollArea`) registered on `tate-scroll-area` in rAF, which runs
  after ParagraphVirtualizer's synchronous `onScroll` handler expands the window.

**`replaceAllMatches`**: off-window paragraphs are replaced by modifying `paragraphRecords[i].src`
and `.viewLen` directly — no DOM insertion. In-window paragraphs modify the DOM div via
`replaceChildren`. A single `commitToCm6()` at the end commits both paths; `getValue()` reads
DOM for in-window and `paragraphRecords[i].src` for off-window, so both are captured correctly.

### setValue (external Markdown-view edits)

`setValue(content, preserveCursor)` previously called `parseToHtml(content)` +
`replaceEditorContent()`, which built all N paragraph divs in the DOM. When the virtualizer is
active, it now calls `virt.initWindowFromLines(lines, lo, hi)` with the center paragraph derived
from:
- The preserved cursor view offset (if `editorEl` has focus), or
- `floor((domStart + domEnd) / 2)` of the old window (if the editor is not focused).

This avoids O(N) DOM insertion for large external edits while keeping the view near its current
scroll position.

### handlePaste (large multi-line paste)

`insertParsedParagraphs()` inserts all pasted lines as individual paragraph divs. For large pastes
this temporarily creates O(N) DOM nodes. The post-paste windowed rebuild:

1. `virt.syncWindowSrcs(newLines)` — brings `domEnd` in sync with the full DOM (the actual div
   count is now `old_window + pasted_count`). Without this, `getVisibleOffset()` would fail to
   find the cursor div because it iterates only `paragraphRecords.length` times with stale `domEnd`.
2. `getVisibleOffset()` — reads the cursor position from the temporarily full DOM.
3. `virt.initWindowFromLines(newLines, lo, hi)` — collapses the DOM back to ~100 divs centered
   on the cursor, discarding the memory spike.
4. `setVisibleOffset(cursorPos)` — restores the cursor in the new windowed DOM.

The `syncWindowSrcs` step is O(N) in time, but `initWindowFromLines` also does O(N) work for
`initRecords`, so the total cost is 2×O(N) record processing + O(window) DOM operations.

### Find & Replace

One-by-one replace (`replaceCurrentMatch`) modifies the in-window div directly and calls
`commitToCm6()`. Bulk replace (`replaceAllMatches`) uses the two-path model: in-window paragraphs
modify the DOM div; off-window paragraphs modify `paragraphRecords[i].src` and `.viewLen` directly
(no DOM insertion). A single `commitToCm6()` call commits all changes.

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

### Phase 2 — DOM window with scroll-event geometry (DONE)

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
- `teleportWindowTo(center, windowHalf=50)` in `ParagraphVirtualizer`: rebuilds a fixed-size
  `[center−50, center+50]` window from `paragraphRecords` in one `replaceChildren` call.
  Used by `EditorElement.jumpWindowTo()` for off-window cursor restore and by `SearchPanel` for
  navigation to off-window matches. Replaces `ensureInWindow(i)` (removed; see Phase 3).
- `buildDomWindow(lo, hi, sources)` private helper in `ParagraphVirtualizer`: creates divs from
  `sources` and inserts them between the spacers via `replaceChildren`. Shared by
  `initWindowFromLines()` and `teleportWindowTo()`.
- `initWindowFromLines(lines, lo, hi)` in `ParagraphVirtualizer`: calls `initRecords(lines, lo, hi)`
  then `buildDomWindow(lo, hi, lines.slice(lo, hi+1))`. Used by `loadContent()`, `setValue()`, and
  the post-paste windowed rebuild.
- `resetWindow(lo, hi)` for repositioning the window with updated spacer widths.
- `jumpWindowTo(center)` in `EditorElement`: thin wrapper over `teleportWindowTo(center)`.
- `loadContent(content, initialViewOffset)` for file open: calls `initWindowFromLines` with a
  window of `INITIAL_WINDOW_HALF = 50` paragraphs on each side of the saved cursor position.
- `syncWindowSrcs(lines)` for keeping records in sync during typing without disturbing the window.
- `spliceRecords(lo, deleteCount, newLines)` with within-window detection to avoid stale-width
  spacer recomputation during Undo/Redo.
- `paragraphChildIndex(i)` accounting for `rightSpacer` offset in `patchParagraphs`.
- `hasCleanDivStructure()` updated to subtract 2 (spacerCount) from `el.childNodes.length`.
- `content-visibility: auto` and all related CSS removed from `.tate-editor > div` since the
  small DOM window makes it unnecessary.

**Phase 2 decision log:**

| Question | Decision |
|---|---|
| Window management trigger | Scroll event (geometry), not IntersectionObserver (transitions) |
| Remove `content-visibility: auto`? | Yes. DOM window (~100 divs) makes C-V:auto unnecessary. |
| Width for never-rendered paragraphs | `estimateWidth(viewLen)` from font size and line height. |
| Initial window size | `INITIAL_WINDOW_HALF = 50` (100 total). Covers typical viewports plus expand buffer. |
| Expand margin | 440 px (~10 paragraphs at default font). |
| Shrink margin | 880 px (440 + 440 gap prevents oscillation). |
| Spacer width on shrink | Use premeasured actual width (not estimate) to keep net scrollWidth change = 0. |
| Spacer width on Undo/Redo splice within window | Skip recomputation; stored widths are correct since off-screen content is unchanged. |

---

### Phase B — VirtualSelection for gap-spanning selections (**current, DONE**)

Gap-spanning selections (Cmd-A, Shift+Arrow past the window edge, mouse drag with scroll) require
the DOM Range to remain valid even as the window shrinks. Phase B implements a lightweight
`VirtualSelection` model that tracks true endpoint positions and re-synthesizes the DOM Range via
proxy nodes at the window boundary.

**What was built:**

- `VirtualSelection` interface: `{ anchorParaIdx, anchorViewOff, focusParaIdx, focusViewOff }`.
- `setVirtualSelectAll()`: replaces `expandWindowToFull()` for Cmd-A. Initializes VS to span the
  entire document and calls `syncDomRangeToVirtual()`. No full DOM rebuild required.
- `syncDomRangeToVirtual()`: computes proxy DOM positions for each VS endpoint (actual DOM position
  if in-window; boundary proxy if off-window) and calls `sel.setBaseAndExtent()`.
- `proxyForEndpoint(paraIdx, viewOff)`: maps a VS endpoint to a DOM `{node, offset}` pair.
  Off-right → `{domStart_div, 0}`; off-left → last text node of `domEnd_div`; in-window →
  `computeDomPositionFromViewOff()`.
- `clampSelectionOnShrink(div, paraIdx)`: called from `shrinkLeft()`/`shrinkRight()` when a
  non-collapsed selection endpoint is in the evicted div. Saves VS (if not yet active) and moves
  the endpoint to a proxy in the adjacent safe div before removal.
- `tryUpdateFocusFromDom(sel)`: reads `sel.focusNode` to update `VS.focusParaIdx/focusViewOff`.
  Returns true if changed (caller calls `syncDomRangeToVirtual()`).
- `markProgrammaticSelection()` / `isSyncingSelection`: counter + setTimeout pattern to suppress
  selectionchange re-entry when `setBaseAndExtent()` is called programmatically.
- `clearVirtualSelection()`: called on mousedown, non-Shift navigation keys, `detach()`.
- `computeViewOffsetInDiv(div, editorEl, node, offset)` and
  `computeDomPositionFromViewOff(div, editorEl, viewOff)` in `domHelpers.ts`: bidirectional
  view-offset ↔ DOM position mapping within a paragraph div.
- `deleteVirtualSelection(vs)` in `EditorElement`: reconstructs content from `paragraphRecords`
  with the VS range removed, calls `loadContent()` + `setViewCursorOffset()`.
- `sliceAozoraSrcByView(src, startViewOff, endViewOff?)` in `EditorElement`: slices Aozora source
  by visible offsets using `buildSegmentMap` + `viewToSrc`.
- `buildClipboardTextFromVirtual(vs)` in `EditorElement`: serializes VS range as Aozora text for
  copy/cut clipboard.
- `handleCopy` / `handleCut` / `handleSelectionDelete` in `EditorElement` now check for VS first.
- `view.ts` event handlers: `selectionchange` runs VS tracking; `mousedown` clears VS; navigation
  keys without Shift clear VS; `beforeinput` handles VS-insert (type over selection); `keydown`
  deletes VS content on printable keys (before IME anchors — see challenge 8 above).

**Phase B decision log:**

| Question | Decision |
|---|---|
| VS visual feedback | Native DOM `::selection` via `setBaseAndExtent()` — no custom CSS |
| Approach when anchor evicted | Proxy at window boundary (not ensureInWindow to avoid memory spike) |
| Shift+Arrow after anchor evicted | `tryUpdateFocusFromDom` + `syncDomRangeToVirtual` in selectionchange; anchor proxy stays |
| Scroll-following selection | `syncDomRangeToVirtual()` called at end of `adjustWindowOnScroll()` |
| Cmd-A with virtual window | `setVirtualSelectAll()` + proxy range; no full DOM expansion |
| selectionchange re-entry loop | `markProgrammaticSelection()` counter + `setTimeout(() => count--, 0)` |
| VS delete implementation | `loadContent(newContent, cursorOffset)` — full window rebuild (acceptable for bulk delete) |

---

### Phase 3 — SearchPanel hardening + memory spike fixes (**DONE**)

Resolved remaining correctness and memory issues after Phase B.

**What was built/changed:**

- **`teleportWindowTo(center, windowHalf=50)` replaces `ensureInWindow(i)`** (`25771e2`,
  `5734561`). `ensureInWindow` expanded the window incrementally (O(distance) DOM operations)
  from the current boundary to the target, creating up to N DOM insertions for a far-away search
  hit. `teleportWindowTo` rebuilds a fixed-size window from `paragraphRecords` in one
  `replaceChildren` call — O(window_size) regardless of distance. `ensureInWindow` was removed.

- **`buildDomWindow(lo, hi, sources)` private helper** (`2a16ed5`): extracted from the common
  DOM-building pattern shared by `initWindowFromLines()` and `teleportWindowTo()`.

- **`initWindowFromLines(lines, lo, hi)` public method** (`2a16ed5`): `initRecords(lines, lo, hi)`
  + `buildDomWindow(lo, hi, ...)`. Used by `loadContent()`, `setValue()`, and the post-paste
  windowed rebuild to avoid duplicating the center-computation + div-generation sequence.

- **SearchPanel stale Range detection** (`db14873`): `setFocus()` detects Ranges invalidated by
  `replaceChildren()` via `!(startContainer instanceof Text)`. See challenge 9.

- **`refreshWindowRanges()`** (`8562623`): clears stale non-Text ranges and builds ranges for
  entries newly in the DOM window after teleport or scroll expansion. Called in the
  `scrollRangeIntoView` rAF and from the scroll listener `onScrollArea` (registered on
  `tate-scroll-area` in rAF to run after ParagraphVirtualizer's synchronous scroll handler).

- **`replaceAllMatches` off-window path** (`22372a3`): off-window paragraphs are replaced via
  `paragraphRecords[i].src` and `.viewLen` directly — no DOM insertion or memory spike.

- **`setValue` windowed rebuild** (`2ba0ee7`): external Markdown-view edits call
  `initWindowFromLines` instead of `parseToHtml` + `replaceEditorContent`, capping DOM size at
  ~100 divs even for large file-wide changes. Center is the cursor paragraph (if focused) or the
  old window midpoint (if not focused).

- **`handlePaste` windowed rebuild** (`2ba0ee7`): large multi-line pastes are immediately
  collapsed to a windowed DOM via `syncWindowSrcs` + `getVisibleOffset` + `initWindowFromLines`
  after `insertParsedParagraphs` creates the full pasted DOM. See challenge 10.

---

## Future Features

(None currently planned. Find & Replace was completed in Phase 3.)
