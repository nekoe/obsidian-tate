# InlineEditor Module Split

Date: 2026-04-20

## Overview

The original `InlineEditor.ts` had grown to ~1,100 lines with five distinct
responsibilities coexisting in a single class: pure DOM helpers, bouten
post-collapse guarding, cursor anchor management, live notation conversion,
and inline expand/collapse. This document describes the motivation, constraints,
and implementation of the five-step split that produced the current module
structure.

---

## 1. Motivation

The pre-split `InlineEditor` had several maintenance problems:

- **Test coverage**: the only way to test individual behaviors was through the
  full `handleSelectionChange` orchestration path. State flags (`isModifyingDom`,
  `boutenJustCollapsed`, `pendingAnchorSkip`, etc.) had to be in the right state
  before each test, making unit tests impractical.
- **Readability**: unrelated concerns (e.g. bouten IME fixup and cursor anchor
  placeholder management) shared the same scroll of code with no clear boundaries.
- **Changeability**: any modification to one behavior required reading the full
  class to understand what state it shared with other behaviors.

---

## 2. Dependency Direction Constraint

The most important architectural decision is a strict **one-directional dependency**:

```
InlineEditor → sub-modules (BoutenGuard, CursorAnchorManager, LiveConverter, InlineExpander)
sub-modules → domHelpers (pure functions only)
sub-modules ✗ InlineEditor
sub-modules ✗ other sub-modules
```

No sub-module may import `InlineEditor` or any sibling sub-module. Communication
from a sub-module back to `InlineEditor` is done exclusively through return values,
never through callbacks or shared mutable objects. This prevents circular imports
and keeps the dependency graph a DAG.

---

## 3. Module Responsibilities

### `domHelpers.ts` — Pure helpers

All functions are module-level exports (no class). Functions that need to search
within the editor always receive an explicit `rootEl: HTMLElement` parameter instead
of closing over `this.el`.

| Category | Functions |
|---|---|
| Element factories | `createRubyEl`, `createTcyEl`, `createBoutenEl`, `createCursorAnchor` |
| DOM manipulation | `insertAnnotationElement`, `setCursorAfter` |
| Ancestor traversal | `findAncestor`, `findBoutenAncestor`, `findTcyAncestor`, `isInsideRuby`, `findCursorAnchorAncestor`, `isInsideRtNode`, `findLastBaseTextInElement` |
| Pure computation | `rawOffsetForExpand`, `getExtraCharsFromAnnotation` |

These functions carry no state and are fully unit-testable with happy-dom.

### `BoutenGuard.ts` — Bouten post-collapse guard

Owns the `boutenJustCollapsed` state. After a bouten span collapses, Chrome
normalizes the cursor synchronously back into the span before any event handler
can observe it. This class detects that re-entry and redirects or repairs the
input.

Public API:

| Method | Purpose |
|---|---|
| `set(bouten, originalText)` | Record that a bouten just collapsed |
| `get()` | Read the current guard state |
| `clear()` | Clear the guard |
| `getCursorBoutenSpan(expandBouten, expandedEl)` | Check if cursor is in the post-collapse zone |
| `insertAfterBouten(bouten, chars)` | Insert text after bouten via DOM Range (bypasses Chrome normalization) |
| `handleBoutenPostCollapseInput()` | Move IME text that landed inside bouten to after it |
| `redirectCursorOutOfCollapsedBouten(bouten, sel)` | Redirect cursor away from bouten without triggering re-expansion |

`InlineEditor` calls `boutenGuard.set(...)` from `placeCursorAfterCollapse`,
and `boutenGuard.clear()` from `reset`, `resetBurst`, and `notifyNavigationKey`.

### `CursorAnchorManager.ts` — Cursor anchor span management

Owns the `pendingAnchorSkip` state. Manages the lifecycle of
`<span class="tate-cursor-anchor">` elements and the skip direction used to make
the invisible U+200B placeholder transparent to keyboard navigation.

Public API:

| Method | Purpose |
|---|---|
| `setSkipDirection(key)` | Record arrow key direction for next selectionchange |
| `clearSkipIfEndOfLine(anchor)` | Clear pending skip when anchor is at end-of-line |
| `handleAnchorPosition(range, sel)` | Consume pending skip, returns `true` if cursor is in anchor (caller must not expand) |
| `ensureCursorAnchorAfter(el)` | Insert anchor at end-of-line before expansion |
| `placeCursorAfterCollapse(nextSib, parentEl, sel)` | Place cursor after a collapsed element; creates anchor if at end-of-line |
| `handleCursorAnchorInput()` | Strip U+200B when real chars are typed; restore it when span is emptied |

`InlineEditor.placeCursorAfterCollapse` calls
`anchorManager.placeCursorAfterCollapse(...)` and then records
`boutenGuard.set(...)` separately — the bouten detection step is in `InlineEditor`
because it would require `CursorAnchorManager` to depend on `BoutenGuard`,
violating the dependency constraint.

### `LiveConverter.ts` — Live notation conversion

Converts raw Aozora text into DOM elements as the user types. Called from
`EditorElement` after `input` and `compositionend` events. All methods are
stateless with respect to expansion state; guards and state updates are applied
by the caller (`InlineEditor`).

| Method | Returns | Purpose |
|---|---|---|
| `handleRubyCompletion()` | `RubyCompletionResult` | Convert `｜base《rt》` or create tate-editing span when rt is empty |
| `handleTcyCompletion()` | `boolean` | Convert `AB［＃「AB」は縦中横］` |
| `handleBoutenCompletion()` | `boolean` | Convert `春［＃「春」に傍点］` |

`RubyCompletionResult` carries an optional `newExpanded: { el, originalText }`
field. `InlineEditor` applies this to `expandedEl` and `expandedElOriginalText`
after the call, keeping LiveConverter free of InlineEditor state.

### `InlineExpander.ts` — Expand/collapse core

Handles the actual DOM transformation between annotation element and tate-editing
span. Stateless: all inputs come from parameters and all outputs are return values.

| Method | Returns | Purpose |
|---|---|---|
| `findExpandableAncestor(node, ruby, tcy, bouten)` | `HTMLElement \| null` | Find the first expandable ancestor, filtered by caller-provided flags |
| `expandForEditing(target, range)` | `{ el, originalText }` | Replace target with tate-editing span, position cursor |
| `collapseEditing(expandedEl, originalText)` | `CollapseResult` | Collapse span back to parsed annotation elements |

`CollapseResult = { hasChanged: boolean; detached: boolean }`. When `detached` is
`true`, the span was not in the DOM (e.g. removed by Undo); in that case
`InlineEditor` must NOT clear `inBurst`, preserving the flag for the interrupted burst.

The expand flags (`expandRuby`, `expandTcy`, `expandBouten`) are InlineEditor
state that can change via `setExpandSettings`. They are passed as parameters to
`findExpandableAncestor` on every call rather than stored in InlineExpander,
keeping InlineExpander truly stateless.

### `InlineEditor.ts` — Orchestrator

Owns the remaining mutable state:

| Field | Purpose |
|---|---|
| `expandedEl` | The tate-editing span currently open (null if none) |
| `expandedElOriginalText` | Snapshot of raw text at expand time (for change detection) |
| `savedRange` | Cached selection for command palette use |
| `inBurst` | Whether uncommitted changes are pending for CM6 |
| `isModifyingDom` | Re-entry guard for selectionchange |
| `expandRuby/Tcy/Bouten` | Per-type expansion toggle flags |

`InlineEditor` is the only class in the call graph that sets and clears
`isModifyingDom`. Sub-modules never touch it. `InlineEditor` wraps each
sub-module call with `isModifyingDom = true / try…finally false` where the
call will modify the DOM, preventing `handleSelectionChange` from re-entering.

---

## 4. `isModifyingDom` Guard Pattern

The guard prevents `handleSelectionChange` from firing during programmatic DOM
changes made by `expandForEditing`, `collapseEditing`, and the live converters.

**Rule:** `isModifyingDom` is set in `InlineEditor` only. Sub-modules must not
set it. When `InlineEditor` calls a sub-module method that may change the DOM,
it wraps the call:

```typescript
this.isModifyingDom = true;
try {
    const result = this.subModule.doSomething(...);
    // apply result to InlineEditor state
} finally {
    this.isModifyingDom = false;
}
```

This means the guard is set even if the sub-module returns early without touching
the DOM. The brief false-positive is harmless because no selectionchange event
fires when no DOM change occurs.

---

## 5. State Communication Pattern

Sub-modules communicate state changes to `InlineEditor` through return values, not
through shared objects or callbacks. The patterns used:

| Pattern | Example |
|---|---|
| Simple boolean | `handleTcyCompletion()` returns `true/false` |
| Tagged union | `RubyCompletionResult` — `{ converted: false }` or `{ converted: true; newExpanded? }` |
| Named tuple | `CollapseResult` — `{ hasChanged, detached }` |

`InlineEditor` reads the return value and applies any state changes:

```typescript
// LiveConverter → InlineEditor state update
const r = this.liveConverter.handleRubyCompletion();
if (r.converted && r.newExpanded) {
    this.expandedEl = r.newExpanded.el;
    this.expandedElOriginalText = r.newExpanded.originalText;
}

// InlineExpander → InlineEditor state update
const { hasChanged, detached } = this.expander.collapseEditing(
    this.expandedEl, this.expandedElOriginalText
);
this.expandedEl = null;
this.expandedElOriginalText = null;
if (!detached) this.inBurst = false;
```

---

## 6. Test Strategy

Unit tests live in files next to the source:

| Test file | Coverage |
|---|---|
| `AozoraParser.test.ts` | `parseInlineToHtml`, `parseToHtml`, `serializeNode`, round-trips |
| `domHelpers.test.ts` | All factory functions, `insertAnnotationElement`, all ancestor traversal, `rawOffsetForExpand`, `getExtraCharsFromAnnotation` |
| `BoutenGuard.test.ts` | State management, `insertAfterBouten` DOM structure, `handleBoutenPostCollapseInput` all branches, `getCursorBoutenSpan` guard flags |
| `SegmentMap.test.ts` | Source ↔ view offset mapping |

Functions that depend on Chrome-specific Selection API behaviour
(`getCursorBoutenSpan` cursor-position cases, `redirectCursorOutOfCollapsedBouten`,
`setCursorAfter`) are covered only by smoke tests or noted as requiring manual
verification in a real browser. Happy-dom's Selection support is sufficient for
basic collapsed/non-collapsed checks but does not replicate Chrome's layout-level
cursor normalization.

---

## 7. Files Changed

| File | Change |
|---|---|
| `src/ui/domHelpers.ts` | New: pure helpers extracted from InlineEditor |
| `src/ui/BoutenGuard.ts` | New: bouten post-collapse guard |
| `src/ui/CursorAnchorManager.ts` | New: cursor anchor lifecycle |
| `src/ui/LiveConverter.ts` | New: live notation conversion |
| `src/ui/InlineExpander.ts` | New: expand/collapse core |
| `src/ui/InlineEditor.ts` | Reduced from ~1,100 to ~500 lines; now orchestrator only |
| `src/ui/domHelpers.test.ts` | New: 47 unit tests |
| `src/ui/BoutenGuard.test.ts` | New: 17 unit tests |
