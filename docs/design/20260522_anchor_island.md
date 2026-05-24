# Anchor Island: Pinned Paragraph Divs Outside the DOM Window

Created: 2026-05-22  
Updated: 2026-05-24 (inner anchor islands for multi-paragraph Bug I)

## Problem

The Phase B DOM virtualization (see `20260505_full_virtualization.md`) had two remaining edge cases
where the DOM window could not slide freely:

### 1. Cursor stalls window shrinking

When the user scrolls without moving the cursor, `shrinkRight()` / `shrinkLeft()` check whether the
cursor is inside the div about to be evicted. If yes, they return early — the window cannot shrink
past the cursor's paragraph. On a long scroll away from the cursor, the window grows unboundedly on
the leading side while being blocked on the cursor side, accumulating an ever-larger set of DOM
nodes. In the extreme case (very long file, cursor at start, user scrolls to end) the window would
expand to span the entire document.

### 2. Cmd-A selection has no real DOM endpoints

`setVirtualSelectAll()` set up a `VirtualSelection` spanning para 0 to para N-1, but neither
endpoint was in the DOM window (para 0 and para N-1 are usually far from the current viewport). The
DOM selection was placed at the window boundaries as proxies. Pressing Shift+Arrow after Cmd-A
started extending from the proxy position (a window boundary paragraph), not from the actual first
or last paragraph. This gave unexpected behavior — the selection appeared to shrink from the wrong
edge.

### 3. Multi-paragraph selection stalls window shrinking (Bug I)

When a non-collapsed selection spans two adjacent paragraphs (anchor para A, focus para B) and the
user scrolls so that both paragraphs leave the window on the same side:

1. The first eviction attempt promotes para A (the one at the window edge) to an outer anchor island.
2. The next eviction attempt finds para B (the adjacent inner paragraph) still at the window
   boundary with a selection endpoint in it — so shrink returns early again, blocking indefinitely.

The window grows unboundedly because the "inner" endpoint permanently guards the window boundary.

---

## Solution: Anchor Islands

An **anchor island** is a paragraph div kept in the DOM *outside* the main window `[domStart,
domEnd]`. It is accompanied by spacers that account for the width of any paragraphs between the
island and the window edge.

### Single anchor (one endpoint outside window)

```
DOM order:
  [rightSpacer]  [?rightAnchor.div]  [?midRightSpacer]
  [domStart .. domEnd]
  [?midLeftSpacer]  [?leftAnchor.div]  [leftSpacer]
```

### Double anchor (both endpoints outside window on same side)

When both selection endpoints have left the window on the same side, a secondary **inner** anchor
island is added between the outer anchor and the window edge:

```
Right side:
  [rightSpacer] [rightAnchor(outer)] [midRightOuterSpacer] [rightAnchorInner(inner)] [midRightSpacer] [window]

Left side:
  [window] [midLeftSpacer] [leftAnchorInner(inner)] [midLeftOuterSpacer] [leftAnchor(outer)] [leftSpacer]
```

Two types of anchor exist:

| Type | Created by | Released by |
|---|---|---|
| `'cursor'` | `shrinkRight` / `shrinkLeft` when cursor/selection endpoint is in the evicted div | `ensureWindowAroundCursor()` when cursor moves away |
| `'selection'` | `setVirtualSelectAll()` for para 0 and para N-1 | `clearVirtualSelection()` |

---

## Data Structures

```typescript
interface AnchorIsland {
    paraIdx: number;            // index into paragraphRecords
    div: HTMLElement;           // the pinned paragraph div (ANCHOR_CLASS added)
    type: 'cursor' | 'selection';
}
```

State added to `ParagraphVirtualizer`:

| Field | Type | Purpose |
|---|---|---|
| `rightAnchor` | `AnchorIsland \| null` | Right-side outer island (lower paraIdx, right of window) |
| `leftAnchor` | `AnchorIsland \| null` | Left-side outer island (higher paraIdx, left of window) |
| `rightAnchorInner` | `AnchorIsland \| null` | Right-side inner island (between outer and window) |
| `leftAnchorInner` | `AnchorIsland \| null` | Left-side inner island (between window and outer) |
| `midRightSpacer` | `HTMLElement \| null` | Spacer between innermost right island and domStart |
| `midLeftSpacer` | `HTMLElement \| null` | Spacer between domEnd and innermost left island |
| `midRightOuterSpacer` | `HTMLElement \| null` | Spacer between right outer and inner islands |
| `midLeftOuterSpacer` | `HTMLElement \| null` | Spacer between left inner and outer islands |
| `midRightSpacerWidth` | `number` | Pixel width of midRightSpacer |
| `midLeftSpacerWidth` | `number` | Pixel width of midLeftSpacer |
| `midRightOuterSpacerWidth` | `number` | Pixel width of midRightOuterSpacer |
| `midLeftOuterSpacerWidth` | `number` | Pixel width of midLeftOuterSpacer |

Inner anchors can only exist when the corresponding outer anchor also exists. Inner anchors are
always `'cursor'` type (created by `shrinkRight`/`shrinkLeft`).

---

## `setRightAnchor` — Two Cases

### Case A: anchor is adjacent to the window (`domStart === paraIdx`)

The current `domStart` div is promoted in-place:

1. Add `ANCHOR_CLASS` to the div.
2. Insert `midRightSpacer` immediately after the div (width = 0, no gap).
3. `domStart++` — the old `domStart` div is now outside the window.

`rightSpacerWidth` is **unchanged** (it already excludes `paraIdx`).

### Case B: anchor is in the rightSpacer region (`domStart > paraIdx`)

A new div is created from `paragraphRecords[paraIdx].src`:

1. Insert `anchorDiv` before the first window div.
2. Insert `midRightSpacer` after `anchorDiv`.
3. `midRightSpacerWidth = sum(widths of paras paraIdx+1 .. domStart-1)`.
4. `rightSpacerWidth -= anchorWidth + midRightSpacerWidth` (spacer now covers only 0..paraIdx-1).

`setLeftAnchor` is the symmetric operation for the left side.

---

## `setRightAnchorInner` — Case A only

Inner anchors are always Case A (the blocking div is always at the current window edge):

1. `anchorDiv = getWindowDiv(domStart)` — the current window's rightmost div.
2. Add `ANCHOR_CLASS` to the div.
3. Rename: `midRightOuterSpacer = midRightSpacer` (the outer→window spacer becomes outer→inner).
4. `midRightOuterSpacerWidth = midRightSpacerWidth`.
5. Create a new `midRightSpacer` (inner→window, width = 0) inserted after `anchorDiv`.
6. `domStart++`.

After this, `windowChildOffset` increases by 2 and the window can shrink past the new `domStart`.

`setLeftAnchorInner` is the symmetric operation for the left side.

---

## `absorbRightAnchor` — Two Cases

### Adjacent case (`midRightSpacerWidth == 0`)

Anchor and window are directly adjacent; anchor div can rejoin the window:

1. `midRightSpacer.remove()`.
2. `anchorDiv.classList.remove(ANCHOR_CLASS)`.
3. `domStart = rightAnchor.paraIdx`.

### Gap case (`midRightSpacerWidth > 0`)

Paragraphs still exist between the anchor and the window. The anchor cannot be cleanly folded back:

1. `anchorDiv.remove()`.
2. `midRightSpacer.remove()`.
3. `rightSpacerWidth += anchorWidth + midRightSpacerWidth`.

`absorbRightAnchor` always calls `absorbRightAnchorInner()` first if an inner anchor is present, so
that `midRightSpacer` is restored to the outer→window role before the outer absorb logic runs.

`absorbLeftAnchor` is the symmetric operation.

---

## `absorbRightAnchorInner` — Two Cases

### Adjacent case (`midRightSpacerWidth == 0`)

1. Remove the inner→window `midRightSpacer`.
2. `anchorDiv.classList.remove(ANCHOR_CLASS)` — inner div rejoins window.
3. `midRightSpacer = midRightOuterSpacer` (outer→inner spacer becomes outer→window).
4. `midRightSpacerWidth = midRightOuterSpacerWidth`.
5. `domStart = rightAnchorInner.paraIdx`.

### Gap case (`midRightSpacerWidth > 0`)

The window has shrunk further since the inner anchor was created:

1. `innerW = paragraphRecords[inner.paraIdx].width`.
2. `oldInnerSpacerW = midRightSpacerWidth`.
3. `inner.div.remove()`, `midRightSpacer.remove()` (inner→window spacer).
4. `midRightSpacer = midRightOuterSpacer`.
5. `applyMidRightSpacer(midRightOuterSpacerWidth + innerW + oldInnerSpacerW)`.

The combined width folds the inner anchor's position back into the outer→window spacer.

`absorbLeftAnchorInner` is the symmetric operation.

---

## Cursor Anchor Lifecycle

### Single-endpoint case (one paragraph selected)

```
idle scroll
  │
  ▼  shrinkRight() — cursor is in children[windowChildOffset]
  │  rightAnchor exists? → return (no more anchors possible)
  │  no rightAnchor?     → setRightAnchor(domStart, 'cursor')  [Case A, midW=0]
  │                         domStart++
  │
  ▼  further scrolling
  │  shrinkRight() — cursor NOT in first window div
  │  → remove div, midRightSpacerWidth += w, domStart++
  │  (anchor stays; gap grows)
  │
  ▼  user moves cursor (selectionchange)
     ensureWindowAroundCursor()
       rightAnchor.type === 'cursor' && !anchorDiv.contains(sel.anchorNode)?
         → absorbRightAnchor()   [gap case if gap grew]
```

### Multi-endpoint case (both selection endpoints on same side) — Bug I fix

```
left scroll, anchor=A focus=B (A < B, both right of window)
  │
  ▼  shrinkRight() — para B is in children[windowChildOffset]
  │  no rightAnchor → setRightAnchor(B, 'cursor')   [Case A]
  │                   domStart = B+1
  │
  ▼  shrinkRight() — para A is now at new windowChildOffset
  │  rightAnchor exists, no rightAnchorInner → setRightAnchorInner(A, 'cursor')
  │                                             domStart = A+1
  │
  ▼  further scrolling
  │  shrinkRight() — neither A nor B is in first window div
  │  → normal eviction, midRightSpacerWidth grows
  │
  ▼  user moves cursor (selectionchange)
     ensureWindowAroundCursor()
       rightAnchor.type === 'cursor' && !contains?
         → absorbRightAnchorInner()   [inner first]
         → absorbRightAnchor()
```

Wait, note: the example above shows B as the outer anchor and A as the inner anchor, which matches
the actual case C1L from the debug logs (anchor=518=A, focus=519=B, left scroll hits B first since
B > A and shrinkRight starts at domStart=B when B is still in the window). The outer/inner
assignment depends on which endpoint is at `domStart` at the moment the first anchor is created.

---

## Selection Anchor Lifecycle (Cmd-A)

```
setVirtualSelectAll()
  │
  ├─ domStart > 0?  → setRightAnchor(0, 'selection')   [Case A or B]
  ├─ domEnd < N-1?  → setLeftAnchor(N-1, 'selection')  [Case A or B]
  └─ syncDomRangeToVirtual()
       proxyForEndpoint(0, 0)   → computeDomPositionFromViewOff(rightAnchor.div, ...)
       proxyForEndpoint(N-1, L) → computeDomPositionFromViewOff(leftAnchor.div, ...)
       sel.setBaseAndExtent(...)  [real DOM nodes, not window proxies]

clearVirtualSelection()
  │
  ├─ absorbRightAnchor()  [if rightAnchor.type === 'selection']
  └─ absorbLeftAnchor()   [if leftAnchor.type === 'selection']
```

`ensureWindowAroundCursor()` intentionally **ignores** selection-type anchors; only cursor-type
anchors are auto-absorbed on selectionchange.

---

## `windowChildOffset` and DOM Index Accounting

Because the DOM has up to 4 extra children per side (outer anchor + midOuter + inner anchor + mid),
all index-based DOM access must account for them:

```typescript
private get windowChildOffset(): number {
    let off = this.rightSpacer ? 1 : 0;
    if (this.rightAnchor)      off += 2;  // rightAnchor.div + midRightOuterSpacer (or midRightSpacer)
    if (this.rightAnchorInner) off += 2;  // rightAnchorInner.div + midRightSpacer
    return off;
}
```

`getWindowDiv(i)` = `editorEl.children[i - domStart + windowChildOffset]`.

`shrinkRight()` reads the first window div as `children[windowChildOffset]` and checks
`SPACER_CLASS` and `ANCHOR_CLASS` guards to avoid mis-identifying a spacer or anchor as a
paragraph.

`expandRight()` checks for inner anchor absorption before outer anchor absorption (inner is closer
to the window) and inserts new divs before `children[windowChildOffset]`.

---

## Scroll Boundary Calculations

`adjustWindowOnScroll()` uses `rightWindowOffset` / `leftWindowOffset` instead of raw spacer
widths to account for all anchor and mid-spacer widths:

```typescript
private get rightWindowOffset(): number {
    if (!this.rightAnchor) return this.rightSpacerWidth;
    const outerW = this.paragraphRecords[this.rightAnchor.paraIdx]?.width ?? 0;
    if (!this.rightAnchorInner) return this.rightSpacerWidth + outerW + this.midRightSpacerWidth;
    const innerW = this.paragraphRecords[this.rightAnchorInner.paraIdx]?.width ?? 0;
    return this.rightSpacerWidth + outerW + this.midRightOuterSpacerWidth + innerW + this.midRightSpacerWidth;
}

private get leftWindowOffset(): number {
    if (!this.leftAnchor) return this.leftSpacerWidth;
    const outerW = this.paragraphRecords[this.leftAnchor.paraIdx]?.width ?? 0;
    if (!this.leftAnchorInner) return this.leftSpacerWidth + outerW + this.midLeftSpacerWidth;
    const innerW = this.paragraphRecords[this.leftAnchorInner.paraIdx]?.width ?? 0;
    return this.leftSpacerWidth + outerW + this.midLeftOuterSpacerWidth + innerW + this.midLeftSpacerWidth;
}
```

Expand/shrink conditions (unchanged form, updated inputs):

```
Expand right: W - rightWindowOffset - domStart.width < scrollLeft + viewW + EXPAND_MARGIN
Shrink right: W - rightWindowOffset - domStart.width > scrollLeft + viewW + SHRINK_MARGIN
Expand left:  leftWindowOffset + domEnd.width         > scrollLeft - EXPAND_MARGIN
Shrink left:  leftWindowOffset + domEnd.width         < scrollLeft - SHRINK_MARGIN
```

`correctSpacerAfterExpand()` adjusts `midRightSpacer` (not `rightSpacer`) when a right anchor is
active, because the newly expanded divs came from the mid-spacer region. This remains correct with
inner anchors: `this.rightAnchor !== null` implies a mid-spacer exists between the innermost right
island and the window.

---

## `getValue()` Serialization Correctness

`EditorElement.getValue()` computes how many children of `editorEl` represent window paragraphs:

```typescript
const spacerOffset  = (virt.rightSpacer ? 1 : 0) + virt.rightAnchorChildCount;
const spacerCount   = (virt.rightSpacer ? 2 : 0) + virt.rightAnchorChildCount + virt.leftAnchorChildCount;
const actualDivCount = this.el.children.length - spacerCount;
```

Where:

```typescript
get rightAnchorChildCount(): number {
    return (this.rightAnchor ? 2 : 0) + (this.rightAnchorInner ? 2 : 0);
}
get leftAnchorChildCount(): number {
    return (this.leftAnchorInner ? 2 : 0) + (this.leftAnchor ? 2 : 0);
}
```

Without correct accounting, anchor divs and mid-spacers would be serialized as window paragraphs,
corrupting `commitToCm6()` output silently on the next typing event or debounced commit.

The old `hasRightAnchor` / `hasLeftAnchor` boolean getters (which only counted a single anchor per
side) have been replaced by `rightAnchorChildCount` / `leftAnchorChildCount` to handle both single
and double anchor configurations.

---

## `spliceRecords` Anchor Index Maintenance

When Undo/Redo splices the paragraph array, anchor `paraIdx` values must shift accordingly.
Inner anchors are processed before outer anchors to keep mid-spacer state consistent:

```typescript
// Inner right anchor
if (this.rightAnchorInner) {
    if (paragraph deleted) → remove inner, restore midRightOuterSpacer as midRightSpacer
    else if shifted        → update paraIdx
}
// Outer right anchor
if (this.rightAnchor) {
    if (paragraph deleted) → clean up any remaining inner anchor, then remove outer
    else if shifted        → update paraIdx
}
// (symmetric for left side)
```

---

## Invariants

| Invariant | Enforced by |
|---|---|
| Inner anchor only exists when outer anchor exists | `setRightAnchorInner` / `setLeftAnchorInner` guard with `if (!this.rightAnchor)` / `if (!this.leftAnchor)` |
| At most one outer + one inner per side | `setRightAnchorInner` absorbs any existing inner before creating a new one; shrink guard `if (!this.rightAnchorInner)` |
| `rightAnchor.paraIdx < rightAnchorInner.paraIdx < domStart` | Case A promotions increment domStart after each anchor creation |
| `domEnd < leftAnchorInner.paraIdx < leftAnchor.paraIdx` | Symmetric |
| Inner absorb precedes outer absorb | `absorbRightAnchor` calls `absorbRightAnchorInner()` first; `ensureWindowAroundCursor` absorbs inner then outer |
| `expandRight/Left` absorbs inner before outer | Inner anchor checked before outer anchor in the absorb path |
| Cursor anchor auto-released when cursor moves | `ensureWindowAroundCursor()` on every selectionchange |
| Selection anchor released only by clearVirtualSelection() | `ensureWindowAroundCursor()` checks `type === 'cursor'` before absorbing |
| `windowChildOffset` is always accurate | Computed live from `rightAnchor` and `rightAnchorInner` state |
| `getValue()` serializes correct content when anchors are present | `spacerCount` uses `rightAnchorChildCount` / `leftAnchorChildCount` |
| Anchor divs never frozen or collapsed by patchParagraphs | `hasCleanDivStructure()` returns false → `forceRemoveAllAnchors()` clears all anchors before rebuild |

---

## Bugs Found and Fixed

### B1 — `ensureWindowAroundCursor` was a no-op

The initial implementation checked `!this.rightAnchor.div.contains(cursorNode)` but returned early
before that check (missing return value propagation). Cursor anchors were never absorbed, and they
accumulated indefinitely as the user clicked around.

**Fix**: rewrote `ensureWindowAroundCursor` as explicit `if (type === 'cursor' && !contains)` blocks
with direct `absorbRightAnchor()` / `absorbLeftAnchor()` calls.

### B2 — `getValue()` corrupted content with active anchors

`getValue()` used `spacerCount = virt.rightSpacer ? 2 : 0`, counting only the two outer spacers.
With a right anchor, `actualDivCount` was inflated by 2, causing the anchor div and midSpacer to be
serialized as window paragraphs. This silently committed incorrect content to CM6 on the next
typing event or debounced commit.

**Fix**: exposed `hasRightAnchor` / `hasLeftAnchor` on `ParagraphVirtualizer` and incorporated them
into `spacerOffset` and `spacerCount` in `getValue()`. Later superseded by `rightAnchorChildCount`
/ `leftAnchorChildCount` when inner anchors were added.

### B3 — `shrinkLeft` missing ANCHOR_CLASS guard

`shrinkRight` already guarded against accidentally operating on a spacer or anchor div via
`div.classList.contains(SPACER_CLASS) || div.classList.contains(ANCHOR_CLASS)`. `shrinkLeft` lacked
the equivalent guard.

**Fix**: added the same SPACER_CLASS + ANCHOR_CLASS guard to `shrinkLeft`.

### B4 — `spliceRecords` incorrect anchor paraIdx boundary condition

A splice at exactly `lo = idx` with `deleteCount > 0` would incorrectly fall into neither the
"deleted" nor the "shifted" branch, leaving the anchor pointing to a deleted paragraph.

**Fix**: the three-case structure (deleted / shifted / before-splice) now correctly handles `lo == idx`.

### B5 — Multi-paragraph Bug I: inner endpoint blocks shrink indefinitely

When a non-collapsed selection spans two adjacent paragraphs and the user scrolls so both leave the
window on the same side, the outer endpoint was correctly promoted to an outer anchor island, but
the inner endpoint remained at the window boundary on every subsequent shrink attempt, permanently
blocking window advancement.

**Fix**: added inner anchor islands (`rightAnchorInner` / `leftAnchorInner`). When `shrinkRight`
or `shrinkLeft` finds the outer anchor already set and the selection still collides, it promotes the
blocking div to an inner anchor island. After both endpoints are captured, the window can shrink
freely past them.

---

## Files Changed

| File | Change |
|---|---|
| `src/ui/ParagraphVirtualizer.ts` | `AnchorIsland` type; outer and inner anchor fields + spacer fields; `setRightAnchor`, `setLeftAnchor`, `absorbRightAnchor`, `absorbLeftAnchor`; `setRightAnchorInner`, `absorbRightAnchorInner`, `setLeftAnchorInner`, `absorbLeftAnchorInner` (new); `windowChildOffset` extended for inner anchors; `leftWindowOffset`, `rightWindowOffset` extended; `rightAnchorChildCount`, `leftAnchorChildCount` public getters (replace `hasRightAnchor`/`hasLeftAnchor`); `expandRight/Left`, `shrinkRight/Left`, `premeasureWindowWidths`, `correctSpacerAfterExpand`, `spliceRecords`, `ensureWindowAroundCursor`, `forceRemoveAllAnchors`, `proxyForEndpoint`, `getParagraphIndex`, `scrollFocusIntoView`, `tryInitVsFromDomSelection`, `tryUpdateFocusFromDom`, `syncWindowSrcs` updated |
| `src/ui/EditorElement.ts` | `getValue()`: `spacerOffset` and `spacerCount` use `rightAnchorChildCount` / `leftAnchorChildCount`; `paragraphChildIndex()`: offset uses `rightAnchorChildCount` |
| `src/ui/ParagraphVirtualizer.test.ts` | Removed `expandWindowToFull` test; removed stale `vi`/`afterEach` imports |
