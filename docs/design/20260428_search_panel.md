# Search Panel: Incremental Search with CSS Custom Highlight API

Created: 2026-04-28

## Overview

An incremental search panel that overlays the vertical writing editor. Activated via the
`tate-search` command, it searches the visible text of the current file, highlights all hits
using the CSS Custom Highlight API, and navigates between them with Enter/Shift+Enter (or ↓/↑
buttons). ESC or the close button dismisses the panel.

## Key Requirements

- Search targets the visible (rendered) text only: `<rt>` content (ruby readings) is excluded.
- Search is case-insensitive.
- All hits are highlighted simultaneously; the focused hit uses a distinct style.
- The panel updates search results in real time as the user edits content while the panel is open.
- Search does not run while an IME composition is in progress; it fires on `compositionend`.
- ESC restores the cursor to the last navigated hit position, or to the pre-search position if
  no navigation occurred.
- Opening the panel while an inline element is expanded (a `tate-editing` span) collapses it
  first, so the DOM structure is clean for searching.
- File switch (`file-open`) automatically closes the panel.

## Architecture

### SearchPanel class (`src/ui/SearchPanel.ts`)

A single class owns the entire search lifecycle: DOM, keyboard scope, CSS highlights, and state.
It is created once in `VerticalWritingView.onOpen()` and kept alive for the view's lifetime.
`open()` / `close()` are called repeatedly without re-creating the object, so the `Scope`
instance and its three registered handlers (Enter, Shift+Enter, Escape) are created only once.

```
VerticalWritingView
└── searchPanel: SearchPanel        created in onOpen(), alive until onClose()
    ├── panelEl: HTMLElement | null  non-null ↔ panel is visible
    ├── searchScope: Scope           created once; pushed/popped on open/close
    ├── matches: Range[]             CSS Highlight ranges, rebuilt on each runSearch()
    ├── matchStarts: number[]        visible-text start offset for each match (parallel to matches[])
    ├── currentIndex: number         focused hit index; preserved across content-change re-searches
    ├── prSearchOffset               cursor offset at open(); restored if no navigation happened
    └── lastNavigatedOffset          cursor offset of the last setFocus(isNavigation=true); restored on close
```

### Visible text extraction

Search operates on the visible text — the text the user reads, without Aozora source notation or
`<rt>` ruby readings. `extractVisibleText()` walks all `Text` nodes inside the editor element
using `TreeWalker`, skips nodes inside `<RT>` elements (via `isInsideRtNode` from `domHelpers`),
and strips U+200B cursor-anchor placeholders. The result is a flat `{ text: string, segments }` pair
where each segment maps a `Text` node to its start offset and visible character count in the
extracted string.

This representation is intentionally simple: the segments array is rebuilt from scratch on every
`runSearch()` call rather than cached, because the DOM can be mutated between calls (user is
editing with the panel open). Re-walking the DOM per search is O(N) in the number of text nodes
but fast in practice because TreeWalker is a native operation and text nodes in a contenteditable
div are compact.

### Range building

For each regex match at `[matchStart, matchEnd]` in the extracted visible text, `createRangeForMatch()`
scans the segment array to find the `Text` nodes that contain those positions and converts visible
offsets to raw DOM offsets via `visibleToRawOffset()` (which skips U+200B characters within a node).
The resulting `Range` objects are passed directly to the CSS Custom Highlight API.

### CSS Custom Highlight API

Two named highlights are maintained:

| Name | Contents | Priority |
|---|---|---|
| `tate-search-hit` | All match ranges | 0 (default) |
| `tate-search-focus` | The single focused match range | 1 |

```typescript
CSS.highlights.set('tate-search-hit', new Highlight(...this.matches));

const h = new Highlight(focused);
h.priority = 1; // wins over tate-search-hit when ranges overlap
CSS.highlights.set('tate-search-focus', h);
```

Both are cleared on `close()` and rebuilt on every `runSearch()`. The `::highlight()` pseudo-element
rules live in `styles.css`:

```css
::highlight(tate-search-hit) {
    background-color: var(--text-highlight-bg, rgba(255, 208, 0, 0.4));
    color: inherit;
}
/* ::highlight() does not support outline/border/box-shadow.
   text-decoration underline+overline = right/left lines in vertical-rl. */
::highlight(tate-search-focus) {
    background-color: color-mix(in srgb, var(--interactive-accent) 35%, transparent);
    color: inherit;
    text-decoration-line: underline overline;
    text-decoration-style: dashed;
    text-decoration-color: var(--interactive-accent);
    text-decoration-thickness: 2px;
}
```

**Priority requirement**: the focused match range is registered in _both_ `tate-search-hit` and
`tate-search-focus`. Without `h.priority = 1`, both highlights have the same priority (0) and the
CSS cascade order is not guaranteed to resolve the conflict correctly — the focus style may be
invisible. Setting `priority = 1` ensures `tate-search-focus` always wins.

**`::highlight()` property constraints**: CSS Custom Highlight API only supports a limited subset
of CSS properties. `outline`, `border`, `box-shadow`, and `padding` are NOT supported. To create
a visually distinct focused indicator in vertical writing mode, `text-decoration-line: underline overline`
is used — in `writing-mode: vertical-rl`, `underline` renders on the right side and `overline` on
the left side of each character, approximating a lateral border.

CSS Custom Highlight API requires no DOM mutation for highlighting — it applies paint-layer
decoration directly to `Range` objects. This avoids the O(N) cost of inserting wrapper `<span>`
elements into the contenteditable DOM and preserves the serializable structure of the editor.
A runtime guard (`typeof CSS === 'undefined' || !CSS.highlights`) is included for environments
where the API is absent, though Obsidian's Electron version ships a Chromium build that supports it.

### Keyboard handling via Scope API

`searchScope` is constructed with `app.scope` as its parent (same pattern as `escScope` in
`VerticalWritingView`), ensuring unhandled keys fall through to the root scope:

```typescript
this.searchScope = new Scope(app.scope);
this.searchScope.register([], 'Enter',       handler);   // navigate forward
this.searchScope.register(['Shift'], 'Enter', handler);  // navigate backward
this.searchScope.register([], 'Escape',      handler);   // close panel
```

Each handler returns `false` to cause Obsidian's `onKeyEvent` to call `preventDefault()` +
`stopPropagation()`, suppressing the global ESC handler and preventing Enter from propagating to
the editor. While the panel is open, `searchScope` sits on top of `escScope` in the keymap stack:

```
[root scope] ← [escScope] ← [searchScope]   (searchScope has highest priority)
```

The panel's `<input>` element also has a `keydown` listener that calls `stopPropagation()` for all
keys except Enter and Escape, preventing the editor's `keydown` handler in `view.ts` from seeing
typing in the search field (which would trigger Undo/Redo or navigation-key commits).

### IME composition guard

Incremental search must not run against partially composed IME text. The `input` listener checks
`event.isComposing` and returns early during composition. A separate `compositionend` listener
triggers `runSearch()` when the user commits the input:

```typescript
input.addEventListener('input', (e) => {
    if ((e as InputEvent).isComposing) return;
    this.runSearch();
});
// In Chromium/Electron, compositionend fires before the subsequent input event,
// so this is the reliable trigger point for post-IME search.
input.addEventListener('compositionend', () => this.runSearch());
```

### Focus management

**Browser focus invariant**: while the search panel is open, keyboard focus must remain in the
search `<input>` so the user can type consecutive characters and use Enter for navigation.

Two operations risk stealing focus from the input:

1. **`sel.addRange()` on a contenteditable node** — moves browser focus to the contenteditable.
   This is called in `setFocus()` to place the editor cursor at the hit (needed to capture
   `lastNavigatedOffset` via `getViewCursorOffset()`). It is guarded by `isNavigation`:

   ```typescript
   private setFocus(index: number, isNavigation: boolean, triggerScroll: boolean): void {
       // ...highlight, count...
       if (isNavigation) {
           sel.removeAllRanges();
           sel.addRange(cursorRange);                      // steals focus
           this.lastNavigatedOffset = getViewCursorOffset();
           this.inputEl?.focus();                          // give it back
       }
       if (triggerScroll) this.scrollRangeIntoView(range);
   }
   ```

   `runSearch()` calls `setFocus(index, false, scroll)` — typing in the input never moves the DOM
   cursor; whether to scroll is controlled by the `scroll` argument passed to `runSearch()`.
   `navigate()` calls `setFocus(next, true, true)` — Enter/button navigation moves the cursor then
   immediately restores focus to the input, and always scrolls.

2. **`close()` called by ESC scope handler or × button** — these call `SearchPanel.close()`
   directly; the return value is not used by a caller. Therefore `close()` must handle cursor
   restore and `el.focus()` itself:

   ```typescript
   close(): number | null {
       // ...cleanup...
       if (restoreOffset !== null) editorElementRef.setViewCursorOffset(restoreOffset);
       editorElementRef.el.focus();
       return restoreOffset; // caller (closeSearch) uses this only to update lastKnownViewOffset
   }
   ```

   `VerticalWritingView.closeSearch()` (called on file-open) also invokes `close()`, so the
   focus restore is consistent across all close paths.

### Panel position

The panel element is appended to `.tate-container` (the `container` parameter passed to the
constructor) rather than `document.body`. This aligns with the existing `tate-loading-spinner`
pattern and ensures Obsidian's normal DOM cleanup manages the panel's lifetime.

```css
.tate-search-panel {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 100;
}
```

`position: absolute` with `right: 8px` inside `.tate-container` (which has `position: relative`)
anchors the panel to the physical right edge of the container element. Because CSS absolute
positioning uses the containing block's padding-box edge (not the scroll position), the panel
stays visually fixed even as the editor content scrolls horizontally.

**DOM structure**: `.tate-container` must NOT have `overflow-x: auto`. The scroll behavior lives
in the inner `.tate-scroll-area` wrapper. If `overflow-x: auto` were on `.tate-container`, then
`right: 8px` would anchor to the right edge of the full scroll content area (which in
`writing-mode: vertical-rl` is the physical left / document end), causing the panel to move with
horizontal scroll and to jump there on `inputEl.focus()`. The inner scroll wrapper was introduced
specifically to fix this:

```
.tate-container  (position:relative, no overflow — anchor for spinner + search panel)
└── .tate-scroll-area  (overflow-x:auto — scroll wrapper for editor content)
    └── .tate-editor   (contenteditable, writing-mode:vertical-rl)
```

A `position: fixed` approach was considered but rejected because it requires dynamic `px`
positioning from `getBoundingClientRect()` and must be updated on resize; `position: absolute`
within the container is self-maintaining.

### Scroll to focused hit

`scrollRangeIntoView()` delegates to `EditorElement.scrollToRange(range)`, which uses
`Range.getBoundingClientRect()` to compute the exact column position of the hit and sets
`container.scrollLeft` directly (see `20260425_scroll_restore_content_visibility.md` for the
rect-based scroll design). `block: 'center'` is used so the hit appears in the horizontal
center of the viewport.

Calling `element.scrollIntoView()` on the paragraph `<div>` was rejected: for long paragraphs
spanning multiple columns, it scrolls to the element boundary rather than the hit's column.

**CSS Custom Highlight repaint after scroll (`tate-search-repaint`)**

After a compositor-thread scroll, `content-visibility: auto` paragraphs that just entered the
viewport can be composited before the CSS Custom Highlight registry reaches the main-thread paint
record. The result is that highlights are absent on newly-visible content until the next pointer
event (e.g. moving the mouse from the search panel to the editor) triggers a main-thread repaint.

The fix: in the rAF after `scrollToRange()`, add the `tate-search-repaint` class to the editor,
re-apply both highlights, then remove the class in the following rAF:

```typescript
private scrollRangeIntoView(range: Range): void {
    this.editorElementRef.scrollToRange(range);
    requestAnimationFrame(() => {
        this.editorElementRef.el.classList.add('tate-search-repaint');
        this.applyHitHighlights();
        this.applyFocusHighlight();
        requestAnimationFrame(() => {
            this.editorElementRef.el.classList.remove('tate-search-repaint');
        });
    });
}
```

```css
.tate-editor.tate-search-repaint {
    outline: 1px solid transparent;
}
```

`outline-style: none → solid` is a paint-record mutation that Chrome cannot optimize away as a
no-op, so it forces a main-thread repaint. The outline is transparent (invisible to the user)
and reverts in the next frame.

**When scroll is triggered**

`scrollRangeIntoView` is called only when `triggerScroll=true` is passed to `setFocus()`.
The call sites are:

| Caller | `triggerScroll` | Reason |
|---|---|---|
| `navigate()` (Enter / buttons) | `true` | User requested to jump to a hit |
| `runSearch()` from search input | `true` (default) | Incremental search should show the first hit |
| `runSearch(false)` from `onContentChanged()` | `false` | User is editing; no scroll needed |

No loading spinner is shown during search navigation. The `tate-scroll-restoring` spinner is
appropriate for file loads (where the user waits for content to appear) but would be jarring for
in-session navigation.

### Initial focus: nearest hit at or after cursor position

When the search panel is first opened and the user types a query, the initial focused hit is the
nearest match at or after `prSearchOffset` (the cursor position when the panel was opened),
rather than always jumping to the first match in the document. This matches standard editor
search UX (VSCode, Sublime Text, etc.).

`matchStarts[]` (parallel to `matches[]`) records each match's visible-text start offset so
`findFirstIndexAtOrAfter()` can locate the target without an additional DOM traversal:

```typescript
// In runSearch(): first search — focus nearest hit at or after the cursor.
this.setFocus(this.findFirstIndexAtOrAfter(this.prSearchOffset ?? 0), false, scroll);

private findFirstIndexAtOrAfter(offset: number): number {
    for (let i = 0; i < this.matchStarts.length; i++) {
        if (this.matchStarts[i] >= offset) return i;
    }
    return 0; // wrap: cursor is past all matches → go to first
}
```

The offset space of `prSearchOffset` (from `EditorElement.getViewCursorOffset()`) and
`matchStarts[i]` (from `m.index` in `extractVisibleText`) are identical: both walk all `Text`
nodes excluding `<RT>` and U+200B, in document order.

### `currentIndex` preservation across content changes

When the user edits the document while the panel is open, `onContentChanged()` triggers
`runSearch()` to rebuild the match list. To avoid jumping back to the initial-focus result after
every keystroke, `runSearch()` saves `currentIndex` before resetting it, then restores it if the
new match count is still sufficient:

```typescript
const prevIndex = this.currentIndex;
this.matches = [];
this.currentIndex = -1;
// ... rebuild matches ...
if (prevIndex >= 0 && prevIndex < this.matches.length) {
    this.setFocus(prevIndex, false, scroll);  // isNavigation=false: do not move DOM cursor
} else {
    this.setFocus(this.findFirstIndexAtOrAfter(this.prSearchOffset ?? 0), false, scroll);
}
```

`scroll` is `true` when called from typing in the search input (show the first hit as the query
is refined) and `false` when called from `onContentChanged()` (no scroll on every keystroke).

### Cursor offset and ESC restore

`SearchPanel` uses `EditorElement.getViewCursorOffset()` (visible offset, `<rt>` and U+200B
excluded) rather than maintaining its own offset calculation. This guarantees consistency with
the offset space used by `VerticalWritingView.lastKnownViewOffset` and `setViewCursorOffset()`.

`lastNavigatedOffset` is updated only during explicit navigation (`isNavigation=true`), not
during typing. This ensures ESC always restores to the last position the user explicitly visited,
not to a position set as a side-effect of typing.

When the panel is closed (by any path), `close()` determines the restore target and applies it:

```typescript
const restoreOffset = this.lastNavigatedOffset ?? this.prSearchOffset;
if (restoreOffset !== null) editorElementRef.setViewCursorOffset(restoreOffset);
editorElementRef.el.focus();
return restoreOffset;
```

`VerticalWritingView.closeSearch()` uses the returned offset only to update `lastKnownViewOffset`
so that subsequent tab-switch restore uses the post-search position.

## Files

| File | Role |
|---|---|
| `src/ui/SearchPanel.ts` | SearchPanel class, visible text extraction, Range building |
| `src/css-highlight.d.ts` | TypeScript type declarations for CSS Custom Highlight API (including `Highlight.priority`) |
| `src/view.ts` | Creates SearchPanel in `onOpen()`; calls `openSearch()`, `closeSearch()`, `onContentChanged()` |
| `src/main.ts` | Registers `tate-search` command (no default hotkey) |
| `styles.css` | `.tate-search-panel`, `.tate-search-repaint`, `::highlight(tate-search-hit/focus)` |
