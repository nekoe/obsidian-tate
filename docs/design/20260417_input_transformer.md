# Input Transformer: Space Conversion, Auto-Indent, and Bracket De-indent

Created: 2026-04-17

## Overview

`InputTransformer` (`src/ui/InputTransformer.ts`) intercepts `beforeinput` and `input` events to apply four
character-level transformations during typing. All transformations write full-width space characters
(U+3000) directly into the file via the Selection/Range API, replacing the previous CSS-only approach
(`text-indent: 1em` on `.tate-auto-indent`).

The class is instantiated by `EditorElement` (alongside `InlineEditor`) and follows the same facade
pattern: `EditorElement.onBeforeInput(e)` delegates to both `InlineEditor.onBeforeInput()` and
`InputTransformer.handleBeforeInput(e)`.

## Why DOM Insertion Instead of CSS

The CSS `text-indent` approach produced visual-only indentation that was not saved to the file.
Full-width spaces are the conventional Japanese typography representation of paragraph indent and
must be present in the source text for correct round-trip behavior (copy/paste, export, editing in
other editors).

## Transformation Rules

All four features are independently togglable. Each fires on a distinct event.

### 1. Half-width Space → Full-width Space (`convertHalfWidthSpace`)

When the typed character is a half-width space (`' '`, U+0020), it is replaced with a full-width
space (`'　'`, U+3000) via `e.preventDefault()` + Range API insertion.

**Event**: `beforeinput` (`inputType === 'insertText'`, non-composing only).

Applies at any cursor position. Paste events are excluded (they do not fire `beforeinput`).

### 2. Auto-indent at Line Start (`autoIndentOnInput`)

Triggered when the cursor is at line start and the typed character is not itself a full-width space.
Always inserts exactly **1** full-width space before the typed character.

**Events**:
- `beforeinput` (`inputType === 'insertText'`, non-composing) — direct keyboard input
- `compositionstart` — IME input: indent space is inserted before composition begins so
  Japanese characters land after the indent

### 3. Align Indent to Preceding Paragraph (`matchPrecedingIndent`)

Triggered when Enter is pressed to create a new paragraph. Inserts N full-width spaces at the
start of the new paragraph, where N is the leading full-width space count of the preceding
paragraph `<div>`. If there is no preceding paragraph, inserts 0 spaces.

**Event**: `input` (`inputType === 'insertParagraph'`), handled in `view.ts` via
`editorEl.handleParagraphInsert()` → `InputTransformer.handleParagraphInsert()`.

**Independence from `autoIndentOnInput`**: The two settings are fully orthogonal.
`autoIndentOnInput` fires on character typing at line start; `matchPrecedingIndent` fires on Enter.
Both can be ON simultaneously without conflict.

### 4. Bracket De-indent (`removeBracketIndent`)

Opening brackets at line start should not be indented in Japanese typography. This rule removes one
leading full-width space when a full-width opening bracket is typed after leading full-width spaces.

**Full-width opening brackets covered:**
`「` `『` `【` `〔` `（` `｛` `〈` `《` `〖` `〘` `〚`

**Events**: `beforeinput` (direct input) and `compositionend` (IME-confirmed bracket).

Two cases are handled:

**Case A — cursor at line start, `autoIndentOnInput` would insert 1 space:**
Instead of 1 space, `max(0, 1 − 1) = 0` spaces are prepended (bracket inserted with no leading space).

**Case B — cursor after only full-width spaces (`leadingSpacesBeforeCursor ≥ 1`):**
The first full-width space of the paragraph is deleted via `Text.deleteData(0, 1)`, then the bracket
is inserted at the (now-adjusted) cursor position.

Case B covers the situation where the user typed or pasted spaces manually before typing the bracket.

## Line-Start Detection

`getTextBeforeCursorInParagraph(range)` creates a `Range` from the start of the containing paragraph
`<div>` to the cursor and calls `Range.toString()`. An empty string means line start.

The "containing paragraph div" is the direct `<div>` child of `.tate-editor` that contains the
cursor node, found by walking `parentNode` up from `range.startContainer`. If no `<div>` is found
(empty editor with only a `<br>`), an empty string is returned (treated as line start).

## Preceding Paragraph Leading Spaces

`getPrecedingParagraphLeadingSpaces(range)` walks to `currentDiv.previousElementSibling` and counts
consecutive U+3000 characters at the start of its first text node. Returns 0 if there is no
preceding paragraph (nothing to match).

## `insertText` Implementation: `insertData` vs `insertNode`

`insertText(range, text)` uses two different DOM paths depending on where the cursor is:

- **Cursor inside a text node**: `Text.insertData(offset, text)` — modifies the node in-place.
- **Cursor inside an element node** (e.g. `<div>` or `<br>`): `Range.insertNode(textNode)` — creates a new text node and inserts it.

The reason `insertData` is preferred for text nodes: `Range.insertNode` on a text node at offset 0
splits the node per the DOM spec — it creates an empty `''` text node on the left and the original
content on the right. This empty node became the first node returned by `TreeWalker`, causing
`removeOneLeadingFullWidthSpace` to exit early (`data[0] !== '\u3000'`) and
`getPrecedingParagraphLeadingSpaces` to return 0. Both failures persisted until the view was
reopened, because `onExternalModify` in `SyncCoordinator` compares serialized content (which ignores
empty text nodes) and therefore never rebuilt the DOM.

`insertData` does not split; it modifies the text node string directly, so no empty nodes are
created.

Additionally, `removeOneLeadingFullWidthSpace` and `getPrecedingParagraphLeadingSpaces` both skip
empty text nodes in their `TreeWalker` loops as a defensive measure against empty nodes arising from
other sources (e.g. browser internals).

## Settings and Initialization

`InputTransformer` is initialized with `DEFAULT_SETTINGS` in the `EditorElement` constructor.
`EditorElement.applySettings()` calls `inputTransformer.updateSettings(settings)` to keep it in
sync. The transformer stores a shallow copy of the settings object.
