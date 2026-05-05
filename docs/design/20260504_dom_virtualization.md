# DOM Virtualization: Frozen Paragraph Placeholders

Created: 2026-05-04

## Problem

`content-visibility: auto` (introduced in `20260425_content_visibility_ime_performance.md`) skips
layout and paint for off-screen paragraph divs but keeps every div's full DOM subtree alive. On a
200 k-character file with ~2,800 paragraph divs, each holding text nodes, ruby/bouten spans, and
cursor-anchor placeholders, this amounts to tens of thousands of live DOM nodes. Memory pressure
from this causes:

- Elevated memory footprint throughout the editing session
- Slower GC cycles (Chrome must trace all live nodes)
- Marginally higher per-frame cost even for on-screen paragraphs (style invalidation walks the whole tree)

## Goal

Replace off-screen paragraph divs with lightweight frozen placeholders so only the paragraphs
near the viewport hold real DOM content. The rest of the codebase (Aozora serialization, cursor
tracking, search, Undo/Redo) must continue to work without requiring consumers to know which
divs are frozen.

## Frozen Placeholder Format

A frozen div is an empty `<div>` decorated with two markers:

```html
<div class="tate-frozen" style="width: 132px"></div>
```

| Attribute / Property | Purpose |
|---|---|
| `class="tate-frozen"` | Identifies the div as frozen; CSS adds `pointer-events: none` |
| `style.width` | Pins the physical column width so the scroll container does not shrink when content is removed |

`data-src` and `data-view-len` attributes are **not** written to frozen divs (they were
removed in the Phase 1 `paragraphRecords` refactor). Content is stored in two dedicated stores:

| Store | Type | Key | Purpose |
|---|---|---|---|
| `frozenSrc` | `WeakMap<HTMLElement, string>` | div element | Aozora source for `getSrcLine()` / `getValue()` |
| `frozenViewLen` | `WeakMap<HTMLElement, number>` | div element | Visible char count for `getViewLen()` / `getVisibleOffset()` |
| `paragraphRecords` | `ParagraphRecord[]` | DOM index | Full per-paragraph store for Phase 2 (DOM windowing) |

The WeakMaps are keyed by **div element identity**, not DOM position. This is intentional:
when a div is inserted elsewhere in the document (e.g., Enter key), frozen div positions
shift, but each WeakMap entry travels with its own element and stays correct.
`style.width` is the key scroll stability mechanism.

### Why `style.width`, not `contain-intrinsic-block-size`

In `writing-mode: vertical-rl` the block direction is horizontal, so
`contain-intrinsic-block-size` controls the column width of each paragraph div. However, this
property only takes effect when `content-visibility: auto` **skips** layout — i.e., when the div
is farther than Chrome's rendering buffer (~3,600 px) from the viewport. Inside that buffer (a
range roughly 440–3,600 px from the visible edge), Chrome renders the div normally. An empty div
inside the buffer with only `contain-intrinsic-block-size` set would render at ~0 px width,
collapsing the scroll container.

`style.width` is an explicit layout instruction that Chrome honors regardless of the
`content-visibility` state, ensuring the frozen div holds its column width everywhere.

## Architecture: ParagraphVirtualizer

All freeze/thaw logic lives in `src/ui/ParagraphVirtualizer.ts`. The class is constructed in
`view.ts`, passed to `EditorElement` via `setVirtualizer()`, and passed to `SearchPanel` as an
optional dependency.

```
VerticalWritingView (view.ts)
  └─ ParagraphVirtualizer
       ├─ IntersectionObserver  (freeze/thaw trigger)
       ├─ freezeTimers          (pending freeze per div)
       ├─ lastKnownWidths       (pixel width cache per div)
       ├─ seenDivs              (freeze eligibility guard)
       ├─ frozenSrc             (WeakMap: div → Aozora src, source of truth for reads)
       ├─ frozenViewLen         (WeakMap: div → visible char count, source of truth for reads)
       └─ paragraphRecords      (ParagraphRecord[]: indexed by DOM position, for Phase 2)
```

### IntersectionObserver setup

```typescript
new IntersectionObserver(callback, {
    root: scrollArea,          // .tate-scroll-area (the horizontal scrolling container)
    rootMargin: '0px 440px 0px 440px',  // ~10 paragraphs on each side of the viewport
    threshold: 0,
})
```

`rootMargin` of 440 px (= 10 × 44 px fallback column width) keeps a buffer zone of thawed divs
around the viewport. Divs inside this buffer are thawed; divs outside it are eligible for
freezing.

## Freeze/Thaw Lifecycle

### Entering the viewport (`isIntersecting: true`)

1. `seenDivs.add(div)` — marks the div as having been rendered at least once
2. `cancelFreeze(div)` — cancels any pending freeze timer; deletes `lastKnownWidths` entry
3. If frozen: `thawDiv(div)` — restores DOM content from `frozenSrc` WeakMap, removes `style.width`

### Leaving the viewport (`isIntersecting: false`)

1. Capture `entry.boundingClientRect.width` and store in `lastKnownWidths` (no layout flush
   required — the observer provides the rect for free)
2. `scheduleFreeze(div)` — sets a 50 ms timer; actual freeze runs in `freezeDiv()`

The 50 ms delay absorbs rapid in/out oscillations (e.g. from fast scrolling) without causing
visible flicker.

### `freezeDiv()`

```
shouldFreeze? → seenDivs guard? → read src/viewLen from live DOM
  → setFrozenContent(div, src, viewLen)    [writes frozenSrc / frozenViewLen WeakMaps]
  → sync paragraphRecords[indexOfDiv(div)] [for Phase 2]
  → set style.width → replaceChildren() → add tate-frozen class
```

`shouldFreeze()` blocks freezing in six cases:

| Guard | Reason |
|---|---|
| `freezeSuppressed` | SearchPanel is open; ranges must remain valid |
| `tate-scroll-restoring` active | Scroll restore needs real DOM sizes |
| `tate-layout-refreshing` on div | Cache refresh in progress; do not interrupt |
| Div not in DOM | Div was removed between schedule and fire |
| Cursor inside div | Prevent freezing the paragraph being edited |
| `.tate-editing` span present | Inline-expanded annotation; freezing would destroy editing state |

### `seenDivs` guard

A div that has never entered the viewport has no accurate width measurement:
`content-visibility: auto` reports the 44 px fallback for never-rendered elements. Freezing such
a div would pin `style.width: 44px` regardless of the actual content length, causing a layout
shift when the div is later thawed. `seenDivs` gates freezing on the div having been rendered at
least once.

### `thawDiv()` vs `unfrostDiv()`

| Method | Use case | DOM effect |
|---|---|---|
| `thawDiv()` | IntersectionObserver scroll-in, `ensureThawed*`, SearchPanel navigation | Reads src from `frozenSrc` WeakMap, reconstructs DOM via `parseInlineToHtml` + `sanitizeHTMLToDom`, removes `style.width` |
| `unfrostDiv()` | `patchParagraphs()` (Undo/Redo) — caller replaces children immediately after | Strips frozen class and `style.width` only; leaves `childNodes` empty for caller to fill |

`thawDiv()` reads src from the `frozenSrc` WeakMap **before** removing the `tate-frozen` class,
because `getSrcLine()` uses the class to branch between the WeakMap path (frozen) and the live
DOM serialization path (real). The WeakMap entries for `frozenSrc`/`frozenViewLen` are not
explicitly cleared on thaw — the `isFrozen()` guard in `getSrcLine()`/`getViewLen()` prevents
stale values from being read. The next `freezeDiv()` call on the same element overwrites them.

`thawDiv()` calls `observeOne()` after reconstruction so the div re-enters the observation cycle.
`unfrostDiv()` does not (caller calls `observeOne()` after `replaceChildren()`).

Both methods call `cancelFreeze()`, which also deletes the stale `lastKnownWidths` entry.

## File-Open Width Capture (`observeAll` + `tate-scroll-restoring`)

At file open, `tate-scroll-restoring` forces `content-visibility: visible` on all paragraph divs
so the browser renders them at their actual sizes before `scrollIntoView` is called
(see `20260425_scroll_restore_content_visibility.md`). `ParagraphVirtualizer.observeAll()` detects
this class and captures all real widths synchronously via `getBoundingClientRect()`:

```typescript
observeAll(): void {
    const captureWidths = this.editorEl.classList.contains('tate-scroll-restoring');
    for (const child of Array.from(this.editorEl.children)) {
        this.observer.observe(child);
        if (captureWidths && child instanceof HTMLElement) {
            const w = child.getBoundingClientRect().width;
            if (w > 0) {
                this.seenDivs.add(child);
                this.lastKnownWidths.set(child, w);
            }
        }
    }
}
```

This makes every paragraph immediately eligible for freezing once `tate-scroll-restoring` is
removed, rather than requiring the user to scroll past each paragraph first.

After `tate-scroll-restoring` is removed, `reobserveAll()` forces the IntersectionObserver to
re-evaluate every div. Off-screen divs fire `isIntersecting: false` callbacks, scheduling their
freeze timers.

## Interaction with `tate-layout-refreshing` (`scheduleLayoutRefresh`)

`scheduleLayoutRefresh()` in `view.ts` adds `tate-layout-refreshing` to mutated divs (paste,
Undo/Redo) so their `contain-intrinsic-block-size` cache is updated in a 2-rAF cycle
(see `20260429_proactive_layout_cache_refresh.md`).

Two interactions with ParagraphVirtualizer:

1. **Freeze suppression during the window**: `shouldFreeze()` returns `false` while
   `tate-layout-refreshing` is present, preventing a div from being re-frozen with a stale width
   before the cache update completes.

2. **Re-freeze after class removal**: When `tate-layout-refreshing` is removed in the second rAF,
   `reobserveOne(div)` is called for each affected div. This forces the IntersectionObserver to
   fire a fresh `isIntersecting: false` callback for divs that were off-screen throughout the
   mutation. Without this, continuously off-screen divs would never receive a new IO callback
   (intersection ratio 0 → 0) and would remain thawed indefinitely.

   The `entry.boundingClientRect.width` in this callback reflects the post-mutation actual width,
   which was written into the `contain-intrinsic-block-size` cache by Frame N's layout (while
   `tate-layout-refreshing` was active). This ensures `lastKnownWidths` is updated and the div
   is re-frozen with the correct `style.width`.

## SearchPanel Integration

The original `SearchPanel` called `thawAll()` before running a search, thawing all frozen divs
to allow `TreeWalker`-based visible-text extraction. This eliminated all virtualization benefit
for the duration the panel was open.

### Hybrid text extraction

Frozen divs now contribute their visible text via `buildParagraphVisibleText(src)` — a pure
function that runs `buildSegmentMap()` on the Aozora source and concatenates the base-text
characters for each segment. The src is read from the `frozenSrc` WeakMap via `getSrcLine()`.
Thawed divs are extracted via `TreeWalker` as before.

All match positions are tracked in combined visible-text space (global character offset across
all paragraphs). Each match is stored as a `MatchEntry` union:

```typescript
type MatchEntry =
    | { kind: 'thawed'; range: Range;    viewStart: number }
    | { kind: 'frozen';  div: HTMLElement; localStart: number; localEnd: number; viewStart: number };
```

### Highlight behavior

CSS Custom Highlight API requires live `Range` objects pointing to `Text` nodes. Frozen divs have
no `Text` nodes, so they cannot be highlighted. This is intentional: frozen divs are off-screen
by definition, so absent highlights are invisible to the user.

`applyHitHighlights()` filters `matchEntries` to `kind === 'thawed'` before constructing the
`Highlight` set.

### On-demand thaw during navigation

When `setFocus()` navigates to a `FrozenMatchEntry`:

1. `thawDiv(entry.div)` is called — the div is brought into the visible DOM
2. `extractSegmentsFromDiv()` walks the newly created `Text` nodes
3. A live `Range` is constructed from the local offsets
4. The entry is upgraded in-place to `ThawedMatchEntry`

Subsequent `applyHitHighlights()` calls include the newly promoted range.

### Freeze suppression

`suppressFreeze(true)` is called when the panel opens and `suppressFreeze(false)` when it closes.
This prevents the IntersectionObserver from re-freezing a div whose `Range` objects are still in
use by the highlight sets.

`thawAll()` is **not** called at panel open. Only the navigated-to div is thawed on demand.

## Cross-Cutting Invariants

| Invariant | Enforced by |
|---|---|
| Frozen divs are never edited | `selectionchange` → `ensureThawedAtCursor()` thaws cursor paragraph before DOM access |
| Frozen divs are not searched via TreeWalker | `extractHybridText()` skips frozen divs; `SearchPanel.extractSegmentsFromDiv()` only called on thawed divs |
| Cursor div is never frozen | `shouldFreeze()` checks `div.contains(sel.getRangeAt(0).startContainer)` |
| `style.width` is never stale | Only set in `freezeDiv()` immediately after `lastKnownWidths` is captured by IO callback |
| `frozenSrc` reflects current content | `getSrcLine()` serializes live DOM at freeze time; `patchParagraphs` calls `unfrostDiv` before `replaceChildren` to avoid a stale `frozenSrc` entry on the next freeze |
| `frozenSrc`/`frozenViewLen` correct after DOM shifts | Keyed by div element identity (WeakMap), not DOM position; insertions/deletions elsewhere do not invalidate existing entries |

## Files Changed

| File | Change |
|---|---|
| `src/ui/ParagraphVirtualizer.ts` | New class; all freeze/thaw/observe logic |
| `src/ui/ParagraphVirtualizer.test.ts` | Unit tests for all public methods |
| `src/view.ts` | `ParagraphVirtualizer` construction, `attach/detach`, `observeAll`, `reobserveAll`, `reobserveOne` call sites; `scheduleLayoutRefresh` integration |
| `src/ui/EditorElement.ts` | `setVirtualizer()`; `patchParagraphs` calls `unfrostDiv` + `observeOne`; `getValue` / `getViewCursorOffset` / `setViewCursorOffset` use `getSrcLine` / `getViewLen` |
| `src/ui/SearchPanel.ts` | Replaced `thawAll()` + `extractVisibleText()` with `extractHybridText()` + `MatchEntry` union; on-demand thaw in `setFocus()`; `updateFrozenToThawedEntries()` in scroll rAF |
| `src/ui/CursorAnchorManager.ts` | `findPositionAfterAnchor` / `findPositionBeforeAnchor` call `virtualizer.thawDiv()` before traversing adjacent paragraphs |
| `styles.css` | `.tate-editor > div.tate-frozen { pointer-events: none }` |
