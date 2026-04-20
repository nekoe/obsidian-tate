# Inline Editing: Cursor Anchor, TCY Navigation, and Bouten Post-Collapse Input

Date: 2026-04-19
Branch: experiment-2

## Overview

This document describes the design decisions and implementation details for three
related features added in the `experiment-2` branch:

1. **Cursor anchor span** (`tate-cursor-anchor`) — a DOM-only invisible span that
   provides a stable cursor position after ruby/tcy/bouten inline-editing spans
2. **TCY arrow key navigation** — ArrowUp/ArrowDown remapping inside tcy spans
3. **Bouten post-collapse input** — preventing typed characters from landing inside
   a bouten span immediately after it collapses

---

## 1. Per-Element Inline Expansion Toggles

Each of ruby, tcy, and bouten can be independently enabled or disabled for inline
expansion via settings (`expandRubyInline`, `expandTcyInline`, `expandBoutenInline`).
All three default to `true`. The flags are stored in `TatePluginSettings` and
forwarded to `InlineEditor.setExpandSettings()` via `EditorElement.applySettings()`.

`findExpandableAncestor()` gates each element type behind its flag:

```typescript
if (el.tagName === 'RUBY' && this.expandRuby) return el;
if (el.tagName === 'SPAN' && el.getAttribute('data-tcy') === 'explicit' && this.expandTcy) return el;
if (el.tagName === 'SPAN' && el.getAttribute('data-bouten') && this.expandBouten) return el;
```

---

## 2. Cursor Anchor Span (`tate-cursor-anchor`)

### Problem

After a ruby/tcy/bouten inline-editing span collapses (user exits past the closing
bracket `》` or `］`), the cursor must land somewhere outside the element. Two
failure modes exist:

- **End-of-line (no next text node):** `setStartAfter(element)` or
  `setStartBefore(next <br>)` creates an element-level cursor position. Chrome
  normalizes this into the nearest text node, which is often inside `<rt>` (for
  ruby) or back into the annotation span.
- **Bouten specifically:** `sel.addRange()` at any position adjacent to a bouten
  span is synchronously normalized by Chrome back into the bouten span. This
  triggers re-expansion on the next selectionchange.

### Solution: cursor anchor span

A `<span class="tate-cursor-anchor">` containing U+200B (zero-width space) is
inserted after the element at end-of-line. This gives Chrome a real text node to
land in, preventing normalization into `<rt>` or back into annotation spans.

**Anchor placement:** `ensureCursorAnchorAfter(el)` is called in
`handleSelectionChange` just before `expandForEditing()`. This ensures the anchor
is the `nextSibling` of the `tate-editing` span during editing, so it survives
collapse as `nextSibling` of the restored annotation element.

**Serialization:** `serializeNode()` in `AozoraParser.ts` handles the anchor span
by stripping U+200B from its text content:

```typescript
if (node.classList.contains('tate-cursor-anchor')) {
    return (node.textContent ?? '').replace(/\u200B/g, '');
}
```

This makes the anchor transparent to the Aozora source. Real characters typed into
the anchor span are preserved; only the U+200B placeholder is dropped.

**U+200B lifecycle (`handleCursorAnchorInput`):** Called after every `input` and
`compositionend` event. If the user typed real characters into the anchor, U+200B
is stripped; if the anchor was emptied (e.g. by deletion), U+200B is restored.
This keeps the anchor's text content well-defined at all times.

**Anchor skip (`pendingAnchorSkip`):** When the cursor lands inside an anchor that
still contains only U+200B and the user pressed ArrowUp/ArrowDown, the cursor
should transparently skip through to the adjacent real text. `notifyNavigationKey()`
records the direction; `handleSelectionChange` fires the skip on the next
selectionchange. The skip is suppressed if the anchor is at end-of-line (no
subsequent content), so the cursor rests there until the user presses again.

**Visible offset accounting:** `EditorElement.getVisibleOffset()` and
`setVisibleOffset()` strip U+200B when counting characters inside anchor spans, so
cursor position mapping (view ↔ src) is not affected by the placeholder.

---

## 3. TCY Arrow Key Navigation

### Problem

A `text-combine-upright: all` span is laid out horizontally within vertical text.
ArrowUp/ArrowDown move the cursor between vertical lines, but inside a tcy span
they would jump to an adjacent line instead of moving within the horizontal text.

### Solution

`handleTcyNavigation(key)` intercepts ArrowUp (→ move left) and ArrowDown
(→ move right) when the cursor is inside a tcy span. It adjusts the cursor offset
within the span's text node by ±1, or moves outside the span if already at the
boundary. Returns `true` if the key was consumed; `view.ts` calls `preventDefault`
in that case.

---

## 4. Bouten Post-Collapse Input

### Problem

After a bouten span collapses (user exits past `］`), the cursor is placed in the
adjacent anchor span or text node. Chrome's Selection API **synchronously**
normalizes `sel.addRange()` back into the bouten span before any subsequent event
handler (including `beforeinput`) can observe it. The result: characters typed
immediately after collapse land inside the bouten span with sesame emphasis applied.

Two sub-cases:

- **1-b (end-of-line):** bouten is followed by anchor span; Chrome normalizes cursor
  from anchor back into bouten.
- **2-b (mid-line):** bouten is followed by a text node; Chrome normalizes cursor
  from the text node start back into bouten.

### Why `sel.addRange`-based redirects do not work

Chrome's normalization is part of the layout engine, applied synchronously during
`sel.addRange()`. Any `sel.addRange` call that positions the cursor adjacent to a
bouten span is immediately overridden. This was verified by attempting to redirect
in `beforeinput` and `compositionstart` — neither had any effect.

### Solution

Two separate paths are used depending on whether input is IME or non-IME.

#### Non-IME: `e.preventDefault()` + Range-level insertion

In `EditorElement.onBeforeInput`, when `inputType === 'insertText'`:

1. `getCursorBoutenSpan()` checks whether `boutenJustCollapsed` is set and the
   cursor is at one of three positions relative to that span:
   - Inside the bouten span itself (Chrome normalization)
   - Inside the adjacent anchor span (end-of-line redirect landed here)
   - At the start of the adjacent text node (mid-line redirect landed here)
   Non-collapsed selections are excluded.
2. If a bouten span is returned, `e.preventDefault()` cancels the browser's default
   insertion. Space conversion is applied manually via
   `InputTransformer.applySpaceConversion()`.
3. `insertAfterBouten(bouten, char)` inserts the character using DOM Range APIs
   (not the Selection API), bypassing Chrome's normalization entirely:
   - End-of-line: creates a new text node between bouten and anchor span.
   - Mid-line: prepends to the existing text node via `insertData(0, char)`.
4. `boutenJustCollapsed` is cleared inside `insertAfterBouten` after the first
   successful insertion, so subsequent characters are handled by normal input logic.

#### IME: post-compositionend fixup (`handleBoutenPostCollapseInput`)

During IME composition, the composition text inevitably appears inside the bouten
span (Chrome normalization cannot be prevented for composition). After
`compositionend`:

1. `handleBoutenPostCollapseInput()` checks `boutenJustCollapsed`. If the span's
   current text has grown beyond `boutenJustCollapsedText` (the text at collapse
   time), the extra suffix is extracted.
2. The bouten span is restored to its original text.
3. The extracted characters are inserted after the span via `insertAfterBouten`.

This method is called in the `compositionend` handler **before** `commitToCm6()`,
so `boutenJustCollapsed` is still set (it would be cleared by `resetBurst` inside
`commitToCm6`).

#### `boutenJustCollapsed` guard

`boutenJustCollapsed` is set in two places:
- `placeCursorAfterCollapse()` — after a bouten span collapses (via the `atSpanEnd` branch of `handleSelectionChange`)
- `wrapSelectionWith()` — after wrapping selected text with a bouten span via the command palette (see section 5)

It is cleared by:

- `insertAfterBouten()` — after first non-IME character inserted
- `handleBoutenPostCollapseInput()` — after IME fixup
- `afterNavigation()` — on mouse click or navigation key (see section 5 for why `afterCommit()` must NOT clear it)
- `notifyNavigationKey()` — on any arrow/navigation key
- `reset()` — on `setValue` / `applyFromCm6`
- Entry into a different expandable element (selectionchange clears it)

When `boutenJustCollapsed` is set and a selectionchange puts the cursor inside that
same bouten span, `handleSelectionChange` calls `redirectCursorOutOfCollapsedBouten`
instead of expanding, preventing re-expansion on Chrome's normalization event.

### Interesting finding: anchor + following span

When the DOM is structured as:

```html
<div>
    <span class="bouten" data-bouten="sesame">あ</span>
    <span class="tate-cursor-anchor">​</span>
    <span>か</span>
</div>
```

(i.e. a non-anchor `<span>` follows the anchor), the browser does NOT normalize
the cursor from the anchor span back into bouten. Typing after collapse inserts
the character into the anchor span, which then serializes correctly without bouten
styling. This behavior differs from the end-of-line case (anchor is last in div)
where Chrome does normalize back into bouten.

The root cause is likely that Chrome treats a cursor at the end of a span as
equivalent to the start of the next element when the next element is a block-level
container or line boundary, but not when a sibling inline element follows. This
difference is what makes end-of-line (1-b) require the `insertAfterBouten`
intervention while the above variant self-corrects.

---

## 5. Bouten Wrap Command: Cursor Placement and Guard

### Problem

`wrapSelectionWithBouten()` (via the command palette) inserts a bouten span into the
DOM and then places the cursor. The original implementation called `setCursorAfter(inserted)`,
which produced an element-level cursor position that Chrome synchronously normalized
into the bouten span — just like the post-collapse case. However, `boutenJustCollapsed`
was not set (no collapse had occurred), so `handleSelectionChange` found the cursor
inside bouten and fired `expandForEditing`. Characters typed immediately after the
wrap command landed inside the expanded editing span.

### Fix: reuse `placeCursorAfterCollapse`

`wrapSelectionWith` now follows the same cursor-placement logic used after collapse:

1. `anchorManager.ensureCursorAnchorAfter(inserted)` — inserts anchor at end-of-line
   (same as before expansion; prevents Chrome normalization into annotation span).
2. `nextSib = inserted.nextSibling` — now points to the anchor if at end-of-line.
3. `placeCursorAfterCollapse(nextSib, parentEl, sel)` — places cursor in anchor text
   AND, for bouten, calls `boutenGuard.set(inserted, ...)` via the
   `nextSib.previousSibling` check already present in `InlineEditor.placeCursorAfterCollapse`.

This reuses the identical proven logic for both the collapse case and the wrap-command
case. TCY wraps also benefit: an anchor is inserted so Chrome cannot normalize the
cursor into the tcy span.

### `afterCommit()` vs `afterNavigation()`

A second root cause was that `commitToCm6()` called `resetBurst()`, which cleared
`boutenGuard`. After `applyBouten()` set the guard and immediately called
`commitToCm6()`, the guard was destroyed before any input event could use it.

The fix splits the method into two:

| Method | Clears `inBurst` | Clears `boutenGuard` | Called from |
|---|---|---|---|
| `afterCommit()` | yes | **no** | `commitToCm6()` |
| `afterNavigation()` | yes | yes | mousedown, navigation keydown |

The guard must survive until the user takes an intentional navigation action (click or
arrow key). It is safe to leave it set after a commit because `getCursorBoutenSpan()`
only returns the span when the cursor is at the immediate next sibling of that specific
bouten span — any cursor that has moved to a different position returns `null`.

---

## 6. Known limitation: IME composition visual

During IME composition (while candidates are being selected), the composition text
temporarily appears inside the bouten span and therefore displays with sesame
emphasis. The text is moved outside on `compositionend`, so the final committed
text has no bouten. This transient visual artifact is accepted as a limitation;
eliminating it would require intercepting the composition at a lower level than
the Web Input Method API exposes.

---

## 7. Event Flow Summary

```
keydown
  → notifyNavigationKey (records pendingAnchorSkip direction, clears boutenJustCollapsed)
  → handleTcyNavigation (ArrowUp/ArrowDown inside tcy)
  → commitToCm6 + afterNavigation (navigation keys)

beforeinput
  → InlineEditor.onBeforeInput (sets inBurst)
  → [non-IME insertText] getCursorBoutenSpan → e.preventDefault + insertAfterBouten
  → InputTransformer.handleBeforeInput (space conversion, auto-indent, bracket de-indent)

input (non-composing)
  → handleRubyCompletion / handleTcyCompletion / handleBoutenCompletion
  → handleCursorAnchorInput

compositionstart
  → InputTransformer.handleCompositionStart (auto-indent at line start)

compositionend
  → handleRubyCompletion / handleTcyCompletion / handleBoutenCompletion
  → InputTransformer.handleCompositionEnd (bracket de-indent)
  → handleCursorAnchorInput
  → handleBoutenPostCollapseInput   ← before commitToCm6, while boutenJustCollapsed is still set
  → commitToCm6

selectionchange
  → handleSelectionChange
      atSpanEnd:   collapseEditing → place cursor → set boutenJustCollapsed
      cursor in boutenJustCollapsed: redirectCursorOutOfCollapsedBouten (no expansion)
      cursor in anchor: pendingAnchorSkip logic
      cursor in expandable: ensureCursorAnchorAfter → expandForEditing
  → commitToCm6 (if contentChanged)
```
