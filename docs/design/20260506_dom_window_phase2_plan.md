# Phase 2 Implementation Plan: DOM Window + Spacers

Created: 2026-05-06  
Status: **TEMPORARY** — working document for implementation tracking. Not a permanent design record.

This document describes the implementation steps for Phase 2 of full DOM virtualization as defined in `20260505_full_virtualization.md`. Phase 2 replaces frozen div shells with true DOM removal: only a sliding window of paragraph divs stays in the DOM; two spacer divs represent the collapsed width of off-screen paragraphs.

---

## Target architecture (end state)

```
editorEl (contenteditable)
│
├── [rightSpacer]  style="width: Wpx"   ← total width of records 0..domStart-1
├── [div] paragraph domStart
├── [div] paragraph domStart+1
│    ...
├── [div] paragraph domEnd
└── [leftSpacer]   style="width: Wpx"   ← total width of records domEnd+1..N-1
```

State in `ParagraphVirtualizer`:
- `domStart: number`, `domEnd: number` — inclusive window range (index into `paragraphRecords[]`)
- `rightSpacer: HTMLElement`, `leftSpacer: HTMLElement`
- `paragraphRecords[]` — sole source of truth for all off-window reads

---

## Phase 2a — Reading path migration

**Goal**: Change `getValue()`, `getVisibleOffset()`, `setVisibleOffset()`, and `extractHybridText()` to use `paragraphRecords[i].src` / `paragraphRecords[i].viewLen` for data access, with a clean abstraction layer that will handle both in-window (DOM) and off-window (records-only) cases. The frozen infrastructure stays in place; this phase only adds the new access paths.

### Changes

**`ParagraphVirtualizer`** — add window-aware accessors:

```typescript
// Initialized to [0, paragraphRecords.length - 1] after initRecords(); updated in Phase 2c.
domStart = 0;
domEnd = -1; // -1 = invalid sentinel (no records yet)

// In Phase 2a: always returns true (all divs are in DOM). Phase 2c makes this meaningful.
isInWindow(i: number): boolean { return i >= this.domStart && i <= this.domEnd; }

// Returns the DOM div at window-relative position, or null if out of window.
// In Phase 2a: i - domStart === i (domStart = 0), so returns editorEl.children[i].
getWindowDiv(i: number): HTMLElement | null {
    if (!this.isInWindow(i)) return null;
    return this.editorEl.children[i - this.domStart] as HTMLElement ?? null;
}

// No-op in Phase 2a. Phase 2c: shifts the window to include i.
ensureInWindow(i: number): void { /* Phase 2c */ }
```

Also update `initRecords()` to set `domEnd = lines.length - 1` after populating records.

**`EditorElement.getValue()`** — iterate by `paragraphRecords` index:

```typescript
getValue(): string {
    const virt = this.virtualizer;
    if (!virt || virt.domEnd < 0) {
        // No records yet: fall back to direct DOM walk (initial state before setValue)
        return Array.from(this.el.childNodes).map(n => serializeNode(n, this.el)).join('');
    }
    return virt.paragraphRecords.map((rec, i) => {
        const div = virt.getWindowDiv(i);
        const src = div ? (virt.isFrozen(div) ? virt.getSrcLine(div) : serializeNode(div, this.el)) : rec.src;
        return i === 0 ? src : '\n' + src;
    }).join('');
}
```

In Phase 2a `getWindowDiv(i)` always returns a div (all in-window), so `rec.src` branch is dead code that activates in Phase 2c.

**`EditorElement.getVisibleOffset()` / `setVisibleOffset()`** — the frozen-div branches change from `thawDiv(child)` to `ensureInWindow(i)`. In Phase 2a `ensureInWindow` is a no-op, but the call site is wired up. Also convert `Array.from(el.children)` iteration to index-based so `i` is available.

**`SearchPanel.extractHybridText()`** — add off-window branch:

```typescript
if (!virtualizer.isInWindow(i)) {
    // Off-window: no DOM, use records directly (dead in Phase 2a; active in Phase 2c)
    const text = virtualizer.buildParagraphVisibleText(rec.src);
    paragraphs.push({ kind: 'offWindow', globalStart, text });
}
```

Also rename `ThawedMatchEntry`/`FrozenMatchEntry` to `InWindowMatchEntry`/`OffWindowMatchEntry`.

**`paragraphRecords` sync guarantee for `getValue()`**: `getValue()` is called at the start of `commitToCm6()`. Records may lag the DOM by one Enter/paste (splice not yet called). In Phase 2a this is harmless because in-window divs are still serialized from DOM (`serializeNode`). In Phase 2c this must be tight — see Phase 2c notes.

---

## Phase 2b — Spacer scaffolding

**Goal**: Add `rightSpacer` and `leftSpacer` to the DOM with correct initial widths (0 at first; will be maintained in Phase 2c). Remove `content-visibility: auto` from the editor's paragraph divs.

### Changes

**`ParagraphVirtualizer.attach()`** / new `initSpacers()`:

```typescript
rightSpacer = this.editorEl.insertAdjacentElement('afterbegin', document.createElement('div')) as HTMLElement;
leftSpacer  = this.editorEl.appendChild(document.createElement('div')) as HTMLElement;
// both start at width 0
rightSpacer.style.setProperty('flex-shrink', '0');
leftSpacer.style.setProperty('flex-shrink', '0');
```

Both spacers are non-focusable, non-editable, non-selectable (`pointer-events: none`; `user-select: none`).

**`styles.css`**: Remove `content-visibility: auto` and `contain-intrinsic-block-size: auto 44px` from `.tate-editor > div`. Also remove the `.tate-editor.tate-scroll-restoring > div` and `.tate-editor > div.tate-layout-refreshing` rules that toggled `content-visibility`.

**`EditorElement.hasCleanDivStructure(expectedCount)`**: Exclude the two spacer divs from the child count check:

```typescript
// spacers are the first and last children; exclude them
const paragraphCount = this.el.childNodes.length - 2; // subtract rightSpacer + leftSpacer
if (paragraphCount !== expectedCount) return false;
```

**`ParagraphVirtualizer.observeAll()` / `observeOne()`**: Skip spacers.

**`patchParagraphs()` in EditorElement**: spacers are permanent fixtures; insertBefore/removeChild operations must account for their positions (rightSpacer at index 0, leftSpacer at last).

At the end of Phase 2b: spacers exist in the DOM but are always `width: 0`. The window still spans all paragraphs. The frozen mechanism still operates. Visually nothing changes for the user (content-visibility removal is the only perceptible change: all divs are now always laid out, which improves scroll smoothness).

---

## Phase 2c — Window state machine + IntersectionObserver

**Goal**: Implement the actual DOM windowing. The IO watches the two boundary divs (domStart and domEnd divs). When a boundary enters the extended viewport, expand in that direction. When the opposite boundary exits the extended viewport, shrink from that side. Spacer widths maintain `scrollWidth` stability.

### Window state

```typescript
private domStart = 0;
private domEnd   = -1; // set to paragraphRecords.length - 1 in initRecords

private rightSpacer!: HTMLElement;
private leftSpacer!:  HTMLElement;

// Measured in pixels; sum = total width of all off-window paragraphs on that side.
private rightSpacerWidth = 0;
private leftSpacerWidth  = 0;
```

The `UNRENDERED_WIDTH_PX = 44` constant is used as the width estimate for paragraphs that have never entered the viewport.

### IntersectionObserver design

The observer watches **only the two boundary divs** (`domStart` div and `domEnd` div) with `rootMargin: '0px 440px 0px 440px'`.

```
               viewport          440px margin
         ◄─────────────────────►◄──────────►
  [rightSpacer][domStart div] ... [domEnd div][leftSpacer]
               ▲                              ▲
          watch here                    watch here
```

- **domStart div enters extended viewport** (user scrolling right): `expandRight()` — pop one record from the right side of rightSpacer, prepend a new div before domStart, update rightSpacer width. Then `shrinkLeft()` to keep the window bounded (only shrink if domEnd div is outside the extended viewport plus a larger buffer).
- **domEnd div enters extended viewport** (user scrolling left): `expandLeft()` — pop one record from the left side of leftSpacer, append a new div after domEnd, update leftSpacer width. Then `shrinkRight()`.
- Re-observe boundary divs after each expand/shrink.

### `expandRight()` / `shrinkRight()`

```typescript
private expandRight(): void {
    if (this.domStart === 0) return;
    const i = this.domStart - 1;
    const rec = this.paragraphRecords[i];
    const div = document.createElement('div');
    div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
    this.editorEl.insertBefore(div, this.editorEl.children[1]); // after rightSpacer
    // Shrink rightSpacer by this div's estimated or measured width
    const w = rec.width > 0 ? rec.width : UNRENDERED_WIDTH_PX;
    this.rightSpacerWidth = Math.max(0, this.rightSpacerWidth - w);
    this.rightSpacer.style.setProperty('width', `${this.rightSpacerWidth}px`);
    this.domStart--;
}

private shrinkRight(): void {
    const sel = window.getSelection();
    const div = this.editorEl.children[1] as HTMLElement; // first paragraph (after rightSpacer)
    if (sel && (div.contains(sel.anchorNode) || div.contains(sel.focusNode))) return; // drag guard
    const w = div.getBoundingClientRect().width || UNRENDERED_WIDTH_PX;
    this.paragraphRecords[this.domStart].width = w; // record measured width
    this.rightSpacerWidth += w;
    this.rightSpacer.style.setProperty('width', `${this.rightSpacerWidth}px`);
    div.remove();
    this.domStart++;
}
```

Symmetric `expandLeft()` / `shrinkLeft()` for the other side.

### `ensureInWindow(i: number): void`

Shifts the window to include paragraph `i`, then updates spacers. Called by `setVisibleOffset()`, `CursorAnchorManager`, and jump-to-heading.

```typescript
ensureInWindow(i: number): void {
    if (this.isInWindow(i)) return;
    if (i < this.domStart) {
        while (this.domStart > i) this.expandRight();
    } else {
        while (this.domEnd < i) this.expandLeft();
    }
    // Re-register IO on new boundaries
    this.reobserveBoundaries();
}
```

### `ensureWindowAroundCursor()` (replaces `ensureThawedAtCursor()`)

```typescript
ensureWindowAroundCursor(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    let node: Node | null = sel.getRangeAt(0).startContainer;
    while (node && node !== this.editorEl) {
        if (node instanceof HTMLElement && node.parentElement === this.editorEl) {
            const i = this.domStart + Array.from(this.editorEl.children).indexOf(node) - 1; // -1 for rightSpacer
            this.ensureInWindow(i);
            return;
        }
        node = node.parentElement;
    }
}
```

### `expandWindowToFull()` — for Cmd-A select-all

```typescript
expandWindowToFull(): void {
    // Build full HTML from records in one pass (no DOM reads needed for off-window)
    const html = this.paragraphRecords.map(rec => `<div>${parseInlineToHtml(rec.src) || '<br>'}</div>`).join('');
    const frag = sanitizeHTMLToDom(html);
    // Replace all children except spacers with full content
    // Single replaceChildren call = single layout recalc
    this.editorEl.replaceChildren(this.rightSpacer, ...Array.from(frag.childNodes), this.leftSpacer);
    this.domStart = 0;
    this.domEnd = this.paragraphRecords.length - 1;
    this.rightSpacerWidth = 0;
    this.leftSpacerWidth  = 0;
    this.rightSpacer.style.removeProperty('width');
    this.leftSpacer.style.removeProperty('width');
    this.reobserveBoundaries();
}
```

Called from `view.ts` keydown handler on Cmd-A, followed by one `requestAnimationFrame` then `document.execCommand('selectAll')` or equivalent.

### `paragraphRecords` sync for off-window writes

In Phase 2c, Enter/paste mutations can happen inside the window. `patchParagraphs()` already calls `spliceRecords()`. The issue is Enter key (single-paragraph split): Chrome inserts a new div without going through `patchParagraphs`. This is handled because `commitToCm6()` calls `initRecords()` with current content after every commit. Since `getValue()` now reads off-window from records and in-window from DOM, and `initRecords()` rebuilds records from `getValue()` output, all records stay in sync after each commit.

---

## Phase 2d — Remove frozen infrastructure

**Goal**: Delete all code related to the Phase 1 frozen-div mechanism.

### Removals from `ParagraphVirtualizer`

- `FROZEN_CLASS` constant and `isFrozen()` method
- `frozenSrc`, `frozenViewLen` WeakMaps
- `seenDivs` WeakSet, `lastKnownWidths` WeakMap
- `freezeTimers` Map, `FREEZE_DELAY_MS`, `scheduleFreeze()`, `cancelFreeze()`, `cancelAllPendingFreezeTimers()`
- `shouldFreeze()`, `freezeDiv()`, `freezeSuppressed`, `suppressFreeze()`
- `viewActive`, `onViewDeactivated()`, `onViewActivated()` (the latter two will be repurposed or removed)
- `thawDiv()`, `unfrostDiv()`, `ensureThawed()`, `ensureThawedAtCursor()`
- `setFrozenContent()`, `getSrcLine()` (now replaced by `paragraphRecords[i].src`), `getViewLen()` (replaced by `paragraphRecords[i].viewLen`)
- `FROZEN_CLASS` CSS class and all `.tate-frozen` CSS rules from `styles.css`

### Updates to dependent code

**`EditorElement.getValue()`**: Remove `isFrozen()` branch (already migrated in Phase 2a to use `getWindowDiv(i)`).

**`EditorElement.getVisibleOffset()` / `setVisibleOffset()`**: Remove `thawDiv()` calls (already replaced with `ensureInWindow()` in Phase 2a/2c).

**`EditorElement.patchParagraphs()`**: Remove `unfrostDiv()` calls.

**`SearchPanel`**:
- Remove `suppressFreeze()` calls (no longer needed; window keeps all viewport-visible divs in DOM).
- Replace `ThawedMatchEntry`/`FrozenMatchEntry` with `InWindowMatchEntry`/`OffWindowMatchEntry`.
- Replace `thawDiv()` on navigation with `ensureInWindow()`.
- Remove `updateFrozenToThawedEntries()`.

**`CursorAnchorManager`** (2 calls at lines ~177, ~210): Replace `thawDiv(div)` with `virtualizer.ensureInWindow(i)`.

**`view.ts`**: Replace `virtualizer.ensureThawedAtCursor()` with `virtualizer.ensureWindowAroundCursor()`. Add Cmd-A keydown interception → `expandWindowToFull()` + deferred select-all.

### `styles.css` cleanups

Remove:
- `.tate-editor > div.tate-frozen` rule
- `.tate-editor.tate-scroll-restoring > div` rule (content-visibility toggle; removed in Phase 2b)
- `.tate-editor > div.tate-layout-refreshing` rule (same)

The `tate-scroll-restoring` class and spinner may be retained if scroll-restore still uses two-rAF pattern. `content-visibility` is fully removed so the class only needs to protect the IO re-registration timing.

---

## Phase 2e — Tests

**Goal**: Update `ParagraphVirtualizer.test.ts` and add new window management tests.

### Existing tests to update / remove

- All tests using `FROZEN_CLASS`, `isFrozen()`, `thawDiv()`, `unfrostDiv()`, `setFrozenContent()` — remove or rewrite.
- `freezeDiv` behavior tests — remove.
- `IntersectionObserver` mock (if any) — update for new boundary-only observation.

### New tests to add

- **Window initialization**: `initRecords([...])` sets `domStart=0`, `domEnd=N-1`, spacer widths 0.
- **`expandRight()` / `shrinkRight()`**: correct div insertion, spacer width update, `domStart` decrement.
- **`expandLeft()` / `shrinkLeft()`**: symmetric.
- **`ensureInWindow(i)`** with `i < domStart`: expands right to include `i`.
- **`ensureInWindow(i)`** with `i > domEnd`: expands left to include `i`.
- **Drag-selection guard**: `shrinkRight()` is a no-op when the div contains `selection.anchorNode`.
- **Spacer width stability**: total `scrollWidth` is constant across expand/shrink cycles.
- **`expandWindowToFull()`**: DOM contains all paragraphs + two spacers; widths are 0.
- **`getValue()` round-trip**: `getValue()` output matches original content after expand/shrink cycles.

---

## Decision log

| Question | Decision |
|---|---|
| Remove `content-visibility: auto`? | Yes (Phase 2b). DOM window (~20–50 divs) makes C-V:auto unnecessary. |
| Width for never-rendered paragraphs | `UNRENDERED_WIDTH_PX = 44` (matches C-V:auto intrinsic). Adjustable constant. |
| Cmd-A behavior | `expandWindowToFull()` (single `replaceChildren`) then deferred native select-all. |
| IO trigger target | Boundary divs only (domStart div and domEnd div), rootMargin 440px. |
| `UNRENDERED_WIDTH_PX` value | 44px. Can be tuned after Phase 2c ships. |
