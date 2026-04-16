# Aozora Notation: Parsing, Serialization, and Inline Expansion

Created: 2026-04-15

## Aozora Notation Parsing and Serialization

`AozoraParser.ts` handles bidirectional conversion between Aozora notation and DOM elements.

### Parse Pipeline (`parseToHtml()` / `parseInlineToHtml()` → DOM)

Two-layer structure with `parseToHtml()` and `parseInlineToHtml()`:
- `parseToHtml(text)`: Used by `setValue()`. Splits text by `\n` and wraps each paragraph in a `<div>` (for indentation). Returns `''` for empty input to enable the `:empty::before` placeholder.
- `parseInlineToHtml(text)`: Used by `collapseEditing()`. Converts inline notation only, without wrapping in `<div>`.

`applyParsers()` processes `ParseSegment[]` (a union type of `text` / `html`) in priority order:

1. Explicit ruby `｜base《rt》` (also accepts half-width `|`) → `<ruby data-ruby-explicit="true">`
2. Explicit tcy `X［＃「X」は縦中横］` → `<span data-tcy="explicit" class="tcy">`
3. Bouten `X［＃「X」に傍点］` → `<span data-bouten="sesame" class="bouten">`
4. Implicit ruby `kanji《rt》` (auto-detects preceding kanji run) → `<ruby data-ruby-explicit="false">`

Tcy and bouten share the same "forward-reference annotation" structure and are unified in `splitByAnnotation()`.

### Serialization (`serializeNode()` → file text)

- `<ruby data-ruby-explicit="true">` → `｜base《rt》` (full-width `｜` U+FF5C)
- `<ruby data-ruby-explicit="false">` → `base《rt》`
- `<span data-tcy="explicit">` → `X［＃「X」は縦中横］`
- `<span data-bouten="sesame">` → `X［＃「X」に傍点］`
- `<span class="tate-editing">` → returns child node text as-is (raw text while inline-expanded)

**Important**: `getValue()` returns the same Aozora raw text regardless of whether a tate-editing span is expanded or collapsed.

**`｜` visibility control**: Serialization always uses full-width `｜`; it is invisible when collapsed inside a `<ruby>` element and only becomes visible as raw text during inline expansion.

### Live Conversion

On `》` / `］` input, `handleRubyCompletion()` / `handleTcyCompletion()` / `handleBoutenCompletion()` convert the notation into elements. Both `input` (with `isComposing=false`) and `compositionend` are handled for IME support. All operations use `insertAnnotationElement()` for direct DOM manipulation (no `execCommand`). `handleTcyCompletion` and `handleBoutenCompletion` are unified in `handleAnnotationCompletion()`. These methods return `boolean` (whether conversion occurred); `view.ts` calls `commitToCm6()` when `true`. Live conversion is suppressed when inline-expanded (`expandedEl` is non-null) or during DOM manipulation (`isModifyingDom` is true) to prevent reentrancy.

## Inline Expansion (Obsidian Markdown Editor Style)

A `selectionchange` event on `document` is registered via `registerDomEvent(document, 'selectionchange', ...)` to expand/collapse ruby/tcy/bouten elements in-place based on cursor position.

### Expansion

When the cursor enters a `<ruby>`, `<span data-tcy="explicit">`, or `<span data-bouten>` element, `expandForEditing()` replaces it with `<span class="tate-editing">` and displays the Aozora raw text. The original text is saved in `expandedElOriginalText` for change detection. `inBurst = false` is also reset.

### Collapse

When the cursor leaves, `collapseEditing()` re-parses with `parseInlineToHtml()` and restores the original element, incorporating any edits. (`parseToHtml()` is prohibited here as it would nest `<div>` inside a paragraph `<div>`.) Collapse always uses direct DOM manipulation (no `execCommand`). `collapseEditing()` returns `boolean` (whether content changed). The `selectionchange` handler in `view.ts` calls `commitToCm6()` when `true`.

### Forward Text Absorption in `collapseEditing()`

`getExtraCharsFromAnnotation()` compares the annotation bracket content against the leading text inside the span. If the bracket content is longer (e.g., content=`130`, leading=`30` → diff=1 char), matching characters are absorbed from the end of the preceding text node (e.g., text `A1` + tcy `30` → edit to `130` → text `A` + tcy `130`).

### Detached Node Guard in `collapseEditing()`

At the start of `collapseEditing()`, `expandedEl.isConnected` is checked. If `false`, `expandedEl` / `expandedElOriginalText` are cleared and the method returns immediately. Calling `parentNode` / `selectNode` on a detached node would throw an exception.

### Orphan Span Detection and Re-tracking

At the start of the `!isModifyingDom` block in `handleSelectionChange()`, if `expandedEl` is null or detached, `this.el.querySelector('span.tate-editing')` is run to sync with the actual DOM state. This is a robustness measure for cases where an editing span remains in the DOM via an unexpected path. After re-tracking, `expandedElOriginalText = null` and `hasChanged = true` are set to ensure collapse.

### Cursor Position

`rawOffsetForExpand()` converts the cursor position inside ruby (base/rt separately), tcy, and bouten elements to an offset in the raw text. For tcy/bouten, the content is at the start, so it simply `return offset`.

### Reentrancy Prevention

The `isModifyingDom` flag blocks `selectionchange` reentrancy during DOM manipulation.

### Conflict Prevention with `setValue()`

`this.expandedEl = null` / `this.expandedElOriginalText = null` / `this.savedRange = null` must be executed **before** the `getValue() === content` early return (to prevent stale detached node references).

### `savedRange` Cleanup After `collapseEditing()`

`collapseEditing()` reconstructs the DOM, so `this.savedRange = null` must be executed immediately after to discard stale node references.

### Multiple View Guard

At the start of `handleSelectionChange()`, if `expandedEl` is null and the cursor is outside the editor, return immediately.

## Applying Notation from the Command Palette

The `add-ruby` / `add-tcy` / `add-bouten` commands apply notation to the selected text.

### Selection Range Cache

At the start of `handleSelectionChange()` (before the `isModifyingDom` check), if there is a non-collapsed selection inside the editor, it is saved to the `savedRange` field. Opening the command palette moves focus away, but `selectionchange` events outside the editor do **not** update the cache (it is retained), allowing the selection to be restored when the command executes.

### Ruby

`wrapSelectionWithRuby()` inserts `<span class="tate-editing">｜text《》</span>` via direct DOM manipulation. `expandedEl` and `expandedElOriginalText` are set directly to enter inline-expanded state. When the user types the ruby text and moves the cursor away, `collapseEditing()` collapses to a `<ruby>` element, and the `selectionchange` handler in `view.ts` calls `commitToCm6()`.

### Tcy and Bouten

Unified in `wrapSelectionWith()`. `insertAnnotationElement()` replaces the selected text with an element via direct DOM manipulation. `setCursorAfter()` places the cursor **just after** the element. If the cursor were inside the element, `selectionchange → expandForEditing()` would fire and cause unintended expansion.

### Cursor Placement After Live Conversion

Similarly in `handleRubyCompletion()` / `handleAnnotationCompletion()`, `insertAnnotationElement()` + `setCursorAfter()` places the cursor just after the element. Without this, the immediate `selectionchange` would fire `expandForEditing()` and leave the notation in expanded state.

### Error Notification and CM6 Sync

- No selection or view not open: notified via `new Notice(...)`. When `editorEl` is null, `applyAnnotation()` returns early (prevents spurious messages).
- After a successful wrap, `applyAnnotation()` in `view.ts` calls `commitToCm6()` (tcy/bouten only; ruby is committed via `selectionchange` on `collapseEditing`).
