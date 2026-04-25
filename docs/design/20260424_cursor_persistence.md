# Cursor Position Persistence

Created: 2026-04-24

## Overview

Per-file cursor positions are saved to `data.json` and restored when the file is reopened.
The stored unit is **viewOffset** — the visible character count in the contenteditable editor,
excluding `<rt>` text and U+200B cursor anchors.

viewOffset is used (rather than source offset) because it maps 1:1 with what the user
perceives as their cursor position and is independent of Aozora notation length. When CM6
cursor sync also needs to happen (inside `commitToCm6`), `viewToSrc(segs, viewOffset)` converts
to source offset.

## Storage

`data.json` structure (shared with plugin settings):
```json
{
  "settings": { ... },
  "cursorPositions": { "path/to/file.md": 123, ... }
}
```

`saveSettings()` and `saveCursorPosition()` both delegate to `saveAllData()`, which serializes
writes through a Promise queue (`saveDataPromise`). Without the queue, concurrent callers would
each start a separate `saveData()` call and the later write would overwrite the earlier one's
changes (a lost update). The queue ensures writes are ordered and each sees the latest in-memory
state. The `.catch(() => {})` recovery prevents a transient I/O error from permanently breaking
the chain.

## Save Triggers

| Trigger | Location | Notes |
|---------|----------|-------|
| File switch | `file-open` handler | Saves prevFile cursor before loading the new file |
| Markdown view closed | `layout-change` handler | Last save opportunity when the source file tab closes |
| View closed | `onClose()` via `saveCursorForQuit()` | |
| App quit | `workspace.on('quit')` via `saveCursorForQuit()` | Best-effort; Obsidian does not guarantee completion |

`commitToCm6()` intentionally does not save the cursor. If the debounce timer (500 ms) fires
after focus has moved away from the editor, `getViewCursorOffset()` returns 0 and would
overwrite the correct position. All four triggers above use `lastKnownViewOffset`, which is
focus-independent.

## Restore Triggers

`restoreViewOffset(savedOffset)` is called after `loadFile()` completes:
- `loadInitialFile()` — when the view is first opened
- `file-open` handler — on every subsequent file switch

## Two-Track Cursor Tracking

Two fields work in tandem for save and deferred restore.

### `lastKnownViewOffset`

Updated on every `selectionchange` while the editor has focus.

**Why it is needed:** `getViewCursorOffset()` reads `window.getSelection()`, which only reflects
the active focus element. When the editor is not focused, it returns 0 instead of the true
cursor position. `lastKnownViewOffset` preserves the last known valid offset so that save paths
that run while the editor is unfocused (file switch, layout-change, close, quit) can still
write the correct position.

Cleared to `null` when a new file is loaded.

### `pendingCursorOffset`

Set by `restoreViewOffset()` when the view is **not** the active leaf at the time of file load.
Applied (with focus and scroll) on the next `active-leaf-change` for this view.

**Why it is needed:** `setViewCursorOffset()` and `scrollCursorIntoView()` have no effect while
the view is in the background. Deferring to `active-leaf-change` ensures the restore runs when
the view is actually visible.

## `focus()` Caret Reset

Calling `el.focus()` in Electron/Chromium resets the caret to position 0. The `active-leaf-change`
handler must focus the editor on every tab switch (so keyboard input works immediately), but must
also preserve the cursor. The fix:

```typescript
el.el.focus({ preventScroll: true });
el.setViewCursorOffset(savedOffset);   // must follow focus() immediately
```

`selectionchange` fires as a queued (asynchronous) task, not synchronously inside `focus()`.
By the time it fires, `setViewCursorOffset()` has already moved the caret to `savedOffset`, so
`getViewCursorOffset()` returns the correct value and `lastKnownViewOffset` is updated correctly.

## Known Issue: Rare Cursor Loss on Cmd-W Close

Closing the tate view with Cmd-W occasionally fails to save the cursor position. The
× (close) button does not reproduce the problem. Reproduction conditions are unknown and
the frequency is low.

**Hypothesis:** When Cmd-W closes a tab, Obsidian switches the active leaf (firing
`active-leaf-change`) before calling `onClose`. By the time `onClose` runs,
`document.activeElement` has already moved away from the editor, so `saveCursorForQuit`
falls back to `lastKnownViewOffset`. If `lastKnownViewOffset` is still `null` at that
point, the save is skipped.

`lastKnownViewOffset` is set to `null` when a new file is loaded and is only updated
when `selectionchange` fires — which is a queued (asynchronous) task. This creates a
short time window after `setViewCursorOffset()` returns but before `selectionchange`
fires during which `lastKnownViewOffset` remains `null`. Pressing Cmd-W within this
window causes the loss.

The × button is unaffected because `document.activeElement` has not yet moved when
`onClose` runs, so `getViewCursorOffset()` is used directly.

**Fix (applied):** `lastKnownViewOffset` is now set synchronously at every
`setViewCursorOffset()` call site (`restoreViewOffset` and the `pendingCursorOffset`
apply path in `active-leaf-change`), eliminating the dependency on the asynchronous
`selectionchange`. This was added as part of the scroll restore fix for
`content-visibility: auto` (see the section below).

## `content-visibility: auto` and Scroll Restore

`styles.css` applies `content-visibility: auto` + `contain-intrinsic-block-size: auto 44px` to
paragraph divs (`.tate-editor > div`) to skip layout/paint for off-screen paragraphs during editing.

**Problem:** On a freshly built DOM (view close + reopen), all paragraph divs start with the 44 px
fallback intrinsic size because none have been rendered yet. `scrollCursorIntoView()` calls
`element.scrollIntoView()`, which uses these estimated sizes to compute the element's position.
For a 200 k-char file with ~2,857 paragraphs averaging 2 lines each, the estimated total width is
~126 kpx but the real total is ~252 kpx, so the scroll lands at the wrong position.

**Fix:** Before calling `scrollCursorIntoView()`, add the class `tate-scroll-restoring` to the
editor element. The CSS rule `.tate-editor.tate-scroll-restoring > div { content-visibility: visible }`
forces the browser to compute real paragraph sizes for the scroll. One `requestAnimationFrame` later,
the class is removed and `content-visibility: auto` takes over again.

After this one-time full layout, all paragraph sizes are cached (`auto` in `contain-intrinsic-block-size`
remembers the last rendered size), so subsequent `scrollCursorIntoView()` calls during the same DOM
session are accurate.

This pattern is applied in both `restoreViewOffset()` (immediate restore path) and the
`pendingCursorOffset` apply path in `active-leaf-change` (background-load restore path).

## File Lifecycle

| Event | Action |
|-------|--------|
| `vault.on('delete')` | `deleteCursorPosition(file.path)` — remove stale entry |
| `vault.on('rename')` | `renameCursorPosition(oldPath, newPath)` — migrate key |
