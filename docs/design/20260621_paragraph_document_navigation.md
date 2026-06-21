# Paragraph / Document Boundary Navigation Keys

Created: 2026-06-21

## Goal

Split the boundary-jump shortcuts into two levels — **paragraph** and **document** — and
map them to keys that read naturally in vertical writing (`vertical-rl`).

| Action | macOS | Windows / Linux |
|---|---|---|
| Paragraph start / end | `Cmd+↑` / `Cmd+↓` | `Home` / `End` |
| Document start / end  | `Cmd+→` / `Cmd+←` | `Ctrl+Home` / `Ctrl+End` |

`Home` / `End` are mapped to **paragraph** boundaries on every platform (so the behavior is
identical regardless of keyboard), including macOS full keyboards.

Previously `Cmd+↑/↓` (macOS) and `Ctrl+Home/End` (Win/Linux) jumped to the **document**
boundary, and there was no paragraph-level jump.

## Why this mapping is natural for vertical-rl

Keyboard conventions in horizontal text map to two axes:

- **Inline axis** (the direction text flows within a line): horizontal → `←/→`, `Home/End`.
- **Block axis** (the direction paragraphs progress): vertical → `↑/↓`, `Ctrl+Home/End`.

In `vertical-rl` both axes rotate 90°:

- The **inline axis becomes vertical** — characters stack top→bottom. So the within-paragraph
  (inline) boundary belongs on the vertical keys: `Cmd+↑/↓`. `Home/End` keep their semantic
  meaning of "line/paragraph start/end".
- The **block axis becomes horizontal** — paragraphs progress right→left. So the document
  boundary belongs on the horizontal keys: `Cmd+→/←`. In `vertical-rl`, rightward (`ArrowRight`)
  is toward the start and leftward (`ArrowLeft`) toward the end (matching the existing direction
  convention in `collapseVirtualSelectionWithArrow`).

The result is the standard convention rotated to match the writing direction; both platforms
stay consistent in terms of which axis each key controls.

### One intentional deviation

OS-standard `Home/End` move to the **visual line** (a single wrapped column) start/end. Here
they move to the **paragraph** (logical line) start/end, crossing soft-wrapped columns. For a
vertical prose editor the paragraph is the meaningful unit, so this is preferred over
column-level navigation. (When a paragraph fits in one column the two coincide.)

## Implementation

All keys are handled in `view.ts`'s keydown dispatch (`handleEditorKeyDown`), in two sibling
handlers that run before the generic arrow/navigation handler:

- `handleDocumentBoundaryKey` — retriggered on `Cmd+→/←` (mac) / `Ctrl+Home/End` (others).
  Body unchanged: Shift extends via `extendSelectionToDocumentBoundary`, otherwise collapses to
  view offset `0` or total length.
- `handleParagraphBoundaryKey` (new) — triggered on `Cmd+↑/↓` (mac) or bare `Home/End`
  (all platforms). Shift extends via the new `extendSelectionToParagraphBoundary`; otherwise it
  collapses to the current paragraph's start or end.

New `ParagraphVirtualizer` methods:

- `getCaretParagraphIndex()` — paragraph index of the current caret (VS focus, else DOM focus).
- `extendSelectionToParagraphBoundary(toStart)` — mirrors `extendSelectionToDocumentBoundary`
  but the focus target is the **focus paragraph's** start (`viewOff = 0`) or end
  (`viewOff = record.viewLen`), with the anchor preserved.

### Boundary-offset asymmetry (why start and end differ)

A paragraph boundary is a single integer in view-offset space: "end of paragraph N" and "start
of paragraph N+1" are the same number. `setVisibleOffset` resolves this tie with `<=`, landing
on the **end of the earlier paragraph**. Consequently:

- **Paragraph start** cannot be reached by offset (the integer resolves to the *previous*
  paragraph's end). It is jumped by **index** via `jumpToParagraphIndex(idx)`, which also makes
  the leaf-reactivation restore index-based (`pendingParagraphJump`). This reuses the exact
  mechanism the outline jump already relies on.
- **Paragraph end** *is* reachable by offset: `startOffset + record.viewLen` resolves, by the
  same `<=` tie-break, to this paragraph's end — both at jump time and when restored from
  `lastKnownViewOffset`. So no special index-based handling or new `EditorElement` method is
  needed for the end case.

This asymmetry is the whole reason the two branches of `handleParagraphBoundaryKey` look
different. See also [Cursor Position Persistence](20260424_cursor_persistence.md).

### Dead-code cleanup

With every `Cmd+Arrow` now consumed by the paragraph/document boundary handlers (which return
early), no `Cmd+Arrow` combination can reach `collapseVirtualSelectionWithArrow`. Its `metaKey`
exception was removed; it now guards on modifier-free arrows only.
