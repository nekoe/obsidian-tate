# ESC: Collapse Selection to Focus and Scroll Into View

Created: 2026-06-01

## Goal

Pressing ESC while a range is selected should:

1. Clear the range selection, collapsing the caret to the **focus node** (the moving end
   of the selection, not the anchor).
2. Scroll the focus position into view, using the **same scroll policy as Undo/Redo**:
   - Focus inside the DOM window → `nearest` (minimal scroll).
   - Focus outside the DOM window → `center`.

When nothing is selected, ESC does nothing extra — it keeps only its existing role of
blocking Obsidian's leaf switch (see [ESC Key Handling via Obsidian Scope API](20260424_esc_key_scope.md)).

## Why reuse the Undo/Redo scroll mechanism

`doUndoRedo` (`view.ts`) already implements exactly the requested policy:

```typescript
const block = editorEl.cursorJumped ? 'center' : 'nearest';
editorEl.scrollCursorIntoView(block, block);
```

`EditorElement.setViewCursorOffset()` → `setVisibleOffset()` teleports the DOM window
via `jumpWindowTo()` and sets `_cursorJumped = true` whenever the target offset lands in
an off-window paragraph. So if ESC computes the **absolute view offset** of the focus and
feeds it to `setViewCursorOffset()`, the off-window-vs-in-window decision and the
center-vs-nearest scroll fall out of the existing machinery for free — identical behavior
to Undo/Redo by construction, no duplicated window-membership logic.

## Two selection systems

- **VirtualSelection** (`ParagraphVirtualizer`): Cmd-A, or Shift+Arrow selections that
  span paragraphs outside the DOM window. Holds `focusParaIdx` / `focusViewOff`; the focus
  may be off-window.
- **Native DOM selection**: drag / Shift+Arrow within the window (plus anchor islands).
  Selections that cross an anchor island are promoted to a VirtualSelection by the
  `selectionchange` handler (`tryInitVsFromDomSelection`), so a *pure* native selection's
  focus is effectively always in-window.

### Handling

```
focusOffset = virtualizer.getVirtualSelectionFocusOffset()  // null when no VS
if focusOffset !== null:                 // VirtualSelection
    clearVirtualSelection()
    setViewCursorOffset(focusOffset)     // teleports + sets cursorJumped when off-window
    scrollCursorIntoView(cursorJumped ? 'center' : 'nearest')
elif native selection is non-collapsed:  // focus is in-window
    sel.collapse(focusNode, focusOffset)
    scrollCursorIntoView('nearest')
else:
    do nothing
```

`getVirtualSelectionFocusOffset()` converts the VS focus endpoint to an absolute view
offset = sum of preceding paragraph `viewLen`s + `focusViewOff`. It is a pure read over
`paragraphRecords` + `virtualSelection`, unit-tested in `ParagraphVirtualizer.test.ts`.

The native path uses a hardcoded `'nearest'` because, per the island-promotion rule above,
its focus is always in-window — there is no off-window case to center on.

## Inline expansion interaction

ESC does **not** explicitly close an inline-expanded annotation (ruby/tcy/bouten). The
expansion lifecycle is purely cursor-position driven (enter → expand, leave → collapse).
After ESC collapses the selection to the focus node, the normal rule applies to wherever
the caret lands: focus inside the expanded element → stays expanded; focus outside → the
existing collapse-back logic closes it. No special-casing is needed.

## IME

The IME-cancel pass-through is preserved: when `evt.isComposing` is true the ESC handler
returns early (before any collapse/scroll) so the IME candidate window can be dismissed
normally.
