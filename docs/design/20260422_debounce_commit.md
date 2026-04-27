# Debounced CM6 Commit for Non-IME Input

Created: 2026-04-22

## Overview

Non-IME input (direct ASCII/alphanumeric typing, Backspace, Delete) was previously committed to CM6
only at the next navigation key press, click, or other natural commit point. This meant a long burst
of typing produced a single large CM6 history entry, making Undo coarse-grained compared with
ordinary text editors.

A 500 ms debounce timer was added so that any qualifying input event schedules a commit. The timer
resets on each qualifying event and fires when the user pauses for 500 ms. Immediate commit points
(navigation keys, Enter, click, etc.) cancel the pending timer and commit right away, giving a more
predictable experience without double-commits.

## Qualifying Input Events

The timer is started (or reset) when an `input` event fires with one of the following `inputType`
values, and `isComposing` is `false`:

- `insertText` — direct character input
- any `inputType` starting with `deleteContent` — `deleteContentBackward` (Backspace),
  `deleteContentForward` (Delete), `deleteWordBackward`, `deleteWordForward`, etc.

All other `inputType` values are excluded because they are either already immediate commit points
(`insertParagraph`) or handled separately (paste via `cut`/`paste` events, notation completion via
`handleRubyCompletion` etc.).

## IME Exclusion

The qualifying event check sits inside the `if (!inputEvent.isComposing)` block of the `input`
handler. IME composition fires `input` events with `isComposing=true`; those skip the block
entirely. `compositionend` calls `commitToCm6()` directly, which cancels any pending timer (see
below), so IME input is always committed immediately without timer involvement.

Note: Chrome fires an `input` event with `isComposing=false` and `inputType='insertText'`
immediately after `compositionend`. This triggers `scheduleCommit()`, starting a 500 ms timer. The
timer fires and calls `commitToCm6()`, which exits early because content already matches CM6 (the
preceding `compositionend` committed it). There is no functional impact.

## Timer Cancellation in `commitToCm6()`

`commitToCm6()` cancels the pending timer at its very start (before the null check on `editorEl`).
This single location covers all immediate commit points — navigation keys, Enter, click, paste, cut,
IME confirmation, notation completion, view close — without requiring each call site to know about
the timer.

```
commitToCm6():
  cancel timer           // preempt any pending debounced commit
  if editorEl null → return
  if cm6 null → return
  diff content vs cm6Content
  if no diff → return
  cm6.replaceRange(...)
  lastCommittedContent = content
  cm6.setCursor(...)
  afterCommit()
```

## Updated Commit Points Table

This table supersedes the equivalent table in `20260415_proxy_editor_model.md`.

| Operation | When committed |
|-----------|---------------|
| Plain typing (`insertText`) | 500 ms after last qualifying input (debounced) |
| Deletion (`deleteContent*`) | 500 ms after last qualifying input (debounced) |
| Enter (`insertParagraph`) | Immediately after `input` event |
| IME confirmation | Immediately after `compositionend` |
| Paste | Immediately after `paste` event |
| Cut | Immediately after `cut` event |
| Live notation conversion | When annotation handler returns `true` in `input` |
| Annotation collapse | When `collapseEditing()` returns `true` in `selectionchange` |
| Navigation keys | On `keydown`, **only if `commitTimer !== null`** (uncommitted changes exist) |
| mousedown | On click (ends a burst) |
| TCY navigation | After `handleTcyNavigation()` succeeds in `keydown`, **only if `commitTimer !== null`** |
| tcy/bouten command | Inside `applyAnnotation()` |
| Undo/Redo | At the start of `doUndoRedo()` (flushes before delegating to CM6) |
| Close view | At the start of `onClose()` |

## Implementation

`scheduleCommit()` and the `commitTimer` field live in `VerticalWritingView` (`src/view.ts`).
No new class or abstraction was introduced; the debounce logic is four lines in `scheduleCommit()`
plus the two-line cancel block at the top of `commitToCm6()`.

```typescript
private commitTimer: ReturnType<typeof setTimeout> | null = null;
private static readonly COMMIT_DEBOUNCE_MS = 500;

private scheduleCommit(): void {
    if (this.commitTimer !== null) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
        this.commitTimer = null;
        this.commitToCm6();
    }, VerticalWritingView.COMMIT_DEBOUNCE_MS);
}
```

## Debounce Interval Choice

500 ms matches the default `newGroupDelay` of the CodeMirror 6 history extension (the interval
after which CM6 itself starts a new history group for its own transactions). Obsidian's MarkdownView
most likely uses the CM6 default. The value is a named constant and can be adjusted if the debounce
feels too coarse or too fine in practice.

## Why Debounce Rather Than Fixed Interval

A fixed interval would commit mid-word during continuous typing, creating arbitrary Undo boundaries
(e.g. Undo could remove half a word). Debounce commits at natural pauses in typing, which aligns
with cognitive editing units. Obsidian's own MarkdownView uses a debounce approach via CM6's
`newGroupDelay`.
