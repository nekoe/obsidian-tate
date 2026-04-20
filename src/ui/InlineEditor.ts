import { sanitizeHTMLToDom } from 'obsidian';
import { KANJI_RE_STR, parseInlineToHtml, serializeNode } from './AozoraParser';
import {
    createRubyEl, createTcyEl, createBoutenEl, createCursorAnchor,
    insertAnnotationElement, setCursorAfter,
    findTcyAncestor, isInsideRuby, findCursorAnchorAncestor,
    isInsideRtNode, findLastBaseTextInElement,
    rawOffsetForExpand, getExtraCharsFromAnnotation,
} from './domHelpers';
import { BoutenGuard } from './BoutenGuard';

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
    // Direction of the most recent navigation key; used by handleSelectionChange to skip
    // the U+200B placeholder in the cursor anchor span in the correct direction.
    private pendingAnchorSkip: 'forward' | 'backward' | null = null;
    // Per-element-type flags controlling whether cursor entry triggers inline expansion.
    private expandRuby = true;
    private expandTcy = true;
    private expandBouten = true;
    private readonly boutenGuard: BoutenGuard;

    constructor(private readonly el: HTMLDivElement) {
        this.boutenGuard = new BoutenGuard(el);
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
            // Synchronize expandedEl with the actual tate-editing span in the DOM
            if (!this.expandedEl || !this.expandedEl.isConnected) {
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
            const anchorSpan = findCursorAnchorAncestor(currentRange.startContainer, this.el);
            const savedSkip = this.pendingAnchorSkip;
            this.pendingAnchorSkip = null;
            if (anchorSpan) {
                const text = anchorSpan.textContent ?? '';
                if ((text === '\u200B' || text === '') && savedSkip !== null) {
                    try {
                        const r = document.createRange();
                        if (savedSkip === 'forward') {
                            const pos = this.findPositionAfterAnchor(anchorSpan);
                            if (pos) r.setStart(pos.node, pos.offset);
                            else r.setStartAfter(anchorSpan);
                        } else {
                            const pos = this.findPositionBeforeAnchor(anchorSpan);
                            if (pos) r.setStart(pos.node, pos.offset);
                            else r.setStartAfter(anchorSpan);
                        }
                        r.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(r);
                    } catch { /* ignore if detached */ }
                }
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
                    this.ensureCursorAnchorAfter(target);
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
        // Skip if a span is already expanded or if a DOM modification is in progress
        if (this.expandedEl) return false;
        if (this.isModifyingDom) return false;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
        if (isInsideRuby(range.startContainer, this.el)) return false;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith('》')) return false;

        // Explicit form takes priority: ｜base《rt》 or |base《rt》
        let match = textBefore.match(/[|｜]([^|｜《》\n]+)《([^《》\n]*)》$/);
        let explicit = true;
        if (!match) {
            // Implicit form: preceding run of kanji followed by 《rt》
            match = textBefore.match(new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》$`, 'u'));
            explicit = false;
        }
        if (!match) return false;

        const base = match[1];
        const rt = match[2];
        const matchStart = range.startOffset - match[0].length;

        // If rt is empty (user typed 《》): expand to a tate-editing span and place cursor between 《 and 》.
        // When the user types the ruby text and moves the cursor away, collapseEditing() collapses it to a <ruby>.
        if (rt === '') {
            const rawText = explicit ? `｜${base}《》` : `${base}《》`;
            const span = document.createElement('span');
            span.className = 'tate-editing';
            span.textContent = rawText;

            this.isModifyingDom = true;
            try {
                insertAnnotationElement(textNode, matchStart, range.startOffset, span);
                this.expandedEl = span;
                this.expandedElOriginalText = rawText;

                // Place cursor between 《 and 》 (rawText.length - 1 = just before 》)
                const spanText = span.firstChild as Text | null;
                if (spanText) {
                    const r = document.createRange();
                    r.setStart(spanText, rawText.length - 1);
                    r.collapse(true);
                    const s = window.getSelection()!;
                    s.removeAllRanges();
                    s.addRange(r);
                }
            } finally {
                this.isModifyingDom = false;
            }
            return true;
        }

        this.isModifyingDom = true;
        try {
            const rubyEl = createRubyEl(base, rt, explicit);
            const inserted = insertAnnotationElement(
                textNode, matchStart, range.startOffset, rubyEl,
            );

            // Place cursor just after the element
            // If the cursor is inside the ruby, selectionchange fires expandForEditing() immediately
            setCursorAfter(inserted);
            return true;
        } finally {
            this.isModifyingDom = false;
        }
    }

    // Converts a tate-chu-yoko notation just before the cursor to a <span class="tcy"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleTcyCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」は縦中横］$/, createTcyEl);
    }

    // Converts a bouten notation just before the cursor to a <span class="bouten"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleBoutenCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」に傍点］$/, createBoutenEl);
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

    // Resets the burst flag (call after commitToCm6() completes or on navigation in view.ts).
    resetBurst(): void {
        this.inBurst = false;
        // Mouse click or navigation commits the current position; allow future bouten expansion.
        this.boutenGuard.clear();
    }

    // ---- Shared logic for selection wrap and annotation completion ----

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
            const inserted = insertAnnotationElement(
                textNode, startOffset, endOffset, newEl,
            );

            // Place cursor just after the inserted element
            // If the cursor is inside the element, selectionchange would trigger expandForEditing()
            setCursorAfter(inserted);
        } finally {
            this.isModifyingDom = false;
        }
        this.savedRange = null;
        return true;
    }

    // Shared implementation for live conversions that complete on a terminal character (tcy, bouten, etc.).
    // Returns true if a conversion occurred.
    private handleAnnotationCompletion(
        endChar: string,
        re: RegExp,
        createElement: (content: string) => HTMLElement,
    ): boolean {
        // Skip if a span is already expanded or if a DOM modification is in progress
        if (this.expandedEl) return false;
        if (this.isModifyingDom) return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
        if (isInsideRuby(range.startContainer, this.el)) return false;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith(endChar)) return false;

        const annotationMatch = textBefore.match(re);
        if (!annotationMatch) return false;

        const content = annotationMatch[1];
        const annotationStart = range.startOffset - annotationMatch[0].length;
        if (!textBefore.slice(0, annotationStart).endsWith(content)) return false;

        this.isModifyingDom = true;
        try {
            const newEl = createElement(content);
            const inserted = insertAnnotationElement(
                textNode, annotationStart - content.length, range.startOffset, newEl,
            );

            // Place cursor just after the element
            // If the cursor is inside the element, selectionchange fires expandForEditing() immediately
            setCursorAfter(inserted);
            return true;
        } finally {
            this.isModifyingDom = false;
        }
    }

    // ---- Private helpers for inline expand/collapse ----

    // Walks up ancestors from node and returns the first expandable element (ruby or explicit tcy)
    private findExpandableAncestor(node: Node): HTMLElement | null {
        let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
        while (el && el !== this.el) {
            if (el.tagName === 'RUBY' && this.expandRuby) return el;
            if (el.tagName === 'SPAN' && el.getAttribute('data-tcy') === 'explicit' && this.expandTcy) return el;
            if (el.tagName === 'SPAN' && el.getAttribute('data-bouten') && this.expandBouten) return el;
            el = el.parentElement;
        }
        return null;
    }

    // Expands target into a raw-text editing span and sets the cursor to the corresponding position
    private expandForEditing(target: HTMLElement, range: Range): void {
        const rawText = serializeNode(target, this.el);
        const cursorOffset = rawOffsetForExpand(
            target, range.startContainer, range.startOffset
        );

        const span = document.createElement('span');
        span.className = 'tate-editing';
        span.textContent = rawText;

        target.parentNode!.replaceChild(span, target);
        this.expandedEl = span;
        this.expandedElOriginalText = rawText; // Saved for change detection in collapseEditing
        this.inBurst = false; // Expansion is a navigation action; treat subsequent input as a new burst.

        const textNode = span.firstChild as Text | null;
        if (textNode) {
            const sel = window.getSelection();
            if (sel) {
                const r = document.createRange();
                r.setStart(textNode, Math.min(cursorOffset, textNode.length));
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            }
        }
    }

    // Places the cursor just after a collapsed annotation element.
    // Inserts a cursor-anchor span at end-of-line if needed, and records boutenJustCollapsed.
    private placeCursorAfterCollapse(nextSib: Node | null, parentEl: HTMLElement, sel: Selection): void {
        try {
            const r = document.createRange();
            let placedAnchor: HTMLElement | null = null;
            if (nextSib && nextSib.isConnected) {
                if (nextSib instanceof HTMLElement
                        && nextSib.classList.contains('tate-cursor-anchor')
                        && nextSib.firstChild?.nodeType === Node.TEXT_NODE) {
                    // Use a text-level position inside the anchor to avoid Chrome creating an
                    // element-level position that fires an intermediate selectionchange and
                    // clears pendingAnchorSkip before the skip runs.
                    r.setStart(nextSib.firstChild, 0);
                    placedAnchor = nextSib;
                } else {
                    r.setStartBefore(nextSib);
                }
            } else {
                // End-of-line: insert cursor anchor span with U+200B so Chrome has a real
                // text position and does not normalize into <rt> or the annotation span.
                const anchor = createCursorAnchor();
                parentEl.appendChild(anchor);
                r.setStart(anchor.firstChild!, 0);
                placedAnchor = anchor;
            }
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            // If the anchor is at end-of-line, clear pendingAnchorSkip so the cursor rests
            // there; if content follows, keep the flag so the skip fires on landing.
            if (placedAnchor) {
                const nextAfterAnchor = placedAnchor.nextSibling;
                const atEndOfLine = !nextAfterAnchor
                    || (nextAfterAnchor instanceof HTMLElement
                        && nextAfterAnchor.tagName === 'BR'
                        && nextAfterAnchor === nextAfterAnchor.parentElement?.lastChild);
                if (atEndOfLine) this.pendingAnchorSkip = null;
            }
        } catch { /* ignore if node detached */ }
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
        // A detached node must be cleared and returned immediately
        // (calling parentNode / selectNode on a detached node throws an exception)
        if (!this.expandedEl.isConnected) {
            this.expandedEl = null;
            this.expandedElOriginalText = null;
            return false;
        }

        let rawText = this.expandedEl.textContent ?? '';
        const hasChanged = this.expandedElOriginalText === null
            || rawText !== this.expandedElOriginalText;

        const parent = this.expandedEl.parentNode!;
        const nextSibling = this.expandedEl.nextSibling;

        // Leading text absorption correction (only meaningful when hasChanged)
        let precedingTextNode: Text | null = null;
        let precedingChars = '';
        if (hasChanged) {
            const extraChars = getExtraCharsFromAnnotation(rawText);
            if (extraChars.length > 0) {
                const prev = this.expandedEl.previousSibling;
                if (prev?.nodeType === Node.TEXT_NODE) {
                    const prevText = prev as Text;
                    if ((prevText.textContent ?? '').endsWith(extraChars)) {
                        precedingTextNode = prevText;
                        precedingChars = extraChars;
                        rawText = precedingChars + rawText;
                    }
                }
            }
        }

        // Do not use parseToHtml (it wraps in <div>, which would nest inside the paragraph <div>)
        const html = parseInlineToHtml(rawText);

        // Remove the absorbed leading characters from the preceding text node
        if (precedingTextNode?.isConnected) {
            precedingTextNode.textContent = (precedingTextNode.textContent ?? '')
                .slice(0, -precedingChars.length);
        }

        // Direct DOM manipulation (handles start of line, end of line, and middle uniformly)
        parent.removeChild(this.expandedEl);
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        const fragment = sanitizeHTMLToDom(html);
        while (fragment.firstChild) {
            parent.insertBefore(fragment.firstChild, nextSibling);
        }

        // After collapse, treat the next input as a new burst
        this.inBurst = false;
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

    // ---- Cursor anchor span management ----

    // Inserts a cursor anchor after el if el is at end-of-line and has no anchor yet.
    // Must be called before expandForEditing so that the anchor survives as nextSibling
    // of the tate-editing span and is available when the user exits past the closing bracket.
    private ensureCursorAnchorAfter(el: HTMLElement): void {
        const next = el.nextSibling;
        if (next instanceof HTMLElement && next.classList.contains('tate-cursor-anchor')) return;
        // End-of-line: no next sibling, or only the decorative <br> Chrome appends
        const isEndOfLine = !next
            || (next instanceof HTMLElement && next.tagName === 'BR'
                && next === next.parentElement?.lastChild);
        if (!isEndOfLine) return;
        const anchor = createCursorAnchor();
        el.parentNode!.insertBefore(anchor, next);
    }

    // Records the direction of the most recent navigation key so handleSelectionChange
    // can skip the U+200B placeholder in the correct direction.
    // Call from the keydown handler before the browser moves the cursor.
    notifyNavigationKey(key: string): void {
        // Intentional navigation clears the post-collapse guard so bouten can be entered again.
        this.boutenGuard.clear();
        if (key === 'ArrowDown') this.pendingAnchorSkip = 'forward';
        else if (key === 'ArrowUp') this.pendingAnchorSkip = 'backward';
        else this.pendingAnchorSkip = null;
    }

    // Returns the first non-<rt> text position after the anchor.
    // Checks siblings within the same paragraph first; falls back to the next paragraph.
    private findPositionAfterAnchor(anchor: HTMLElement): { node: Text; offset: number } | null {
        let sibling: Node | null = anchor.nextSibling;
        while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
                const t = sibling as Text;
                if (!isInsideRtNode(t, this.el)) return { node: t, offset: 0 };
            } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                const walker = document.createTreeWalker(sibling, NodeFilter.SHOW_TEXT);
                let node = walker.nextNode() as Text | null;
                while (node) {
                    if (!isInsideRtNode(node, this.el)) return { node, offset: 0 };
                    node = walker.nextNode() as Text | null;
                }
            }
            sibling = sibling.nextSibling;
        }
        // Fallback: first text in the next paragraph
        const parentDiv = anchor.parentElement;
        if (!parentDiv) return null;
        let next = parentDiv.nextSibling;
        while (next) {
            const walker = document.createTreeWalker(next, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode() as Text | null;
            while (node) {
                if (!isInsideRtNode(node, this.el)) return { node, offset: 0 };
                node = walker.nextNode() as Text | null;
            }
            next = next.nextSibling;
        }
        return null;
    }

    // Returns the last non-<rt> text position before the anchor on the same line.
    // Descends into element siblings (e.g. <ruby>) to find their last base text node,
    // which causes selectionchange to trigger expandForEditing on the ruby.
    // Falls back to the last text of the previous paragraph if nothing is found on the same line.
    private findPositionBeforeAnchor(anchor: HTMLElement): { node: Text; offset: number } | null {
        // Search backward among siblings of the anchor on the same line
        let prev: Node | null = anchor.previousSibling;
        while (prev) {
            if (prev.nodeType === Node.TEXT_NODE) {
                return { node: prev as Text, offset: (prev as Text).length };
            }
            if (prev.nodeType === Node.ELEMENT_NODE) {
                const pos = findLastBaseTextInElement(prev as HTMLElement, this.el);
                if (pos) return pos;
            }
            prev = prev.previousSibling;
        }
        // Nothing usable on the same line: fall back to end of previous paragraph
        const parentDiv = anchor.parentElement;
        if (!parentDiv) return null;
        let prevDiv = parentDiv.previousSibling;
        while (prevDiv) {
            const walker = document.createTreeWalker(prevDiv, NodeFilter.SHOW_TEXT);
            let lastText: Text | null = null;
            let node = walker.nextNode() as Text | null;
            while (node) {
                if (!isInsideRtNode(node, this.el)) lastText = node;
                node = walker.nextNode() as Text | null;
            }
            if (lastText) return { node: lastText, offset: lastText.length };
            prevDiv = prevDiv.previousSibling;
        }
        return null;
    }

    // Called after input/compositionend when cursor may be inside a tate-cursor-anchor span.
    // Removes U+200B once real characters have been typed, or re-inserts it when the span is empty.
    handleCursorAnchorInput(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const anchor = findCursorAnchorAncestor(range.startContainer, this.el);
        if (!anchor) return;

        const text = anchor.textContent ?? '';
        this.isModifyingDom = true;
        try {
            if (text === '') {
                // Span emptied by deletion: restore U+200B placeholder
                const zws = document.createTextNode('\u200B');
                anchor.replaceChildren(zws);
                const r = document.createRange();
                r.setStart(zws, 0);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            } else if (text !== '\u200B' && text.includes('\u200B')) {
                // Real chars mixed with U+200B: strip placeholder
                const cleaned = text.replace(/\u200B/g, '');
                const textNode = anchor.firstChild;
                if (textNode?.nodeType === Node.TEXT_NODE) {
                    const prevOffset = range.startContainer === textNode ? range.startOffset : cleaned.length;
                    textNode.textContent = cleaned;
                    const adjustedOffset = text.slice(0, prevOffset).replace(/\u200B/g, '').length;
                    const r = document.createRange();
                    r.setStart(textNode, Math.min(adjustedOffset, cleaned.length));
                    r.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(r);
                }
            }
        } finally {
            this.isModifyingDom = false;
        }
    }
}
