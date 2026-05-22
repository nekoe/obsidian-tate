# Anchor Island: Pinned Paragraph Divs Outside the DOM Window

Created: 2026-05-22

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

---

## Solution: Anchor Islands

An **anchor island** is a paragraph div kept in the DOM *outside* the main window `[domStart,
domEnd]`. It is accompanied by a **mid-spacer** that accounts for the width of any paragraphs
between the anchor and the window edge:

```
DOM order:
  [rightSpacer]  [?rightAnchor.div]  [?midRightSpacer]
  [domStart .. domEnd]
  [?midLeftSpacer]  [?leftAnchor.div]  [leftSpacer]
```

Two types of anchor exist:

| Type | Created by | Released by |
|---|---|---|
| `'cursor'` | `shrinkRight` / `shrinkLeft` when cursor is in the evicted div | `ensureWindowAroundCursor()` when cursor moves away |
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
| `rightAnchor` | `AnchorIsland \| null` | Right-side island (low paraIdx, right of window) |
| `leftAnchor` | `AnchorIsland \| null` | Left-side island (high paraIdx, left of window) |
| `midRightSpacer` | `HTMLElement \| null` | Spacer between rightAnchor and domStart |
| `midLeftSpacer` | `HTMLElement \| null` | Spacer between domEnd and leftAnchor |
| `midRightSpacerWidth` | `number` | Pixel width of midRightSpacer |
| `midLeftSpacerWidth` | `number` | Pixel width of midLeftSpacer |

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

## `absorbRightAnchor` — Two Cases

### Adjacent case (`midRightSpacerWidth == 0`)

Anchor and window are directly adjacent; anchor div can rejoin the window:

1. `midRightSpacer.remove()`.
2. `anchorDiv.classList.remove(ANCHOR_CLASS)`.
3. `domStart = rightAnchor.paraIdx`.

The anchor div is now the new rightmost window div with no layout change.

### Gap case (`midRightSpacerWidth > 0`)

Paragraphs still exist between the anchor and the window. The anchor cannot be cleanly folded back:

1. `anchorDiv.remove()`.
2. `midRightSpacer.remove()`.
3. `rightSpacerWidth += anchorWidth + midRightSpacerWidth` (spacer reclaims the full region).

`domStart` is **unchanged** — the anchor's paragraph reverts to being represented only by the
spacer. The next `expandRight()` call will create a fresh div for it when needed.

`absorbLeftAnchor` is the symmetric operation.

---

## Cursor Anchor Lifecycle

```
idle scroll
  │
  ▼  shrinkRight() — cursor is in children[windowChildOffset]
  │  rightAnchor exists? → return (no second anchor)
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

Key invariant: only one right anchor and one left anchor exist at any time. If a second anchor
would be needed (edge case: cursor in first window div when a selection anchor is already present),
`shrinkRight` simply returns without creating a second anchor.

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

Because the DOM has up to 2 extra children per anchor, all index-based DOM access must account for
them:

```typescript
private get windowChildOffset(): number {
    let off = this.rightSpacer ? 1 : 0;
    if (this.rightAnchor) off += 2;   // anchorDiv + midRightSpacer
    return off;
}
```

`getWindowDiv(i)` = `editorEl.children[i - domStart + windowChildOffset]`.

`shrinkRight()` reads the first window div as `children[windowChildOffset]` and checks
`SPACER_CLASS` and `ANCHOR_CLASS` guards to avoid mis-identifying a spacer or anchor as a
paragraph.

`expandRight()` inserts new divs before `children[windowChildOffset]` (= before the first window
div, after the optional anchor+midSpacer block).

---

## Scroll Boundary Calculations

`adjustWindowOnScroll()` used raw `rightSpacerWidth` / `leftSpacerWidth` for the expand/shrink
threshold comparisons. With anchor islands, these no longer represent the full right/left
offset — the anchor and mid-spacer widths must be included:

```typescript
private get rightWindowOffset(): number {
    return this.rightSpacerWidth
        + (this.rightAnchor
            ? (this.paragraphRecords[this.rightAnchor.paraIdx]?.width ?? 0)
              + this.midRightSpacerWidth
            : 0);
}

private get leftWindowOffset(): number {
    return this.leftSpacerWidth
        + (this.leftAnchor
            ? (this.paragraphRecords[this.leftAnchor.paraIdx]?.width ?? 0)
              + this.midLeftSpacerWidth
            : 0);
}
```

These getters replace the direct spacer-width reads in the expand/shrink conditions:

```
Expand right: W - rightWindowOffset - domStart.width < scrollLeft + viewW + EXPAND_MARGIN
Shrink right: W - rightWindowOffset - domStart.width > scrollLeft + viewW + SHRINK_MARGIN
Expand left:  leftWindowOffset + domEnd.width         > scrollLeft - EXPAND_MARGIN
Shrink left:  leftWindowOffset + domEnd.width         < scrollLeft - SHRINK_MARGIN
```

`correctSpacerAfterExpand()` adjusts `midRightSpacerWidth` (not `rightSpacerWidth`) when a right
anchor is active, because the newly expanded divs came from the mid-spacer region.

---

## `getValue()` Serialization Correctness

`EditorElement.getValue()` computes how many children of `editorEl` represent window paragraphs:

```typescript
const spacerOffset  = (virt.rightSpacer ? 1 : 0) + (virt.hasRightAnchor ? 2 : 0);
const spacerCount   = (virt.rightSpacer ? 2 : 0) + (virt.hasRightAnchor ? 2 : 0)
                                                  + (virt.hasLeftAnchor  ? 2 : 0);
const actualDivCount = this.el.children.length - spacerCount;
```

Without this fix, `spacerCount = 2` would cause anchor divs and mid-spacers to be treated as window
paragraphs during serialization:
- `children[1]` (anchorDiv) would be read as para `domStart` → anchor content at wrong position.
- `children[2]` (midRightSpacer, empty) would be read as para `domStart+1` → empty line inserted.
- All real window divs would shift 2 positions in the output.

This produced corrupted content in `commitToCm6()` without any visible editing action — merely
scrolling to create an anchor, then any action that triggered a commit (typing, click, scheduled
debounce timer).

`hasRightAnchor` and `hasLeftAnchor` are exposed as public getters on `ParagraphVirtualizer` for
this purpose.

---

## `spliceRecords` Anchor Index Maintenance

When Undo/Redo splices the paragraph array, anchor `paraIdx` values must shift accordingly:

```typescript
if (this.rightAnchor) {
    const idx = this.rightAnchor.paraIdx;
    if (lo <= idx && idx < lo + deleteCount) {
        // Anchor's paragraph was deleted — remove from DOM.
        this.rightAnchor.div.remove();
        this.midRightSpacer?.remove();
        this.rightAnchor = null; ...
    } else if (idx >= lo + deleteCount) {
        // Anchor is past the deleted range — shift its index.
        this.rightAnchor = { ...this.rightAnchor, paraIdx: idx + delta };
    }
    // idx < lo: anchor is before the splice — no change needed.
}
```

Note: the condition `idx >= lo + deleteCount` (not `idx >= lo`) ensures that if `lo == idx` with
`deleteCount > 0`, the anchor's own paragraph is correctly treated as deleted rather than shifted.

When `spliceWithinWindow = false` AND an anchor is active, spacer recomputation (`applyRightSpacer`,
`applyLeftSpacer`) is intentionally skipped for the anchor and mid-spacer widths — those are
accounted for separately and remain valid across splices that do not touch the anchor's paragraph.

---

## Invariants

| Invariant | Enforced by |
|---|---|
| At most one right anchor and one left anchor at any time | `setRightAnchor` absorbs any existing anchor before creating a new one; `shrinkRight/Left` guard with `if (!this.rightAnchor)` |
| `rightAnchor.paraIdx < domStart` always | Case A: domStart is incremented after promotion; Case B: paraIdx < domStart by precondition |
| `leftAnchor.paraIdx > domEnd` always | Symmetric |
| Cursor anchor auto-released when cursor moves | `ensureWindowAroundCursor()` on every selectionchange while editor has focus |
| Selection anchor released only by clearVirtualSelection() | `ensureWindowAroundCursor()` checks `type === 'cursor'` before absorbing |
| `windowChildOffset` is always accurate | Computed from `rightAnchor !== null` live state; no cached value to go stale |
| `getValue()` serializes correct content when anchors are present | `spacerCount` and `spacerOffset` include anchor children via `hasRightAnchor` / `hasLeftAnchor` |
| Anchor div never frozen or collapsed by patchParagraphs | `hasCleanDivStructure()` returns false when anchors are present → windowed rebuild path via `buildDomWindow` → `forceRemoveAllAnchors()` clears all anchors before rebuild |

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
typing event or debounced commit, making the anchor paragraph's content appear at a different
position in the file.

**Fix**: exposed `hasRightAnchor` / `hasLeftAnchor` on `ParagraphVirtualizer` and incorporated them
into `spacerOffset` and `spacerCount` in `getValue()`.

### B3 — `shrinkLeft` missing ANCHOR_CLASS guard

`shrinkRight` already guarded against accidentally operating on a spacer or anchor div via
`div.classList.contains(SPACER_CLASS) || div.classList.contains(ANCHOR_CLASS)`. `shrinkLeft` lacked
the equivalent guard, allowing it to attempt eviction of the left anchor div when it happened to be
at the computed child index.

**Fix**: added the same SPACER_CLASS + ANCHOR_CLASS guard to `shrinkLeft`.

### B4 — `spliceRecords` incorrect anchor paraIdx boundary condition

The condition `lo <= idx && idx < lo + deleteCount` used `lo <= idx` but should use `lo <= idx` for
deletion detection and `idx >= lo + deleteCount` for shift detection. A splice at exactly `lo = idx`
with `deleteCount > 0` would incorrectly fall into neither branch, leaving the anchor pointing to a
deleted paragraph.

**Fix**: the three-case structure (deleted / shifted / before-splice) now correctly handles `lo == idx`.

---

## Files Changed

| File | Change |
|---|---|
| `src/ui/ParagraphVirtualizer.ts` | `AnchorIsland` type; `rightAnchor`, `leftAnchor`, `midRightSpacer`, `midLeftSpacer`, `midRightSpacerWidth`, `midLeftSpacerWidth` fields; `setRightAnchor`, `setLeftAnchor`, `absorbRightAnchor`, `absorbLeftAnchor`, `forceRemoveAllAnchors`; `windowChildOffset` extended; `leftWindowOffset`, `rightWindowOffset` getters; `expandRight/Left`, `shrinkRight/Left`, `premeasureWindowWidths`, `correctSpacerAfterExpand`, `spliceRecords` updated; `ensureWindowAroundCursor` rewritten; `setVirtualSelectAll` updated; `proxyForEndpoint` handles anchor divs; `hasRightAnchor`, `hasLeftAnchor` public getters added; `expandWindowToFull` removed (dead code) |
| `src/ui/EditorElement.ts` | `getValue()`: `spacerOffset` and `spacerCount` account for `hasRightAnchor` / `hasLeftAnchor`; `paragraphChildIndex()`: offset includes `hasRightAnchor` |
| `src/ui/ParagraphVirtualizer.test.ts` | Removed `expandWindowToFull` test; removed stale `vi`/`afterEach` imports |
