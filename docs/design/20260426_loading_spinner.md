# Loading Spinner During Scroll Restore

Created: 2026-04-26

## Problem

Opening a large file (e.g., 200 k characters, ~2,857 paragraph divs) causes a noticeable UI
lag before the view scrolls to the saved cursor position. The lag comes from the O(N) forced
synchronous layout triggered by `scrollIntoView()` while `tate-scroll-restoring` is active
(all N paragraph divs have `content-visibility: visible`, so the browser must compute real
column widths for all of them).

The root cause of the O(N) cost is discussed in `20260425_scroll_restore_content_visibility.md`
and cannot be eliminated without either:
- Relaxing scroll accuracy (acceptable to user: "near center" rather than pixel-exact), or
- Paying the full layout cost every time.

An earlier attempt to reduce the cost by making only a subset of paragraphs visible (selective
reveal) was already tried during the original `tate-scroll-restoring` implementation and failed:
paragraph divs created with `content-visibility: auto` (44 px fallback) do not produce correct
layout sizes when the property is changed to `visible` after the fact, even inside a forced
reflow triggered by `scrollIntoView`. The "before replaceChildren" approach (adding the class
before the DOM is built) is required for correctness.

## Solution: Loading Spinner

Since the lag cannot be eliminated, the UX is improved by showing a spinner during the scroll
restore sequence so the user sees visual feedback rather than a frozen/blank screen.

### Spinner Lifecycle

```
classList.add('tate-scroll-restoring')  →  showLoadingSpinner()
        ↓
  vault.read() awaits (async I/O) — spinner animates
        ↓
  replaceChildren() — UI may freeze briefly (spinner pauses)
        ↓
  rAF 1 fires:
    hideLoadingSpinner()           ← spinner disappears
    setViewCursorOffset(offset)
    scrollCursorIntoView()         ← O(N) forced layout; content scrolls to cursor
        ↓
  Paint frame: content at cursor, no spinner
        ↓
  rAF 2 fires: classList.remove('tate-scroll-restoring')
```

The spinner is hidden in **rAF 1, before `scrollIntoView`**, so that when the browser paints
after the layout computation, both events are reflected simultaneously: the spinner is gone and
the content is already at the correct cursor position. Hiding in rAF 2 instead would show the
spinner on top of the correctly scrolled content for one frame (~16 ms).

For cleanup paths (no saved cursor, superseded load), the spinner and the class are removed
in the same rAF.

### Spinner Positioning

The spinner (`div.tate-loading-spinner`) is a direct child of `.tate-container` and is
positioned with `position: absolute; top: 50%; left: 50%` (centered via negative margins).

`.tate-container` receives `position: relative` to serve as the containing block.

Since `tate-container` has `overflow-x: auto`, the absolutely positioned spinner lives within
the scrollable content coordinate system. Before any scroll occurs (spinner is shown at
`scrollLeft = 0`), the spinner appears at the center of the viewport. After `scrollIntoView`
shifts `scrollLeft`, the spinner may be off-screen — but at that point `hideLoadingSpinner()`
has already been called (rAF 1) and the spinner is `display: none`, so this is not visible.

### Generation Guard

The existing `scrollRestoringGeneration` counter that guards `tate-scroll-restoring` removal
rAFs also implicitly guards the spinner: `hideLoadingSpinner()` is called only inside the
`if (this.scrollRestoringGeneration === gen)` block (except for the active-leaf-change direct
path), so a cleanup rAF from a superseded load will not hide the spinner owned by a newer load.

## Files Changed

- `src/view.ts`: `spinnerEl` field, `showLoadingSpinner()` / `hideLoadingSpinner()` methods,
  calls at each `tate-scroll-restoring` add/remove site.
- `styles.css`: `.tate-loading-spinner` / `.tate-loading-visible` rules, `@keyframes tate-spin`,
  `position: relative` added to `.tate-container`.
