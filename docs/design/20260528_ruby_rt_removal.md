# Ruby `<rt>` Removal and CollapseGuard Unification

Date: 2026-05-28
Branch: feat/ruby-without-rt

## Overview

This document describes three related changes made to fix a cursor-trap bug that
surfaced in Obsidian running on macOS 26.5 (Chromium-based renderer):

1. **`<rt>` elimination** — replace `<ruby><rt>…</rt></ruby>` with
   `<ruby data-rt="…">base</ruby>` + CSS `::after` to prevent the cursor from
   being trapped inside ruby annotations.
2. **Post-collapse guard for ruby/heading** — after eliminating `<rt>`, a secondary
   bug emerged: cursor placement after ruby/heading collapse triggered re-expansion
   and characters typed immediately after went inside the element. Solved by adding
   a `postCollapseEl` guard modelled on the existing `BoutenGuard`.
3. **`CollapseGuard` unification** — `BoutenGuard` and `postCollapseEl` had
   identical structure and no element-specific logic. Both were merged into a single
   `CollapseGuard` class.

---

## 1. The Cursor-Trap Bug

### Symptom

After the cursor enters a ruby-annotated character in the contenteditable editor,
pressing arrow keys leaves the cursor stuck — it cannot exit the ruby element.
Observed on macOS 26.5 with Obsidian (Chromium renderer), in particular when
navigating vertically through ruby annotations.

The bug was introduced by the upgrade to Obsidian running on macOS 26.5, which
uses a newer Chromium build than previous versions.

### Root Cause

The pre-fix DOM structure was:

```html
<ruby data-ruby-explicit="true">
  春         <!-- Text node: base character -->
  <rt>しゅん</rt>  <!-- <rt> element: annotation text -->
</ruby>
```

`<rt>` is a standard HTML element. In a `contenteditable` div, it participates in
the normal cursor-placement model: Chrome creates a text position inside `<rt>` and
can navigate the cursor into it. When writing-mode is `vertical-rl`, Chrome's
vertical cursor movement maps ArrowUp/ArrowDown to moving along columns. Because
`<rt>` is rendered as a separate inline box (small text above/beside the base), the
cursor enters `<rt>` and then cannot find a valid next position in the expected
direction — it becomes trapped.

The `isInsideRtNode` guard and all `!isInsideRtNode(node)` filtering throughout
`domHelpers`, `CursorAnchorManager`, and `SearchPanel` existed precisely to work
around `<rt>` participation in cursor logic, but they only handled specific code
paths. The core issue — Chrome offering `<rt>` as a cursor destination — was not
fixable by filtering alone.

### Why this changed in macOS 26.5

Earlier Chromium versions placed cursor positions differently around ruby. The
macOS 26.5 upgrade brought a Chromium version that more aggressively places cursor
positions inside all text-containing elements, including `<rt>`, regardless of
`font-size` or visual position.

---

## 2. Solution: Data Attribute + CSS `::after`

### Approach

Remove `<rt>` from the DOM entirely. Store the ruby annotation text in a
`data-rt` attribute on `<ruby>` and render it via CSS pseudo-element:

```html
<!-- New structure -->
<ruby data-ruby-explicit="true" data-rt="しゅん">春</ruby>
```

```css
.tate-editor ruby[data-rt]::after {
    content: attr(data-rt);
    position: absolute;
    /* … */
}
```

A pseudo-element is not a DOM node. It has no text positions and cannot receive the
cursor. The cursor-trap is eliminated structurally — there is no node to trap into.

### CSS Design Decisions

#### `display: inline` vs `display: inline-block`

```css
.tate-editor ruby[data-rt] {
    display: inline;
    position: relative;
}
```

`display: inline-block` was rejected because it creates an isolated line box. In
`writing-mode: vertical-rl`, each inline-block generates its own line-height context.
Adjacent text and the ruby element would not share the column gap reserved by
`line-height: 2` (set on the editor for ruby annotation clearance), resulting in
uneven spacing. `display: inline` keeps `<ruby>` in the normal inline flow so the
gap is shared across all elements on the same column.

`position: relative` is required to establish a containing block for the absolutely
positioned `::after`. Without it, `::after` would be positioned relative to the
nearest positioned ancestor (the paragraph `<div>`), placing the annotation at the
wrong column.

#### Pseudo-element positioning

```css
.tate-editor ruby[data-rt]::after {
    position: absolute;
    top: 50%;
    left: 100%;
    transform: translateY(-50%);
    writing-mode: vertical-rl;
    text-orientation: mixed;
    font-size: 0.5em;
    line-height: 1.2;
    white-space: nowrap;
    user-select: none;
    pointer-events: none;
}
```

- `left: 100%`: in `vertical-rl` layout the "right column" corresponds to `left` in
  CSS coordinates. `left: 100%` places the annotation in the column to the right of
  the base character — the conventional ruby side in vertical Japanese typography.
- `top: 50% + translateY(-50%)`: centers the annotation vertically alongside the
  base glyph.
- `writing-mode` is set explicitly because absolutely-positioned elements do not
  reliably inherit `writing-mode` across all Chromium versions bundled with Obsidian.
- `user-select: none; pointer-events: none`: prevents accidental selection of
  annotation text and ensures click-to-position targets the base character, not the
  annotation.

#### Empty annotation suppression

```css
.tate-editor ruby[data-rt=""]::after {
    display: none;
}
```

When `data-rt` is empty (ruby with no annotation, or during inline editing where the
annotation is removed), the pseudo-element generates a zero-size absolute-positioned
box. Suppressing it avoids a stray layout slot.

---

## 3. Code Changes from `<rt>` Removal

### `domHelpers.ts`

- `createRubyEl`: sets `data-rt` attribute instead of creating `<rt>` element.
- `isInsideRtNode`: **deleted** — no `<rt>` exists in the DOM.
- `findLastBaseTextInElement`: removed `isInsideRtNode` filter (all text nodes are
  now base text).
- `rawOffsetForExpand`: for `RUBY` elements, removed the branch that returned an
  `rt`-relative offset. Since `<rt>` no longer exists as a child node, the cursor
  can never be inside it; only `prefix + offset` is needed.
- `computeDivViewLen`: removed `isInsideRtNode` filter.

### `AozoraParser.ts`

- `splitByExplicitRuby` / `splitByImplicitRuby`: HTML template changed from
  `<ruby …><rt>…</rt></ruby>` to `<ruby … data-rt="…">base</ruby>`.
- `esc()`: added `"` → `&quot;` escaping because the annotation text now appears
  inside an HTML attribute value.
- `serializeNode` (RUBY case): changed `node.querySelector('rt')?.textContent` to
  `node.getAttribute('data-rt')`. Removed `<rt>` filter in child node iteration.

### `CursorAnchorManager.ts`

- Removed `isInsideRtNode` import and all call sites.
- `findPositionAfterAnchor`: simplified — no `<rt>` skip needed.
- `findPositionBeforeAnchor`: simplified similarly.
- End-of-line comment updated: removed mention of `<rt>` normalization.

### `SearchPanel.ts`

- `extractSegmentsFromDiv`: removed `isInsideRtNode` guard; parameter `editorEl`
  removed since it was only passed to `isInsideRtNode`.

---

## 4. Secondary Bug: Re-Expansion After Ruby/Heading Collapse

### Symptom

After eliminating `<rt>`, a new bug appeared: placing the cursor after a ruby or
heading element and typing a character caused the element to inline-expand
unexpectedly. Characters typed immediately after collapse landed inside the element
instead of after it.

### Root Cause

This is the same Chrome normalization issue that `BoutenGuard` was designed to
handle for bouten spans. After `collapseEditing` runs and the cursor is placed after
the restored annotation element:

1. Chrome synchronously normalizes the cursor back inside the element (before any
   event fires).
2. On the next `selectionchange`, `handleSelectionChange` sees the cursor inside an
   expandable element and calls `expandForEditing` — re-expansion.
3. For non-IME input, the `beforeinput` event fires with the cursor already inside
   the re-expanded element, so characters land there.
4. For IME, composition text appears inside the element for the same reason.

Before `<rt>` removal, this bug existed for ruby elements too, but `<rt>` provided
an inadvertent buffer — Chrome would normalize into `<rt>` rather than the base of
the ruby element, and the `isInsideRtNode` guards prevented `expandForEditing` from
firing on `<rt>`-interior positions. After removal, the normalization target changed
to the base text inside `<ruby>`, triggering expansion.

### Solution

Added `postCollapseEl: { el: HTMLElement; originalText: string } | null` to
`InlineEditor`, mirroring `BoutenGuard`'s `boutenJustCollapsed` field.

`placeCursorAfterCollapse` sets the guard for ruby and heading elements (alongside
the existing call to `boutenGuard.set` for bouten):

```typescript
if (prev?.instanceOf(HTMLElement)
        && (prev.tagName === 'RUBY'
            || prev.getAttribute('data-heading') !== null)) {
    this.postCollapseEl = { el: prev, originalText: prev.textContent ?? '' };
}
```

Three handler methods were added to `InlineEditor`, each with the same structure as
the corresponding `BoutenGuard` method:

- `redirectCursorOutOfCollapsed(el, sel)` — called from `handleSelectionChange` when
  cursor re-enters the guarded element.
- `getPostCollapseEl()` / `insertAfterCollapsed(el, chars)` — called from
  `EditorElement.onBeforeInput` for non-IME input.
- `handlePostCollapseInput()` — called from `view.ts` `compositionend` handler.

---

## 5. CollapseGuard Unification

### Observation

After implementing the `postCollapseEl` fix, `BoutenGuard` and the new
`postCollapseEl` guard were reviewed side by side. Key finding:

- `BoutenGuard` was named and described as bouten-specific, but contained **zero**
  bouten-specific logic.
- The `findBoutenAncestor(container, rootEl) === bouten` check in
  `getCursorBoutenSpan` is exactly equivalent to `bouten.contains(container)`, which
  works for any element type.
- `insertAfterBouten`, `handleBoutenPostCollapseInput`, and
  `redirectCursorOutOfCollapsedBouten` have no bouten-specific branches.
- The `postCollapseEl` in `InlineEditor` was independently implementing the same
  pattern with the same structure.

Both guards were merged into `CollapseGuard`.

### `CollapseGuard` API

```typescript
class CollapseGuard {
    set(el: HTMLElement, originalText: string): void
    get(): { el: HTMLElement; originalText: string } | null
    clear(): void
    getCursorCollapseEl(expandFlag: boolean, expandedEl: HTMLSpanElement | null): HTMLElement | null
    insertAfter(el: HTMLElement, chars: string): void
    handlePostCollapseInput(): boolean
    redirectCursorOutOfCollapsed(el: HTMLElement, sel: Selection): void
}
```

No constructor argument (the `rootEl` parameter that `BoutenGuard` accepted was
unused; `el.contains(container)` requires only the guarded element).

### `InlineEditor` changes

- Fields `boutenGuard` (type `BoutenGuard`) and `postCollapseEl` replaced by single
  `collapseGuard: CollapseGuard`.
- `placeCursorAfterCollapse`: unified — all three annotation types (bouten, ruby,
  heading) call `this.collapseGuard.set(prev, prev.textContent ?? '')`.
- `handleSelectionChange`: the two separate guard checks (bouten re-entry and
  postCollapse re-entry) collapsed into one:
  ```typescript
  const bjc = this.collapseGuard.get();
  if (bjc && target === bjc.el) {
      this.collapseGuard.redirectCursorOutOfCollapsed(target, sel);
      return contentChanged;
  }
  this.collapseGuard.clear();
  ```
- `getCursorCollapseEl()` (replaces both `getCursorBoutenSpan` and `getPostCollapseEl`):
  determines the correct `expandFlag` by inspecting the guarded element type:
  ```typescript
  getCursorCollapseEl(): HTMLElement | null {
      const state = this.collapseGuard.get();
      if (!state) return null;
      const expandFlag = state.el.getAttribute('data-bouten') !== null ? this.expandBouten
          : state.el.tagName === 'RUBY' ? this.expandRuby
          : state.el.getAttribute('data-heading') !== null ? this.expandHeading
          : true;
      return this.collapseGuard.getCursorCollapseEl(expandFlag, this.expandedEl);
  }
  ```

### `EditorElement.ts` changes

- `onBeforeInput`: the two-path check (`getCursorBoutenSpan` + `getPostCollapseEl`)
  replaced by a single `getCursorCollapseEl` call.
- `handleBoutenPostCollapseInput` deleted; `handlePostCollapseInput` covers all
  element types.

### `view.ts` changes

- `compositionend` handler: the two calls
  (`handleBoutenPostCollapseInput` + `handlePostCollapseInput`) replaced by a
  single `handlePostCollapseInput`.

### Files deleted

- `src/ui/BoutenGuard.ts`
- `src/ui/BoutenGuard.test.ts`

---

## 6. Updated Event Flow (compositionend path)

```
compositionend
  → handleRubyCompletion / handleTcyCompletion / handleBoutenCompletion
  → InputTransformer.handleCompositionEnd (bracket de-indent)
  → handleCursorAnchorInput
  → editorEl.handlePostCollapseInput()   ← moves IME text out of post-collapse element
  → commitToCm6
```

The call must be before `commitToCm6` because `collapseGuard` is cleared by
`reset()` inside the commit path for navigation events. It is safe to leave the
guard set across commits: `getCursorCollapseEl` only returns the element when the
cursor is at the immediate next sibling of that specific element, so a guard from a
previous paragraph does not interfere with unrelated input.

---

## 7. Known Limitation

During IME composition (while candidates are being selected), the composition text
temporarily appears inside the annotation element — for bouten with sesame marks,
for ruby with no special styling. The text is moved outside on `compositionend`, so
the committed result is correct. This transient visual artifact is accepted as a
limitation; eliminating it would require intercepting composition at a lower level
than the Web Input Method API exposes.

---

## 8. Files Changed

| File | Change |
|---|---|
| `styles.css` | Add ruby `::after` rendering, `position: relative`, empty suppression |
| `src/ui/domHelpers.ts` | `createRubyEl`: use `data-rt`; delete `isInsideRtNode`; simplify traversal helpers |
| `src/ui/AozoraParser.ts` | HTML template → `data-rt`; `esc()` adds `&quot;`; serializer reads `getAttribute('data-rt')` |
| `src/ui/CursorAnchorManager.ts` | Remove `isInsideRtNode` calls; simplify traversal |
| `src/ui/SearchPanel.ts` | Remove `isInsideRtNode` call; drop `editorEl` parameter from `extractSegmentsFromDiv` |
| `src/ui/BoutenGuard.ts` | **Deleted** — replaced by `CollapseGuard.ts` |
| `src/ui/BoutenGuard.test.ts` | **Deleted** — replaced by `CollapseGuard.test.ts` |
| `src/ui/CollapseGuard.ts` | **New** — unified guard for bouten/ruby/heading post-collapse input |
| `src/ui/CollapseGuard.test.ts` | **New** — 17 unit tests |
| `src/ui/InlineEditor.ts` | Replace `boutenGuard` + `postCollapseEl` with `collapseGuard: CollapseGuard` |
| `src/ui/EditorElement.ts` | Unify two-path `onBeforeInput` check; delete `handleBoutenPostCollapseInput` |
| `src/view.ts` | Replace two post-collapse calls with one `handlePostCollapseInput` |
