import {
    createTcyEl, createBoutenEl,
    insertAnnotationElement,
    findTcyAncestor,
} from './domHelpers';
import { BoutenGuard } from './BoutenGuard';
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
    private readonly boutenGuard: BoutenGuard;
    private readonly anchorManager: CursorAnchorManager;
    private readonly liveConverter: LiveConverter;
    private readonly expander: InlineExpander;

    constructor(private readonly el: HTMLDivElement) {
        this.boutenGuard = new BoutenGuard(el);
        this.anchorManager = new CursorAnchorManager(el);
        this.liveConverter = new LiveConverter(el);
        this.expander = new InlineExpander(el);
    }

    setVirtualizer(v: ParagraphVirtualizer): void {
        this.anchorManager.setVirtualizer(v);
    }

    setExpandSettings(ruby: boolean, tcy: boolean, bouten: boolean): void {
        this.expandRuby = ruby;
        this.expandTcy = tcy;
        this.expandBouten = bouten;
    }

    // Resets expansion state, selection cache, and burst flag (called from setValue / applyFromCm6)
    reset(): void {
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        this.savedRange = null;
        this.inBurst = false;
        this.boutenGuard.clear();
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
                        const r = document.createRange();
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

            // If cursor is inside a U+200B-only anchor span and a navigation key was just pressed,
            // skip in the recorded direction to make the invisible placeholder transparent.
            if (this.anchorManager.handleAnchorPosition(currentRange, sel)) {
                return contentChanged; // Don't try to expand anchor span
            }

            // Expand if the cursor is inside an expandable element (ruby/tcy/bouten)
            const target = this.findExpandableAncestor(currentRange.startContainer);
            if (target) {
                // After a bouten collapse, Chrome normalizes the cursor from the adjacent anchor
                // back into the bouten span. Detect this and redirect cursor instead of re-expanding.
                const bjc = this.boutenGuard.get();
                if (bjc && target === bjc.el) {
                    this.boutenGuard.redirectCursorOutOfCollapsedBouten(target, sel);
                    // Keep boutenJustCollapsed set; cleared only on user action (nav key / mouse).
                    return contentChanged;
                }
                // Cursor entered a different expandable element: clear the post-collapse guard.
                this.boutenGuard.clear();
                // For expandable elements at end-of-line, insert a cursor anchor before expanding so
                // that when the user exits past the closing bracket, nextSibling is already the anchor.
                if (target.tagName === 'RUBY' || target.getAttribute('data-tcy') === 'explicit'
                        || target.getAttribute('data-bouten'))
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
        const span = document.createElement('span');
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
            if (precedingText) parentEl.insertBefore(document.createTextNode(precedingText), next);
            parentEl.insertBefore(span, next);
            if (followingText) parentEl.insertBefore(document.createTextNode(followingText), next);

            this.expandedEl = span;
            this.expandedElOriginalText = rawText;

            // Place cursor between 《 and 》 (rawText.length - 1 = just before 》)
            const spanText = span.firstChild as Text | null;
            if (spanText) {
                const sel = window.getSelection()!;
                const r = document.createRange();
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

    // Handles ArrowUp (→ move left) and ArrowDown (→ move right) when cursor is inside a tcy span.
    // In vertical writing mode the tcy element is laid out horizontally, so the vertical arrow keys
    // should navigate within the tcy text rather than jumping to the adjacent line.
    // Returns true if the key was consumed (caller should call preventDefault).
    handleTcyNavigation(key: string): boolean {
        if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);

        const tcySpan = findTcyAncestor(range.startContainer, this.el);
        if (!tcySpan) return false;

        const moveLeft = key === 'ArrowUp';
        const textNode = tcySpan.firstChild instanceof Text ? tcySpan.firstChild as Text : null;
        const r = document.createRange();

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

    // Returns the bouten span that should intercept the next insertText event due to Chrome's
    // post-collapse cursor behavior, or null if not applicable.
    getCursorBoutenSpan(): HTMLElement | null {
        return this.boutenGuard.getCursorBoutenSpan(this.expandBouten, this.expandedEl);
    }

    // Inserts chars into the DOM immediately after bouten without going through the Selection API.
    insertAfterBouten(bouten: HTMLElement, chars: string): void {
        this.boutenGuard.insertAfterBouten(bouten, chars);
    }

    // Called in compositionend (before commitToCm6) to move IME text that landed inside a
    // post-collapse bouten span out to after the span. Returns true if the DOM was changed.
    handleBoutenPostCollapseInput(): boolean {
        return this.boutenGuard.handleBoutenPostCollapseInput();
    }

    // Resets the burst flag after a commit. Does NOT clear boutenGuard.
    afterCommit(): void {
        this.inBurst = false;
    }

    // Resets the burst flag and clears boutenGuard on mouse click or navigation key.
    afterNavigation(): void {
        this.inBurst = false;
        this.boutenGuard.clear();
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
            // placeCursorAfterCollapse also sets boutenGuard when wrapping a bouten span.
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

    // Walks up ancestors from node and returns the first expandable element (ruby or explicit tcy)
    private findExpandableAncestor(node: Node): HTMLElement | null {
        return this.expander.findExpandableAncestor(node, this.expandRuby, this.expandTcy, this.expandBouten);
    }

    // Expands target into a raw-text editing span and sets the cursor to the corresponding position
    private expandForEditing(target: HTMLElement, range: Range): void {
        const { el: span, originalText } = this.expander.expandForEditing(target, range);
        this.expandedEl = span;
        this.expandedElOriginalText = originalText;
        this.inBurst = false; // Expansion is a navigation action; treat subsequent input as a new burst.
    }

    // Places the cursor just after a collapsed annotation element.
    // Inserts a cursor-anchor span at end-of-line if needed, and records boutenJustCollapsed.
    private placeCursorAfterCollapse(nextSib: Node | null, parentEl: HTMLElement, sel: Selection): void {
        this.anchorManager.placeCursorAfterCollapse(nextSib, parentEl, sel);
        // After collapsing a bouten span, record it so handleSelectionChange can detect
        // Chrome's cursor normalization back into the span and redirect instead of re-expanding.
        if (nextSib?.isConnected) {
            const prevOfNextSib = nextSib.previousSibling;
            if (prevOfNextSib instanceof HTMLElement && prevOfNextSib.getAttribute('data-bouten')) {
                this.boutenGuard.set(prevOfNextSib, prevOfNextSib.textContent ?? '');
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

        return null;
    }

    // Records the direction of the most recent navigation key so handleSelectionChange
    // can skip the U+200B placeholder in the correct direction.
    // Call from the keydown handler before the browser moves the cursor.
    notifyNavigationKey(key: string): void {
        // Intentional navigation clears the post-collapse guard so bouten can be entered again.
        this.boutenGuard.clear();
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
