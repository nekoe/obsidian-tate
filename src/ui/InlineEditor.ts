import {
    createTcyEl, createBoutenEl, createHeadingEl,
    insertAnnotationElement,
    findTcyAncestor, findAncestor, findParentDivInEditor,
    annotationKindOf, isAnnotationElement, ANNOTATION_SELECTOR,
} from './domHelpers';
import { CollapseGuard } from './CollapseGuard';
import { CursorAnchorManager } from './CursorAnchorManager';
import { LiveConverter } from './LiveConverter';
import { InlineExpander } from './InlineExpander';
import type { ParagraphVirtualizer } from './ParagraphVirtualizer';

export class InlineEditor {
    // The editing span currently expanded inline. null if not expanded.
    private expandedEl: HTMLSpanElement | null = null;
    // Guard to prevent re-entry during DOM manipulation inside the selectionchange handler
    private isModifyingDom = false;
    // Serialized text captured at expandForEditing time (used to detect changes in collapseEditing)
    private expandedElOriginalText: string | null = null;
    // Cached selection range for command execution (retained even after focus leaves due to command palette)
    private savedRange: {
        startContainer: Node; startOffset: number;
        endContainer: Node; endOffset: number;
    } | null = null;
    // Flag indicating there are uncommitted changes pending for CM6.
    // Set by onBeforeInput, cleared by resetBurst() when commitToCm6() completes.
    private inBurst = false;
    // Per-element-type flags controlling whether cursor entry triggers inline expansion.
    private expandRuby = true;
    private expandTcy = true;
    private expandBouten = true;
    private expandHeading = true;
    // Post-collapse guard: after any annotation element collapses, Chrome may normalize the cursor
    // back into it. collapseGuard records the element and intercepts input to route it outside.
    private readonly collapseGuard: CollapseGuard;
    private readonly anchorManager: CursorAnchorManager;
    private readonly liveConverter: LiveConverter;
    private readonly expander: InlineExpander;

    constructor(private readonly el: HTMLDivElement) {
        this.collapseGuard = new CollapseGuard();
        this.anchorManager = new CursorAnchorManager(el);
        this.liveConverter = new LiveConverter(el);
        this.expander = new InlineExpander(el);
    }

    setVirtualizer(v: ParagraphVirtualizer): void {
        this.anchorManager.setVirtualizer(v);
    }

    setExpandSettings(ruby: boolean, tcy: boolean, bouten: boolean, heading: boolean): void {
        this.expandRuby = ruby;
        this.expandTcy = tcy;
        this.expandBouten = bouten;
        this.expandHeading = heading;
    }

    // Resets expansion state, selection cache, and burst flag (called from setValue / applyFromCm6)
    reset(): void {
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        this.savedRange = null;
        this.inBurst = false;
        this.collapseGuard.clear();
    }

    isExpanded(): boolean {
        return this.expandedEl !== null;
    }

    // ---- Inline expand/collapse (call from selectionchange) ----

    // Called on every cursor movement to expand or collapse ruby/tcy elements.
    // Returns true if collapse changed the content (signal for view.ts to call commitToCm6).
    handleSelectionChange(): boolean {
        // Update the cache only when not in DOM manipulation and there is a non-collapsed selection inside the editor
        // (retaining it when focus leaves allows access after the command palette is opened)
        if (!this.isModifyingDom) {
            // Synchronize expandedEl when Undo/external DOM change detached the span.
            // Skip when expandedEl is null: no span is in the DOM in that case (all code paths
            // that create span.tate-editing also set expandedEl, so null → no DOM span to find).
            if (this.expandedEl !== null && !this.expandedEl.isConnected) {
                const actualSpan = this.el.querySelector<HTMLSpanElement>('span.tate-editing');
                if (actualSpan !== this.expandedEl) {
                    this.expandedEl = actualSpan;
                    // Original text is unknown, so set to null to force hasChanged = true
                    this.expandedElOriginalText = null;
                }
            }

            const sc = window.getSelection();
            if (sc && sc.rangeCount > 0) {
                const rc = sc.getRangeAt(0);
                if (!rc.collapsed
                    && this.el.contains(rc.startContainer)
                    && this.el.contains(rc.endContainer)) {
                    this.savedRange = {
                        startContainer: rc.startContainer,
                        startOffset: rc.startOffset,
                        endContainer: rc.endContainer,
                        endOffset: rc.endOffset,
                    };
                }
            }
        }
        if (this.isModifyingDom) return false;
        // Early return for selectionchange outside the editor unless expanded (guards against multiple views)
        const sel0 = window.getSelection();
        if (!this.expandedEl && (!sel0 || sel0.rangeCount === 0 ||
            !this.el.contains(sel0.getRangeAt(0).startContainer))) return false;
        let contentChanged = false;
        this.isModifyingDom = true;
        try {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return false;
            const range = sel.getRangeAt(0);

            // Cursor is still inside the expanded span — do nothing (unless past the closing bracket)
            if (this.expandedEl && this.expandedEl.contains(range.startContainer)) {
                const spanText = this.expandedEl.firstChild as Text | null;
                const atSpanEnd = spanText
                    && range.startContainer === spanText
                    && range.startOffset >= spanText.length;
                if (!atSpanEnd) return false;
                // Cursor is past the closing bracket (》 or ］): collapse and place cursor just after
                const nextSib = this.expandedEl.nextSibling;
                const parentEl = this.expandedEl.parentElement;
                contentChanged = this.collapseEditing();
                this.savedRange = null;
                if (parentEl) this.placeCursorAfterCollapse(nextSib, parentEl, sel);
                return contentChanged;
            }

            // Cursor moved outside the expanded span — collapse, then restore the intended position
            // B2: selection extends before the span while anchor (endContainer) remains inside —
            // keep the span expanded and let the selection stand (symmetric with B3/Shift+Down).
            if (this.expandedEl && !range.collapsed && this.expandedEl.contains(range.endContainer)) {
                return contentChanged;
            }
            if (this.expandedEl) {
                const savedNode = range.startContainer;
                const savedOffset = range.startOffset;

                contentChanged = this.collapseEditing();
                this.savedRange = null; // Discard stale node reference after collapse

                // Restore the cursor to the position the user moved to (savedNode)
                if (savedNode.isConnected && this.el.contains(savedNode)) {
                    try {
                        const maxOffset = savedNode.nodeType === Node.TEXT_NODE
                            ? (savedNode as Text).length
                            : savedNode.childNodes.length;
                        const r = activeDocument.createRange();
                        r.setStart(savedNode, Math.min(savedOffset, maxOffset));
                        r.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(r);
                    } catch { /* ignore if node was detached */ }
                }
            }

            // Check if cursor is still inside the editor
            if (sel.rangeCount === 0) return contentChanged;
            const currentRange = sel.getRangeAt(0);
            if (!this.el.contains(currentRange.startContainer)) return contentChanged;

            // Suppress expansion and anchor-skip while the user has an active selection.
            // Clear pendingAnchorSkip so stale skip directions don't fire after selection ends.
            if (!currentRange.collapsed) {
                this.anchorManager.clearPendingSkip();
                return contentChanged;
            }

            // If cursor is inside a U+200B-only anchor span and a navigation key was just pressed,
            // skip in the recorded direction to make the invisible placeholder transparent.
            if (this.anchorManager.handleAnchorPosition(currentRange, sel)) {
                return contentChanged; // Don't try to expand anchor span
            }

            // Expand if the cursor is inside an expandable element (ruby/tcy/bouten)
            const target = this.findExpandableAncestor(currentRange.startContainer);
            if (target) {
                // After collapse, Chrome may normalize the cursor back into the element.
                // Detect this via collapseGuard and redirect cursor instead of re-expanding.
                const bjc = this.collapseGuard.get();
                if (bjc && target === bjc.el) {
                    this.collapseGuard.redirectCursorOutOfCollapsed(target, sel);
                    // Keep guard set; cleared only on user action (nav key / mouse / reset).
                    return contentChanged;
                }
                // Cursor entered a different expandable element: clear the post-collapse guard.
                this.collapseGuard.clear();
                // For expandable elements at end-of-line, insert a cursor anchor before expanding so
                // that when the user exits past the closing bracket, nextSibling is already the anchor.
                if (isAnnotationElement(target))
                    this.anchorManager.ensureCursorAnchorAfter(target);
                this.expandForEditing(target, currentRange);
            }
        } finally {
            this.isModifyingDom = false;
        }
        return contentChanged;
    }

    // ---- Ruby / tcy live conversion (call from input/compositionend) ----

    // Converts a ruby notation just before the cursor to a <ruby> element when 》 is typed.
    // Returns true if a conversion occurred (signal for view.ts to call commitToCm6).
    handleRubyCompletion(): boolean {
        if (this.expandedEl || this.isModifyingDom) return false;
        this.isModifyingDom = true;
        try {
            const r = this.liveConverter.handleRubyCompletion();
            if (r.converted && r.newExpanded) {
                this.expandedEl = r.newExpanded.el;
                this.expandedElOriginalText = r.newExpanded.originalText;
            }
            return r.converted;
        } finally {
            this.isModifyingDom = false;
        }
    }

    // Converts a tate-chu-yoko notation just before the cursor to a <span class="tcy"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleTcyCompletion(): boolean {
        if (this.expandedEl || this.isModifyingDom) return false;
        this.isModifyingDom = true;
        try {
            return this.liveConverter.handleTcyCompletion();
        } finally {
            this.isModifyingDom = false;
        }
    }

    // Converts a bouten notation just before the cursor to a <span class="bouten"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleBoutenCompletion(): boolean {
        if (this.expandedEl || this.isModifyingDom) return false;
        this.isModifyingDom = true;
        try {
            return this.liveConverter.handleBoutenCompletion();
        } finally {
            this.isModifyingDom = false;
        }
    }

    // Converts a heading notation just before the cursor to a heading span when ］ is typed.
    // Returns true if a conversion occurred.
    handleHeadingCompletion(): boolean {
        if (this.expandedEl || this.isModifyingDom) return false;
        this.isModifyingDom = true;
        try {
            return this.liveConverter.handleHeadingCompletion();
        } finally {
            this.isModifyingDom = false;
        }
    }

    // ---- Selection wrap methods called from the command palette ----

    // Wraps the selected text in a tate-editing span and places the cursor between 《 and 》
    // When the cursor leaves the span, collapseEditing() collapses it to a <ruby> element
    wrapSelectionWithRuby(): boolean {
        if (this.expandedEl) return false;
        const resolved = this.resolveSelectionRange();
        if (!resolved) return false;
        const { textNode, startOffset, endOffset } = resolved;
        const selectedText = textNode.data.slice(startOffset, endOffset);
        if (!selectedText) return false;

        const rawText = `｜${selectedText}《》`;
        const span = activeDocument.createElement('span');
        span.className = 'tate-editing';
        span.textContent = rawText;

        const parentEl = textNode.parentNode as HTMLElement;

        this.isModifyingDom = true;
        try {
            // Direct DOM manipulation: insert span (handles start, end, and middle of line uniformly)
            const precedingText = textNode.data.slice(0, startOffset);
            const followingText = textNode.data.slice(endOffset);
            const next = textNode.nextSibling;
            parentEl.removeChild(textNode);
            if (precedingText) parentEl.insertBefore(activeDocument.createTextNode(precedingText), next);
            parentEl.insertBefore(span, next);
            if (followingText) parentEl.insertBefore(activeDocument.createTextNode(followingText), next);

            this.expandedEl = span;
            this.expandedElOriginalText = rawText;

            // Place cursor between 《 and 》 (rawText.length - 1 = just before 》)
            const spanText = span.firstChild as Text | null;
            if (spanText) {
                const sel = window.getSelection()!;
                const r = activeDocument.createRange();
                r.setStart(spanText, rawText.length - 1);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            }
        } finally {
            this.isModifyingDom = false;
        }

        this.savedRange = null;
        return true;
    }

    // Wraps the selected text in a tate-chu-yoko element
    wrapSelectionWithTcy(): boolean {
        return this.wrapSelectionWith(createTcyEl);
    }

    // Wraps the selected text in a bouten element
    wrapSelectionWithBouten(): boolean {
        return this.wrapSelectionWith(createBoutenEl);
    }

    // Wraps the selected text in a heading element
    wrapSelectionWithHeading(level: 'large' | 'mid' | 'small'): boolean {
        return this.wrapSelectionWith(content => createHeadingEl(content, level));
    }

    // Returns true if the current savedRange intersects at least one annotation element.
    // Used by view.ts to block wrap commands when the selection already contains an annotation.
    hasAnnotationInSelection(): boolean {
        return this.findAnnotationsIntersectingSavedRange().length > 0;
    }

    // Returns true if savedRange selects content from more than one paragraph div.
    // Wrap commands only support a single text node, so view.ts blocks multi-paragraph
    // selections. A triple-click ends at offset 0 of the following paragraph div — that
    // selects no content from it, so the effective end is the previous paragraph and the
    // selection is treated as single-paragraph.
    spansMultipleParagraphs(): boolean {
        const r = this.savedRange;
        if (!r) return false;
        const startPara = findParentDivInEditor(r.startContainer, this.el);
        if (!startPara) return false;
        let endPara = findParentDivInEditor(r.endContainer, this.el);
        if (endPara && r.endContainer === endPara && r.endOffset === 0) {
            const prev = endPara.previousElementSibling;
            if (prev?.instanceOf(HTMLElement) && prev.tagName === 'DIV') endPara = prev;
        }
        if (!endPara) return false;
        return startPara !== endPara;
    }

    // Removes all annotation elements (ruby/tcy/bouten/heading) that intersect the current
    // savedRange, replacing each with its base text. Returns true if any were removed.
    removeAnnotationsInSelection(): boolean {
        // Collapse inline-expand first so the annotation element is restored to the DOM.
        // Avoid collapseForApply() here because it calls reset() which clears savedRange.
        // Save nextSibling/parentElement before collapse so we can locate the newly created
        // annotation element afterwards (collapseEditing inserts it just before nextSibling).
        let collapseNextSib: Node | null = null;
        let collapseParent: HTMLElement | null = null;
        if (this.expandedEl?.isConnected) {
            collapseNextSib = this.expandedEl.nextSibling;
            collapseParent  = this.expandedEl.parentElement;
            this.isModifyingDom = true;
            try {
                this.collapseEditing();
            } finally {
                this.isModifyingDom = false;
            }
            // After collapse the tate-editing span is removed; savedRange may now point to a
            // detached text node that lived inside the span. Discard it to prevent creating a
            // Range with an invalid node in findAnnotationsIntersectingSavedRange().
            if (this.savedRange && !this.savedRange.startContainer.isConnected) {
                this.savedRange = null;
            }
        }

        let targets = this.findAnnotationsIntersectingSavedRange();

        // Fallback 1: after inline-expand collapse, the annotation element was inserted
        // immediately before collapseNextSib in collapseParent (or as its last child).
        if (targets.length === 0 && collapseParent) {
            const candidate = collapseNextSib
                ? collapseNextSib.previousSibling
                : collapseParent.lastChild;
            if (isAnnotationElement(candidate)) {
                targets = [candidate];
            }
        }

        // Fallback 2: collapsed cursor — check inside and adjacent to annotation elements.
        // Covers two cases:
        //   • Inline expansion suppressed: cursor entered annotation without expanding it.
        //   • Command palette collapse: handleSelectionChange collapsed the span and left
        //     the cursor just before/after the resulting annotation element.
        if (targets.length === 0) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && sel.isCollapsed
                    && this.el.contains(sel.getRangeAt(0).startContainer)) {
                const found = this.findAnnotationAtCursor(sel.getRangeAt(0));
                if (found) targets = [found];
            }
        }

        if (targets.length === 0) return false;

        this.isModifyingDom = true;
        try {
            for (const target of targets) {
                if (!target.isConnected) continue;
                // For ruby: textContent is the base text only (no <rt> element per design).
                // For tcy/bouten/heading: textContent is the base text.
                target.replaceWith(activeDocument.createTextNode(target.textContent ?? ''));
            }
        } finally {
            this.isModifyingDom = false;
        }

        this.collapseGuard.clear();
        this.savedRange = null;
        return true;
    }

    // Handles arrow keys when cursor is inside a tcy span.
    // ArrowUp/Down: move left/right within the horizontal TCY text.
    // ArrowLeft/Right (no Shift): escape the TCY span entirely to prevent the infinite loop
    //   that occurs when the browser bounces the cursor back to the adjacent paragraph.
    //   ArrowLeft (toward later paragraphs in vertical-rl) → cursor lands after the span.
    //   ArrowRight (toward earlier paragraphs in vertical-rl) → cursor lands before the span.
    // With shiftKey=true, jumps the selection focus past the span for ArrowUp/Down
    //   (browser gets stuck inside horizontal layout when extending a selection).
    // Returns true if the key was consumed (caller should call preventDefault).
    handleTcyNavigation(key: string, shiftKey = false): boolean {
        if (key !== 'ArrowUp' && key !== 'ArrowDown' &&
            key !== 'ArrowLeft' && key !== 'ArrowRight') return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);

        // ArrowLeft/Right without Shift: escape the span to break the bounce-back loop.
        if ((key === 'ArrowLeft' || key === 'ArrowRight') && !shiftKey) {
            const tcySpan = findTcyAncestor(range.startContainer, this.el);
            if (!tcySpan) return false;
            const r = activeDocument.createRange();
            if (key === 'ArrowLeft') r.setStartAfter(tcySpan);
            else r.setStartBefore(tcySpan);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            return true;
        }

        if (shiftKey) {
            // Use sel.focusNode (the moving end) to detect whether the selection is stuck in a TCY span.
            if (!sel.focusNode) return false;
            const tcySpan = findTcyAncestor(sel.focusNode, this.el);
            if (!tcySpan) return false;
            // Move focus just before (ArrowUp/Right) or just after (ArrowDown/Left) the span.
            const r = activeDocument.createRange();
            if (key === 'ArrowUp' || key === 'ArrowRight') r.setStartBefore(tcySpan);
            else r.setStartAfter(tcySpan); // ArrowDown or ArrowLeft
            r.collapse(true);
            sel.setBaseAndExtent(sel.anchorNode!, sel.anchorOffset, r.startContainer, r.startOffset);
            return true;
        }

        const tcySpan = findTcyAncestor(range.startContainer, this.el);
        if (!tcySpan) return false;

        const moveLeft = key === 'ArrowUp';
        const textNode = tcySpan.firstChild?.instanceOf(Text) ? tcySpan.firstChild as Text : null;
        const r = activeDocument.createRange();

        if (!textNode) {
            if (moveLeft) r.setStartBefore(tcySpan); else r.setStartAfter(tcySpan);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            return true;
        }

        let currentOffset: number;
        if (range.startContainer === textNode) {
            currentOffset = range.startOffset;
        } else if (range.startContainer === tcySpan) {
            currentOffset = range.startOffset === 0 ? 0 : textNode.length;
        } else {
            return false;
        }

        const newOffset = currentOffset + (moveLeft ? -1 : 1);
        if (newOffset < 0) {
            r.setStartBefore(tcySpan);
        } else if (newOffset > textNode.length) {
            r.setStartAfter(tcySpan);
        } else {
            r.setStart(textNode, newOffset);
        }
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        return true;
    }

    // Called on the beforeinput event (registered from view.ts).
    // Sets the inBurst flag to indicate there are uncommitted changes pending for CM6.
    onBeforeInput(): void {
        this.inBurst = true;
    }

    // Returns the annotation element that should intercept the next insertText event, or null.
    // Determines the expand flag based on the recorded element type.
    getCursorCollapseEl(): HTMLElement | null {
        const state = this.collapseGuard.get();
        if (!state) return null;
        const flags = {
            ruby: this.expandRuby, tcy: this.expandTcy,
            bouten: this.expandBouten, heading: this.expandHeading,
        };
        const kind = annotationKindOf(state.el);
        const expandFlag = kind ? flags[kind] : true;
        return this.collapseGuard.getCursorCollapseEl(expandFlag, this.expandedEl);
    }

    // Inserts chars immediately after el without going through the Selection API.
    insertAfterCollapsed(el: HTMLElement, chars: string): void {
        this.collapseGuard.insertAfter(el, chars);
    }

    // Called in compositionend (before commitToCm6) to move IME text that landed inside a
    // post-collapse annotation element out to after the element. Returns true if changed.
    handlePostCollapseInput(): boolean {
        return this.collapseGuard.handlePostCollapseInput();
    }

    // Resets the burst flag after a commit. Does NOT clear collapseGuard.
    afterCommit(): void {
        this.inBurst = false;
    }

    // Resets the burst flag and clears collapseGuard on mouse click or navigation key.
    afterNavigation(): void {
        this.inBurst = false;
        this.collapseGuard.clear();
    }

    // ---- Shared logic for selection wrap ----

    // Shared implementation for element-replacement wraps (tcy, bouten, etc.)
    private wrapSelectionWith(createElement: (content: string) => HTMLElement): boolean {
        if (this.expandedEl) return false;
        const resolved = this.resolveSelectionRange();
        if (!resolved) return false;
        const { textNode, startOffset, endOffset } = resolved;
        const selectedText = textNode.data.slice(startOffset, endOffset);
        if (!selectedText) return false;

        const newEl = createElement(selectedText);

        this.isModifyingDom = true;
        try {
            const inserted = insertAnnotationElement(textNode, startOffset, endOffset, newEl);
            // Insert anchor first so Chrome cannot normalize cursor into the annotation span.
            // placeCursorAfterCollapse also sets collapseGuard for the newly created element.
            this.anchorManager.ensureCursorAnchorAfter(inserted);
            const nextSib = inserted.nextSibling;
            const parentEl = inserted.parentElement;
            const sel = window.getSelection();
            if (parentEl && sel) this.placeCursorAfterCollapse(nextSib, parentEl, sel);
        } finally {
            this.isModifyingDom = false;
        }
        this.savedRange = null;
        return true;
    }

    // ---- Private helpers for inline expand/collapse ----

    // Returns the annotation element (ruby/tcy/bouten/heading) at or immediately adjacent to
    // the cursor, or null if none found. Checks three positions:
    //   1. An annotation ancestor of the cursor node (cursor is inside the annotation).
    //   2. The node just before or after the cursor (cursor is adjacent to the annotation).
    //   3. The previous sibling of a cursor anchor span (cursor is inside the anchor).
    private findAnnotationAtCursor(range: Range): HTMLElement | null {
        const node   = range.startContainer;
        const offset = range.startOffset;

        // Case 1: cursor is inside an annotation element
        const ancestor = findAncestor(node, isAnnotationElement, this.el);
        if (ancestor) return ancestor;

        // Case 2: cursor is between DOM siblings — check the node just before and just after
        let next: Node | null = null;
        let prev: Node | null = null;
        if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            next = el.childNodes[offset] ?? null;
            prev = offset > 0 ? el.childNodes[offset - 1] : null;
        } else if (node.nodeType === Node.TEXT_NODE) {
            const text = node as Text;
            if (offset === text.length) next = text.nextSibling;
            if (offset === 0)           prev = text.previousSibling;
        }
        if (isAnnotationElement(next)) return next;
        if (isAnnotationElement(prev)) return prev;

        // Case 3: cursor is inside a cursor anchor span — annotation is the anchor's prev sibling
        const parentEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
        if (parentEl?.classList.contains('tate-cursor-anchor')) {
            const beforeAnchor = parentEl.previousSibling;
            if (isAnnotationElement(beforeAnchor)) return beforeAnchor;
        }

        return null;
    }

    // Returns all annotation elements (ruby/tcy/bouten/heading) that intersect savedRange.
    // Rebuilds a DOM Range from savedRange and uses intersectsNode() so that partial overlaps,
    // full containment, and cross-node selections are all handled uniformly.
    private findAnnotationsIntersectingSavedRange(): HTMLElement[] {
        const r = this.savedRange;
        if (!r) return [];

        const range = activeDocument.createRange();
        try {
            range.setStart(r.startContainer, r.startOffset);
            range.setEnd(r.endContainer, r.endOffset);
        } catch {
            return [];
        }

        const candidates = this.el.querySelectorAll<HTMLElement>(ANNOTATION_SELECTOR);
        const result: HTMLElement[] = [];
        for (const candidate of Array.from(candidates)) {
            if (range.intersectsNode(candidate)) result.push(candidate);
        }
        return result;
    }

    // Walks up ancestors from node and returns the first expandable element (ruby or explicit tcy)
    private findExpandableAncestor(node: Node): HTMLElement | null {
        return this.expander.findExpandableAncestor(node, this.expandRuby, this.expandTcy, this.expandBouten, this.expandHeading);
    }

    // Expands target into a raw-text editing span and sets the cursor to the corresponding position
    private expandForEditing(target: HTMLElement, range: Range): void {
        const { el: span, originalText } = this.expander.expandForEditing(target, range);
        this.expandedEl = span;
        this.expandedElOriginalText = originalText;
        this.inBurst = false; // Expansion is a navigation action; treat subsequent input as a new burst.
    }

    // Places the cursor just after a collapsed annotation element.
    // Inserts a cursor-anchor span at end-of-line if needed, and records the collapsed element
    // in collapseGuard so handleSelectionChange can detect Chrome's cursor normalization.
    private placeCursorAfterCollapse(nextSib: Node | null, parentEl: HTMLElement, sel: Selection): void {
        this.anchorManager.placeCursorAfterCollapse(nextSib, parentEl, sel);
        if (nextSib?.isConnected) {
            const prev = nextSib.previousSibling;
            // tcy is intentionally excluded: it has its own arrow-key navigation and is not
            // subject to the post-collapse cursor-normalization that collapseGuard handles.
            if (isAnnotationElement(prev) && annotationKindOf(prev) !== 'tcy') {
                this.collapseGuard.set(prev, prev.textContent ?? '');
            }
        }
    }

    // Called when Enter is pressed while expanded. Collapses and places cursor after the element.
    // Returns true if content changed (signal for view.ts to call commitToCm6).
    collapseForEnter(): boolean {
        if (!this.expandedEl) return false;
        const nextSib = this.expandedEl.nextSibling;
        const parentEl = this.expandedEl.parentElement;
        this.isModifyingDom = true;
        let changed = false;
        try {
            changed = this.collapseEditing();
            const sel = window.getSelection();
            if (parentEl && sel) this.placeCursorAfterCollapse(nextSib, parentEl, sel);
        } finally {
            this.isModifyingDom = false;
        }
        return changed;
    }

    // Collapses the editing span, re-parses its content, and inserts the result at the original position (caller handles cursor).
    // Returns true if content changed (signal for view.ts to call commitToCm6).
    private collapseEditing(): boolean {
        if (!this.expandedEl) return false;
        const { hasChanged, detached } = this.expander.collapseEditing(
            this.expandedEl, this.expandedElOriginalText
        );
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        // Preserve inBurst when the span was already detached (e.g. Undo removed it externally).
        if (!detached) this.inBurst = false;
        return hasChanged;
    }

    // Collapses the editing span (DOM cleanup) before applying CM6 changes, then resets all state.
    // Unlike reset(), this removes span.tate-editing from the DOM so that patchParagraphs() sees a
    // clean annotation element even when the Undo/Redo touches a different paragraph.
    // After collapse, selectionchange will re-expand the annotation if the cursor lands inside it.
    collapseForApply(): void {
        if (this.expandedEl?.isConnected) {
            this.isModifyingDom = true;
            try {
                this.collapseEditing();
            } finally {
                this.isModifyingDom = false;
            }
        }
        this.reset();
    }

    // Normalizes savedRange and returns { textNode, startOffset, endOffset }.
    private resolveSelectionRange(): { textNode: Text; startOffset: number; endOffset: number } | null {
        const r = this.savedRange;
        if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return null;
        const textNode = r.startContainer as Text;

        // Ideal case: selection within the same text node
        if (r.endContainer === r.startContainer) {
            if (r.startOffset === r.endOffset) return null; // Empty selection
            return { textNode, startOffset: r.startOffset, endOffset: r.endOffset };
        }

        // Chrome block-end selection: endContainer is the parent element (<div>)
        const parent = textNode.parentNode;
        if (!parent) return null;
        if (r.endContainer === parent) {
            const textNodeIdx = Array.from(parent.childNodes).indexOf(textNode);
            if (textNodeIdx !== -1 && r.endOffset > textNodeIdx) {
                return { textNode, startOffset: r.startOffset, endOffset: textNode.length };
            }
        }
        // Chrome block-end selection: endContainer is a sibling <br> under the same parent
        if (r.endContainer.nodeType === Node.ELEMENT_NODE &&
            (r.endContainer as Element).tagName === 'BR' &&
            r.endContainer.parentNode === parent) {
            return { textNode, startOffset: r.startOffset, endOffset: textNode.length };
        }
        // Triple-click selection: endContainer is a following block (e.g. the next paragraph
        // div at offset 0). The selection extends past this text node's paragraph, so clamp to
        // the end of textNode — consistent with the block-end cases above.
        if (textNode.compareDocumentPosition(r.endContainer) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return { textNode, startOffset: r.startOffset, endOffset: textNode.length };
        }

        return null;
    }

    // Records the direction of the most recent navigation key so handleSelectionChange
    // can skip the U+200B placeholder in the correct direction.
    // Call from the keydown handler before the browser moves the cursor.
    notifyNavigationKey(key: string): void {
        // Intentional navigation clears the post-collapse guard so the element can be re-entered.
        this.collapseGuard.clear();
        this.anchorManager.setSkipDirection(key);
    }

    // Called after input/compositionend when cursor may be inside a tate-cursor-anchor span.
    // Removes U+200B once real characters have been typed, or re-inserts it when the span is empty.
    handleCursorAnchorInput(): void {
        this.isModifyingDom = true;
        try {
            this.anchorManager.handleCursorAnchorInput();
        } finally {
            this.isModifyingDom = false;
        }
    }
}
