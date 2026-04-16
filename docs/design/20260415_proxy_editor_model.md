# Proxy Editor Model — Bidirectional Sync and Undo/Redo Design

Created: 2026-04-15

## Overview

The vertical writing view acts as a "Proxy Editor". All file writes are delegated to CM6 (Obsidian's built-in Markdown editor) via autosave; the vertical writing view never writes to the file directly.

## Sync Conflict Prevention

- `SyncCoordinator` is read-only (does not use `vault.modify` / `DebounceQueue`)
- Direct assignment to `el.innerHTML` does not fire input events, so an `isApplyingExternalChange` flag is unnecessary
- Both `SyncCoordinator.loadFile()` and `onExternalModify()` are async (vault.read), so sequence numbers (`loadSeq`, `externalModifySeq`) are used to discard stale results
- `modify` events fired by CM6 autosave are skipped via content comparison (`externalContent === getEditorValue()`)

## Data Loss Prevention on Close

`commitToCm6()` is called at the start of `onClose()` to ensure any uncommitted burst is flushed to CM6 before the view closes. CM6 then saves to the file via autosave.

## `commitToCm6()` — Differential Commit

Input to the vertical writing view is committed to CM6 via differential `replaceRange()` in `commitToCm6()` (`view.ts`). Only the changed region (excluding identical leading/trailing characters) is replaced, so CM6 records the exact edit position and the cursor lands at the edit site after Undo.

## `lastCommittedContent` — IME Conflict Prevention

The last confirmed text committed to CM6, held by `VerticalWritingView`. During IME composition, the DOM contains uncommitted text, so using `getValue()` directly in `onExternalModify()` comparison would cause the CM6 autosave `modify` event to erroneously reset the view. Because `lastCommittedContent` is not updated during IME composition, autosave-triggered `modify` events are correctly skipped.

Update timing: on `commitToCm6()` completion, on file load, and on external change application.

## Commit Points

| Operation | When committed |
|-----------|---------------|
| Paste | Immediately after `paste` event |
| IME confirmation | Immediately after `compositionend` |
| Live notation conversion | When `input` event handler returns `true` |
| Annotation collapse | When `collapseEditing()` returns `true` in `selectionchange` |
| Navigation keys | On `keydown` detecting arrow / Home / End / PgUp / PgDn |
| mousedown | On click (ends a burst) |
| Close view | At the start of `onClose()` |
| tcy/bouten command | Inside `applyAnnotation()` |

## `inBurst` Flag

`inBurst = true` means "there are uncommitted changes in CM6". Set to `true` by `onBeforeInput()`; reset to `false` by `resetBurst()` inside `commitToCm6()`.

## Undo/Redo

Undo/Redo is fully delegated to CM6. The vertical writing view maintains no Undo stack of its own.

### Execution Flow (`doUndoRedo()`)

```
commitToCm6()                    // flush any uncommitted burst to CM6 first
prevContent = lastCommittedContent
cm6.undo() / cm6.redo()          // execute Undo/Redo on CM6 side
newContent = cm6.getValue()
if newContent === prevContent: return  // stack empty or no change → leave cursor as-is
srcOffset = deriveUndoRedoCursor(prevContent, newContent)
editorEl.applyFromCm6(newContent, srcOffset)
```

### Why `cm6.getCursor()` Is Not Used

After `cm6.undo()`, `getCursor()` returns the position set by the last `setCursor()` call before the undone transaction. This is the position set by the previous `commitToCm6()` call and is unrelated to the current edit site, causing the cursor to jump to unexpected locations.

### `deriveUndoRedoCursor(prev, next)`

Returns the end of the changed region in `next` from the diff between `prevContent` and `newContent` (excluding common prefix/suffix):
- undo (text restoration): end of restored text — e.g., undoing deletion of "うえお" → just after "お"
- redo (re-applying deletion): deletion point (start of changed region = fromStart = fromEndNext)
- no change (empty stack): handled by early return in the caller; never reached here

### Cursor Restoration via `applyFromCm6()`

`EditorElement.applyFromCm6(content, srcOffset)`:
1. Clear `expandedEl` / `expandedElOriginalText` / `savedRange` (remove stale references)
2. If content changed, update DOM with `replaceChildren(sanitizeHTMLToDom(parseToHtml(content)))`
3. Convert source offset to view offset using `buildSegmentMap(content)` + `srcToView(segs, srcOffset)`
4. Set cursor with `setVisibleOffset(viewOffset)`
