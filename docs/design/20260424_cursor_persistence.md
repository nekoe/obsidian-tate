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

**Potential fix (not yet applied):** Set `lastKnownViewOffset` synchronously at every
`setViewCursorOffset()` call site (`restoreViewOffset` and the `pendingCursorOffset`
apply path in `active-leaf-change`), eliminating the dependency on the asynchronous
`selectionchange`.

## File Lifecycle

| Event | Action |
|-------|--------|
| `vault.on('delete')` | `deleteCursorPosition(file.path)` — remove stale entry |
| `vault.on('rename')` | `renameCursorPosition(oldPath, newPath)` — migrate key |
