# Input Transformer: Space Conversion, Auto-Indent, and Bracket De-indent

Created: 2026-04-17

## Overview

`InputTransformer` (`src/ui/InputTransformer.ts`) intercepts `beforeinput` events to apply four
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

All four features are independently togglable. They are applied in a single `beforeinput` handler
(`inputType === 'insertText'`, non-composing only).

### 1. Half-width Space → Full-width Space (`convertHalfWidthSpace`)

When the typed character is a half-width space (`' '`, U+0020), it is replaced with a full-width
space (`'　'`, U+3000) via `e.preventDefault()` + Range API insertion.

Applies at any cursor position. Paste events are excluded (they do not fire `beforeinput`).

### 2. Auto-indent at Line Start (`autoIndentOnInput`)

Triggered when the cursor is at line start and the typed character is not itself a full-width space.
Always inserts exactly **1** full-width space before the typed character.

### 3. Align Indent to Preceding Paragraph (`matchPrecedingIndent`)

Also triggered at line start (independently of `autoIndentOnInput`). Inserts N full-width spaces,
where N is the leading full-width space count of the preceding paragraph `<div>`. If there is no
preceding paragraph, defaults to 1.

**Priority when both are ON:** `matchPrecedingIndent` takes precedence (inserts N spaces instead of 1).

**Indent count determination at line start:**

| `matchPrecedingIndent` | `autoIndentOnInput` | indent inserted |
|---|---|---|
| true | any | N (from preceding paragraph; 1 if no preceding paragraph) |
| false | true | 1 |
| false | false | 0 |

### 4. Bracket De-indent (`removeBracketIndent`)

Opening brackets at line start should not be indented in Japanese typography. This rule removes one
leading full-width space when a full-width opening bracket is typed after leading full-width spaces.

**Full-width opening brackets covered:**
`「` `『` `【` `〔` `（` `｛` `〈` `《` `〖` `〘` `〚`

Two cases are handled:

**Case A — cursor at line start, at least one indent space would be inserted:**  
Rules 2/3 would normally insert N spaces. Instead, `max(0, N − 1)` spaces are prepended.
When N = 0 or N = 1, the bracket is inserted with no leading spaces.

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
consecutive U+3000 characters at the start of its first text node. Returns 1 if there is no
preceding paragraph (first paragraph default).

## Settings and Initialization

`InputTransformer` is initialized with `DEFAULT_SETTINGS` in the `EditorElement` constructor.
`EditorElement.applySettings()` calls `inputTransformer.updateSettings(settings)` to keep it in
sync. The transformer stores a shallow copy of the settings object.
