import { sanitizeHTMLToDom } from 'obsidian';
import { KANJI_RE_STR, parseInlineToHtml, serializeNode } from './AozoraParser';

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
    private expandTcy = false;
    private expandBouten = false;

    constructor(private readonly el: HTMLDivElement) {}

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
                if (parentEl) {
                    try {
                        const r = document.createRange();
                        let placedAnchor: HTMLElement | null = null;
                        if (nextSib && nextSib.isConnected) {
                            if (nextSib instanceof HTMLElement
                                    && nextSib.classList.contains('tate-cursor-anchor')
                                    && nextSib.firstChild?.nodeType === Node.TEXT_NODE) {
                                // Use a text-level position inside the anchor to avoid Chrome
                                // creating an element-level position that fires an intermediate
                                // selectionchange and clears pendingAnchorSkip before the skip runs.
                                r.setStart(nextSib.firstChild, 0);
                                placedAnchor = nextSib;
                            } else {
                                r.setStartBefore(nextSib);
                            }
                        } else {
                            // End-of-line after ruby: insert cursor anchor span with U+200B so
                            // Chrome has a real text position and does not normalize into <rt>.
                            const anchor = this.createCursorAnchor();
                            parentEl.appendChild(anchor);
                            r.setStart(anchor.firstChild!, 0);
                            placedAnchor = anchor;
                        }
                        r.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(r);
                        // If the anchor is at end-of-line (no content follows in this paragraph),
                        // clear pendingAnchorSkip so the cursor rests there and the user must press
                        // ArrowDown again to move to the next line.
                        // If content follows, keep the flag so the skip fires immediately on landing.
                        if (placedAnchor) {
                            const nextAfterAnchor = placedAnchor.nextSibling;
                            const atEndOfLine = !nextAfterAnchor
                                || (nextAfterAnchor instanceof HTMLElement
                                    && nextAfterAnchor.tagName === 'BR'
                                    && nextAfterAnchor === nextAfterAnchor.parentElement?.lastChild);
                            if (atEndOfLine) this.pendingAnchorSkip = null;
                        }
                    } catch { /* ignore if node detached */ }
                }
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
            const anchorSpan = this.findCursorAnchorAncestor(currentRange.startContainer);
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

            // Expand if the cursor is inside an expandable element (ruby/tcy)
            const target = this.findExpandableAncestor(currentRange.startContainer);
            if (target) {
                // For expandable elements at end-of-line, insert a cursor anchor before expanding so
                // that when the user exits past the closing bracket, nextSibling is already the anchor.
                if (target.tagName === 'RUBY' || target.getAttribute('data-tcy') === 'explicit')
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
        if (this.isInsideRuby(range.startContainer)) return false;

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
                this.insertAnnotationElement(textNode, matchStart, range.startOffset, span);
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
            const rubyEl = this.createRubyEl(base, rt, explicit);
            const inserted = this.insertAnnotationElement(
                textNode, matchStart, range.startOffset, rubyEl,
            );

            // Place cursor just after the element
            // If the cursor is inside the ruby, selectionchange fires expandForEditing() immediately
            this.setCursorAfter(inserted);
            return true;
        } finally {
            this.isModifyingDom = false;
        }
    }

    // Converts a tate-chu-yoko notation just before the cursor to a <span class="tcy"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleTcyCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」は縦中横］$/, c => this.createTcyEl(c));
    }

    // Converts a bouten notation just before the cursor to a <span class="bouten"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleBoutenCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」に傍点］$/, c => this.createBoutenEl(c));
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
        return this.wrapSelectionWith(c => this.createTcyEl(c));
    }

    // Wraps the selected text in a bouten element
    wrapSelectionWithBouten(): boolean {
        return this.wrapSelectionWith(c => this.createBoutenEl(c));
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

        const tcySpan = this.findTcyAncestor(range.startContainer);
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

    // Resets the burst flag (call after commitToCm6() completes or on navigation in view.ts).
    resetBurst(): void {
        this.inBurst = false;
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
            const inserted = this.insertAnnotationElement(
                textNode, startOffset, endOffset, newEl,
            );

            // Place cursor just after the inserted element
            // If the cursor is inside the element, selectionchange would trigger expandForEditing()
            this.setCursorAfter(inserted);
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
        if (this.isInsideRuby(range.startContainer)) return false;

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
            const inserted = this.insertAnnotationElement(
                textNode, annotationStart - content.length, range.startOffset, newEl,
            );

            // Place cursor just after the element
            // If the cursor is inside the element, selectionchange fires expandForEditing() immediately
            this.setCursorAfter(inserted);
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
        const cursorOffset = this.rawOffsetForExpand(
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
            const extraChars = this.getExtraCharsFromAnnotation(rawText);
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

    // Converts the cursor position inside an element to a character offset in raw text
    private rawOffsetForExpand(el: HTMLElement, node: Node, offset: number): number {
        if (el.tagName === 'RUBY') {
            const explicit = el.getAttribute('data-ruby-explicit') !== 'false';
            const prefix = explicit ? 1 : 0; // '|'
            const baseLen = Array.from(el.childNodes)
                .filter(n => !(n instanceof HTMLElement && n.tagName === 'RT'))
                .reduce((sum, n) => sum + (n.textContent?.length ?? 0), 0);
            const rt = el.querySelector('rt');

            if (rt && rt.contains(node)) {
                // Cursor is inside <rt>: prefix + base + '《' + offset
                return prefix + baseLen + 1 + offset;
            } else {
                // Cursor is inside the base text: prefix + offset
                return prefix + offset;
            }
        } else {
            // <span data-tcy="explicit"> / <span data-bouten>: raw = 'X［＃「X」は縦中横/に傍点］'
            // The content part (X) is at the beginning
            return offset;
        }
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

    // Direct DOM operation: replaces the range [matchStart, matchEnd) of the text node with element.
    private insertAnnotationElement(
        textNode: Text,
        matchStart: number,
        matchEnd: number,
        element: HTMLElement,
    ): HTMLElement {
        const parentEl = textNode.parentNode as HTMLElement;

        const precedingText = textNode.data.slice(0, matchStart);
        const followingText = textNode.data.slice(matchEnd);
        const next = textNode.nextSibling;
        parentEl.removeChild(textNode);
        if (precedingText) parentEl.insertBefore(document.createTextNode(precedingText), next);
        parentEl.insertBefore(element, next);
        if (followingText) parentEl.insertBefore(document.createTextNode(followingText), next);

        return element;
    }

    // Moves the cursor to just after node.
    private setCursorAfter(node: Node): void {
        const sel = window.getSelection();
        if (!sel) return;
        const r = document.createRange();
        r.setStartAfter(node);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    }

    // After inline editing, on collapse: returns the characters to absorb from the preceding text node
    // when the annotation 「」content is longer than the leading text inside the span.
    private getExtraCharsFromAnnotation(rawText: string): string {
        const patterns = [
            /［＃「([^「」\n]+)」は縦中横］/,
            /［＃「([^「」\n]+)」に傍点］/,
        ];
        for (const re of patterns) {
            const m = rawText.match(re);
            if (!m || m.index === undefined) continue;
            const content = m[1];
            const leadingText = rawText.slice(0, m.index);
            if (!leadingText.endsWith(content) && content.length > leadingText.length) {
                const extraCount = content.length - leadingText.length;
                return content.slice(0, extraCount);
            }
        }
        return '';
    }

    private findTcyAncestor(node: Node): HTMLElement | null {
        let el: Node | null = node;
        while (el && el !== this.el) {
            if (el instanceof HTMLElement && el.classList.contains('tcy')) return el;
            el = el.parentElement;
        }
        return null;
    }

    private isInsideRuby(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RUBY') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    private createRubyEl(base: string, rt: string, explicit: boolean): HTMLElement {
        const rubyEl = document.createElement('ruby');
        rubyEl.setAttribute('data-ruby-explicit', String(explicit));
        rubyEl.appendChild(document.createTextNode(base));
        const rtEl = document.createElement('rt');
        rtEl.textContent = rt;
        rubyEl.appendChild(rtEl);
        return rubyEl;
    }

    private createTcyEl(content: string): HTMLElement {
        const span = document.createElement('span');
        span.setAttribute('data-tcy', 'explicit');
        span.className = 'tcy';
        span.textContent = content;
        return span;
    }

    private createBoutenEl(content: string): HTMLElement {
        const span = document.createElement('span');
        span.setAttribute('data-bouten', 'sesame');
        span.className = 'bouten';
        span.textContent = content;
        return span;
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
        const anchor = this.createCursorAnchor();
        el.parentNode!.insertBefore(anchor, next);
    }

    // Records the direction of the most recent navigation key so handleSelectionChange
    // can skip the U+200B placeholder in the correct direction.
    // Call from the keydown handler before the browser moves the cursor.
    notifyNavigationKey(key: string): void {
        if (key === 'ArrowDown') this.pendingAnchorSkip = 'forward';
        else if (key === 'ArrowUp') this.pendingAnchorSkip = 'backward';
        else this.pendingAnchorSkip = null;
    }

    // Returns an ancestor <span class=tate-cursor-anchor> of node, or null if not found.
    private findCursorAnchorAncestor(node: Node): HTMLElement | null {
        let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
        while (el && el !== this.el) {
            if (el.classList.contains('tate-cursor-anchor')) return el;
            el = el.parentElement;
        }
        return null;
    }

    // Creates a new cursor anchor span containing U+200B.
    private createCursorAnchor(): HTMLSpanElement {
        const anchor = document.createElement('span');
        anchor.className = 'tate-cursor-anchor';
        anchor.appendChild(document.createTextNode('\u200B'));
        return anchor;
    }

    // Returns the first non-<rt> text position after the anchor.
    // Checks siblings within the same paragraph first; falls back to the next paragraph.
    private findPositionAfterAnchor(anchor: HTMLElement): { node: Text; offset: number } | null {
        let sibling: Node | null = anchor.nextSibling;
        while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
                const t = sibling as Text;
                if (!this.isInsideRtNode(t)) return { node: t, offset: 0 };
            } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                const walker = document.createTreeWalker(sibling, NodeFilter.SHOW_TEXT);
                let node = walker.nextNode() as Text | null;
                while (node) {
                    if (!this.isInsideRtNode(node)) return { node, offset: 0 };
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
                if (!this.isInsideRtNode(node)) return { node, offset: 0 };
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
                const pos = this.findLastBaseTextInElement(prev as HTMLElement);
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
                if (!this.isInsideRtNode(node)) lastText = node;
                node = walker.nextNode() as Text | null;
            }
            if (lastText) return { node: lastText, offset: lastText.length };
            prevDiv = prevDiv.previousSibling;
        }
        return null;
    }

    // Finds the last non-<rt> text node inside el (used to land inside <ruby> on backward skip).
    private findLastBaseTextInElement(el: HTMLElement): { node: Text; offset: number } | null {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let lastText: Text | null = null;
        let node = walker.nextNode() as Text | null;
        while (node) {
            if (!this.isInsideRtNode(node)) lastText = node;
            node = walker.nextNode() as Text | null;
        }
        if (!lastText) return null;
        return { node: lastText, offset: lastText.length };
    }

    // Returns true if node has an <rt> ancestor within the editor root.
    private isInsideRtNode(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RT') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    // Called after input/compositionend when cursor may be inside a tate-cursor-anchor span.
    // Removes U+200B once real characters have been typed, or re-inserts it when the span is empty.
    handleCursorAnchorInput(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const anchor = this.findCursorAnchorAncestor(range.startContainer);
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
