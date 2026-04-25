# IME Performance on Large Files with content-visibility: auto

Created: 2026-04-25

## Problem

On large files (~200 k characters, ~2,800 paragraph divs), Japanese IME input had
noticeable lag during composition. Each `compositionupdate` event triggered a full
layout pass over the entire document.

## Root Cause

`.tate-editor` uses `writing-mode: vertical-rl`. In this writing mode the CSS block
direction is horizontal: each direct `<div>` child is a column laid out right to left.
`parseToHtml()` produces one `<div>` per source line:

```
<div class="tate-editor">
  <div>paragraph 0</div>   ← column N   (rightmost)
  <div>paragraph 1</div>   ← column N-1
  …
  <div>paragraph 2800</div> ← column 0  (leftmost)
</div>
```

When the user types a character inside one paragraph, the browser must re-lay out
that paragraph to compute its new column width. Because there is no containment
boundary, the engine also needs to re-evaluate whether the new width affects the
intrinsic width of `.tate-editor` (which is `width: max-content`) and, transitively,
the layout of every sibling column. On a 2,800-column document this is an O(N) layout
pass on every keystroke.

During IME composition (`compositionupdate` fires at every candidate change), this
repeats continuously, causing input lag proportional to document size.

## Fix

### `content-visibility: auto`

```css
.tate-editor > div {
    content-visibility: auto;
    contain-intrinsic-block-size: auto 44px;
}
```

`content-visibility: auto` adds implicit CSS containment to each paragraph div.
When a paragraph is outside the viewport the browser skips its layout and paint
entirely. Only the paragraph(s) visible in the current viewport are fully laid out
and painted. This converts the per-keystroke O(N) layout pass into an O(1) operation
over the handful of visible paragraphs, eliminating IME lag regardless of total
document length.

### `contain-intrinsic-block-size: auto 44px`

When `content-visibility: auto` skips layout for an off-screen paragraph, the
paragraph still occupies space in the scroll container (otherwise the scrollbar
width would collapse to zero). The browser needs a *placeholder* size for those
skipped elements.

`contain-intrinsic-block-size` specifies the placeholder block-size. In
`writing-mode: vertical-rl` the block direction maps to the horizontal axis, so
`contain-intrinsic-block-size` controls the *column width* of each paragraph div.

The value `auto 44px` means:

| State | Size used |
|---|---|
| Element has a cached rendered size | Cached real size |
| Never rendered yet (fresh DOM) | 44 px fallback |

**Why 44 px:** The default settings are `font-size: 22px` and `line-height: 2`. A
single-line paragraph has a column width of `font-size × line-height = 22 × 2 = 44 px`.
This is the smallest plausible column width, so it keeps the scrollbar roughly
proportional to the real document size even before paragraphs are rendered.

The `auto` keyword is critical: after a paragraph is scrolled into view once, the
browser caches its real rendered width. Subsequent layout passes (e.g., after editing)
use the cached size rather than the 44 px fallback. As the user scrolls through a
document, all visited paragraphs accumulate accurate cached sizes.

## Quantified example

A 200 k-char file with ~2,857 paragraph divs, average ~2 lines per paragraph
(22 px font, `line-height: 2`):

| | Per paragraph | Total scroll width |
|---|---|---|
| Fallback (44 px, 1 line) | 44 px | ~126 kpx |
| Real (2 lines × 44 px) | ~88 px | ~252 kpx |

The fallback underestimates the total width by ~50 %. After all paragraphs have been
rendered once, the cached sizes restore full accuracy.

## Trade-off: scroll position accuracy on fresh DOM

Because a freshly opened document has no cached sizes, `scrollIntoView` calls that
execute before paragraphs have been rendered (e.g., restoring the cursor on view
reopen) land at the wrong position. This was a regression introduced by this change.

The fix — the `tate-scroll-restoring` CSS class and the two-rAF removal pattern —
is documented in `20260425_scroll_restore_content_visibility.md`.

## Alternatives considered

### CSS containment only (`contain: layout style`)

`contain: layout style` without `content-visibility: auto` creates a containment
boundary but does **not** skip layout for off-screen elements. The browser still
lays out all paragraphs; it only knows that a change inside one paragraph cannot
affect layout outside the paragraph's containing block. This would reduce the
scope of re-layout but not eliminate the O(N) paint pass.

### DOM virtualization

Render only the visible paragraphs in the DOM and replace off-screen paragraphs
with height-placeholder elements. This achieves the same O(1) per-keystroke cost
but requires significant refactoring: `getValue()` / `setValue()` / `AozoraParser`
all assume the full document is in the DOM. It also complicates cursor position
tracking, copy/paste, and Undo/Redo. `content-visibility: auto` achieves the
same effect at the CSS level with no JS changes.

### Lazy parsing / chunked rendering

Delay parsing off-screen paragraphs. Ruled out for the same reasons as DOM
virtualization — the rest of the codebase assumes a complete DOM.
