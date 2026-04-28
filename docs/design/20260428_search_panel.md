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
    ├── currentIndex: number         focused hit index; preserved across content-change re-searches
    ├── prSearchOffset               cursor offset at open(); restored if no navigation happened
    ├── lastNavigatedOffset          cursor offset of the last setFocus(); restored on ESC
    └── scrollGen: number            generation counter for rAF guard in scrollRangeIntoView()
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

| Name | Contents |
|---|---|
| `tate-search-hit` | All match ranges |
| `tate-search-focus` | The single focused match range |

```typescript
CSS.highlights.set('tate-search-hit', new Highlight(...this.matches));
CSS.highlights.set('tate-search-focus', new Highlight(focused));
```

Both are cleared on `close()` and rebuilt on every `runSearch()`. The `::highlight()` pseudo-element
rules live in `styles.css`:

```css
::highlight(tate-search-hit)   { background-color: var(--text-highlight-bg); }
::highlight(tate-search-focus) { background-color: var(--interactive-accent);
                                  color: var(--text-on-accent); }
```

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
stays visually fixed even as the editor content scrolls horizontally. A `position: fixed` approach
was considered but rejected because it requires dynamic `px` positioning from `getBoundingClientRect()`
and must be updated on resize; `position: absolute` within the container is self-maintaining.

### Scroll to focused hit: `tate-searching` class

`content-visibility: auto` on `.tate-editor > div` makes `scrollIntoView()` inaccurate for
off-screen paragraphs (they report their `contain-intrinsic-block-size: 44px` fallback size
rather than their real size). The same problem applies to search navigation as to cursor restore
after file load (see `20260425_scroll_restore_content_visibility.md`).

A separate CSS class `tate-searching` is used — distinct from `tate-scroll-restoring` — to
temporarily force `content-visibility: visible` on all paragraphs during a navigation scroll:

```css
.tate-editor.tate-searching > div { content-visibility: visible; }
```

```typescript
private scrollRangeIntoView(range: Range): void {
    editorEl.classList.add('tate-searching');
    const gen = ++this.scrollGen;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    requestAnimationFrame(() => {
        if (this.scrollGen === gen) editorEl.classList.remove('tate-searching');
    });
}
```

Using a separate class avoids interfering with `scrollRestoringGeneration` counter in
`VerticalWritingView`, which guards the file-load scroll-restore lifecycle. The `scrollGen`
generation counter inside `SearchPanel` guards against stale rAF callbacks when the user
navigates quickly (pressing Enter multiple times before any rAF fires): only the most recent
rAF removes the class.

No loading spinner is shown during search navigation. The `tate-scroll-restoring` spinner is
appropriate for file loads (where the user waits for content to appear) but would be jarring for
in-session navigation.

### Cursor offset and ESC restore

`SearchPanel` uses `EditorElement.getViewCursorOffset()` (visible offset, `<rt>` and U+200B
excluded) rather than maintaining its own offset calculation. This guarantees consistency with
the offset space used by `VerticalWritingView.lastKnownViewOffset` and `setViewCursorOffset()`.

On `setFocus()`, the editor selection is moved to the start of the focused `Range`, then
`getViewCursorOffset()` is called to capture `lastNavigatedOffset`. When the panel is closed
(by ESC or the close button), `close()` returns the offset to restore:

```typescript
const restoreOffset = this.lastNavigatedOffset ?? this.prSearchOffset;
```

`VerticalWritingView.closeSearch()` applies the returned offset via `setViewCursorOffset()` and
updates `lastKnownViewOffset` so that subsequent tab-switch restore uses the post-search position.

### `currentIndex` preservation across content changes

When the user edits the document while the panel is open, `onContentChanged()` triggers
`runSearch()` to rebuild the match list. To avoid jumping back to the first result after every
keystroke, `runSearch()` saves `currentIndex` before resetting it, then restores it if the new
match count is still sufficient:

```typescript
const prevIndex = this.currentIndex;
this.matches = [];
this.currentIndex = -1;
// ... rebuild matches ...
if (prevIndex >= 0 && prevIndex < this.matches.length) {
    this.setFocus(prevIndex);
} else {
    this.setFocus(0);
}
```

## Files

| File | Role |
|---|---|
| `src/ui/SearchPanel.ts` | SearchPanel class, visible text extraction, Range building |
| `src/css-highlight.d.ts` | TypeScript type declarations for CSS Custom Highlight API |
| `src/view.ts` | Creates SearchPanel in `onOpen()`; calls `openSearch()`, `closeSearch()`, `onContentChanged()` |
| `src/main.ts` | Registers `tate-search` command (no default hotkey) |
| `styles.css` | `.tate-search-panel`, `.tate-searching`, `::highlight(tate-search-hit/focus)` |
