# Full DOM Virtualization: Design Notes and Future Feature Roadmap

Created: 2026-05-05

## Background

The existing pseudo-virtualization (`ParagraphVirtualizer`, introduced in
`20260504_dom_virtualization.md`) empties off-screen paragraph divs and stores their content in
`data-src` / `data-view-len` attributes ("frozen" divs). This eliminates live DOM subtrees for
off-screen paragraphs, but every frozen div shell remains in the DOM tree. On a 936 k-character
file the editor holds ~21,000 div shells.

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

### Why pseudo-virtualization cannot fully solve the problem

`range.deleteContents()` still traverses all DOM nodes inside the range, including frozen shells.
Full virtualization — keeping only the visible window in the DOM — would reduce the node count
that `deleteContents()` must traverse, cutting deletion cost proportionally.

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
    viewLen: number;   // visible character count
    width: number;     // measured pixel width (0 = not yet measured)
}
paragraphRecords: ParagraphRecord[];
```

`width: 0` (or a placeholder estimate such as the `content-visibility: auto` intrinsic fallback
of 44 px) is used for paragraphs that have never entered the viewport. These paragraphs have not
been rendered by the browser, so their real width is unknown. The actual value is written when the
paragraph first becomes visible (same measurement point as the current `lastKnownWidths` capture
in `onIntersection`).

### DOM window management

The window is defined by `[domStart, domEnd]` (inclusive, paragraph indices). Window expansion
and contraction are triggered by an `IntersectionObserver` on the boundary divs (first and last
of the window):

- **Boundary div enters viewport** → expand the window by one paragraph in that direction:
  create a new div from `paragraphRecords[domStart-1]` (or `domEnd+1`), insert it at the
  appropriate end, and shrink the corresponding spacer by the new div's width.
- **Boundary div leaves viewport (beyond a buffer threshold)** → contract the window from the
  far end: read the div's current width, add it to the appropriate spacer, then remove the div.

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

**Solution**: track the selection anchor and focus nodes. Do not remove a div from the window if
it contains `selection.anchorNode` or `selection.focusNode`. During an active drag (between
`mousedown` and `mouseup`), hold the entire selection range in the DOM.

### 2. Width of never-rendered paragraphs

A paragraph that has never been in the viewport has no measured width. Using 44 px (the
`content-visibility: auto` intrinsic fallback) as a placeholder causes the spacer to be
inaccurate by `(realWidth - 44) × count` pixels for all unrendered paragraphs.

**Acceptable trade-off**: the inaccuracy only affects paragraphs in the right spacer (not yet
scrolled to from the right, i.e., not yet read). The error corrects itself the first time each
paragraph enters the viewport. For a document read front-to-back this causes no visible jump.
For random-access navigation (e.g., the outline panel jumping to an unrendered heading), a
one-time correction is acceptable.

### 3. Contenteditable + mouse click on spacer (non-issue)

Spacers are in the off-screen area. The user can only click on positions that are visible in
the viewport, which are always within the DOM window. Clicks never land on a spacer.

### 4. IME composition (non-issue)

IME input occurs at the cursor position, which is always inside a visible paragraph div and
therefore inside the DOM window.

---

## Impact on Existing Features

### getValue() / getSrcLine()

`getValue()` currently serializes every div either via `data-src` (frozen) or `serializeNode`
(real). With full virtualization, off-window divs are not in the DOM at all. `getValue()` must
read from `paragraphRecords[i].src` for off-window paragraphs instead. This is faster (no DOM
traversal) and simpler than the current frozen-div path.

### patchParagraphs (Undo/Redo)

`patchParagraphs` diffs previous and next content and updates only changed divs. With full
virtualization, it must also update `paragraphRecords` for changed lines, regardless of whether
those lines are currently in the DOM window. Off-window changed lines update only the record;
in-window changed lines update both the record and the DOM.

### selectionchange / ensureThawedAtCursor

`ensureThawedAtCursor` currently thaws the cursor div and its neighbors. With full virtualization,
the cursor is always inside the DOM window by construction (the window is expanded to include the
cursor paragraph on `selectionchange`). The thaw concept is replaced by "ensure cursor paragraph
is within `[domStart, domEnd]`; if not, shift the window."

### SearchPanel (CSS Custom Highlight API)

The search panel highlights matches using `CSS.highlights`. Highlights can only reference DOM
`Range` objects; off-window paragraphs have no DOM nodes to create ranges from.

**Required extension**: when a search match falls in an off-window paragraph, either:
(a) expand the DOM window to include that paragraph before creating the highlight range, or
(b) defer highlighting to scroll-time (highlight as paragraphs enter the window).

Option (b) matches how virtual list renderers handle off-screen rendering and is preferred for
performance. The current approach of scanning `data-src` for matches (already implemented for
frozen divs) extends naturally to `paragraphRecords`.

### Find & Replace

See "Future Features" below. Replace in off-window paragraphs operates on `paragraphRecords[i].src`
directly without touching the DOM, then notifies CM6 of the change.

---

## Future Features

### Find & Replace

**One-by-one replace**

Extend `SearchPanel` with a replace input field. On "Replace":

1. Locate the current match's paragraph index and character range within the Aozora source.
2. Update `paragraphRecords[i].src` with the substituted string.
3. If the paragraph is in the DOM window, also update its div content.
4. Call `commitToCm6()` to propagate the change.

Replacing within Aozora notation requires care: the match may span only the base text of a ruby
annotation (e.g., replacing "東京" in `東京《とうきょう》`). The replace operation should update
only the base text and leave the annotation intact. Using `SegmentMap` (source ↔ view offset
mapping) to locate the correct source range handles this correctly.

**Bulk replace**

Iterate over all matches in `paragraphRecords` (no DOM access needed for off-window paragraphs),
apply substitutions to `.src` and `.viewLen`, then rebuild the DOM window from updated records and
call `commitToCm6()` once. Because `paragraphRecords` is the source of truth, bulk replace is
a pure data operation followed by a single DOM patch for the visible window.

### Aozora Heading Notation

Aozora defines heading annotations:

```
見出し文字列［＃「見出し文字列」は大見出し］
見出し文字列［＃「見出し文字列」は中見出し］
見出し文字列［＃「見出し文字列」は小見出し］
```

**Rendering**

`AozoraParser.parseInlineToHtml()` already handles ruby, tcy, and bouten via the same annotation
pattern. Heading support follows the same structure: detect the `は大見出し` / `は中見出し` /
`は小見出し` suffix in `SegmentMap` and emit a wrapper element:

```html
<span class="tate-heading tate-heading-large">見出し文字列</span>
```

CSS applies font-weight and optional decorative marks appropriate for vertical typography.
The annotation text itself (`［＃…］`) is hidden via `display: none` on a child span, matching
the current tcy / bouten rendering approach.

**Command palette input**

Add Obsidian commands (`addCommand`) such as "縦書き：大見出しとして設定". The command wraps the
current paragraph's content in the heading annotation, updates the div's DOM and `commitToCm6()`.
If the current paragraph already has a heading annotation, the command toggles it off.

**Serialization**

`serializeNode()` already round-trips ruby/tcy/bouten; heading spans serialize back to the
`［＃…］` form by reading the `tate-heading` class and reconstructing the annotation suffix.

### Outline Panel

The outline panel is an Obsidian `ItemView` (sidebar panel) that lists all headings in the current
file and allows click-to-jump navigation.

**Heading extraction**

Scan `paragraphRecords[i].src` for heading annotations using the same regex used by `AozoraParser`.
This scan is O(N) but only needs to run on file load and after any edit that changes a heading line.
`patchParagraphs` already knows which lines changed, so incremental rescanning is straightforward.

**Jump navigation**

On heading click:

1. Compute the target paragraph's `viewLen` prefix sum to derive the visible offset.
2. Call `setViewCursorOffset(offset)` to place the cursor.
3. If the paragraph is outside the DOM window, shift the window to include it first, then scroll.
4. Call `scrollCursorIntoView()`.

With pseudo-virtualization (current state), step 3 is handled by `ensureThawed()`. With full
virtualization, step 3 shifts `domStart` / `domEnd` and updates spacer widths.

---

## Implementation Sequence

If full virtualization is pursued, the recommended order is:

1. **Introduce `paragraphRecords[]`** alongside the existing `ParagraphVirtualizer` (dual-track,
   keep frozen-div path working) so the data store is available before the DOM window logic lands.

2. **Replace frozen divs with full removal + spacers** for the far-off-screen paragraphs (beyond
   the existing `rootMargin` buffer). Keep frozen divs for the near-buffer zone during transition.

3. **Add drag-selection protection** (hold divs referenced by `anchorNode`/`focusNode`).

4. **Migrate `getValue()` and `patchParagraphs()`** to read/write `paragraphRecords` for
   off-window paragraphs.

5. **Implement heading notation** (parser + CSS + command palette).

6. **Implement replace** (extends SearchPanel, operates on `paragraphRecords`).

7. **Implement outline panel** (depends on heading notation).

Steps 5–7 are independent of full virtualization and can be implemented before or after it.
